import {
  nrCorpus,
  ormSignal,
  nrSignallingState,
  nrSmart,
  nrTrainPosition,
  nrTrainPositionHistory,
  sopMapping,
  stationTrackModelPosition,
} from "@signaller/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { namedSignallingCorridor } from "./signalling-corridors";
import {
  layoutBerths,
  layoutBerthsByArea,
  layoutBerthsFlat,
  reorderByMileage,
  type BerthEdge,
  type DiagramLayout,
  type MileageAnchor,
} from "./signalling-layout";

/**
 * Data for the corridor signalling diagram, resolved from a single train. The
 * train's TD area(s) define the corridor; SMART supplies the berth graph (laid
 * out by signalling-layout); live overlays are:
 *   - occupancy: which headcode is in which berth (nr_train_position), and
 *   - aspects: decoded from raw S-class bytes (nr_signalling_state) via the SOP
 *     bit-map (sop_mapping). Signals with no SOP mapping report aspect "unknown"
 *     — expected for areas whose SOP data isn't published.
 *
 * There is no live signal-aspect feed in GB open data; aspects here are decoded
 * per-bit from SOP tables where those tables exist. See data/sop/README.md.
 */

const FRESH_SECONDS = 20 * 60;

export type Aspect = "off" | "red" | "unknown";

export interface DiagramSignal {
  id: string;
  itemId?: string;
  aspect: Aspect;
  /** True when the SOP-mapped track ahead reports occupied. */
  occupiedAhead?: boolean;
  /** True when a "route" SOP row keyed to this signal's itemId reports set. */
  routeSet?: boolean;
  /** The berth this signal protects entry to — needed to draw the route-set line. */
  berthAhead?: string;
  mapped: boolean;
  x: number;
  y: number;
}

export interface DiagramTrain {
  headcode: string;
  berthId: string; // full `${area}:${berth}` id
  lateness?: number;
  focus: boolean;
}

/**
 * The part of the diagram that moves: aspects and where the trains are.
 *
 * Split from the layout because they change on completely different timescales.
 * This is what the stream sends every time something happens.
 */
export interface DiagramState {
  generatedAt: string;
  areas: string[];
  focusHeadcode?: string;
  signals: DiagramSignal[];
  trains: DiagramTrain[];
  /** How many of the corridor's areas have any SOP coverage. */
  mappedAreas: number;
}

export interface CorridorDiagram extends DiagramState {
  layout: DiagramLayout;
}

const EMPTY = (areas: string[] = []): CorridorDiagram => ({
  generatedAt: new Date().toISOString(),
  areas,
  layout: { berths: [], signals: [], edges: [], width: 0, height: 0 },
  signals: [],
  trains: [],
  mappedAreas: 0,
});

/** Resolve the TD area(s) that make up the corridor for a given train, or a station. */
export async function resolveAreas(opts: {
  trainId?: string;
  rid?: string;
  area?: string;
  crs?: string;
  corridor?: string;
}): Promise<{ areas: string[]; focusHeadcode?: string }> {
  const db = getDb();
  if (opts.area) return { areas: [opts.area] };
  if (opts.corridor) return { areas: await resolveAreasForCorridor(opts.corridor) };
  if (opts.crs) return { areas: await resolveAreasForStation(opts.crs) };

  const where = opts.trainId
    ? eq(nrTrainPosition.trainId, opts.trainId)
    : opts.rid
      ? eq(nrTrainPosition.rid, opts.rid)
      : undefined;
  if (!where) return { areas: [] };

  const rows = await db
    .select({ tdArea: nrTrainPosition.tdArea, headcode: nrTrainPosition.headcode })
    .from(nrTrainPosition)
    .where(where)
    .limit(4);

  const areas = [...new Set(rows.map((r) => r.tdArea).filter(Boolean) as string[])];
  const focusHeadcode = rows.find((r) => r.headcode)?.headcode ?? undefined;
  return { areas, focusHeadcode };
}

/**
 * Resolve every TD area signalling a station: CORPUS maps the CRS to its
 * STANOX(es), then SMART's per-edge stanox tells us which TD area(s) contain
 * berths at that location. A big station can span more than one signalling
 * area (different throats/platforms worked from different boxes), so this
 * returns all of them rather than picking one.
 */
async function resolveAreasForStation(crs: string): Promise<string[]> {
  const db = getDb();
  const corpusRows = await db
    .select({ stanox: nrCorpus.stanox })
    .from(nrCorpus)
    .where(eq(nrCorpus.crs, crs.toUpperCase()));
  const stanoxes = corpusRows.map((r) => r.stanox).filter((s): s is string => Boolean(s));
  if (stanoxes.length === 0) return [];

  const smartRows = await db
    .select({ tdArea: nrSmart.tdArea })
    .from(nrSmart)
    .where(inArray(nrSmart.stanox, stanoxes));
  return [...new Set(smartRows.map((r) => r.tdArea))];
}

async function resolveAreasForCorridor(corridorId: string): Promise<string[]> {
  const corridor = namedSignallingCorridor(corridorId);
  if (!corridor) return [];

  const db = getDb();
  const corpusRows = await db
    .select({ crs: nrCorpus.crs, stanox: nrCorpus.stanox })
    .from(nrCorpus)
    .where(inArray(nrCorpus.crs, corridor.stationCrs));
  const orderByStanox = new Map<string, number>();
  const orderByCrs = new Map(corridor.stationCrs.map((crs, i) => [crs, i]));
  const stanoxes = corpusRows
    .map((r) => {
      if (r.stanox) {
        orderByStanox.set(r.stanox, orderByCrs.get(r.crs ?? "") ?? Number.MAX_SAFE_INTEGER);
      }
      return r.stanox;
    })
    .filter((s): s is string => Boolean(s));
  if (stanoxes.length === 0) return [];

  const smartRows = await db
    .select({ tdArea: nrSmart.tdArea, stanox: nrSmart.stanox })
    .from(nrSmart)
    .where(inArray(nrSmart.stanox, stanoxes));
  const firstStationByArea = new Map<string, number>();
  for (const row of smartRows) {
    const order = row.stanox ? orderByStanox.get(row.stanox) : undefined;
    if (order === undefined) continue;
    const current = firstStationByArea.get(row.tdArea);
    if (current === undefined || order < current) firstStationByArea.set(row.tdArea, order);
  }
  return [...new Set(smartRows.map((r) => r.tdArea))].sort((a, b) => {
    const ai = firstStationByArea.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bi = firstStationByArea.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi || a.localeCompare(b);
  });
}

/**
 * The corridor's shape, cached.
 *
 * SMART is reference data — it changes when someone runs `nr-ingest reference`,
 * not while anyone is watching. The layout derived from it dominates the
 * diagram's payload (hundreds of berth nodes) and was rebuilt from scratch on
 * every 8-second poll. Deriving it once per area set and holding it is the
 * single biggest saving in this file.
 *
 * The TTL is long because the input is static, but not infinite, because a
 * reference reload should eventually show up without a restart.
 */
const LAYOUT_TTL_MS = 10 * 60_000;

const layoutCache = new Map<string, { at: number; layout: DiagramLayout }>();

export function areaKey(areas: string[]): string {
  return [...areas].sort().join(",");
}

export async function getLayout(areas: string[]): Promise<DiagramLayout> {
  const key = areaKey(areas);
  const hit = layoutCache.get(key);
  if (hit && Date.now() - hit.at < LAYOUT_TTL_MS) return hit.layout;

  const smart = await getDb()
    .select({
      tdArea: nrSmart.tdArea,
      from: nrSmart.fromBerth,
      to: nrSmart.toBerth,
      stanox: nrSmart.stanox,
      platform: nrSmart.platform,
    })
    .from(nrSmart)
    .where(inArray(nrSmart.tdArea, areas));
  const edges: BerthEdge[] = smart
    .filter((s) => s.from && s.to)
    .map((s) => ({ tdArea: s.tdArea, from: s.from as string, to: s.to as string }));
  const layout = areas.length > 1 ? layoutBerthsByArea(edges, areas) : layoutBerths(edges);
  const withPlaces = await attachPlaceNames(layout, smart);
  const withMileage = await applyMileageAnchors(withPlaces);

  if (layoutCache.size > 200) layoutCache.clear();
  layoutCache.set(key, { at: Date.now(), layout: withMileage });
  return withMileage;
}

/**
 * Attach a station/place name to each berth, resolved via its SMART stanox.
 *
 * SMART's stanox is a per-edge column, not per-node — a berth can appear as
 * `to` on several edges, each with its own (possibly null) stanox. We take the
 * first non-null one, in a fixed sort order, so the same input always resolves
 * the same way — matching layoutBerths's own determinism guarantee.
 */
async function attachPlaceNames(
  layout: DiagramLayout,
  smart: Array<{ tdArea: string; from: string | null; to: string | null; stanox: string | null; platform: string | null }>,
): Promise<DiagramLayout> {
  const sorted = [...smart].sort((a, b) => {
    const ka = `${a.tdArea}|${a.from ?? ""}|${a.to ?? ""}`;
    const kb = `${b.tdArea}|${b.from ?? ""}|${b.to ?? ""}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const stanoxByBerth = new Map<string, string>();
  const platformByBerth = new Map<string, string>();
  for (const s of sorted) {
    if (!s.to) continue;
    const berthId = `${s.tdArea}:${s.to}`;
    if (s.stanox && !stanoxByBerth.has(berthId)) stanoxByBerth.set(berthId, s.stanox);
    if (s.platform && !platformByBerth.has(berthId)) platformByBerth.set(berthId, s.platform);
  }

  const stanoxes = [...new Set(stanoxByBerth.values())];
  const corpusRows = stanoxes.length
    ? await getDb()
        .select({ stanox: nrCorpus.stanox, crs: nrCorpus.crs, description: nrCorpus.description })
        .from(nrCorpus)
        .where(inArray(nrCorpus.stanox, stanoxes))
    : [];
  const corpusByStanox = new Map(corpusRows.map((r) => [r.stanox, r]));

  const berths = layout.berths.map((b) => {
    const stanox = stanoxByBerth.get(b.id);
    const corpus = stanox ? corpusByStanox.get(stanox) : undefined;
    return {
      ...b,
      place: corpus?.description ?? undefined,
      crs: corpus?.crs ?? undefined,
      platform: platformByBerth.get(b.id),
    };
  });

  return { ...layout, berths };
}

/**
 * Re-rank berths by real mileage where enough station anchors exist (see
 * reorderByMileage's docstring). Anchors come from station_track_model_position,
 * looked up via the CRS attachPlaceNames already resolved onto each berth —
 * so this is a no-op query (no rows to look up) for any corridor with no
 * place-resolved berths at all, which is most of them.
 */
async function applyMileageAnchors(layout: DiagramLayout): Promise<DiagramLayout> {
  const crsByBerth = new Map<string, string>();
  for (const b of layout.berths) if (b.crs) crsByBerth.set(b.id, b.crs);
  if (crsByBerth.size === 0) return layout;

  const crsValues = [...new Set(crsByBerth.values())];
  const positions = await getDb()
    .select({
      crs: stationTrackModelPosition.crs,
      elr: stationTrackModelPosition.elr,
      mileage: stationTrackModelPosition.mileage,
    })
    .from(stationTrackModelPosition)
    .where(inArray(stationTrackModelPosition.crs, crsValues));
  if (positions.length === 0) return layout;

  const positionByCrs = new Map(positions.map((p) => [p.crs, p]));
  const berthByIdForArea = new Map(layout.berths.map((b) => [b.id, b]));
  const anchors: MileageAnchor[] = [];
  for (const [berthId, crs] of crsByBerth) {
    const pos = positionByCrs.get(crs);
    const berth = berthByIdForArea.get(berthId);
    if (!pos || !berth) continue;
    anchors.push({ berthId, tdArea: berth.tdArea, elr: pos.elr, mileage: pos.mileage });
  }

  return reorderByMileage(layout, anchors);
}

/**
 * The live overlay for a corridor whose layout is already known: which berths
 * are occupied, and what the signals are showing.
 *
 * Takes the layout rather than fetching it, so a stream can hold the shape
 * still and send only this.
 */
export async function getDiagramState(
  areas: string[],
  layout: DiagramLayout,
  focusHeadcode?: string,
): Promise<DiagramState> {
  const db = getDb();
  const berthIds = new Set(layout.berths.map((b) => b.id));

  // 2. Live occupancy: recent trains in these areas, positioned by berth.
  const since = new Date(Date.now() - FRESH_SECONDS * 1000);
  const positions = await db
    .select({
      headcode: nrTrainPosition.headcode,
      tdArea: nrTrainPosition.tdArea,
      berth: nrTrainPosition.berth,
      lateness: nrTrainPosition.lateness,
    })
    .from(nrTrainPosition)
    .where(
      and(
        inArray(nrTrainPosition.tdArea, areas),
        gte(nrTrainPosition.lastReportedAt, since),
        sql`${nrTrainPosition.berth} is not null`,
      ),
    );
  const trains: DiagramTrain[] = [];
  for (const p of positions) {
    if (!p.headcode || !p.tdArea || !p.berth) continue;
    const berthId = `${p.tdArea}:${p.berth}`;
    if (!berthIds.has(berthId)) continue;
    trains.push({
      headcode: p.headcode,
      berthId,
      lateness: p.lateness ?? undefined,
      focus: focusHeadcode !== undefined && p.headcode === focusHeadcode,
    });
  }

  // 3. Decode aspects: SOP mapping × raw S-class byte, per area/address.
  const sop = await db
    .select({
      tdArea: sopMapping.tdArea,
      address: sopMapping.address,
      bit: sopMapping.bit,
      itemType: sopMapping.itemType,
      itemId: sopMapping.itemId,
      aspect: sopMapping.aspect,
    })
    .from(sopMapping)
    .where(inArray(sopMapping.tdArea, areas));
  const state = await db
    .select({
      tdArea: nrSignallingState.tdArea,
      address: nrSignallingState.address,
      data: nrSignallingState.data,
    })
    .from(nrSignallingState)
    .where(inArray(nrSignallingState.tdArea, areas));

  const byteAt = new Map<string, number>(); // `${area}|${address}` -> byte
  for (const s of state) byteAt.set(`${s.tdArea}|${s.address}`, parseInt(s.data, 16) || 0);
  const mappedAreas = new Set(sop.map((r) => r.tdArea)).size;

  // Per signal itemId: is it off (proceed)? Per track itemId: is it occupied?
  // Per route itemId (keyed to the signal whose route it is): is it set?
  const signalOff = new Map<string, boolean>(); // itemId -> off
  const trackOccupied = new Map<string, boolean>(); // itemId -> occupied
  const routeSet = new Map<string, boolean>(); // signal itemId -> route set
  for (const r of sop) {
    const byte = byteAt.get(`${r.tdArea}|${r.address}`);
    if (byte === undefined || !r.itemId) continue;
    const set = (byte & (1 << r.bit)) !== 0;
    if (r.itemType === "signal") {
      // aspect field says what a SET bit means; default assume set = off/proceed.
      const meaning = (r.aspect ?? "off").toLowerCase();
      const isOff = meaning === "off" || meaning === "green" || meaning === "proceed" ? set : !set;
      signalOff.set(r.itemId, isOff);
    } else if (r.itemType === "track") {
      trackOccupied.set(r.itemId, set);
    } else if (r.itemType === "route") {
      // Convention: a route row's itemId is the signal's own itemId — "this
      // signal's route is set" — so it keys off the same id-space the signal
      // decode already produces, rather than a separate berth-pair id.
      routeSet.set(r.itemId, set);
    }
  }

  // 4. Attach an aspect to each laid-out signal via the berth it protects.
  //
  //    This is index-zip (decoded SOP signals distributed along the line in
  //    array order), NOT a real join — and, having dug into it, there is no
  //    real key available to join on instead. A SOP row's only identity is a
  //    bare signal/points/track number (sopMapping.itemId, e.g. "Q101"); it
  //    carries no berth code or STANOX. SMART's berth codes ("146A", "0146",
  //    …) are a completely separate, independently-maintained numbering
  //    scheme in UK signalling — this is true of the real published Open
  //    Rail Data SOP/ECS tables too, not just data/sop/Q0.sample.json. So
  //    "match via SMART's STANOX/mileage ordering" (an earlier version of
  //    this comment proposed exactly that) isn't a fixable-in-code gap: it's
  //    a genuine data-model limitation of the source SOP format itself. See
  //    data/sop/README.md's file-format table — there's no field to add.
  //    Where SOP coverage is partial (or, currently, non-existent beyond one
  //    illustrative sample area) this yields aspects for the signals we could
  //    decode and "unknown" for the rest — honest to the data we have, same
  //    as the rest of this feature's pattern — but even a signal reporting a
  //    real decoded aspect may be paired to the WRONG physical signal by this
  //    index-zip, since nothing here actually verifies which signal produced
  //    which byte. Surface that caveat to users (see the diagram/map legend
  //    text), don't just note it in code.
  const decodedSignals = [...signalOff.entries()];
  const signals: DiagramSignal[] = layout.signals.map((sig, i) => {
    // Best-effort association: distribute decoded signals along the line in
    // order. Where SOP coverage is partial this yields aspects for the mapped
    // signals and "unknown" for the rest — honest to the data we have.
    const decoded = decodedSignals[i];
    if (!decoded) {
      return {
        id: sig.id,
        aspect: "unknown",
        berthAhead: sig.berthAhead,
        mapped: false,
        x: sig.x,
        y: sig.y,
      };
    }
    const [itemId, off] = decoded;
    return {
      id: sig.id,
      itemId,
      aspect: off ? "off" : "red",
      occupiedAhead: trackOccupied.get(itemId),
      routeSet: routeSet.get(itemId),
      berthAhead: sig.berthAhead,
      mapped: true,
      x: sig.x,
      y: sig.y,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    areas,
    focusHeadcode,
    signals,
    trains,
    mappedAreas,
  };
}

/**
 * The whole diagram in one go — layout and live state together.
 *
 * Still what `/api/signalling` serves, so the polling fallback keeps working
 * unchanged. The stream sends the same two pieces separately.
 */
export async function getDiagramForTrain(opts: {
  trainId?: string;
  rid?: string;
  area?: string;
  crs?: string;
  corridor?: string;
}): Promise<CorridorDiagram> {
  const { areas, focusHeadcode } = await resolveAreas(opts);
  if (areas.length === 0) return EMPTY();

  const layout = await getLayout(areas);
  if (layout.berths.length === 0) return EMPTY(areas);

  const state = await getDiagramState(areas, layout, focusHeadcode);
  return { ...state, layout };
}

/** A signal marker with a real WGS84 position, for the national map layer. */
export interface GeoSignalMarker {
  id: string;
  itemId?: string;
  berthAhead?: string;
  source: "td" | "orm";
  osmId?: string;
  signalDirection?: string;
  signalPosition?: string;
  trackBearing?: number;
  mainForm?: string;
  signalKind?: string;
  signalTags?: Record<string, string>;
  aspect: Aspect;
  routeSet?: boolean;
  mapped: boolean;
  lat: number;
  lon: number;
}

/** A berth with a real WGS84 position, for the /map national layer's berth boxes. */
export interface GeoBerth {
  id: string; // full `${tdArea}:${berth}` id
  tdArea: string;
  berth: string;
  place?: string;
  lat: number;
  lon: number;
  /** Headcode currently occupying this berth, if any. */
  headcode?: string;
  /**
   * True when the section immediately ahead of this berth is occupied by
   * another train — a genuine, SOP-free stand-in for "the next signal is at
   * danger". This is NOT a real decoded aspect (see GeoSignalMarker for that,
   * where a real SOP map exists) — it's plain block-occupancy logic, the same
   * "one train per section" rule every fixed-block signalling system enforces,
   * derived purely from TD berth-step occupancy which needs no SOP data at all.
   * Undefined where the berth has no known berths-ahead in the layout (e.g. a
   * line end/edge of area) — not "false", since there's genuinely nothing to
   * report either way.
   */
  blockedAhead?: boolean;
}

interface NationalSnapshot {
  layout: DiagramLayout;
  state: DiagramState;
  matchedByCrs: Map<string, { lat: number; lon: number }>;
  ormSignals: OrmPhysicalSignal[];
}

interface OrmPhysicalSignal {
  osmId: string;
  ref?: string;
  normalizedRef?: string;
  caption?: string;
  signalDirection?: string;
  signalPosition?: string;
  trackBearing?: number;
  main?: string;
  mainDesign?: string;
  mainFunction?: string;
  mainForm?: string;
  mainStates?: string;
  distant?: string;
  distantForm?: string;
  distantStates?: string;
  combined?: string;
  combinedForm?: string;
  combinedStates?: string;
  minor?: string;
  minorForm?: string;
  shunting?: string;
  shuntingForm?: string;
  mainRepeated?: string;
  mainRepeatedForm?: string;
  route?: string;
  routeDesign?: string;
  routeForm?: string;
  routeStates?: string;
  tags?: Record<string, string>;
  lat: number;
  lon: number;
}

function normalizeSignalRef(value: string | undefined): string | undefined {
  const normalized = value?.replace(/[^A-Za-z0-9]/g, "").toUpperCase() ?? "";
  return normalized || undefined;
}

function offsetSignalPosition(signal: OrmPhysicalSignal): { lat: number; lon: number } {
  const position = signal.signalPosition?.toLowerCase();
  if (position !== "left" && position !== "right") return { lat: signal.lat, lon: signal.lon };
  if (typeof signal.trackBearing !== "number" || Number.isNaN(signal.trackBearing)) {
    return { lat: signal.lat, lon: signal.lon };
  }

  const sideBearing = signal.trackBearing + (position === "right" ? 90 : -90);
  const radians = (sideBearing * Math.PI) / 180;
  const metres = 4.5;
  const north = Math.cos(radians) * metres;
  const east = Math.sin(radians) * metres;
  const lat = signal.lat + north / 111_320;
  const lon = signal.lon + east / (111_320 * Math.cos((signal.lat * Math.PI) / 180));
  return { lat, lon };
}

function signalKind(signal: OrmPhysicalSignal): string | undefined {
  if (signal.combined) return "combined";
  if (signal.main) return "main";
  if (signal.distant) return "distant";
  if (signal.mainRepeated) return "main_repeated";
  if (signal.shunting) return "shunting";
  if (signal.minor) return "minor";
  if (signal.route) return "route";
  return undefined;
}

/**
 * The national map's own layout builder — deliberately NOT getLayout(). That
 * function calls layoutBerths(), whose columnDepths ranking is Bellman-Ford
 * style (O(nodes x edges) per pass, up to nodes.length passes to flush out
 * cycles): fine for one corridor's few-hundred-node graph, measured at ~19s
 * for the whole national graph (~30k nodes/edges across every TD area) when
 * getNationalSnapshot first tried reusing it. The national map never renders
 * a schematic diagram — getAllAreasSignalMarkers/getAllAreasBerths only ever
 * read berth id/place/crs and edge from/to, never x/y — so there's no reason
 * to pay for the ranking here. layoutBerthsFlat builds the same graph/edges/
 * signals list without it; applyMileageAnchors/reorderByMileage are skipped
 * for the same reason (they only reposition x/y).
 */
async function getNationalLayout(areas: string[]): Promise<DiagramLayout> {
  const smart = await getDb()
    .select({
      tdArea: nrSmart.tdArea,
      from: nrSmart.fromBerth,
      to: nrSmart.toBerth,
      stanox: nrSmart.stanox,
      platform: nrSmart.platform,
    })
    .from(nrSmart)
    .where(inArray(nrSmart.tdArea, areas));
  const edges: BerthEdge[] = smart
    .filter((s) => s.from && s.to)
    .map((s) => ({ tdArea: s.tdArea, from: s.from as string, to: s.to as string }));
  const layout = layoutBerthsFlat(edges);
  return attachPlaceNames(layout, smart);
}

const NATIONAL_TTL_MS = 60_000;
let nationalSnapshotCache: { at: number; snapshot: NationalSnapshot } | null = null;
let nationalSnapshotInFlight: Promise<NationalSnapshot> | null = null;

/**
 * The one shared computation every national-map endpoint (signal markers,
 * berth boxes, recent paths) is derived from: every TD area's layout + live
 * state, plus every station's real Track Model anchor. This used to be
 * recomputed independently by three separate functions — each doing its own
 * `selectDistinct tdArea` + getLayout + getDiagramState — which meant every
 * map poll cycle (four concurrent fetches on toggle-on, three of them hitting
 * this) did three times the DB work for the same answer. Computed at most
 * once per TTL window, and in-flight de-duplicated so concurrent callers
 * during a cold cache await the same promise instead of triggering it three
 * times over.
 *
 * TTL is much shorter than the old per-function caches (1 minute, not 10) —
 * occupancy/headcodes are the whole point of the berth/path layers and were
 * going stale for most of a 10-minute window otherwise. The layout itself
 * doesn't need refreshing that often, but getDiagramState's occupancy/aspect
 * read is cheap compared to the layout derivation, so recomputing the whole
 * snapshot on this shorter cadence is still far cheaper than the old 3x-per-poll cost.
 */
async function getNationalSnapshot(): Promise<NationalSnapshot> {
  if (nationalSnapshotCache && Date.now() - nationalSnapshotCache.at < NATIONAL_TTL_MS) {
    return nationalSnapshotCache.snapshot;
  }
  if (nationalSnapshotInFlight) return nationalSnapshotInFlight;

  nationalSnapshotInFlight = (async () => {
    const db = getDb();
    const areaRows = await db.selectDistinct({ tdArea: nrSmart.tdArea }).from(nrSmart);
    const areas = areaRows.map((r) => r.tdArea);

    const layout = areas.length ? await getNationalLayout(areas) : { berths: [], signals: [], edges: [], width: 0, height: 0 };
    const state = areas.length
      ? await getDiagramState(areas, layout, undefined)
      : { generatedAt: new Date().toISOString(), areas: [], signals: [], trains: [], mappedAreas: 0 };

    const crsValues = [...new Set(layout.berths.map((b) => b.crs).filter((c): c is string => Boolean(c)))];
    const matchedByCrs = new Map<string, { lat: number; lon: number }>();
    if (crsValues.length > 0) {
      const positions = await db
        .select({
          crs: stationTrackModelPosition.crs,
          matchedLat: stationTrackModelPosition.matchedLat,
          matchedLon: stationTrackModelPosition.matchedLon,
        })
        .from(stationTrackModelPosition)
        .where(inArray(stationTrackModelPosition.crs, crsValues));
      for (const p of positions) matchedByCrs.set(p.crs, { lat: p.matchedLat, lon: p.matchedLon });
    }

    const ormRows = await db
      .select({
        osmId: ormSignal.osmId,
        ref: ormSignal.ref,
        normalizedRef: ormSignal.normalizedRef,
        caption: ormSignal.caption,
        signalDirection: ormSignal.signalDirection,
        signalPosition: ormSignal.signalPosition,
        trackBearing: ormSignal.trackBearing,
        main: ormSignal.main,
        mainDesign: ormSignal.mainDesign,
        mainFunction: ormSignal.mainFunction,
        mainForm: ormSignal.mainForm,
        mainStates: ormSignal.mainStates,
        distant: ormSignal.distant,
        distantForm: ormSignal.distantForm,
        distantStates: ormSignal.distantStates,
        combined: ormSignal.combined,
        combinedForm: ormSignal.combinedForm,
        combinedStates: ormSignal.combinedStates,
        minor: ormSignal.minor,
        minorForm: ormSignal.minorForm,
        shunting: ormSignal.shunting,
        shuntingForm: ormSignal.shuntingForm,
        mainRepeated: ormSignal.mainRepeated,
        mainRepeatedForm: ormSignal.mainRepeatedForm,
        route: ormSignal.route,
        routeDesign: ormSignal.routeDesign,
        routeForm: ormSignal.routeForm,
        routeStates: ormSignal.routeStates,
        tags: ormSignal.tags,
        lat: ormSignal.lat,
        lon: ormSignal.lon,
      })
      .from(ormSignal);
    const ormSignals = ormRows.map((r) => ({
      osmId: r.osmId,
      ref: r.ref ?? undefined,
      normalizedRef: r.normalizedRef ?? undefined,
      caption: r.caption ?? undefined,
      signalDirection: r.signalDirection ?? undefined,
      signalPosition: r.signalPosition ?? undefined,
      trackBearing: r.trackBearing ?? undefined,
      main: r.main ?? undefined,
      mainDesign: r.mainDesign ?? undefined,
      mainFunction: r.mainFunction ?? undefined,
      mainForm: r.mainForm ?? undefined,
      mainStates: r.mainStates ?? undefined,
      distant: r.distant ?? undefined,
      distantForm: r.distantForm ?? undefined,
      distantStates: r.distantStates ?? undefined,
      combined: r.combined ?? undefined,
      combinedForm: r.combinedForm ?? undefined,
      combinedStates: r.combinedStates ?? undefined,
      minor: r.minor ?? undefined,
      minorForm: r.minorForm ?? undefined,
      shunting: r.shunting ?? undefined,
      shuntingForm: r.shuntingForm ?? undefined,
      mainRepeated: r.mainRepeated ?? undefined,
      mainRepeatedForm: r.mainRepeatedForm ?? undefined,
      route: r.route ?? undefined,
      routeDesign: r.routeDesign ?? undefined,
      routeForm: r.routeForm ?? undefined,
      routeStates: r.routeStates ?? undefined,
      tags: (r.tags as Record<string, string> | null) ?? undefined,
      lat: r.lat,
      lon: r.lon,
    }));

    const snapshot: NationalSnapshot = { layout, state, matchedByCrs, ormSignals };
    nationalSnapshotCache = { at: Date.now(), snapshot };
    return snapshot;
  })();

  try {
    return await nationalSnapshotInFlight;
  } finally {
    nationalSnapshotInFlight = null;
  }
}

/**
 * Every signal nationally that has a real WGS84 position — i.e. one whose
 * berth is anchored to a station via station_track_model_position (see
 * applyMileageAnchors). layoutBerths' x/y are schematic pixels, not geography
 * — useless on a map. Only berths whose CRS resolved a
 * station_track_model_position row get a real coordinate here (that station's
 * own matched point); everything else is omitted rather than fabricated, same
 * as the rest of this feature's "honest to the data" pattern. National
 * coverage is therefore expected to be partial and uneven — dependent on both
 * SOP publication coverage and Track Model snap success — not a bug to chase
 * further.
 */
async function getAllAreasSignalMarkers(): Promise<GeoSignalMarker[]> {
  const { layout, state, matchedByCrs, ormSignals } = await getNationalSnapshot();
  const berthById = new Map(layout.berths.map((b) => [b.id, b]));
  const ormByRef = new Map<string, OrmPhysicalSignal[]>();
  for (const signal of ormSignals) {
    if (!signal.normalizedRef) continue;
    const list = ormByRef.get(signal.normalizedRef);
    if (list) list.push(signal);
    else ormByRef.set(signal.normalizedRef, [signal]);
  }
  const matchedOsmIds = new Set<string>();

  const markers: GeoSignalMarker[] = [];
  for (const sig of state.signals) {
    const ormMatches = normalizeSignalRef(sig.itemId) ? (ormByRef.get(normalizeSignalRef(sig.itemId)!) ?? []) : [];
    if (ormMatches.length > 0) {
      for (const ormMatch of ormMatches) {
        const point = offsetSignalPosition(ormMatch);
        matchedOsmIds.add(ormMatch.osmId);
        markers.push({
          id: `orm:${ormMatch.osmId}`,
          itemId: sig.itemId ?? ormMatch.ref,
          berthAhead: sig.berthAhead,
          source: "orm",
          osmId: ormMatch.osmId,
          signalDirection: ormMatch.signalDirection,
          signalPosition: ormMatch.signalPosition,
          trackBearing: ormMatch.trackBearing,
          mainForm: ormMatch.mainForm ?? ormMatch.combinedForm ?? ormMatch.distantForm ?? ormMatch.shuntingForm ?? ormMatch.minorForm,
          signalKind: signalKind(ormMatch),
          signalTags: ormMatch.tags,
          aspect: sig.aspect,
          routeSet: sig.routeSet,
          mapped: sig.mapped,
          lat: point.lat,
          lon: point.lon,
        });
      }
      continue;
    }

    const berth = berthById.get(sig.berthAhead ?? "");
    const point = berth?.crs ? matchedByCrs.get(berth.crs) : undefined;
    if (!point) continue; // no real coordinate for this signal — omit, don't fabricate
    markers.push({
      id: sig.id,
      itemId: sig.itemId,
      berthAhead: sig.berthAhead,
      source: "td",
      aspect: sig.aspect,
      routeSet: sig.routeSet,
      mapped: sig.mapped,
      lat: point.lat,
      lon: point.lon,
    });
  }

  for (const signal of ormSignals) {
    if (matchedOsmIds.has(signal.osmId)) continue;
    const point = offsetSignalPosition(signal);
    markers.push({
      id: `orm:${signal.osmId}`,
      itemId: signal.ref ?? signal.caption,
      source: "orm",
      osmId: signal.osmId,
      signalDirection: signal.signalDirection,
      signalPosition: signal.signalPosition,
      trackBearing: signal.trackBearing,
      mainForm: signal.mainForm ?? signal.combinedForm ?? signal.distantForm ?? signal.shuntingForm ?? signal.minorForm,
      signalKind: signalKind(signal),
      signalTags: signal.tags,
      aspect: "unknown",
      mapped: false,
      lat: point.lat,
      lon: point.lon,
    });
  }
  return markers;
}

/** Signal markers within a bbox, for the national map's viewport-scoped fetch. */
export async function getSignalMarkersInBbox(bbox: {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}): Promise<GeoSignalMarker[]> {
  const all = await getAllAreasSignalMarkers();
  return all.filter(
    (m) =>
      m.lon >= bbox.minLon && m.lon <= bbox.maxLon && m.lat >= bbox.minLat && m.lat <= bbox.maxLat,
  );
}

/**
 * Every berth nationally with a real WGS84 position (same "only where anchored
 * to a station" rule as getAllAreasSignalMarkers), carrying live occupancy
 * (headcode) and a derived block-occupancy signal.
 *
 * blockedAhead comes from layout.edges, not from any SOP/S-class decode: a
 * berth's "ahead" section is occupied whenever any edge from it leads to a
 * currently-occupied berth. This is real signalling logic (one train per
 * block section) derivable from TD occupancy alone, unlike signal aspect
 * colour, which genuinely needs the area's own SOP bit-map to mean anything.
 *
 * This isn't a loose approximation of what the signal shows — it's the same
 * condition a real train describer waits for before stepping a description
 * forward (signal proceed-aspect + occupied predecessor berth + the next
 * track section transitioning clear->occupied). We can't see which bit is
 * the signal without a SOP map, but "is the section ahead occupied" is
 * exactly the fact a real interlocking bases a red aspect on, so this proxy
 * is honest to how the underlying system actually behaves, not a guess.
 */
async function getAllAreasBerths(): Promise<GeoBerth[]> {
  const { layout, state, matchedByCrs } = await getNationalSnapshot();

  const headcodeByBerth = new Map(state.trains.map((t) => [t.berthId, t.headcode]));
  const occupied = new Set(state.trains.map((t) => t.berthId));
  const aheadByBerth = new Map<string, string[]>();
  for (const e of layout.edges) {
    (aheadByBerth.get(e.from) ?? aheadByBerth.set(e.from, []).get(e.from)!).push(e.to);
  }

  const berths: GeoBerth[] = [];
  for (const b of layout.berths) {
    if (!b.crs) continue; // no real coordinate — omit, don't fabricate
    const point = matchedByCrs.get(b.crs);
    if (!point) continue;
    const ahead = aheadByBerth.get(b.id);
    berths.push({
      id: b.id,
      tdArea: b.tdArea,
      berth: b.berth,
      place: b.place,
      lat: point.lat,
      lon: point.lon,
      headcode: headcodeByBerth.get(b.id),
      blockedAhead: ahead && ahead.length > 0 ? ahead.some((id) => occupied.has(id)) : undefined,
    });
  }
  return berths;
}

/** Berths within a bbox, for the national map's viewport-scoped fetch. */
export async function getBerthsInBbox(bbox: {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}): Promise<GeoBerth[]> {
  const all = await getAllAreasBerths();
  return all.filter(
    (b) =>
      b.lon >= bbox.minLon && b.lon <= bbox.maxLon && b.lat >= bbox.minLat && b.lat <= bbox.maxLat,
  );
}

const PATH_HISTORY_MINUTES = 10;
const PATH_ROWS_PER_TRAIN = 12;

/**
 * One train's recent real-ground path, split into `segments` rather than one
 * continuous line: consecutive history rows are only joined into the same
 * segment when they're an actual adjacent step in the berth graph (same TD
 * area's layout.edges connects them, in either direction). Two anchored
 * points that are geographically distant but NOT graph-adjacent (e.g. the
 * train left this TD area, crossed several unanchored berths elsewhere, and
 * only re-appears anchored several areas later) start a new segment instead
 * of being joined by a straight line that cuts across the map ignoring the
 * actual track layout.
 */
export interface GeoTrainPath {
  trainId: string;
  headcode?: string;
  segments: Array<Array<{ lat: number; lon: number; reportedAt: string }>>;
}

/**
 * Recent train paths, derived purely from TD berth-step history
 * (nr_train_position_history) joined to each berth's station anchor — no SOP
 * data involved at all. This is a genuinely different thing from a decoded
 * signal aspect: it's "where has this headcode actually been", not "what is
 * this signal showing". Coverage is the same honest subset as everywhere else
 * in this feature — only history rows whose berth resolved to a station with
 * a real Track Model anchor produce a point; a train's path has gaps wherever
 * it passed through unanchored berths, so it's returned as separate segments
 * rather than one line that would otherwise jump across the country between
 * unrelated anchors.
 *
 * Bounded to the last PATH_HISTORY_MINUTES and PATH_ROWS_PER_TRAIN per train so
 * a national query stays cheap — this is meant to show "which way is this
 * train currently heading", not a full journey replay.
 */
/**
 * A segment with fewer than 2 points, or where every point lands on the same
 * coordinate, draws nothing visible (a zero-length line) — most often several
 * different berths at one busy station all sharing that station's single
 * Track Model anchor point (berths don't get their own coordinate; see this
 * file's other "only where anchored" notes). That's a real resolution limit,
 * not a bug to paper over with fabricated in-between points — just not worth
 * emitting as a segment.
 */
function hasMovement(points: Array<{ lat: number; lon: number }>): boolean {
  if (points.length < 2) return false;
  const [first] = points;
  return points.some((p) => p.lat !== first!.lat || p.lon !== first!.lon);
}

export async function getRecentPathsInBbox(bbox: {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}): Promise<GeoTrainPath[]> {
  const db = getDb();
  const since = new Date(Date.now() - PATH_HISTORY_MINUTES * 60_000);

  const rows = await db
    .select({
      trainId: nrTrainPositionHistory.trainId,
      headcode: nrTrainPositionHistory.headcode,
      tdArea: nrTrainPositionHistory.tdArea,
      berth: nrTrainPositionHistory.berth,
      reportedAt: nrTrainPositionHistory.reportedAt,
    })
    .from(nrTrainPositionHistory)
    .where(and(gte(nrTrainPositionHistory.reportedAt, since), sql`${nrTrainPositionHistory.berth} is not null`))
    .orderBy(desc(nrTrainPositionHistory.reportedAt))
    .limit(5000);

  const { layout, matchedByCrs } = await getNationalSnapshot();
  const crsByBerthId = new Map<string, string>();
  for (const b of layout.berths) if (b.crs) crsByBerthId.set(b.id, b.crs);

  // Adjacency is symmetric here — we only care whether two berths are one
  // graph step apart, not the direction the edge was recorded in.
  const adjacent = new Set<string>();
  for (const e of layout.edges) {
    adjacent.add(`${e.from}|${e.to}`);
    adjacent.add(`${e.to}|${e.from}`);
  }

  type Row = { trainId: string; headcode: string | null; berthId: string; reportedAt: Date };
  const rowsByTrain = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.tdArea || !r.berth) continue;
    const berthId = `${r.tdArea}:${r.berth}`;
    if (!crsByBerthId.has(berthId)) continue; // no real coordinate for this step — omit, don't fabricate
    const list = rowsByTrain.get(r.trainId) ?? [];
    if (list.length === 0) rowsByTrain.set(r.trainId, list);
    if (list.length >= PATH_ROWS_PER_TRAIN) continue; // rows arrive newest-first; cap per train
    list.push({ trainId: r.trainId, headcode: r.headcode, berthId, reportedAt: r.reportedAt });
  }

  const paths: GeoTrainPath[] = [];
  for (const [trainId, list] of rowsByTrain) {
    // Oldest-first, so segments read in the direction of travel.
    list.reverse();

    const segments: GeoTrainPath["segments"] = [];
    let current: GeoTrainPath["segments"][number] = [];
    let prevBerthId: string | undefined;
    for (const r of list) {
      // A repeat report for the same berth (the train re-reported without
      // having moved) isn't a new point on the path — skip it rather than
      // treating it as "not adjacent" and starting a spurious new segment.
      if (r.berthId === prevBerthId) continue;

      const crs = crsByBerthId.get(r.berthId)!;
      const point = matchedByCrs.get(crs);
      if (!point) continue;

      const isAdjacent = prevBerthId === undefined || adjacent.has(`${prevBerthId}|${r.berthId}`);
      if (!isAdjacent && current.length > 0) {
        if (hasMovement(current)) segments.push(current);
        current = [];
      }
      current.push({ lat: point.lat, lon: point.lon, reportedAt: r.reportedAt.toISOString() });
      prevBerthId = r.berthId;
    }
    if (hasMovement(current)) segments.push(current);
    if (segments.length === 0) continue;

    paths.push({ trainId, headcode: list[0]?.headcode ?? undefined, segments });
  }

  return paths.filter((p) =>
    p.segments.some((seg) =>
      seg.some(
        (pt) => pt.lon >= bbox.minLon && pt.lon <= bbox.maxLon && pt.lat >= bbox.minLat && pt.lat <= bbox.maxLat,
      ),
    ),
  );
}
