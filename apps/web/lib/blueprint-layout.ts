import { milesAndChainsToMiles, sectionAt, type TrackSection } from "@signaller/shared";
import type { CorridorStation, SignallingCorridor } from "./signalling-corridors";

/**
 * Geometry for the vertical corridor blueprint.
 *
 * The diagram used to run left-to-right at a flat 74px per station, which made
 * Waterloo–Vauxhall (1.3 miles) exactly as long as Brockenhurst–Sway (4 miles)
 * and forced every station name to sit at -35°. It now reads top-to-bottom:
 * running lines are vertical columns, stations are horizontal ticks spaced by
 * real track mileage, and labels sit upright in a gutter.
 *
 * Pure and deterministic — no React, no DOM — so the ordering and spacing rules
 * can be tested directly.
 */

/** Vertical pixels per mile of real railway. */
const PX_PER_MILE = 26;

/** …but never let two adjacent stations get closer than this. */
const MIN_STATION_GAP = 30;

/** …or further apart than this, so the New Forest doesn't dwarf the diagram. */
const MAX_STATION_GAP = 132;

/** Spacing used when a station has no Track Model position at all. */
const FALLBACK_GAP = 54;

/**
 * A running line has to reach at least this many of the corridor's stations.
 *
 * Guards against a short ELR at a terminus promoting its approach roads to
 * "through line" — see placeTracks.
 */
const MIN_STATIONS_PER_TRACK = 3;

/**
 * Top margin above the first station.
 *
 * Has to clear two stacked things: the rotated running-line labels, and (at
 * Waterloo) the 24-platform throat fanning in above them.
 */
export const BLUEPRINT_TOP = 240;
export const BLUEPRINT_BOTTOM_PAD = 64;
/**
 * Left gutter holding station names, then the CRS column.
 *
 * Wide enough for the longest name on any corridor ("Southampton Airport
 * Parkway", "Queenstown Road (Battersea)") at the label font size, so names
 * never run into the CRS codes beside them.
 */
export const LABEL_GUTTER = 340;
/**
 * Where the CRS code sits, right-aligned before the tracks.
 *
 * Far enough left that a train box on the first running line (32px wide,
 * centred on the column) and the signal dots beside it cannot reach it — the
 * live board draws both, and at Waterloo they covered the codes entirely.
 */
export const CRS_COLUMN_X = LABEL_GUTTER - 62;
/** Horizontal pitch between running lines. */
export const TRACK_PITCH = 34;
/**
 * Width reserved to the right of the tracks for branch spurs.
 *
 * Branch labels are the widest text on the diagram ("Windsor / Reading /
 * Richmond"), and they sit outside the running lines, so this has to cover the
 * spur plus the longest label or the label is clipped by the viewBox.
 */
export const BRANCH_GUTTER = 300;

/**
 * London Waterloo's platforms, grouped by the lines they actually feed.
 *
 * The old diagram fanned all 24 platforms into the running lines by
 * `(platform - 1) % laneCount`, which cycled them through the four lanes in
 * rotation — a pattern that matches nothing at Waterloo. The real split is by
 * platform group: 1–4 are the Windsor lines (the suburban side), 5–19 are the
 * main lines, and 20–24 return to the Windsor side.
 */
export const WATERLOO_PLATFORM_GROUPS = [
  { from: 1, to: 4, group: "windsor" as const },
  { from: 5, to: 19, group: "main" as const },
  { from: 20, to: 24, group: "windsor" as const },
];

export type WaterlooGroup = "windsor" | "main";

export function waterlooPlatformGroup(platform: number): WaterlooGroup | undefined {
  const found = WATERLOO_PLATFORM_GROUPS.find((g) => platform >= g.from && platform <= g.to);
  return found?.group;
}

export interface BlueprintTrack {
  trackId: string;
  label: string;
  x: number;
  /** Vertical extent: the first and last station y where this line exists. */
  fromY: number;
  toY: number;
}

export interface BlueprintStation extends CorridorStation {
  y: number;
  /** Decimal miles along `elr`, when Track Model could place it. */
  mile?: number;
  /** The engineering line this station's mileage is measured on. */
  elr?: string;
  /** True when y came from interpolation rather than a real Track Model row. */
  estimated: boolean;
  berthCount: number;
  platforms: Set<string>;
  tdAreas: Set<string>;
}

export interface BlueprintBranch {
  id: string;
  label: string;
  side: "up" | "down";
  y: number;
  atCrs: string;
}

export interface BlueprintModel {
  stations: BlueprintStation[];
  tracks: BlueprintTrack[];
  branches: BlueprintBranch[];
  width: number;
  height: number;
  /** True when no station on this corridor had a Track Model position. */
  evenlySpaced: boolean;
}

export interface StationPosition {
  crs: string;
  elr: string;
  mileage: number;
}

/**
 * Place the corridor's stations down the page.
 *
 * Stations with a Track Model position are spaced by the real distance between
 * them, clamped so a very short hop stays readable and a very long one doesn't
 * push everything else off-screen. Stations without one are spread evenly
 * through the gap between their nearest placed neighbours and flagged
 * `estimated` so the renderer can mark them rather than imply false precision.
 */
export function placeStations(
  stations: CorridorStation[],
  positions: StationPosition[],
): Array<{
  station: CorridorStation;
  y: number;
  mile?: number;
  elr?: string;
  estimated: boolean;
}> {
  const byCrs = new Map(positions.map((p) => [p.crs, p]));
  const placed = stations.map((s) => {
    const pos = byCrs.get(s.crs);
    return pos
      ? { mile: milesAndChainsToMiles(pos.mileage), elr: pos.elr }
      : { mile: undefined, elr: undefined };
  });

  const anyReal = placed.some((p) => p.mile !== undefined);
  if (!anyReal) {
    return stations.map((station, i) => ({
      station,
      y: BLUEPRINT_TOP + i * FALLBACK_GAP,
      mile: undefined,
      elr: undefined,
      estimated: true,
    }));
  }

  /**
   * Mileage only means anything within one ELR.
   *
   * A corridor is not one engineering line: the SWML runs over RDG1 out of
   * Waterloo, then BML1, BML2 and BML3 down to Weymouth, and each of those
   * restarts its own mileage from zero. Treating them as a single number line
   * put Moreton at mile 129 and Upwey at 166 — a 37-mile "gap" that is really
   * just an ELR change — and collapsed everything else against the clamp.
   *
   * So distance is measured only between consecutive stations on the *same*
   * ELR. Crossing an ELR boundary steps a fixed gap instead, since Track Model
   * gives no way to relate the two mileage origins.
   */
  const out: Array<{
    station: CorridorStation;
    y: number;
    mile?: number;
    elr?: string;
    estimated: boolean;
  }> = [];

  // Direction can differ per ELR, so work it out for each one from its own
  // first and last known station in corridor order.
  const runDirection = new Map<string, boolean>();
  for (const elr of new Set(placed.map((p) => p.elr).filter(Boolean) as string[])) {
    const onElr = placed.filter((p) => p.elr === elr).map((p) => p.mile as number);
    runDirection.set(elr, (onElr.at(-1) ?? 0) < (onElr[0] ?? 0));
  }

  let y = BLUEPRINT_TOP;
  let prev: { mile: number; elr: string } | undefined;

  for (let i = 0; i < stations.length; i++) {
    const station = stations[i]!;
    const { mile, elr } = placed[i]!;

    if (i === 0) {
      out.push({ station, y, mile, elr, estimated: mile === undefined });
      if (mile !== undefined && elr) prev = { mile, elr };
      continue;
    }

    if (mile !== undefined && elr && prev && prev.elr === elr) {
      const descending = runDirection.get(elr) ?? false;
      const dir = (m: number) => (descending ? -m : m);
      const delta = Math.abs(dir(mile) - dir(prev.mile));
      y += Math.min(MAX_STATION_GAP, Math.max(MIN_STATION_GAP, delta * PX_PER_MILE));
      out.push({ station, y, mile, elr, estimated: false });
      prev = { mile, elr };
      continue;
    }

    // Either no position at all, or the first station on a new ELR — there is
    // no comparable distance to the one before it, so step a default gap.
    y += FALLBACK_GAP;
    out.push({ station, y, mile, elr, estimated: mile === undefined });
    if (mile !== undefined && elr) prev = { mile, elr };
  }

  return out;
}

/** Where a corridor's station sits on the railway, once placed. */
export interface PlacedPoint {
  y: number;
  mile?: number;
  elr?: string;
}

/**
 * Which running lines to draw, where each column sits, and how far down the
 * page each one exists.
 *
 * Driven by the stations rather than by raw mileage. A corridor crosses several
 * ELRs (the SWML uses RDG1, BML1, BML2 and BML3) and each restarts its mileage
 * from zero, so there is no single number line to filter sections against —
 * doing that left one track drawn and the rest dropped. Instead, each placed
 * station is looked up in its own ELR's sections to get the track count there,
 * and a line's vertical extent is the range of station y positions that
 * actually have it.
 *
 * The widest count anywhere on the corridor fixes the column positions, so the
 * columns stay put down the whole diagram and simply stop where the line does —
 * which is what makes four tracks visibly narrow to two past Worting Junction.
 */
export function placeTracks(
  sections: TrackSection[],
  points: PlacedPoint[],
  nameFor: (trackId: string) => string,
): BlueprintTrack[] {
  if (sections.length === 0 || points.length === 0) return [];

  const byElr = new Map<string, TrackSection[]>();
  for (const s of sections) {
    const list = byElr.get(s.elr) ?? [];
    list.push(s);
    byElr.set(s.elr, list);
  }

  // For each station we can place, which lines exist there.
  const atStation: Array<{ y: number; trackIds: string[] }> = [];
  for (const p of points) {
    if (p.mile === undefined || !p.elr) continue;
    const onElr = byElr.get(p.elr);
    if (!onElr) continue;
    const hit = sectionAt(onElr, p.mile);
    if (hit) atStation.push({ y: p.y, trackIds: hit.trackIds });
  }
  if (atStation.length === 0) return [];

  /**
   * Only draw lines that actually run along the corridor.
   *
   * `deriveSections` filters sidings out per ELR, but a corridor crossing
   * several ELRs picks up whatever each one calls a through line — and a short
   * ELR at a terminus (RDG1 covers barely a mile out of Waterloo) promotes its
   * approach roads to that status. Those showed up as a full-height running
   * line, labelled `Line 3100`, that existed at exactly one station.
   *
   * A real running line reaches multiple stations, so require that.
   */
  const stationCount = new Map<string, number>();
  for (const s of atStation) {
    for (const id of s.trackIds) stationCount.set(id, (stationCount.get(id) ?? 0) + 1);
  }
  const allIds = [...stationCount.entries()]
    .filter(([, n]) => n >= MIN_STATIONS_PER_TRACK)
    .map(([id]) => id);
  if (allIds.length === 0) return [];

  // Up lines to the left of down lines, so the diagram reads consistently.
  const ordered = allIds.sort((a, b) => {
    const dirA = a.startsWith("2") ? 0 : 1;
    const dirB = b.startsWith("2") ? 0 : 1;
    return dirA - dirB || a.localeCompare(b);
  });

  return ordered.map((trackId, i) => {
    const ys = atStation.filter((s) => s.trackIds.includes(trackId)).map((s) => s.y);
    return {
      trackId,
      label: nameFor(trackId),
      x: LABEL_GUTTER + i * TRACK_PITCH,
      fromY: Math.min(...ys),
      toY: Math.max(...ys),
    };
  });
}

export function buildBlueprint(opts: {
  corridor: SignallingCorridor;
  positions: StationPosition[];
  sections: TrackSection[];
  berths: Array<{ crs?: string; platform?: string; tdArea: string }>;
  nameFor: (trackId: string) => string;
}): BlueprintModel {
  const { corridor, positions, sections, berths, nameFor } = opts;

  const placed = placeStations(corridor.stations, positions);
  const stats = new Map<string, { berthCount: number; platforms: Set<string>; tdAreas: Set<string> }>();
  for (const station of corridor.stations) {
    stats.set(station.crs, { berthCount: 0, platforms: new Set(), tdAreas: new Set() });
  }
  for (const berth of berths) {
    if (!berth.crs) continue;
    const stat = stats.get(berth.crs);
    if (!stat) continue;
    stat.berthCount += 1;
    if (berth.platform) stat.platforms.add(berth.platform);
    stat.tdAreas.add(berth.tdArea);
  }

  const stations: BlueprintStation[] = placed.map((p) => {
    const stat = stats.get(p.station.crs)!;
    return {
      ...p.station,
      y: p.y,
      mile: p.mile,
      elr: p.elr,
      estimated: p.estimated,
      berthCount: stat.berthCount,
      platforms: stat.platforms,
      tdAreas: stat.tdAreas,
    };
  });

  const tracks = placeTracks(
    sections,
    stations.map((s) => ({ y: s.y, mile: s.mile, elr: s.elr })),
    nameFor,
  );
  const knownMiles = stations.filter((s) => s.mile !== undefined).length;

  const yByCrs = new Map(stations.map((s) => [s.crs, s.y]));
  const branches: BlueprintBranch[] = corridor.branches
    .filter((b) => yByCrs.has(b.atCrs))
    .map((b) => ({
      id: b.id,
      label: b.label,
      side: b.side,
      atCrs: b.atCrs,
      y: yByCrs.get(b.atCrs)!,
    }));

  const lastY = stations.at(-1)?.y ?? BLUEPRINT_TOP;
  const trackRight = tracks.length
    ? Math.max(...tracks.map((t) => t.x))
    : LABEL_GUTTER + TRACK_PITCH;

  // One extra column to the right of the running lines holds trains whose line
  // is unknown, so the branch gutter starts beyond that.
  const unknownColumn = trackRight + TRACK_PITCH;

  return {
    stations,
    tracks,
    branches,
    width: unknownColumn + BRANCH_GUTTER,
    height: lastY + BLUEPRINT_BOTTOM_PAD,
    evenlySpaced: knownMiles === 0,
  };
}
