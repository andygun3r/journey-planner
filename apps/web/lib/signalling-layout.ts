/**
 * Auto-layout for the corridor signalling diagram. SMART gives how berths
 * connect (from-berth → to-berth steps within a TD area) but no coordinates, so
 * we derive a linear track schematic from the connection graph alone:
 *
 *   - x = the berth's rank along the running line (longest-path depth), so the
 *     main line reads left→right.
 *   - y is a compact lane within each rank. A station throat can have several
 *     berths at the same graph depth; drawing those as a single lane made the
 *     diagram look like one impossible line. Lanes preserve the left-to-right
 *     flow while letting branches, bays and platform throats separate visibly.
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
  /** CORPUS place name for this berth's STANOX, e.g. "LONDON WATERLOO". Undefined if unresolved. */
  place?: string;
  crs?: string;
  /** SMART platform, where recorded. */
  platform?: string;
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
const MARGIN = 30;
const Y_STEP = 34;
const AREA_GAP = 72;

function berthId(tdArea: string, berth: string): string {
  return `${tdArea}:${berth}`;
}

/**
 * Depth of each node = longest chain of edges reaching it (its column). Computed
 * by relaxing every edge up to |V| times (Bellman-Ford-style longest path).
 *
 * A cycle (trains reversing, crossovers, loops through sidings — common in a
 * busy area's SMART data) does NOT make this settle: every node on the cycle
 * keeps incrementing by one on every pass, all the way to the |V|-pass cap, so
 * a cycle inflates depth roughly linearly with node count rather than
 * "flattening" as previously assumed. Left unchecked, this stretched a single
 * area's layout width past 29,000px. Nodes still changing on the final pass
 * are on such a cycle; clamp them to one past the max depth seen among nodes
 * that did settle, so they sit just after the real linear chain instead of
 * running away.
 */
function columnDepths(nodes: string[], outAdj: Map<string, string[]>): Map<string, number> {
  const depth = new Map<string, number>();
  for (const n of nodes) depth.set(n, 0);
  const unresolved = new Set<string>();
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    unresolved.clear();
    for (const [from, tos] of outAdj) {
      const df = depth.get(from) ?? 0;
      for (const to of tos) {
        if ((depth.get(to) ?? 0) < df + 1) {
          depth.set(to, df + 1);
          changed = true;
          unresolved.add(to);
        }
      }
    }
    if (!changed) break;
  }
  if (unresolved.size > 0) {
    const settledMax = Math.max(0, ...nodes.filter((n) => !unresolved.has(n)).map((n) => depth.get(n) ?? 0));
    for (const n of unresolved) depth.set(n, settledMax + 1);
  }
  return depth;
}

/** Shared graph-building step behind layoutBerths and layoutBerthsFlat. */
function buildBerthGraph(edgesIn: BerthEdge[]): {
  nodeList: string[];
  areaOf: Map<string, { tdArea: string; berth: string }>;
  outAdj: Map<string, string[]>;
  edges: Array<{ from: string; to: string; tdArea: string }>;
} {
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

  return { nodeList: [...nodes], areaOf, outAdj, edges };
}

/**
 * Same berth/edge/signal graph as layoutBerths, but skipping columnDepths'
 * longest-path ranking (and therefore x/y — every node gets {0, 0}).
 *
 * columnDepths is Bellman-Ford-style: O(nodes x edges) per pass, up to
 * nodes.length passes to flush out cycles. Fine for one corridor's few-hundred
 * node graph; measured at ~19s for the WHOLE NATIONAL graph (~30k nodes/edges
 * across every TD area) when getNationalSnapshot in signalling.ts first tried
 * reusing layoutBerths for the /map overlay. That overlay only ever reads
 * berth ids/place/crs and edge from/to — never x/y — so there's no reason to
 * pay for the ranking at all there. Use this for any caller that doesn't
 * render a schematic diagram.
 */
export function layoutBerthsFlat(edgesIn: BerthEdge[]): DiagramLayout {
  const { nodeList, areaOf, edges } = buildBerthGraph(edgesIn);

  const berths: LaidBerth[] = nodeList.map((n) => {
    const a = areaOf.get(n)!;
    return { id: n, tdArea: a.tdArea, berth: a.berth, x: 0, y: 0 };
  });

  const signals: LaidSignal[] = edges.map((e) => ({
    id: `${e.from}->${e.to}`,
    tdArea: e.tdArea,
    berthAhead: e.to,
    x: 0,
    y: 0,
  }));

  return {
    berths,
    signals,
    edges: edges.map((e) => ({ from: e.from, to: e.to })),
    width: 0,
    height: MARGIN * 2,
  };
}

export function layoutBerths(edgesIn: BerthEdge[], yStep = Y_STEP): DiagramLayout {
  const { nodeList, areaOf, outAdj, edges } = buildBerthGraph(edgesIn);
  const depth = columnDepths(nodeList, outAdj);

  // Group by rank. Same-rank berths are real branches/junctions/bays, so give
  // them their own vertical lanes rather than compressing them onto one line.
  const byRank = new Map<number, string[]>();
  for (const n of nodeList) {
    const r = depth.get(n) ?? 0;
    (byRank.get(r) ?? byRank.set(r, []).get(r)!).push(n);
  }
  const pos = new Map<string, { x: number; y: number }>();
  let maxX = 0;
  let minY = MARGIN;
  let maxY = MARGIN;
  for (const [r, list] of [...byRank.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.localeCompare(b));
    const rankHeight = (list.length - 1) * yStep;
    list.forEach((n, i) => {
      const x = MARGIN + r * X_STEP;
      const y = MARGIN + i * yStep - rankHeight / 2;
      pos.set(n, { x, y });
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
  }
  if (minY < MARGIN) {
    const dy = MARGIN - minY;
    for (const [id, p] of pos) pos.set(id, { ...p, y: p.y + dy });
    maxY += dy;
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
    height: Math.max(MARGIN * 2, maxY + MARGIN),
  };
}

export function layoutBerthsByArea(edgesIn: BerthEdge[], areaOrder: string[]): DiagramLayout {
  const order = new Map(areaOrder.map((area, i) => [area, i]));
  const edgesByArea = new Map<string, BerthEdge[]>();
  for (const edge of edgesIn) {
    const list = edgesByArea.get(edge.tdArea);
    if (list) list.push(edge);
    else edgesByArea.set(edge.tdArea, [edge]);
  }

  const areaLayouts = [...edgesByArea.entries()]
    .sort((a, b) => {
      const ai = order.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
      const bi = order.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi || a[0].localeCompare(b[0]);
    })
    .map(([tdArea, edges]) => ({ tdArea, layout: layoutBerths(edges, 18) }));

  const berths: LaidBerth[] = [];
  const signals: LaidSignal[] = [];
  const edges: DiagramLayout["edges"] = [];
  let yOffset = 0;
  let width = 0;

  for (const { layout } of areaLayouts) {
    berths.push(...layout.berths.map((b) => ({ ...b, y: b.y + yOffset })));
    signals.push(...layout.signals.map((s) => ({ ...s, y: s.y + yOffset })));
    edges.push(...layout.edges);
    width = Math.max(width, layout.width);
    yOffset += layout.height + AREA_GAP;
  }

  return {
    berths,
    signals,
    edges,
    width,
    height: Math.max(MARGIN * 2, yOffset > 0 ? yOffset - AREA_GAP : 0),
  };
}

export interface MileageAnchor {
  berthId: string;
  tdArea: string;
  elr: string;
  mileage: number;
}

/**
 * Best-effort re-rank of berths by real mileage, where enough anchors exist
 * to make that meaningful. `layoutBerths`'s hop-rank x is a graph-distance
 * guess with no real-world geography; where a TD area has >=2 berths whose
 * station has a known ELR+mileage (see signalling.ts's applyMileageAnchors,
 * sourced from station_track_model_position), those anchors are real ground
 * truth and should win.
 *
 * A no-op (returns `layout` untouched) for any TD area with under 2 anchors —
 * the large majority, expected — so most areas render pixel-identical to the
 * pure hop-rank layout. Pure function: same input always gives the same
 * output, matching layoutBerths's own determinism contract.
 */
export function reorderByMileage(layout: DiagramLayout, anchors: MileageAnchor[]): DiagramLayout {
  if (anchors.length === 0) return layout;

  // Anchors can span >1 ELR within one TD area (a junction). Inventing a
  // cross-ELR mileage scale would be nonsense, so per TD area, use only the
  // ELR with the most anchors and leave everything else on hop-order.
  const anchorsByArea = new Map<string, MileageAnchor[]>();
  for (const a of anchors) {
    (anchorsByArea.get(a.tdArea) ?? anchorsByArea.set(a.tdArea, []).get(a.tdArea)!).push(a);
  }

  const anchorByBerthId = new Map<string, MileageAnchor>();
  for (const [, areaAnchors] of anchorsByArea) {
    const countByElr = new Map<string, number>();
    for (const a of areaAnchors) countByElr.set(a.elr, (countByElr.get(a.elr) ?? 0) + 1);
    let bestElr: string | undefined;
    let bestCount = 0;
    for (const [elr, count] of countByElr) {
      if (count > bestCount) {
        bestCount = count;
        bestElr = elr;
      }
    }
    if (bestElr === undefined || bestCount < 2) continue;
    for (const a of areaAnchors) {
      if (a.elr === bestElr) anchorByBerthId.set(a.berthId, a);
    }
  }
  if (anchorByBerthId.size === 0) return layout;

  // Existing hop-rank x, in ascending order, is the interpolation frame for
  // berths with no anchor of their own.
  const berthsByX = [...layout.berths].sort((a, b) => a.x - b.x);
  const xIndex = new Map<string, number>();
  berthsByX.forEach((b, i) => xIndex.set(b.id, i));

  // Anchored berths only, sorted by their real mileage.
  const anchoredSorted = berthsByX
    .filter((b) => anchorByBerthId.has(b.id))
    .map((b) => ({ berth: b, anchor: anchorByBerthId.get(b.id)! }))
    .sort((a, b) => a.anchor.mileage - b.anchor.mileage);

  if (anchoredSorted.length < 2) return layout;

  // Keep the new x span roughly the same pixel budget the hop-order ranks
  // already occupy for these berths, so total diagram width doesn't lurch.
  const anchoredXs = anchoredSorted.map((a) => xIndex.get(a.berth.id)!);
  const spanWidth = Math.max(...anchoredXs) - Math.min(...anchoredXs) || X_STEP;
  const minMileage = anchoredSorted[0]!.anchor.mileage;
  const maxMileage = anchoredSorted[anchoredSorted.length - 1]!.anchor.mileage;
  const mileageRange = maxMileage - minMileage || 1;
  const originX = Math.min(...anchoredXs);

  const mileageX = new Map<string, number>();
  for (const { berth, anchor } of anchoredSorted) {
    const t = (anchor.mileage - minMileage) / mileageRange;
    mileageX.set(berth.id, originX + t * spanWidth);
  }

  // Unanchored berths between two anchors: interpolate using their existing
  // hop-rank position as the parameter between the two bounding anchors' new
  // mileage-based x. Berths with no bounding anchor on either side keep their
  // original x untouched — no invented extrapolation.
  const newX = new Map<string, number>(mileageX);
  for (let i = 0; i < berthsByX.length; i++) {
    const berth = berthsByX[i]!;
    if (newX.has(berth.id)) continue;

    let before: { berth: LaidBerth; x: number } | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const candidate = berthsByX[j]!;
      if (mileageX.has(candidate.id)) {
        before = { berth: candidate, x: mileageX.get(candidate.id)! };
        break;
      }
    }
    let after: { berth: LaidBerth; x: number } | undefined;
    for (let j = i + 1; j < berthsByX.length; j++) {
      const candidate = berthsByX[j]!;
      if (mileageX.has(candidate.id)) {
        after = { berth: candidate, x: mileageX.get(candidate.id)! };
        break;
      }
    }
    if (!before || !after) continue; // no bounding anchor on one side — leave as-is

    const beforeRank = xIndex.get(before.berth.id)!;
    const afterRank = xIndex.get(after.berth.id)!;
    const rank = xIndex.get(berth.id)!;
    const t = afterRank === beforeRank ? 0 : (rank - beforeRank) / (afterRank - beforeRank);
    newX.set(berth.id, before.x + t * (after.x - before.x));
  }

  const berthById = new Map(layout.berths.map((b) => [b.id, b]));
  const berths = layout.berths.map((b) => (newX.has(b.id) ? { ...b, x: newX.get(b.id)! } : b));

  // Each signal sits at a fixed fractional offset before the berth it
  // protects (see layoutBerths: x = pt.x - (pt.x - pf.x) * 0.28). Preserve
  // that same fractional offset — relative to the berth's OLD x — when the
  // berth moves, rather than trying to reconstruct which edge fed into it.
  const signals = layout.signals.map((s) => {
    const oldAheadX = berthById.get(s.berthAhead)?.x;
    const newAheadX = newX.get(s.berthAhead);
    if (oldAheadX === undefined || newAheadX === undefined) return s;
    const offset = oldAheadX - s.x; // how far before the berth this signal originally sat
    return { ...s, x: newAheadX - offset };
  });

  return { ...layout, berths, signals };
}
