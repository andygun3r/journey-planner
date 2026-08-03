"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SIGNALLING_CORRIDORS } from "@/lib/signalling-corridors";

/**
 * Traksy-style corridor signalling board. Draws the berth graph (auto-laid-out
 * server-side from SMART) as a single-lane linear track diagram, with live
 * headcodes riding their berths and signal aspects decoded from S-class where
 * SOP data exists. Signals with no SOP mapping render "unknown" (grey) —
 * honest to the data.
 *
 * Shown in a modal launched from a station board — every TD area signalling
 * that station, not one train's corridor. Live over SSE, with polling as the
 * fallback.
 *
 * The layout arrives once and stays put. It comes from SMART reference data and
 * does not change while the modal is open, but it used to be re-sent — hundreds
 * of berth nodes — on every 8-second poll. Only the aspects and the trains move,
 * so only those are streamed.
 */

interface LaidBerth {
  id: string;
  tdArea: string;
  berth: string;
  x: number;
  y: number;
  place?: string;
  crs?: string;
  platform?: string;
}
interface DiagramSignal {
  id: string;
  itemId?: string;
  aspect: "off" | "red" | "unknown";
  occupiedAhead?: boolean;
  routeSet?: boolean;
  berthAhead?: string;
  mapped: boolean;
  x: number;
  y: number;
}
interface DiagramTrain {
  headcode: string;
  berthId: string;
  lateness?: number;
  focus: boolean;
}
interface DiagramLayout {
  berths: LaidBerth[];
  edges: Array<{ from: string; to: string }>;
  width: number;
  height: number;
}
/** The moving part: what the signals show and where the trains are. */
interface DiagramState {
  generatedAt: string;
  areas: string[];
  focusHeadcode?: string;
  signals: DiagramSignal[];
  trains: DiagramTrain[];
  mappedAreas: number;
}
interface CorridorDiagram extends DiagramState {
  layout: DiagramLayout;
}

const SWML_STATION_NAMES: Record<string, string> = {
  WAT: "London Waterloo",
  VXH: "Vauxhall",
  QRB: "Queenstown Road",
  CLJ: "Clapham Junction",
  EAD: "Earlsfield",
  WIM: "Wimbledon",
  RAY: "Raynes Park",
  NEM: "New Malden",
  BRS: "Berrylands",
  SUR: "Surbiton",
  ESH: "Esher",
  HER: "Hersham",
  WAL: "Walton-on-Thames",
  WYB: "Weybridge",
  BFN: "Byfleet & New Haw",
  WBY: "West Byfleet",
  WOK: "Woking",
  BKO: "Brookwood",
  FNB: "Farnborough",
  FLE: "Fleet",
  WNF: "Winchfield",
  HOK: "Hook",
  BSK: "Basingstoke",
  MIC: "Micheldever",
  WIN: "Winchester",
  SHW: "Shawford",
  ESL: "Eastleigh",
  SOA: "Southampton Airport",
  SOU: "Southampton Central",
  MBK: "Millbrook",
  RDB: "Redbridge",
  TTN: "Totton",
  ANF: "Ashurst New Forest",
  BEU: "Beaulieu Road",
  BCU: "Brockenhurst",
  SWY: "Sway",
  NWM: "New Milton",
  HNA: "Hinton Admiral",
  CHR: "Christchurch",
  POK: "Pokesdown",
  BMH: "Bournemouth",
  BSM: "Branksome",
  PKS: "Parkstone",
  POO: "Poole",
  HAM: "Hamworthy",
  WRM: "Wareham",
  WOO: "Wool",
  MTN: "Moreton",
  DCH: "Dorchester South",
  UPW: "Upwey",
  WEY: "Weymouth",
};

const BLUEPRINT_LANES = [
  { id: "uf", label: "Up fast", y: 72 },
  { id: "df", label: "Down fast", y: 106 },
  { id: "us", label: "Up slow", y: 156 },
  { id: "ds", label: "Down slow", y: 190 },
] as const;
const WATERLOO_BRANCH_LANES = [
  { id: "wr-uf", label: "Windsor / Reading up fast", y: 232 },
  { id: "wr-df", label: "Windsor / Reading down fast", y: 258 },
  { id: "wr-us", label: "Windsor / Reading up slow", y: 284 },
  { id: "wr-ds", label: "Windsor / Reading down slow", y: 310 },
] as const;
const WATERLOO_THROAT_WIDTH = 250;
const BLUEPRINT_MARGIN_X = 54 + WATERLOO_THROAT_WIDTH;
const BLUEPRINT_STEP_X = 74;
const BLUEPRINT_TOP = 28;
const BLUEPRINT_HEIGHT = 450;
const WATERLOO_PLATFORMS = Array.from({ length: 24 }, (_, i) => i + 1);
const WATERLOO_PLATFORM_TOP = 34;
const WATERLOO_PLATFORM_STEP = 10;

const SWML_BRANCH_LINKS = [
  { crs: "CLJ", label: "Windsor / Reading / Richmond", href: "/signalling/windsor-reading" },
  { crs: "RAY", label: "Epsom / Dorking", href: "/signalling/epsom" },
  { crs: "RAY", label: "Chessington South", href: "/signalling/chessington" },
  { crs: "NEM", label: "Kingston loop / Shepperton", href: "/signalling/kingston-shepperton" },
  { crs: "SUR", label: "Hampton Court", href: "/signalling/hampton-court" },
  { crs: "SUR", label: "Guildford via Cobham", href: "/signalling/guildford-cobham" },
  { crs: "WYB", label: "Chertsey / Staines", href: "/signalling/chertsey" },
  { crs: "WOK", label: "Portsmouth Direct", href: "/signalling/portsmouth-direct" },
  { crs: "BKO", label: "Alton / Ascot", href: "/signalling/alton-ascot" },
  { crs: "BSK", label: "Salisbury / Exeter", href: "/signalling/west-of-england" },
  { crs: "BSK", label: "Reading / Berks & Hants", href: "/signalling/reading-basingstoke" },
  { crs: "ESL", label: "Portsmouth via Fareham", href: "/signalling/fareham" },
  { crs: "ESL", label: "Romsey / Netley", href: "/signalling/romsey-netley" },
  { crs: "BCU", label: "Lymington branch", href: "/signalling/lymington" },
];

function laneIndexForBerth(berth: string): number {
  const digits = berth.match(/\d/g)?.join("");
  if (digits) return Number(digits.slice(-1)) % BLUEPRINT_LANES.length;
  let hash = 0;
  for (const c of berth) hash += c.charCodeAt(0);
  return hash % BLUEPRINT_LANES.length;
}

function readableStationName(crs: string, berths: LaidBerth[]): string {
  const fromData = berths.find((b) => b.crs === crs && b.place)?.place;
  return fromData ?? SWML_STATION_NAMES[crs] ?? crs;
}

function numericPlatform(platform: string | undefined): number | undefined {
  const match = platform?.match(/\d+/);
  return match ? Number(match[0]) : undefined;
}

function waterlooPlatformY(platform: string | undefined): number | undefined {
  const n = numericPlatform(platform);
  if (!n || n < 1 || n > WATERLOO_PLATFORMS.length) return undefined;
  return WATERLOO_PLATFORM_TOP + (n - 1) * WATERLOO_PLATFORM_STEP;
}

function laneForPlatform(
  crs: string,
  platform: string | undefined,
  fallbackSeed: string,
): (typeof BLUEPRINT_LANES)[number] | (typeof WATERLOO_BRANCH_LANES)[number] {
  const n = numericPlatform(platform);
  const [upFast, downFast, upSlow, downSlow] = BLUEPRINT_LANES;
  const [windsorUpFast, windsorDownFast, windsorUpSlow, windsorDownSlow] = WATERLOO_BRANCH_LANES;

  if (crs === "CLJ" && n) {
    if (n <= 6) return n % 2 === 0 ? windsorDownFast : windsorUpFast;
    if (n <= 8) return n % 2 === 0 ? downFast ?? upFast : upFast;
    if (n <= 11) return n % 2 === 0 ? downSlow ?? downFast ?? upFast : upSlow ?? upFast;
    return n % 2 === 0 ? windsorDownSlow : windsorUpSlow;
  }

  if (n) {
    if (n <= 2) return n % 2 === 0 ? downFast ?? upFast : upFast;
    return n % 2 === 0 ? downSlow ?? downFast ?? upFast : upSlow ?? upFast;
  }

  return BLUEPRINT_LANES[laneIndexForBerth(fallbackSeed)] ?? upFast;
}

function trainYForBerth(
  crs: string,
  berth: LaidBerth,
  fallbackLane: (typeof BLUEPRINT_LANES)[number] | (typeof WATERLOO_BRANCH_LANES)[number],
): number {
  const waterlooY = crs === "WAT" ? waterlooPlatformY(berth.platform) : undefined;
  if (waterlooY !== undefined) return waterlooY;
  return fallbackLane.y;
}

interface BlueprintStation {
  crs: string;
  name: string;
  x: number;
  berthCount: number;
  platforms: Set<string>;
  tdAreas: Set<string>;
}

interface SwmlBlueprintModel {
  stations: BlueprintStation[];
  trainsByStation: Map<string, Array<DiagramTrain & { berth: LaidBerth }>>;
  signalCounts: Map<
    string,
    { off: number; red: number; unknown: number; mapped: number; routeSet: number }
  >;
  areaBands: Array<{ area: string; x1: number; x2: number }>;
  width: number;
  height: number;
}

function SwmlBlueprint({
  blueprint,
}: {
  blueprint: SwmlBlueprintModel;
  data: DiagramState;
}) {
  const firstX = blueprint.stations[0]?.x ?? BLUEPRINT_MARGIN_X;
  const lastX = blueprint.stations.at(-1)?.x ?? firstX;
  const [upFast, downFast, upSlow, downSlow] = BLUEPRINT_LANES;
  if (!upFast || !downFast || !upSlow || !downSlow) return null;
  const junctions = new Set(["WAT", "CLJ", "WOK", "BSK", "ESL", "SOU", "BCU", "BMH", "POO"]);
  const waterlooX = blueprint.stations.find((station) => station.crs === "WAT")?.x ?? firstX;
  const claphamX = blueprint.stations.find((station) => station.crs === "CLJ")?.x ?? waterlooX + 3 * BLUEPRINT_STEP_X;
  const waterlooFanInX = waterlooX - 28;
  const waterlooPlatformEndX = waterlooX - 102;
  const waterlooPlatformStartX = 34;
  const laneTargets = [
    upFast.y,
    downFast.y,
    upSlow.y,
    downSlow.y,
    WATERLOO_BRANCH_LANES[0]?.y ?? downSlow.y,
    WATERLOO_BRANCH_LANES[1]?.y ?? downSlow.y,
    WATERLOO_BRANCH_LANES[2]?.y ?? downSlow.y,
    WATERLOO_BRANCH_LANES[3]?.y ?? downSlow.y,
  ];

  return (
    <>
      <rect
        x={0}
        y={0}
        width={blueprint.width}
        height={blueprint.height}
        className="sig-blueprint-paper"
      />

      <g className="sig-blueprint-areas" aria-hidden="true">
        {blueprint.areaBands.map((band, i) => (
          <g key={band.area}>
            <rect
              x={Math.max(0, band.x1)}
              y={BLUEPRINT_TOP}
              width={Math.max(22, band.x2 - band.x1)}
              height={BLUEPRINT_HEIGHT - BLUEPRINT_TOP - 62}
              className={i % 2 === 0 ? "sig-blueprint-area" : "sig-blueprint-area-alt"}
            />
            <text x={band.x1 + 8} y={BLUEPRINT_TOP + 14} className="sig-blueprint-area-label">
              {band.area}
            </text>
          </g>
        ))}
      </g>

      <g className="sig-blueprint-lanes">
        {BLUEPRINT_LANES.map((lane) => (
          <g key={lane.id}>
            <line
              x1={lane.id.startsWith("u") ? waterlooFanInX : firstX - 28}
              y1={lane.y}
              x2={lastX + 28}
              y2={lane.y}
              className="sig-blueprint-road"
            />
            <text x={16} y={lane.y + 4} className="sig-blueprint-road-label">
              {lane.label}
            </text>
          </g>
        ))}
        {WATERLOO_BRANCH_LANES.map((lane) => (
          <g key={lane.id}>
            <line
              x1={waterlooFanInX}
              y1={lane.y}
              x2={claphamX + 28}
              y2={lane.y}
              className="sig-blueprint-road sig-blueprint-road-branch"
            />
            <text x={16} y={lane.y + 4} className="sig-blueprint-road-label">
              {lane.label}
            </text>
          </g>
        ))}
      </g>

      <g className="sig-blueprint-waterloo" aria-label="London Waterloo platform throat">
        <text x={waterlooPlatformStartX} y={20} className="sig-blueprint-terminal-title">
          London Waterloo
        </text>
        <rect
          x={waterlooPlatformStartX - 4}
          y={WATERLOO_PLATFORM_TOP - 11}
          width={waterlooPlatformEndX - waterlooPlatformStartX + 10}
          height={(WATERLOO_PLATFORMS.length - 1) * WATERLOO_PLATFORM_STEP + 22}
          rx={4}
          className="sig-blueprint-terminal-box"
        />
        {WATERLOO_PLATFORMS.map((platform) => {
          const y = WATERLOO_PLATFORM_TOP + (platform - 1) * WATERLOO_PLATFORM_STEP;
          const targetY = laneTargets[(platform - 1) % laneTargets.length] ?? downFast.y;
          return (
            <g key={platform}>
              <line
                x1={waterlooPlatformStartX + 28}
                y1={y}
                x2={waterlooPlatformEndX}
                y2={y}
                className="sig-blueprint-platform-road"
              />
              <path
                d={`M ${waterlooPlatformEndX} ${y} C ${waterlooPlatformEndX + 42} ${y}, ${waterlooFanInX - 34} ${targetY}, ${waterlooFanInX} ${targetY}`}
                className="sig-blueprint-platform-fan"
              />
              <rect
                x={waterlooPlatformStartX + 2}
                y={y - 4}
                width={20}
                height={8}
                rx={1.5}
                className="sig-blueprint-platform-number-box"
              />
              <text
                x={waterlooPlatformStartX + 12}
                y={y + 2.5}
                className="sig-blueprint-platform-number"
                textAnchor="middle"
              >
                {platform}
              </text>
            </g>
          );
        })}
      </g>

      <g className="sig-blueprint-junctions" aria-hidden="true">
        {blueprint.stations
          .filter((station) => junctions.has(station.crs))
          .map((station) => (
            <g key={station.crs}>
              <line
                x1={station.x - 20}
                y1={upFast.y}
                x2={station.x + 20}
                y2={upSlow.y}
                className="sig-blueprint-crossover"
              />
              <line
                x1={station.x - 20}
                y1={downFast.y}
                x2={station.x + 20}
                y2={downSlow.y}
                className="sig-blueprint-crossover"
              />
            </g>
          ))}
      </g>

      <g className="sig-blueprint-branches">
        {SWML_BRANCH_LINKS.map((branch, i) => {
          const station = blueprint.stations.find((s) => s.crs === branch.crs);
          if (!station) return null;
          const isWindsorReading = branch.crs === "CLJ";
          const sameStationIndex = SWML_BRANCH_LINKS.slice(0, i).filter((b) => b.crs === branch.crs).length;
          const y = isWindsorReading
            ? WATERLOO_BRANCH_LANES[3]?.y ?? downSlow.y
            : i % 2 === 0
              ? upFast.y - 38 - sameStationIndex * 18
              : downSlow.y + 34 + sameStationIndex * 18;
          const joinY = isWindsorReading ? y : i % 2 === 0 ? upFast.y : downSlow.y;
          const labelY = isWindsorReading ? y + 24 : y + 4;
          return (
            <a key={branch.href} href={branch.href} className="sig-blueprint-branch-link">
              <path
                d={
                  isWindsorReading
                    ? `M ${claphamX + 28} ${joinY} C ${claphamX + 52} ${joinY}, ${claphamX + 62} ${joinY + 22}, ${claphamX + 96} ${joinY + 22}`
                    : `M ${station.x} ${joinY} C ${station.x + 24} ${joinY}, ${station.x + 30} ${y}, ${station.x + 64} ${y}`
                }
                className="sig-blueprint-branch-road"
              />
              <circle
                cx={isWindsorReading ? claphamX + 96 : station.x + 64}
                cy={isWindsorReading ? joinY + 22 : y}
                r={5}
                className="sig-blueprint-branch-node"
              />
              <text
                x={isWindsorReading ? claphamX + 106 : station.x + 74}
                y={labelY}
                className="sig-blueprint-branch-label"
              >
                {branch.label}
              </text>
            </a>
          );
        })}
      </g>

      <g className="sig-blueprint-stations">
        {blueprint.stations.map((station, i) => {
          const isMajor = station.berthCount > 28 || junctions.has(station.crs);
          const platformCount = station.platforms.size;
          return (
            <g key={station.crs}>
              <line
                x1={station.x}
                y1={upFast.y - 18}
                x2={station.x}
                y2={downSlow.y + 18}
                className={isMajor ? "sig-blueprint-station-major" : "sig-blueprint-station"}
              />
              {platformCount > 0 && (
                <rect
                  x={station.x - 16}
                  y={downFast.y + 12}
                  width={32}
                  height={28}
                  rx={3}
                  className="sig-blueprint-platforms"
                >
                  <title>
                    {station.name}: {platformCount} platform{platformCount === 1 ? "" : "s"} in
                    matched berth data
                  </title>
                </rect>
              )}
              <text
                x={station.x}
                y={386}
                className={isMajor ? "sig-blueprint-station-label-major" : "sig-blueprint-station-label"}
                textAnchor="end"
                transform={`rotate(-35 ${station.x} 386)`}
              >
                {isMajor ? station.name : station.crs}
              </text>
              {i % 5 === 0 && (
                <text x={station.x} y={420} className="sig-blueprint-chainage" textAnchor="middle">
                  {station.crs}
                </text>
              )}
            </g>
          );
        })}
      </g>

      <g className="sig-blueprint-signals">
        {blueprint.stations.map((station) => {
          const counts = blueprint.signalCounts.get(station.crs);
          if (!counts) return null;
          const signals = [
            ...Array.from({ length: Math.min(counts.red, 3) }, (_, i) => ({ aspect: "red", i })),
            ...Array.from({ length: Math.min(counts.off, 3) }, (_, i) => ({ aspect: "off", i })),
            ...Array.from({ length: Math.min(counts.unknown, 3) }, (_, i) => ({
              aspect: "unknown",
              i,
            })),
          ].slice(0, 5);
          return (
            <g key={station.crs}>
              {counts.routeSet > 0 && (
                <line
                  x1={station.x - 18}
                  y1={upFast.y - 10}
                  x2={station.x + 18}
                  y2={downFast.y + 10}
                  className="sig-blueprint-route"
                />
              )}
              {signals.map((signal, i) => (
                <circle
                  key={`${station.crs}-${signal.aspect}-${i}`}
                  cx={station.x - 20 + i * 9}
                  cy={upFast.y - 18}
                  r={3.2}
                  className={`sig-signal-head sig-signal-${signal.aspect}`}
                >
                  <title>
                    {station.name}: {counts.red} red, {counts.off} off, {counts.unknown} unknown
                  </title>
                </circle>
              ))}
            </g>
          );
        })}
      </g>

      <g className="sig-blueprint-trains">
        {blueprint.stations.flatMap((station) => {
          const trains = blueprint.trainsByStation.get(station.crs) ?? [];
          return trains.slice(0, 4).map((train, i) => {
            const lane = laneForPlatform(station.crs, train.berth.platform, train.berth.berth);
            const y = trainYForBerth(station.crs, train.berth, lane);
            const terminalX = station.crs === "WAT" ? waterlooPlatformEndX - 22 : station.x;
            const x = terminalX + (i - Math.min(trains.length, 4) / 2 + 0.5) * 42;
            return (
              <g key={`${train.headcode}-${train.berthId}`} className={train.focus ? "sig-train-focus" : ""}>
                <rect
                  x={x - 18}
                  y={y - 8}
                  width={36}
                  height={16}
                  rx={2}
                  className={`sig-berth-occupied${train.focus ? " sig-berth-focus" : ""}`}
                >
                  <title>
                    {train.headcode} at {station.name}, berth {train.berth.tdArea}{" "}
                    {train.berth.berth}
                  </title>
                </rect>
                <text
                  x={x}
                  y={y + 0.5}
                  className="sig-headcode sig-blueprint-headcode"
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {train.headcode}
                </text>
              </g>
            );
          });
        })}
      </g>
    </>
  );
}

export function SignallingDiagram({
  query,
  title,
  mode = "modal",
  variant = "topology",
  onClose,
}: {
  query: string; // e.g. "trainId=TD:1A23" or "rid=..."
  title: string;
  mode?: "modal" | "inline";
  variant?: "topology" | "blueprint";
  onClose?: () => void;
}) {
  const [layout, setLayout] = useState<DiagramLayout | null>(null);
  const [data, setData] = useState<DiagramState | null>(null);
  const [error, setError] = useState(false);

  const fetchDiagram = useCallback(async () => {
    try {
      const res = await fetch(`/api/signalling?${query}`, { cache: "no-store" });
      if (!res.ok) throw new Error("bad");
      const json = (await res.json()) as CorridorDiagram;
      // The polling endpoint still returns both halves together; split them so
      // the rest of the component doesn't care which path the data came from.
      setLayout(json.layout);
      setData(json);
      setError(false);
    } catch {
      setError(true);
    }
  }, [query]);

  // Same shape as the map and the alert feed: stream first, poll to cover the
  // gaps, and the mutual-exclusion guard in startPolling is what stops a tab
  // doing both at once.
  useEffect(() => {
    let stopped = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const startPolling = () => {
      if (stopped || poll) return;
      void fetchDiagram();
      poll = setInterval(() => void fetchDiagram(), 8_000);
    };
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = undefined;
    };

    const open = () => {
      if (stopped) return;
      if (typeof window === "undefined" || !("EventSource" in window)) {
        startPolling();
        return;
      }

      // Draw something immediately, and keep drawing if a proxy buffers the
      // stream — a failure that otherwise looks exactly like a quiet corridor.
      startPolling();

      const es = new EventSource(`/api/live/signalling?${query}`);

      es.addEventListener("ready", () => {
        attempt = 0;
        stopPolling();
      });

      // No Redis on the server, so the stream has no trigger. Retrying won't
      // help; stay on polling.
      es.addEventListener("unavailable", () => {
        es.close();
        startPolling();
      });

      es.addEventListener("layout", (ev) => {
        const parsed = JSON.parse((ev as MessageEvent<string>).data) as { layout: DiagramLayout };
        setLayout(parsed.layout);
      });

      es.addEventListener("state", (ev) => {
        attempt = 0;
        stopPolling();
        setData(JSON.parse((ev as MessageEvent<string>).data) as DiagramState);
        setError(false);
      });

      es.onerror = () => {
        es.close();
        if (stopped) return;
        startPolling();
        attempt += 1;
        reconnect = setTimeout(open, Math.min(1000 * 2 ** attempt, 60_000));
      };
    };

    open();

    return () => {
      stopped = true;
      stopPolling();
      if (reconnect) clearTimeout(reconnect);
    };
  }, [fetchDiagram, query]);

  // Close on Escape.
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Keyed on the layout, not the data, so it stops rebuilding on every update.
  // It used to be thrown away and reconstructed 7.5 times a minute even though
  // the berths it indexes never moved.
  const berthById = useMemo(() => {
    const m = new Map<string, LaidBerth>();
    for (const b of layout?.berths ?? []) m.set(b.id, b);
    return m;
  }, [layout]);

  const areaBands = useMemo(() => {
    const bands = new Map<string, { area: string; minY: number; maxY: number }>();
    for (const b of layout?.berths ?? []) {
      const band = bands.get(b.tdArea);
      if (!band) {
        bands.set(b.tdArea, { area: b.tdArea, minY: b.y, maxY: b.y });
      } else {
        band.minY = Math.min(band.minY, b.y);
        band.maxY = Math.max(band.maxY, b.y);
      }
    }
    return [...bands.values()].sort((a, b) => a.minY - b.minY);
  }, [layout]);

  // One label per distinct place, at its leftmost x, so a station spanning many
  // berths/platforms only gets labelled once. Ranks near the start of a large
  // area can bunch dozens of distinct places into a narrow x range (many
  // source nodes with no incoming edge all land at x=MARGIN); labelling every
  // one there would just overlap into an unreadable smear, so once sorted by
  // x we drop any label too close to the one already placed.
  const MIN_LABEL_GAP = 60;
  const placeLabels = useMemo(() => {
    const leftmost = new Map<string, number>();
    for (const b of layout?.berths ?? []) {
      if (!b.place) continue;
      const x = leftmost.get(b.place);
      if (x === undefined || b.x < x) leftmost.set(b.place, b.x);
    }
    const sorted = [...leftmost.entries()]
      .map(([place, x]) => ({ place, x }))
      .sort((a, b) => a.x - b.x);
    const spaced: typeof sorted = [];
    let lastX = -Infinity;
    for (const label of sorted) {
      if (label.x - lastX < MIN_LABEL_GAP) continue;
      spaced.push(label);
      lastX = label.x;
    }
    return spaced;
  }, [layout]);

  const swmlBlueprint = useMemo(() => {
    if (variant !== "blueprint" || !layout || !data || !query.includes("corridor=swml")) {
      return null;
    }

    const stationCrs = SIGNALLING_CORRIDORS.swml.stationCrs;
    const stationIndex = new Map(stationCrs.map((crs, i) => [crs, i]));
    const stationStats = new Map<
      string,
      {
        crs: string;
        name: string;
        x: number;
        berthCount: number;
        platforms: Set<string>;
        tdAreas: Set<string>;
      }
    >();
    for (const crs of stationCrs) {
      const i = stationIndex.get(crs) ?? 0;
      stationStats.set(crs, {
        crs,
        name: readableStationName(crs, layout.berths),
        x: BLUEPRINT_MARGIN_X + i * BLUEPRINT_STEP_X,
        berthCount: 0,
        platforms: new Set(),
        tdAreas: new Set(),
      });
    }
    for (const berth of layout.berths) {
      if (!berth.crs) continue;
      const stat = stationStats.get(berth.crs);
      if (!stat) continue;
      stat.berthCount += 1;
      if (berth.platform) stat.platforms.add(berth.platform);
      stat.tdAreas.add(berth.tdArea);
    }

    const trainsByStation = new Map<string, Array<DiagramTrain & { berth: LaidBerth }>>();
    for (const train of data.trains) {
      const berth = berthById.get(train.berthId);
      if (!berth?.crs || !stationStats.has(berth.crs)) continue;
      const list = trainsByStation.get(berth.crs);
      if (list) list.push({ ...train, berth });
      else trainsByStation.set(berth.crs, [{ ...train, berth }]);
    }

    const signalCounts = new Map<
      string,
      { off: number; red: number; unknown: number; mapped: number; routeSet: number }
    >();
    for (const signal of data.signals) {
      const berth = signal.berthAhead ? berthById.get(signal.berthAhead) : undefined;
      if (!berth?.crs || !stationStats.has(berth.crs)) continue;
      const counts =
        signalCounts.get(berth.crs) ?? { off: 0, red: 0, unknown: 0, mapped: 0, routeSet: 0 };
      counts[signal.aspect] += 1;
      if (signal.mapped) counts.mapped += 1;
      if (signal.routeSet) counts.routeSet += 1;
      signalCounts.set(berth.crs, counts);
    }

    const areaBands = data.areas.map((area) => {
      const xs = [...stationStats.values()]
        .filter((station) => station.tdAreas.has(area))
        .map((station) => station.x);
      if (!xs.length) return null;
      return { area, x1: Math.min(...xs) - 28, x2: Math.max(...xs) + 28 };
    }).filter((band): band is { area: string; x1: number; x2: number } => Boolean(band));

    return {
      stations: [...stationStats.values()],
      trainsByStation,
      signalCounts,
      areaBands,
      width: BLUEPRINT_MARGIN_X * 2 + (stationCrs.length - 1) * BLUEPRINT_STEP_X,
      height: BLUEPRINT_HEIGHT,
    };
  }, [berthById, data, layout, query, variant]);

  const hasBerths = (layout?.berths.length ?? 0) > 0;
  const LABEL_BAND = 70;
  const isBlueprint = Boolean(swmlBlueprint);
  const viewBoxWidth = swmlBlueprint?.width ?? layout?.width ?? 0;
  const viewBoxHeight = isBlueprint
    ? BLUEPRINT_HEIGHT
    : (layout?.height ?? 0) + (placeLabels.length ? LABEL_BAND : 0);
  // Render close to native size (viewBox units are already pixel-scale, e.g.
  // 90px per berth column) rather than stretching to the modal's width — a
  // wide/tall corridor stays legible and the board scrolls instead of
  // squashing everything into the panel.
  const SCALE = isBlueprint ? 1 : mode === "inline" ? 0.85 : 1.5;
  const renderWidth = viewBoxWidth * SCALE;
  const renderHeight = viewBoxHeight * SCALE;

  const panel = (
      <div className={`sig-panel${isBlueprint ? " sig-panel-blueprint" : ""}`}>
        <div className="sig-head">
          <div>
            <h2 className="sig-title">Signalling · {title}</h2>
            {data && (
              <p className="sig-sub">
                {data.areas.length ? `TD area ${data.areas.join(", ")}` : "No area"} ·{" "}
                {data.mappedAreas > 0
                  ? `${data.mappedAreas}/${data.areas.length} area(s) with signal data`
                  : "no SOP signal data for these areas"}
              </p>
            )}
          </div>
          {onClose && (
            <button type="button" className="sig-close" onClick={onClose} aria-label="Close">
              ×
            </button>
          )}
        </div>

        <div className={`sig-board${isBlueprint ? " sig-board-blueprint" : ""}`}>
          {error && <p className="sig-empty">Signalling data offline.</p>}
          {!error && !data && <p className="sig-empty">Loading signalling…</p>}
          {!error && data && !hasBerths && (
            <p className="sig-empty">
              No berth topology for this corridor yet — SMART reference data is needed for its TD
              area(s).
            </p>
          )}
          {hasBerths && layout && data && (
            <svg
              viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
              width={renderWidth}
              height={renderHeight}
              className={`sig-svg${isBlueprint ? " sig-blueprint-svg" : ""}`}
              role="img"
              aria-label="Corridor signalling diagram"
            >
              {swmlBlueprint ? (
                <SwmlBlueprint
                  blueprint={swmlBlueprint}
                  data={data}
                />
              ) : (
                <>
                  <g className="sig-area-bands" aria-hidden="true">
                {areaBands.map((band, i) => (
                  <g key={band.area}>
                    <rect
                      x={0}
                      y={Math.max(0, band.minY - 24)}
                      width={layout.width}
                      height={band.maxY - band.minY + 48}
                      className={i % 2 === 0 ? "sig-area-band" : "sig-area-band-alt"}
                    />
                    <text x={8} y={band.minY - 8} className="sig-area-label">
                      {band.area}
                    </text>
                  </g>
                ))}
              </g>
              {/* Track edges */}
              <g className="sig-edges">
                {layout.edges.map((e, i) => {
                  const a = berthById.get(e.from);
                  const b = berthById.get(e.to);
                  if (!a || !b) return null;
                  return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="sig-track" />;
                })}
              </g>
              {/* Route-set overlay: a highlighted line from a signal to the berth its route protects. */}
              <g className="sig-routes">
                {data.signals.map((s) => {
                  if (!s.routeSet || !s.berthAhead) return null;
                  const ahead = berthById.get(s.berthAhead);
                  if (!ahead) return null;
                  return (
                    <line
                      key={`route-${s.id}`}
                      x1={s.x}
                      y1={s.y}
                      x2={ahead.x}
                      y2={ahead.y}
                      className="sig-route-set"
                    />
                  );
                })}
              </g>
              {/* Signals: a short trackside post with a coloured head, angled off the line. */}
              <g className="sig-signals">
                {data.signals.map((s) => (
                  <g key={s.id} className="sig-signal-mark">
                    <line x1={s.x} y1={s.y} x2={s.x} y2={s.y - 8} className="sig-signal-post" />
                    <circle
                      cx={s.x}
                      cy={s.y - 8}
                      r={3}
                      className={`sig-signal-head sig-signal-${s.aspect}`}
                    >
                      <title>
                        {s.itemId ? `Signal ${s.itemId}: ` : "Signal: "}
                        {s.aspect === "unknown" ? "no data" : s.aspect}
                        {s.routeSet ? " · route set" : ""}
                      </title>
                    </circle>
                    {s.mapped && s.itemId && (
                      <text x={s.x} y={s.y - 12} className="sig-signal-label" textAnchor="middle">
                        {s.itemId}
                      </text>
                    )}
                  </g>
                ))}
              </g>
              {/* Berths */}
              <g className="sig-berths">
                {layout.berths.map((b) => (
                  <rect
                    key={b.id}
                    x={b.x - 11}
                    y={b.y - 7}
                    width={22}
                    height={14}
                    rx={2}
                    className="sig-berth"
                  >
                    <title>
                      {b.place ? `${b.place} — ` : ""}
                      {b.tdArea} berth {b.berth}
                      {b.platform ? ` · platform ${b.platform}` : ""}
                    </title>
                  </rect>
                ))}
              </g>
              {/* Trains riding their berths */}
              <g className="sig-trains">
                {data.trains.map((t) => {
                  const b = berthById.get(t.berthId);
                  if (!b) return null;
                  return (
                    <g key={t.headcode + t.berthId} className={t.focus ? "sig-train-focus" : ""}>
                      <rect
                        x={b.x - 11}
                        y={b.y - 7}
                        width={22}
                        height={14}
                        rx={2}
                        className={`sig-berth-occupied${t.focus ? " sig-berth-focus" : ""}`}
                      />
                      <text
                        x={b.x}
                        y={b.y}
                        className="sig-headcode"
                        textAnchor="middle"
                        dominantBaseline="middle"
                      >
                        {t.headcode}
                      </text>
                    </g>
                  );
                })}
              </g>
              {/* Station/place labels, once per distinct place, below the track. */}
              <g className="sig-places">
                {placeLabels.map(({ place, x }) => (
                  <text
                    key={place}
                    x={x}
                    y={layout.height + 16}
                    className="sig-place-label"
                    textAnchor="end"
                    transform={`rotate(-40 ${x} ${layout.height + 16})`}
                  >
                    {place}
                  </text>
                ))}
              </g>
                </>
              )}
            </svg>
          )}
        </div>

        <p className="sig-legend">
          <span className="sig-key sig-key-off">Off (clear)</span>
          <span className="sig-key sig-key-red">On (red)</span>
          <span className="sig-key sig-key-route">Route set</span>
          <span className="sig-key sig-key-unknown">No data</span>
          <span className="sig-legend-note">
            Aspects decoded from Network Rail TD S-class where SOP maps exist. Legacy areas without
            published maps show “no data”. Signals are matched to their decoded data by position
            along the line, not a verified id — even a signal showing a real aspect may be paired
            to the wrong one.
          </span>
        </p>
      </div>
  );

  if (mode === "inline") {
    return (
      <section className="sig-inline" aria-label="Signalling diagram">
        {panel}
      </section>
    );
  }

  return (
    <div className="sig-modal" role="dialog" aria-modal="true" aria-label="Signalling diagram">
      <div className="sig-backdrop" onClick={onClose} />
      {panel}
    </div>
  );
}
