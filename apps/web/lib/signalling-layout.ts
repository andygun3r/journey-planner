/**
 * Auto-layout for the corridor signalling diagram. SMART gives how berths
 * connect (from-berth → to-berth steps within a TD area) but no coordinates, so
 * we derive a linear track schematic from the connection graph alone:
 *
 *   - x = the berth's rank along the running line (longest-path depth), so the
 *     main line reads left→right.
 *   - y = a lane, so where the graph branches, branches sit on separate rows
 *     instead of overlapping.
 *   - a signal sits on each berth boundary (each from→to edge is a section).
 *
 * Pure and deterministic: same graph → same layout, so live overlays register
 * against stable geometry. Cycles (loops/reversals) are broken by ignoring the
 * back-edge for ranking; the berths still appear, just not perfectly ordered.
 */

export interface BerthEdge {
  tdArea: string;
  from: string; // berth id
  to: string; // berth id
}

export interface LaidBerth {
  id: string; // `${tdArea}:${berth}`
  tdArea: string;
  berth: string;
  x: number;
  y: number;
}

export interface LaidSignal {
  id: string; // boundary id `${fromId}->${toId}`
  tdArea: string;
  /** The berth the signal protects entry to (its `to` berth). */
  berthAhead: string; // full berth id
  x: number;
  y: number;
}

export interface DiagramLayout {
  berths: LaidBerth[];
  signals: LaidSignal[];
  edges: Array<{ from: string; to: string }>; // full berth ids
  width: number;
  height: number;
}

const X_STEP = 90;
const Y_STEP = 26;
const MARGIN = 30;
// Cap lanes per column: an overloaded rank wraps into extra sub-columns instead
// of growing into an unreadable vertical strip (some TD areas are wide + flat).
const MAX_LANES = 18;
const SUBCOL_X = 30;

function berthId(tdArea: string, berth: string): string {
  return `${tdArea}:${berth}`;
}

/**
 * Depth of each node = longest chain of edges reaching it (its column). Computed
 * by relaxing every edge up to |V| times (Bellman-Ford-style longest path); this
 * terminates even with cycles, which simply stop deepening once relaxation
 * settles — so loops/reversals don't hang, they just flatten.
 */
function columnDepths(nodes: string[], outAdj: Map<string, string[]>): Map<string, number> {
  const depth = new Map<string, number>();
  for (const n of nodes) depth.set(n, 0);
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const [from, tos] of outAdj) {
      const df = depth.get(from) ?? 0;
      for (const to of tos) {
        if ((depth.get(to) ?? 0) < df + 1) {
          depth.set(to, df + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return depth;
}

export function layoutBerths(edgesIn: BerthEdge[]): DiagramLayout {
  // Build the berth graph (full ids), de-duplicating edges.
  const nodes = new Set<string>();
  const outAdj = new Map<string, string[]>();
  const areaOf = new Map<string, { tdArea: string; berth: string }>();
  const seenEdge = new Set<string>();
  const edges: Array<{ from: string; to: string; tdArea: string }> = [];

  for (const e of edgesIn) {
    if (!e.from || !e.to) continue;
    const from = berthId(e.tdArea, e.from);
    const to = berthId(e.tdArea, e.to);
    if (from === to) continue;
    nodes.add(from);
    nodes.add(to);
    areaOf.set(from, { tdArea: e.tdArea, berth: e.from });
    areaOf.set(to, { tdArea: e.tdArea, berth: e.to });
    const key = `${from}->${to}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    (outAdj.get(from) ?? outAdj.set(from, []).get(from)!).push(to);
    edges.push({ from, to, tdArea: e.tdArea });
  }

  const nodeList = [...nodes];
  const depth = columnDepths(nodeList, outAdj);

  // Assign a lane (y) per column so branches don't collide: within each rank,
  // stack nodes in a stable order.
  const byRank = new Map<number, string[]>();
  for (const n of nodeList) {
    const r = depth.get(n) ?? 0;
    (byRank.get(r) ?? byRank.set(r, []).get(r)!).push(n);
  }
  const pos = new Map<string, { x: number; y: number }>();
  let maxLane = 0;
  let maxX = 0;
  for (const [r, list] of [...byRank.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.localeCompare(b));
    list.forEach((n, i) => {
      // Wrap an overloaded rank into sub-columns so it never towers vertically.
      const lane = i % MAX_LANES;
      const sub = Math.floor(i / MAX_LANES);
      const x = MARGIN + r * X_STEP + sub * SUBCOL_X;
      pos.set(n, { x, y: MARGIN + lane * Y_STEP });
      if (lane > maxLane) maxLane = lane;
      if (x > maxX) maxX = x;
    });
  }

  const berths: LaidBerth[] = nodeList.map((n) => {
    const a = areaOf.get(n)!;
    const p = pos.get(n)!;
    return { id: n, tdArea: a.tdArea, berth: a.berth, x: p.x, y: p.y };
  });

  // A signal on each edge, placed just before its `to` berth (the berth it
  // protects entry to).
  const signals: LaidSignal[] = edges.map((e) => {
    const pf = pos.get(e.from)!;
    const pt = pos.get(e.to)!;
    return {
      id: `${e.from}->${e.to}`,
      tdArea: e.tdArea,
      berthAhead: e.to,
      x: pt.x - (pt.x - pf.x) * 0.28,
      y: pt.y - (pt.y - pf.y) * 0.28,
    };
  });

  return {
    berths,
    signals,
    edges: edges.map((e) => ({ from: e.from, to: e.to })),
    width: maxX + MARGIN,
    height: MARGIN * 2 + maxLane * Y_STEP,
  };
}
