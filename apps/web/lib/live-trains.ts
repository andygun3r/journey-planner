import {
  darwinStopForecast,
  darwinTrain,
  nrTrainPosition,
  railCorridor,
  station,
} from "@signaller/db";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { tocName } from "@signaller/shared";
import { getDb } from "./db";
import { resolvePatternTimes } from "./uk-time";

/**
 * The live train map's data source. Reads the Network Rail live-position table
 * (nr_train_position, kept fresh by services/nr-ingest from TRUST movements +
 * Train Describer) and turns each recently-reporting train into a plottable
 * point: last-reported station/timing-point coordinates, or a point along the
 * current precomputed rail corridor where one exists.
 *
 * There is no GPS for GB rail — position is derived from the last timing-point
 * or berth report. A train that reported ARRIVAL or PASS sits on that point;
 * one that reported DEPARTURE moves along the leg only when we have track
 * geometry for that leg.
 *
 * The nudge used to be a fixed 50%-of-the-way point regardless of how long ago
 * the departure was reported. Measured live: reports are a median 139s old but
 * a p90 of ~760s (12+min) — at that tail a train that's nearly reached the next
 * stop and one that's just left the platform were drawn in the identical spot.
 * Departed trains are now placed by elapsed-time-since-departure over the
 * scheduled leg duration (from Darwin's own times, resolved via
 * resolvePatternTimes — see timeFractionAlongLeg), clamped to [0,1] so a very
 * late or very early report never overshoots the next station. This only moves
 * the dot when a precomputed rail_corridor exists for the leg; otherwise the
 * train stays on its last reported track-snapped point rather than being drawn
 * through open country.
 *
 * "Where in the path is the train right now" is anchored on nr_train_position's
 * own lastCrs (NR's TRUST/TD report), not Darwin's actArr/actDep — Darwin's
 * actuals are far sparser (CLAUDE.md: "LDBWS/TRUST/TD is the richer real-time
 * source"), so a train 25 stops into a long route could still show Darwin's
 * actuals stuck at stop #2. That previously left "next stop" (and the drawn
 * nudge target) pinned at the ORIGIN's next call for the entire journey —
 * confirmed live: a train physically at Biggleswade got plotted 80km away,
 * nudged toward Doncaster, because Doncaster was "the first stop with no
 * Darwin actual" from the moment the train left King's Cross. See
 * findCurrentPathIndex.
 */

/** One ordered calling point on a train's route, with coordinates for drawing. */
export interface PathStop {
  crs: string;
  name: string;
  lat: number;
  lon: number;
  /** Scheduled public time (dep for the origin, arr elsewhere), HH:MM. */
  scheduled?: string;
  /** Best-known actual/estimated time, HH:MM. */
  expected?: string;
  /** Whether `expected` is an actual report vs a forecast. */
  actual?: boolean;
  status: "departed" | "current" | "upcoming";
}

export interface LiveTrain {
  id: string;
  headcode?: string;
  operator?: string;
  /** Plotted position (WGS84). */
  lat: number;
  lon: number;
  /** Where it physically last reported. */
  atName?: string;
  atCrs?: string;
  event?: string;
  /** Where it's heading next (drives the tooltip and direction arrow). */
  towardName?: string;
  destName?: string;
  latenessMinutes?: number;
  reportedAgoSeconds: number;
  /** Darwin rid, when correlated — lets the map link to the service page. */
  rid?: string;
  /**
   * Ordered calling points with coordinates — the train's route line and the
   * detail panel's calling list. Only correlated (rid-bearing) trains have one.
   */
  path?: PathStop[];
  /**
   * Track-following geometry per leg of `path`, in order: entry i covers
   * path[i] -> path[i+1]. Null where no corridor is precomputed for that pair,
   * so the caller draws that leg as a straight chord instead.
   */
  pathGeometry?: ([number, number][] | null)[];
}

export interface LiveTrainsResult {
  generatedAt: string;
  count: number;
  trains: LiveTrain[];
}

type ForecastPoint = {
  rid: string;
  seq: number;
  crs: string | null;
  schedArr: string | null;
  schedDep: string | null;
  estArr: string | null;
  estDep: string | null;
  actArr: string | null;
  actDep: string | null;
};

/**
 * Track-following geometry for the legs of a train's route, in path order.
 * Each entry is the corridor from path[i] to path[i+1] as [lon, lat] pairs, or
 * null where no corridor was precomputed for that pair. The map deliberately
 * omits those missing legs rather than drawing straight chords across country.
 */
async function corridorsForPaths(
  db: ReturnType<typeof getDb>,
  paths: Map<string, PathStop[]>,
): Promise<Map<string, ([number, number][] | null)[]>> {
  const pairSep = "|";
  const wanted = new Set<string>();
  for (const path of paths.values()) {
    for (let i = 1; i < path.length; i += 1) {
      wanted.add(`${path[i - 1]!.crs}${pairSep}${path[i]!.crs}`);
    }
  }
  if (wanted.size === 0) return new Map();

  const pairs = [...wanted].map((k) => k.split(pairSep) as [string, string]);
  const rows = await db
    .select({
      fromCrs: railCorridor.fromCrs,
      toCrs: railCorridor.toCrs,
      geometry: railCorridor.geometry,
    })
    .from(railCorridor)
    .where(
      inArray(
        sql`(${railCorridor.fromCrs}, ${railCorridor.toCrs})`,
        pairs.map((p) => sql`(${p[0]}, ${p[1]})`),
      ),
    );

  // geometry is a flat [lon0, lat0, lon1, lat1, ...] real[] — see the
  // rail_corridor schema comment for why it isn't jsonb or PostGIS.
  const byPair = new Map<string, [number, number][]>();
  for (const r of rows) {
    const flat = r.geometry;
    const coords: [number, number][] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) coords.push([flat[i]!, flat[i + 1]!]);
    if (coords.length >= 2) byPair.set(`${r.fromCrs}${pairSep}${r.toCrs}`, coords);
  }

  const out = new Map<string, ([number, number][] | null)[]>();
  for (const [rid, path] of paths) {
    const legs: ([number, number][] | null)[] = [];
    for (let i = 1; i < path.length; i += 1) {
      legs.push(byPair.get(`${path[i - 1]!.crs}${pairSep}${path[i]!.crs}`) ?? null);
    }
    out.set(rid, legs);
  }
  return out;
}

/** Consider a train "live on the map" if it reported within this window. */
const FRESH_SECONDS = 20 * 60;

/**
 * Private HS1/Eurostar timing points that arrive in TRUST/TD as pseudo-CRS
 * codes, not public station CRS codes. They do not join to `station`, but they
 * are real GB railway locations and otherwise Eurostar disappears from /map
 * except when it reports at St Pancras. Coordinates are approximate points on
 * HS1/CTRL, enough for the live map's "where is it broadly?" operational view.
 *
 * Longer term this should be replaced by a materialised timing-point geometry
 * table from Track Model / Sectional Appendix data.
 */
const PRIVATE_TIMING_POINTS: Record<string, { name: string; lat: number; lon: number }> = {
  XXH: { name: "Dagenham Junction", lat: 51.5262, lon: 0.1584 },
  DAGNMJN: { name: "Dagenham Junction", lat: 51.5262, lon: 0.1584 },
  XXU: { name: "Wennington Crossovers", lat: 51.5069, lon: 0.2582 },
  WENGTNX: { name: "Wennington Crossovers", lat: 51.5069, lon: 0.2582 },
  XXJ: { name: "Ebbsfleet West Junction", lat: 51.4458, lon: 0.3049 },
  EBSFWJN: { name: "Ebbsfleet West Junction", lat: 51.4458, lon: 0.3049 },
  XXX: { name: "Westenhanger Crossovers", lat: 51.0959, lon: 1.0352 },
  WENHX: { name: "Westenhanger Crossovers", lat: 51.0959, lon: 1.0352 },
  CHUNCTR: { name: "Eurotunnel Boundary", lat: 51.0972, lon: 1.1518 },
};

function privateTimingPoint(row: {
  lastCrs: string | null;
  lastTiploc: string | null;
}): { name: string; lat: number; lon: number } | undefined {
  return PRIVATE_TIMING_POINTS[row.lastCrs ?? ""] ?? PRIVATE_TIMING_POINTS[row.lastTiploc ?? ""];
}

function dedupeByPhysicalTrain(trains: LiveTrain[]): LiveTrain[] {
  const byKey = new Map<string, LiveTrain>();
  for (const train of trains) {
    const key = train.rid ? `rid:${train.rid}` : `id:${train.id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, train);
      continue;
    }
    const trainIsFresher = train.reportedAgoSeconds < existing.reportedAgoSeconds;
    const trainIsTd = train.id.startsWith("TD:");
    const existingIsTd = existing.id.startsWith("TD:");
    if (trainIsFresher || (train.reportedAgoSeconds === existing.reportedAgoSeconds && trainIsTd && !existingIsTd)) {
      byKey.set(key, train);
    }
  }
  return [...byKey.values()];
}

function titleCase(raw: string): string {
  if (raw !== raw.toUpperCase()) return raw;
  return raw
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(On|Of|The|Upon|And|In|Under|Le|By)\b/g, (w) => w.toLowerCase())
    .replace(/^./, (c) => c.toUpperCase());
}

/** Darwin supplies HH:MM or HH:MM:SS; the panel only wants HH:MM. */
function trimTime(t: string | null | undefined): string | undefined {
  if (!t) return undefined;
  const m = /^(\d{2}:\d{2})/.exec(t);
  return m ? m[1] : t;
}

/**
 * Where in `path` the train is right now, anchored on Network Rail's own
 * lastCrs — NOT Darwin's actArr/actDep sweep, which is far sparser and left
 * "current stop" pinned at the first stop after the origin for a train's
 * entire journey whenever Darwin's actuals lagged (see this file's header
 * comment for the measured 80km-off Biggleswade/Doncaster case).
 *
 * A route can call at the same CRS twice (reversals, circulars), so among all
 * matching indices this picks whichever is nearest to Darwin's own view of
 * progress (`darwinFrontSeq`, the first stop index with no actual time) —
 * cheap and needs no event history, unlike service-progress.ts's fuller
 * TRUST-history-walk disambiguation, which isn't available in this map-wide
 * query (it runs per-service, on demand, not for ~800 trains at once).
 *
 * Returns -1 when lastCrs isn't a stop on this path at all (e.g. the train
 * reported at a passing loop/depot not in the Darwin calling pattern) — the
 * caller falls back to Darwin's own status/next-stop in that case.
 */
function findCurrentPathIndex(path: PathStop[], lastCrs: string, darwinFrontSeq: number): number {
  let best = -1;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let i = 0; i < path.length; i += 1) {
    if (path[i]!.crs !== lastCrs) continue;
    const gap = Math.abs(i - darwinFrontSeq);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}

/**
 * Resolve each stop's departure and arrival time to a real instant, walking
 * the pattern in order so an overnight leg's day rolls forward correctly —
 * see resolvePatternTimes's own comment for why a stop-by-stop anchor-to-now
 * would scatter an overnight service across the wrong days.
 *
 * Departure and arrival are resolved as two independent monotonic sequences
 * (each stop's own arr and dep are naturally a minute or two apart, and
 * mixing them into one sequence would read as the clock going backwards at
 * every stop). Both prefer the actual time where TRUST/Darwin has reported
 * one, then the estimate, then schedule — same precedence live-trains uses
 * for display, so the nudge and the calling-point labels agree.
 */
function resolveLegTimes(
  stops: Array<{
    schedArr: string | null;
    schedDep: string | null;
    estArr: string | null;
    estDep: string | null;
    actArr: string | null;
    actDep: string | null;
  }>,
): { departIso?: string; arriveIso?: string }[] {
  const now = new Date();
  const departTimes = stops.map((s) => s.actDep ?? s.estDep ?? s.schedDep);
  const arriveTimes = stops.map((s) => s.actArr ?? s.estArr ?? s.schedArr);
  const departIsos = resolvePatternTimes(departTimes, now);
  const arriveIsos = resolvePatternTimes(arriveTimes, now);
  return stops.map((_, i) => ({ departIso: departIsos[i], arriveIso: arriveIsos[i] }));
}

/** Cumulative along-track distance to each point of a corridor polyline. */
function cumulativeLengths(coords: [number, number][]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i += 1) {
    out.push(out[i - 1]! + haversineMeters(coords[i - 1]!, coords[i]!));
  }
  return out;
}

function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Position `fraction` of the way along a corridor polyline, by track length —
 * not by vertex index, whose spacing is uneven — so e.g. fraction 0.5 lands
 * where the train has actually covered half the distance.
 */
function pointAlongCorridor(coords: [number, number][], fraction: number): [number, number] {
  if (coords.length === 1) return coords[0]!;
  const lengths = cumulativeLengths(coords);
  const target = lengths[lengths.length - 1]! * fraction;
  for (let i = 1; i < lengths.length; i += 1) {
    if (lengths[i]! >= target) {
      const segStart = lengths[i - 1]!;
      const segLen = lengths[i]! - segStart;
      const segFrac = segLen > 0 ? (target - segStart) / segLen : 0;
      const a = coords[i - 1]!;
      const b = coords[i]!;
      return [a[0] + (b[0] - a[0]) * segFrac, a[1] + (b[1] - a[1]) * segFrac];
    }
  }
  return coords[coords.length - 1]!;
}

/**
 * How far a departed train has covered its current leg, as elapsed real time
 * over the leg's scheduled duration — replacing the old fixed 0.5 nudge, which
 * put a train that departed 10 seconds ago in the same spot as one that
 * departed 12 minutes ago (measured p90 report age). Clamped to [0,1]: a very
 * late-reporting or early train still lands on the leg, never past the next
 * station or behind the one it left.
 *
 * Returns null when either instant is unknown (no schedule data for this leg),
 * so the caller can fall back to a conservative fixed fraction on the known
 * rail corridor rather than guess from station coordinates.
 */
function timeFractionAlongLeg(
  departIso: string | undefined,
  arriveIso: string | undefined,
  now: number,
): number | null {
  if (!departIso || !arriveIso) return null;
  const depart = Date.parse(departIso);
  const arrive = Date.parse(arriveIso);
  const duration = arrive - depart;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return Math.max(0, Math.min(1, (now - depart) / duration));
}

/**
 * `limit` is undefined for the full map view: every train within
 * FRESH_SECONDS should be plotted. It used to default to 800, ordered by
 * most-recent-report — but the live network regularly has several thousand
 * trains reporting within that 20-minute window, so the cap was silently
 * dropping whichever trains hadn't reported most recently, and which trains
 * that was reshuffled every tick as newer reports came in. That read as
 * trains randomly vanishing from /map. Single-service lookups still pass an
 * explicit small limit (1 or 10) since those only ever want one train's row.
 */
export async function getLiveTrains(limit?: number, ridFilter?: string): Promise<LiveTrainsResult> {
  const db = getDb();
  const since = new Date(Date.now() - FRESH_SECONDS * 1000);

  let rows: Array<{
    trainId: string;
    headcode: string | null;
    rid: string | null;
    lastCrs: string | null;
    lastTiploc: string | null;
    lastEvent: string | null;
    lastReportedAt: Date | null;
    lateness: number | null;
    lat: number | null;
    lon: number | null;
    stationName: string | null;
    toc: string | null;
  }>;
  try {
    const query = db
      .select({
        trainId: nrTrainPosition.trainId,
        headcode: nrTrainPosition.headcode,
        rid: nrTrainPosition.rid,
        lastCrs: nrTrainPosition.lastCrs,
        lastTiploc: nrTrainPosition.lastTiploc,
        lastEvent: nrTrainPosition.lastEventType,
        lastReportedAt: nrTrainPosition.lastReportedAt,
        lateness: nrTrainPosition.lateness,
        // Prefer the track-snapped coordinate (see station.trackLat's comment):
        // the .MSN lat/lon is the station entrance/centroid, which leaves a
        // train visibly beside the rails rather than on them. Falls back to the
        // raw coordinate for stations with no usable snap.
        lat: sql<number | null>`coalesce(${station.trackLat}, ${station.lat})`,
        lon: sql<number | null>`coalesce(${station.trackLon}, ${station.lon})`,
        stationName: station.name,
        toc: darwinTrain.toc,
      })
      .from(nrTrainPosition)
      .leftJoin(station, eq(nrTrainPosition.lastCrs, station.crs))
      .leftJoin(darwinTrain, eq(nrTrainPosition.rid, darwinTrain.rid))
      .where(
        and(
          isNotNull(nrTrainPosition.lastReportedAt),
          gte(nrTrainPosition.lastReportedAt, since),
          ridFilter ? eq(nrTrainPosition.rid, ridFilter) : undefined,
        ),
      )
      .orderBy(sql`${nrTrainPosition.lastReportedAt} desc`);
    rows = limit !== undefined ? await query.limit(limit) : await query;
  } catch {
    return { generatedAt: new Date().toISOString(), count: 0, trains: [] };
  }

  if (rows.length === 0) {
    return { generatedAt: new Date().toISOString(), count: 0, trains: [] };
  }

  // For correlated trains, load the full ordered calling pattern. It drives the
  // next-stop label, the route line, corridor placement, and the detail panel's
  // calling list — all from this one query.
  const rids = [...new Set(rows.map((r) => r.rid).filter(Boolean) as string[])];
  const destByRid = new Map<string, string>();
  const pathByRid = new Map<string, PathStop[]>();
  // Per rid, one entry per stop in `path` order: that stop's resolved
  // departure and arrival instants, when known. Powers the time-based
  // along-corridor placement below — see resolveLegTimes.
  const legTimesByRid = new Map<
    string,
    { departIso?: string; arriveIso?: string }[]
  >();
  // Per rid, Darwin's own view of "current stop" as an index into that rid's
  // `path` — the fallback findCurrentPathIndex uses to disambiguate a route
  // that calls at the same CRS twice, and the fallback status/next-stop used
  // when NR's lastCrs isn't found in the path at all.
  const darwinFrontIdxByRid = new Map<string, number>();
  if (rids.length > 0) {
    const forecasts = await db
      .select({
        rid: darwinStopForecast.rid,
        seq: darwinStopForecast.seq,
        crs: darwinStopForecast.crs,
        schedArr: darwinStopForecast.schedArr,
        schedDep: darwinStopForecast.schedDep,
        estArr: darwinStopForecast.estArr,
        estDep: darwinStopForecast.estDep,
        actArr: darwinStopForecast.actArr,
        actDep: darwinStopForecast.actDep,
      })
      .from(darwinStopForecast)
      .where(inArray(darwinStopForecast.rid, rids));

    const byRid = new Map<string, typeof forecasts>();
    for (const f of forecasts) {
      const list = byRid.get(f.rid) ?? [];
      list.push(f);
      byRid.set(f.rid, list);
    }

    // First pass: order each route and gather every CRS we'll need
    // coordinates for (the whole path, not just endpoints). "Next stop" is no
    // longer decided here — see findCurrentPathIndex for why anchoring it on
    // Darwin's actArr/actDep sweep was wrong.
    const orderedByRid = new Map<string, typeof forecasts>();
    const allCrsNeeded = new Set<string>();
    for (const [rid, list] of byRid) {
      const ordered = list
        .filter((s: ForecastPoint) => s.crs)
        .sort((a: ForecastPoint, b: ForecastPoint) => a.seq - b.seq);
      const last = ordered[ordered.length - 1];
      if (!last) continue;
      orderedByRid.set(rid, ordered);
      for (const s of ordered) if (s.crs) allCrsNeeded.add(s.crs);
      if (last.crs) destByRid.set(rid, last.crs);
    }

    // Coordinates + names for every calling point on every correlated route.
    const crsNeeded = [...allCrsNeeded];
    const coords = new Map<string, { name: string; lat: number | null; lon: number | null }>();
    if (crsNeeded.length > 0) {
      const st = await db
        .select({
          crs: station.crs,
          name: station.name,
          // Same track-snapped preference as the position query above, so the
          // drawn route line and the "next stop" the bearing points at both
          // sit on the rails rather than beside them.
          lat: sql<number | null>`coalesce(${station.trackLat}, ${station.lat})`,
          lon: sql<number | null>`coalesce(${station.trackLon}, ${station.lon})`,
        })
        .from(station)
        .where(inArray(station.crs, crsNeeded));
      for (const s of st) coords.set(s.crs, { name: s.name, lat: s.lat, lon: s.lon });
    }

    // Build the drawable path per rid (only stops with coordinates), and
    // alongside it the resolved departure/arrival instant for each stop —
    // used below to place a departed train by elapsed time rather than a
    // fixed fraction. Departure and arrival are resolved as separate
    // sequences: resolvePatternTimes needs a monotonic walk to roll an
    // overnight leg's day forward correctly, and mixing arr/dep times of the
    // same stop into one sequence (as `path`'s display-only `scheduled` does)
    // would put the arrival before its own stop's departure at every stop.
    //
    // status starts from Darwin's own actArr/actDep sweep as a fallback only —
    // it's overwritten per row below once r.lastCrs (NR's authoritative
    // position) is known, via findCurrentPathIndex. Kept here so a train with
    // no fresh NR row at all (rare; the outer query requires one) still gets a
    // sane status rather than every stop reading "upcoming".
    for (const [rid, ordered] of orderedByRid) {
      const firstUpcomingSeq = ordered.find((s: ForecastPoint) => !s.actArr && !s.actDep)?.seq;
      const path: PathStop[] = [];
      const stopsForTimes: typeof ordered = [];
      let darwinFrontIdx = 0;
      for (const s of ordered) {
        if (!s.crs) continue;
        const c = coords.get(s.crs);
        if (!c || c.lat == null || c.lon == null) continue;
        const departed = !!(s.actArr || s.actDep);
        const isCurrent = firstUpcomingSeq !== undefined && s.seq === firstUpcomingSeq;
        if (isCurrent) darwinFrontIdx = path.length;
        const status: PathStop["status"] = departed
          ? "departed"
          : isCurrent
            ? "current"
            : "upcoming";
        // Prefer the public arrival face; fall back to departure (origin has no arr).
        const sched = trimTime(s.schedArr ?? s.schedDep);
        const act = trimTime(s.actArr ?? s.actDep);
        const est = trimTime(s.estArr ?? s.estDep);
        path.push({
          crs: s.crs,
          name: titleCase(c.name),
          lat: c.lat,
          lon: c.lon,
          scheduled: sched,
          expected: act ?? est,
          actual: !!act,
          status,
        });
        stopsForTimes.push(s);
      }
      if (path.length > 1) {
        pathByRid.set(rid, path);
        legTimesByRid.set(rid, resolveLegTimes(stopsForTimes));
        darwinFrontIdxByRid.set(rid, darwinFrontIdx);
      }
    }

    // Swap dest CRS for a display name.
    for (const [rid, crs] of destByRid) {
      const c = coords.get(crs);
      if (c) destByRid.set(rid, titleCase(c.name));
    }
  }

  // Track geometry FULL polylines (every leg of a route, hundreds of points
  // each) only when a single service was asked for — attaching that to the
  // whole map's ~2,900 trains produced a 58MB response, which is why the bulk
  // view resolves only the current leg instead of every route leg.
  // But the map dot only ever needs ONE point per train (its current position
  // along its current leg), not the polyline — so for the bulk view we
  // instead resolve just that one leg's corridor per train below and collapse
  // it to a point server-side. No geometry array reaches the client either way.
  const geometryByRid = ridFilter
    ? await corridorsForPaths(db, pathByRid).catch(
        () => new Map<string, ([number, number][] | null)[]>(),
      )
    : new Map<string, ([number, number][] | null)[]>();

  // First pass: for every row, resolve which leg (fromCrs -> toCrs) it's
  // currently on, so the second pass knows exactly which corridors to fetch —
  // one row per row here, cheap (array indexing only), before touching the DB.
  interface RowPlacement {
    path?: PathStop[];
    atIdx: number;
    effectiveIdx: number;
    legTimes?: { departIso?: string; arriveIso?: string }[];
  }
  const placementByTrainId = new Map<string, RowPlacement>();
  const legPairsNeeded = new Set<string>();
  for (const r of rows) {
    const basePath = r.rid ? pathByRid.get(r.rid) : undefined;
    // Cloned per row (not just per rid): rid is expected 1:1 with trainId,
    // but path.status is about to be overwritten below, and mutating a
    // shared array would let one row's status corrupt another's if that
    // assumption is ever wrong.
    const path = basePath ? basePath.map((p) => ({ ...p })) : undefined;
    const darwinFrontIdx = r.rid ? (darwinFrontIdxByRid.get(r.rid) ?? -1) : -1;
    const atIdx = path && r.lastCrs ? findCurrentPathIndex(path, r.lastCrs, darwinFrontIdx) : -1;
    const effectiveIdx = atIdx >= 0 ? atIdx : darwinFrontIdx;
    placementByTrainId.set(r.trainId, {
      path,
      atIdx,
      effectiveIdx,
      legTimes: r.rid ? legTimesByRid.get(r.rid) : undefined,
    });
    if (!ridFilter && path && r.lastEvent === "DEPARTURE" && atIdx >= 0 && path[atIdx + 1]) {
      legPairsNeeded.add(`${path[atIdx]!.crs} ${path[atIdx + 1]!.crs}`);
    }
  }

  // One query for every distinct current leg across all trains — far fewer
  // rows than "every leg of every route" (corridorsForPaths), and busy legs
  // (e.g. into a major terminus) are shared by many trains at once, so this
  // is nowhere near one row per train.
  const currentLegGeometry = new Map<string, [number, number][]>();
  if (legPairsNeeded.size > 0) {
    const pairs = [...legPairsNeeded].map((k) => k.split(" ") as [string, string]);
    try {
      const legRows = await db
        .select({
          fromCrs: railCorridor.fromCrs,
          toCrs: railCorridor.toCrs,
          geometry: railCorridor.geometry,
        })
        .from(railCorridor)
        .where(
          inArray(
            sql`(${railCorridor.fromCrs}, ${railCorridor.toCrs})`,
            pairs.map((p) => sql`(${p[0]}, ${p[1]})`),
          ),
        );
      for (const lr of legRows) {
        const flat = lr.geometry;
        const coords: [number, number][] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) coords.push([flat[i]!, flat[i + 1]!]);
        if (coords.length >= 2) currentLegGeometry.set(`${lr.fromCrs} ${lr.toCrs}`, coords);
      }
    } catch {
      // Corridor lookup failing shouldn't take down the whole map — trains
      // just stay on their last reported snapped point.
    }
  }
  const now = Date.now();
  const trains: LiveTrain[] = rows
    .filter((r) => (r.lat !== null && r.lon !== null) || privateTimingPoint(r))
    .map((r) => {
      const privatePoint = privateTimingPoint(r);
      const from =
        r.lat !== null && r.lon !== null
          ? { lat: r.lat as number, lon: r.lon as number }
          : { lat: privatePoint!.lat, lon: privatePoint!.lon };
      const placement = placementByTrainId.get(r.trainId)!;
      const { path, atIdx, effectiveIdx, legTimes } = placement;

      // The calling-point highlight must agree with the map dot — both are
      // now driven by the same effectiveIdx, where before `path[i].status` was
      // fixed at build time from Darwin's sweep alone and never reconciled
      // with the NR-derived position used for the map marker.
      if (path && effectiveIdx >= 0) {
        for (let i = 0; i < path.length; i += 1) {
          path[i]!.status = i < effectiveIdx ? "departed" : i === effectiveIdx ? "current" : "upcoming";
        }
      }

      const next = path && effectiveIdx >= 0 ? path[effectiveIdx + 1] : undefined;
      // Time-based fraction along the current leg, replacing the old fixed
      // station-to-station nudge — see resolveLegTimes/timeFractionAlongLeg.
      let fraction = 0.5;
      let corridorPos: { lat: number; lon: number } | undefined;
      if (path && next && r.lastEvent === "DEPARTURE" && atIdx >= 0) {
        // Selected-train requests already have the full per-leg geometry
        // fetched above (geometryByRid); the bulk map view resolves just
        // this one leg via currentLegGeometry instead. If timing is missing,
        // still walk the known rail corridor with the conservative default
        // fraction rather than drawing a straight off-rail interpolation.
        const corridor = ridFilter
          ? (r.rid ? geometryByRid.get(r.rid)?.[atIdx] : undefined)
          : currentLegGeometry.get(`${path[atIdx]!.crs} ${path[atIdx + 1]!.crs}`);
        const timeFraction = timeFractionAlongLeg(
          legTimes?.[atIdx]?.departIso,
          legTimes?.[atIdx + 1]?.arriveIso,
          now,
        );
        if (timeFraction !== null) fraction = timeFraction;
        if (corridor) {
          const [lon, lat] = pointAlongCorridor(corridor, fraction);
          corridorPos = { lat, lon };
        }
      }
      const pos = corridorPos ?? from;
      return {
        id: r.trainId,
        headcode: r.headcode ?? undefined,
        operator: r.toc ? (tocName(r.toc) ?? r.toc) : undefined,
        lat: Number(pos.lat.toFixed(5)),
        lon: Number(pos.lon.toFixed(5)),
        atName: r.stationName ? titleCase(r.stationName) : privatePoint?.name,
        atCrs: r.lastCrs ?? undefined,
        event: r.lastEvent ?? undefined,
        towardName: next?.name,
        destName: r.rid ? destByRid.get(r.rid) : undefined,
        latenessMinutes:
          r.lateness !== null && r.lateness !== undefined ? Math.round(r.lateness / 60) : undefined,
        // Clamp to >= 0: TRUST timestamps can read slightly ahead of our clock
        // (clock skew / BST edge), which would otherwise show a negative "ago".
        reportedAgoSeconds: r.lastReportedAt
          ? Math.max(0, Math.round((now - r.lastReportedAt.getTime()) / 1000))
          : 0,
        rid: r.rid ?? undefined,
        path,
        pathGeometry: r.rid ? geometryByRid.get(r.rid) : undefined,
      };
    });

  const deduped = dedupeByPhysicalTrain(trains);
  return { generatedAt: new Date().toISOString(), count: deduped.length, trains: deduped };
}
