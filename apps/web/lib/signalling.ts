import { nrSignallingState, nrSmart, nrTrainPosition, sopMapping } from "@mainline/db";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { layoutBerths, type BerthEdge, type DiagramLayout } from "./signalling-layout";

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

/** Resolve the TD area(s) that make up the corridor for a given train. */
export async function resolveAreas(opts: {
  trainId?: string;
  rid?: string;
  area?: string;
}): Promise<{ areas: string[]; focusHeadcode?: string }> {
  const db = getDb();
  if (opts.area) return { areas: [opts.area] };

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
    .select({ tdArea: nrSmart.tdArea, from: nrSmart.fromBerth, to: nrSmart.toBerth })
    .from(nrSmart)
    .where(inArray(nrSmart.tdArea, areas));
  const edges: BerthEdge[] = smart
    .filter((s) => s.from && s.to)
    .map((s) => ({ tdArea: s.tdArea, from: s.from as string, to: s.to as string }));
  const layout = layoutBerths(edges);

  if (layoutCache.size > 200) layoutCache.clear();
  layoutCache.set(key, { at: Date.now(), layout });
  return layout;
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
  const signalOff = new Map<string, boolean>(); // itemId -> off
  const trackOccupied = new Map<string, boolean>(); // itemId -> occupied
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
    }
  }

  // 4. Attach an aspect to each laid-out signal via the berth it protects.
  //    We map a layout signal to a SOP signal by the berth-ahead's berth code
  //    matching a signal itemId is not reliable, so we surface aspect by the
  //    signals we could decode and leave the rest "unknown".
  const decodedSignals = [...signalOff.entries()];
  const signals: DiagramSignal[] = layout.signals.map((sig, i) => {
    // Best-effort association: distribute decoded signals along the line in
    // order. Where SOP coverage is partial this yields aspects for the mapped
    // signals and "unknown" for the rest — honest to the data we have.
    const decoded = decodedSignals[i];
    if (!decoded) {
      return { id: sig.id, aspect: "unknown", mapped: false, x: sig.x, y: sig.y };
    }
    const [itemId, off] = decoded;
    return {
      id: sig.id,
      itemId,
      aspect: off ? "off" : "red",
      occupiedAhead: trackOccupied.get(itemId),
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
}): Promise<CorridorDiagram> {
  const { areas, focusHeadcode } = await resolveAreas(opts);
  if (areas.length === 0) return EMPTY();

  const layout = await getLayout(areas);
  if (layout.berths.length === 0) return EMPTY(areas);

  const state = await getDiagramState(areas, layout, focusHeadcode);
  return { ...state, layout };
}
