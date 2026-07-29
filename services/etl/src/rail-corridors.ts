import { darwinStopForecast, railCorridor, station } from "@mainline/db";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * Precompute track-following geometry between adjacent calling points, into
 * rail_corridor.
 *
 * Why: the map drew each route as straight chords between calling points, which
 * cuts across open country instead of following the railway. Resolving a real
 * path means a shortest-path search over the OpenRailwayMap ways in orm-db
 * (~118k main/branch segments) — too slow for the request path, and orm-db has
 * no host port for the web app regardless. So this materialises the result into
 * the main Postgres, the same precompute pattern as snap-stations.
 *
 * How the graph is built: OSM nodes its ways exactly, so connecting segments
 * share endpoint coordinates bit-for-bit (measured: 236,756 endpoints collapse
 * to 138,265 distinct points). That means the graph can be keyed on exact
 * rounded coordinates with no tolerance fuzzing, which keeps this a plain
 * in-memory Dijkstra rather than anything needing pgrouting (not available in
 * the orm-db image, and not installable there).
 *
 * What this deliberately does NOT do: interpolate a train's position *along*
 * the returned corridor. Drawing a corridor is forgiving — picking the adjacent
 * parallel line still reads as "follows the railway" and is honest cartography.
 * Claiming a train is at a specific point on it would be fabricating measured
 * motion, which snap-stations.ts's header already rejects for the same reason.
 * Between-station position stays the straight-line approximation the map legend
 * describes.
 *
 * Coverage ceiling, so this isn't re-investigated: ~88% of distinct pairs solve,
 * but only ~75% weighted by how often each leg is actually travelled. The
 * shortfall is concentrated in short urban hops and is an OSM data limit, not a
 * tuning problem. Verified by running an unbounded search on the worst
 * offenders (endpoints snapped to within 4-23m in every case):
 *
 *   Ealing Broadway -> Acton Main Line   2.4km apart, shortest path 15.0km (6.3x)
 *   Honor Oak Park  -> Brockley          1.7km apart, shortest path 15.1km (9.0x)
 *   Bond Street     -> Tottenham Ct Rd   unreachable (Elizabeth line core is a
 *                                        disconnected fragment in the extract)
 *
 * Parallel running lines (up/down/relief) are mapped as separate ways that only
 * meet at distant junctions, so the true shortest path detours miles from where
 * the train goes. Admitting those would draw something worse than the straight
 * chord, which is why MAX_DETOUR_RATIO rejects them and the map falls back.
 * Raising the limits does not help; better OSM noding, or a different track
 * source, is what would.
 */

/**
 * How far from a station's coordinate we'll look for a graph node to start or
 * end a search. Generous compared with snap-stations' 150m tolerance because a
 * corridor endpoint only has to land on the right *line*, not on the exact
 * platform face — and it also has to cover the 320 stations that failed to snap
 * and therefore fall back to their .MSN entrance/centroid coordinate.
 */
const ENDPOINT_SEARCH_METERS = 800;

/**
 * Reject a solved path this many times longer than the straight-line distance.
 * A sane rail corridor is rarely more than ~1.6x the chord; a much larger ratio
 * means the search escaped down a branch and looped back (via a depot spur or
 * a parallel freight route), which would draw as an obviously wrong detour.
 * Those pairs get no row and fall back to the chord.
 */
const MAX_DETOUR_RATIO = 2.5;

/**
 * Absolute slack added to the detour budget, so the ratio doesn't over-constrain
 * short hops. A ratio alone gives a 700m pair only a 1.75km budget, which a
 * perfectly normal curve through a junction throat can exceed — measured, pairs
 * under 10km solved at 57% against 83% for long ones, purely from this. Two
 * adjacent stations are never a meaningful walk apart on the ground, so a fixed
 * few km of headroom costs nothing on long routes and rescues the short ones.
 */
const DETOUR_SLACK_METERS = 3_000;

/**
 * Hard ceiling on the ratio regardless of slack. Without it the fixed slack
 * dominates at very short chords and waves through nonsense — Blackfriars to
 * City Thameslink is 237m apart, and a 1.8km path around the Thameslink core
 * cleared a slack-only budget at 7.6x. Those draw worse than the chord they
 * were meant to replace, so they get no row and fall back.
 */
const ABSOLUTE_MAX_RATIO = 4;

/** Budget for a pair whose straight-line separation is `chord` metres. */
function detourBudget(chord: number): number {
  return Math.min(chord * MAX_DETOUR_RATIO + DETOUR_SLACK_METERS, chord * ABSOLUTE_MAX_RATIO);
}

/** Coordinates are keyed at ~1cm precision — well inside OSM's exact noding. */
const COORD_PRECISION = 7;

interface Edge {
  /** Index of the node at the far end. */
  to: number;
  /** Along-track length in metres. */
  cost: number;
  /** Way geometry from this node to `to`, as [lon, lat] pairs. */
  coords: [number, number][];
}

interface Graph {
  /** node key ("lon,lat") -> node index */
  index: Map<string, number>;
  /** node index -> [lon, lat] */
  points: [number, number][];
  adjacency: Edge[][];
}

function key(lon: number, lat: number): string {
  return `${lon.toFixed(COORD_PRECISION)},${lat.toFixed(COORD_PRECISION)}`;
}

function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Pull every running-line way out of orm-db as GeoJSON and build an undirected
 * node/edge graph. Filters to the same feature/usage set snap-stations uses, so
 * corridors follow passenger track rather than sidings and depot spurs.
 */
async function buildGraph(): Promise<Graph> {
  const url = process.env.ORM_DATABASE_URL ?? "postgresql://postgres@orm-db:5432/gis";
  const client = postgres(url, { max: 1 });
  try {
    // `state` matters more than it looks: GB's OSM extract carries 17k
    // abandoned and 4.7k razed ways (Beeching-era trackbeds, largely) inside
    // the same feature/usage filter as live track. Routing over those produced
    // corridors down railways that no longer physically exist, and left the
    // live network fragmented where a torn-up parallel broke the run.
    // `service` excludes sidings/yards/spurs/crossovers — real rails, but yard
    // stubs that add graph bulk without connecting anything.
    const rows = await client<{ geojson: string }[]>`
      select ST_AsGeoJSON(ST_Transform(way, 4326)) as geojson
      from railway_line
      where feature in ('rail', 'light_rail', 'subway')
        and (usage in ('main', 'branch') or usage is null)
        and state = 'present'
        and (service is null or service in ('main', 'loop'))
    `;

    const index = new Map<string, number>();
    const points: [number, number][] = [];
    const adjacency: Edge[][] = [];

    const nodeFor = (lon: number, lat: number): number => {
      const k = key(lon, lat);
      const existing = index.get(k);
      if (existing !== undefined) return existing;
      const id = points.length;
      index.set(k, id);
      points.push([lon, lat]);
      adjacency.push([]);
      return id;
    };

    // Every vertex becomes a node, and every consecutive vertex pair an edge.
    //
    // Noding only at way endpoints looks cheaper but breaks two ways at once:
    // OSM routinely places junctions partway along a way (sampled over 3k ways,
    // 51 endpoints landed on another way's interior), and a station snapped to
    // the middle of a long unsplit way has no nearby node to start a search
    // from — which is what left 6,152 pairs with "no endpoint" despite every
    // station having good coordinates. Per-vertex noding makes both problems
    // disappear: shared vertices are automatically the same node, so junctions
    // connect wherever they occur, and there is always a node within a few
    // metres of anything snapped onto the line.
    //
    // The cost is a larger graph (~950k nodes rather than ~145k), which is
    // still an easy fit in memory for a batch precompute and leaves Dijkstra
    // comfortably fast at these search radii.
    for (const row of rows) {
      const geom = JSON.parse(row.geojson) as { type: string; coordinates: [number, number][] };
      if (geom.type !== "LineString" || geom.coordinates.length < 2) continue;
      const coords = geom.coordinates;
      for (let i = 1; i < coords.length; i += 1) {
        const p = coords[i - 1]!;
        const q = coords[i]!;
        const a = nodeFor(p[0], p[1]);
        const b = nodeFor(q[0], q[1]);
        if (a === b) continue; // duplicate vertex contributes no traversable edge
        const cost = haversineMeters(p, q);
        const seg: [number, number][] = [p, q];
        // Undirected: the same rail is walkable either way round, so store the
        // reversed geometry too rather than reversing at query time.
        adjacency[a]!.push({ to: b, cost, coords: seg });
        adjacency[b]!.push({ to: a, cost, coords: [q, p] });
      }
    }

    return { index, points, adjacency };
  } finally {
    await client.end();
  }
}

/**
 * Spatial bucket index over graph nodes, so finding the nodes near a station is
 * a few bucket lookups rather than a scan of all ~138k points per station.
 * Bucketed on a ~0.01deg grid (roughly 1.1km lat, 0.7km lon at GB latitudes).
 */
function buildNodeIndex(graph: Graph): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < graph.points.length; i += 1) {
    const [lon, lat] = graph.points[i]!;
    const k = `${Math.floor(lat * 100)},${Math.floor(lon * 100)}`;
    const list = buckets.get(k);
    if (list) list.push(i);
    else buckets.set(k, [i]);
  }
  return buckets;
}

function nearestNode(
  graph: Graph,
  buckets: Map<string, number[]>,
  lon: number,
  lat: number,
): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  const cy = Math.floor(lat * 100);
  const cx = Math.floor(lon * 100);
  // A 0.01deg bucket is ~1.1km tall but only ~700m wide at GB latitudes, so a
  // 3x3 window would not reliably cover ENDPOINT_SEARCH_METERS in longitude.
  const span = 2;
  for (let dy = -span; dy <= span; dy += 1) {
    for (let dx = -span; dx <= span; dx += 1) {
      for (const i of buckets.get(`${cy + dy},${cx + dx}`) ?? []) {
        const d = haversineMeters([lon, lat], graph.points[i]!);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
    }
  }
  return bestDist <= ENDPOINT_SEARCH_METERS ? best : null;
}

/** Minimal binary heap — a sorted-array queue makes Dijkstra quadratic here. */
class MinHeap {
  private heap: { node: number; cost: number }[] = [];

  push(node: number, cost: number): void {
    this.heap.push({ node, cost });
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent]!.cost <= this.heap[i]!.cost) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i]!, this.heap[parent]!];
      i = parent;
    }
  }

  pop(): { node: number; cost: number } | undefined {
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0 && last) {
      this.heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let small = i;
        if (l < this.heap.length && this.heap[l]!.cost < this.heap[small]!.cost) small = l;
        if (r < this.heap.length && this.heap[r]!.cost < this.heap[small]!.cost) small = r;
        if (small === i) break;
        [this.heap[small], this.heap[i]] = [this.heap[i]!, this.heap[small]!];
        i = small;
      }
    }
    return top;
  }

  get size(): number {
    return this.heap.length;
  }
}

/**
 * Dijkstra from `start` to `goal`, bounded by `maxCost` so an unreachable pair
 * doesn't walk the entire GB network before giving up. Returns the concatenated
 * geometry, or null if no path came in under the bound.
 */
function shortestPath(
  graph: Graph,
  start: number,
  goal: number,
  maxCost: number,
): { coords: [number, number][]; cost: number } | null {
  const dist = new Map<number, number>([[start, 0]]);
  const prev = new Map<number, { node: number; coords: [number, number][] }>();
  const settled = new Set<number>();
  const queue = new MinHeap();
  queue.push(start, 0);

  while (queue.size > 0) {
    const current = queue.pop()!;
    if (settled.has(current.node)) continue;
    settled.add(current.node);
    if (current.node === goal) break;
    if (current.cost > maxCost) return null;

    for (const edge of graph.adjacency[current.node] ?? []) {
      if (settled.has(edge.to)) continue;
      const next = current.cost + edge.cost;
      if (next > maxCost) continue;
      if (next < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, next);
        prev.set(edge.to, { node: current.node, coords: edge.coords });
        queue.push(edge.to, next);
      }
    }
  }

  const total = dist.get(goal);
  if (total === undefined || !settled.has(goal)) return null;

  // Walk the predecessor chain back to the start, stitching way geometries.
  const segments: [number, number][][] = [];
  let at = goal;
  while (at !== start) {
    const step = prev.get(at);
    if (!step) return null;
    segments.push(step.coords);
    at = step.node;
  }
  segments.reverse();

  const coords: [number, number][] = [];
  for (const seg of segments) {
    // Each segment starts where the previous ended — drop the duplicate joint.
    for (const c of coords.length === 0 ? seg : seg.slice(1)) coords.push(c);
  }
  return { coords, cost: total };
}

export async function railCorridors(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const mainClient = postgres(url);
  const db = drizzle(mainClient);

  try {
    console.log("[rail-corridors] building graph from orm-db…");
    const graph = await buildGraph();
    console.log(
      `[rail-corridors] graph: ${graph.points.length} nodes, ` +
        `${graph.adjacency.reduce((n, a) => n + a.length, 0) / 2} edges`,
    );
    const buckets = buildNodeIndex(graph);

    // Station coordinates: prefer the track-snapped point so a corridor endpoint
    // starts on the rails, matching what live-trains.ts plots.
    const stations = await db
      .select({
        crs: station.crs,
        lat: sql<number | null>`coalesce(${station.trackLat}, ${station.lat})`,
        lon: sql<number | null>`coalesce(${station.trackLon}, ${station.lon})`,
      })
      .from(station);
    const coordByCrs = new Map<string, [number, number]>();
    for (const s of stations) {
      if (s.lat != null && s.lon != null) coordByCrs.set(s.crs, [s.lon, s.lat]);
    }

    // The pairs worth solving: consecutive calling points on real schedules,
    // rather than the full CRS cross-product (which would be ~4.8M mostly
    // meaningless pairs).
    const pairRows = await db
      .select({
        fromCrs: sql<string>`f.crs`,
        toCrs: sql<string>`f.next_crs`,
      })
      .from(
        sql`(
          select distinct crs, next_crs from (
            select crs, lead(crs) over (partition by rid order by seq) as next_crs
            from ${darwinStopForecast} where crs is not null
          ) s where next_crs is not null
        ) f`,
      );
    console.log(`[rail-corridors] ${pairRows.length} adjacent station pairs to solve`);

    const nodeCache = new Map<string, number | null>();
    const nodeFor = (crs: string): number | null => {
      if (nodeCache.has(crs)) return nodeCache.get(crs)!;
      const c = coordByCrs.get(crs);
      const n = c ? nearestNode(graph, buckets, c[0], c[1]) : null;
      nodeCache.set(crs, n);
      return n;
    };

    const solved: { fromCrs: string; toCrs: string; coords: [number, number][]; length: number }[] =
      [];
    let noEndpoint = 0;
    let noPath = 0;
    let tooLong = 0;

    for (const [i, pair] of pairRows.entries()) {
      if (i > 0 && i % 2000 === 0) {
        console.log(`[rail-corridors] ${i}/${pairRows.length} (${solved.length} solved)`);
      }
      const from = coordByCrs.get(pair.fromCrs);
      const to = coordByCrs.get(pair.toCrs);
      if (!from || !to) {
        noEndpoint += 1;
        continue;
      }
      const startNode = nodeFor(pair.fromCrs);
      const goalNode = nodeFor(pair.toCrs);
      if (startNode === null || goalNode === null || startNode === goalNode) {
        noEndpoint += 1;
        continue;
      }

      const budget = detourBudget(haversineMeters(from, to));
      const result = shortestPath(graph, startNode, goalNode, budget);
      if (!result) {
        noPath += 1;
        continue;
      }
      if (result.cost > budget) {
        tooLong += 1;
        continue;
      }
      solved.push({
        fromCrs: pair.fromCrs,
        toCrs: pair.toCrs,
        coords: result.coords,
        length: result.cost,
      });
    }

    console.log(
      `[rail-corridors] solved ${solved.length}; ` +
        `${noEndpoint} no endpoint, ${noPath} no path, ${tooLong} over detour limit`,
    );
    if (solved.length === 0) return;

    // Replace wholesale: a re-run reflects a fresh OSM import, so stale rows for
    // pairs that no longer solve should not survive.
    await db.execute(sql`truncate table ${railCorridor}`);
    for (let i = 0; i < solved.length; i += 500) {
      const batch = solved.slice(i, i + 500);
      await db.insert(railCorridor).values(
        batch.map((s) => ({
          fromCrs: s.fromCrs,
          toCrs: s.toCrs,
          geometry: s.coords.flat(),
          lengthM: s.length,
        })),
      );
    }
    console.log(`[rail-corridors] wrote ${solved.length} corridors`);
  } finally {
    await mainClient.end();
  }
}
