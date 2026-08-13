"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type maplibregl from "maplibre-gl";
import { tflColour } from "@signaller/shared";
import { LiveMap } from "./live-map";
import { JourneyMapLayer } from "./journey-map-layer";
import { MapSheet, sheetHeightFraction, type SheetPosition } from "./map-sheet";
import { DestinationInput, type DestinationValue } from "./destination-input";
import { LegLiveArrivals } from "./leg-live-arrivals";
import { StationInput, type StationOption } from "./station-input";
import type { JourneyView } from "../lib/journeys";

/**
 * The map-first journey planner: a persistent live map with a draggable sheet
 * over it. Search in the sheet, and the planned journey draws on the map;
 * pick a leg and the map frames it.
 *
 * This wraps LiveMap rather than rewriting it — all the live-train, TfL and
 * signalling behaviour there is untouched, and this only adds the journey
 * overlay and the sheet. The /journeys page stays as the server-rendered,
 * shareable view of the same plan.
 */

type PlanState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; journeys: JourneyView[] };

function t(iso: string): string {
  if (!iso) return "--:--";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "--:--"
    : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/**
 * Swatch colour for a leg row. Must match colourFor() in journey-map-layer.tsx
 * so the sheet row and the drawn line read as the same thing.
 */
function legSwatchColour(mode: string, lineId?: string): string {
  if (mode === "rail") return "#1c2340";
  if (mode === "walk") return "#4a4e5c";
  return tflColour(lineId, mode) ?? "#1c2340";
}

/**
 * "Walk 8 min · 650m" when street routing gives us the numbers, plain "Walk"
 * when it doesn't. Distances round to the nearest 50m below a kilometre —
 * pavement routing isn't accurate to the metre, and "652m" implies it is.
 */
export function walkLabel(leg: { distanceMeters?: number; durationSeconds?: number }): string {
  const parts: string[] = ["Walk"];
  if (leg.durationSeconds !== undefined && leg.durationSeconds > 0) {
    parts.push(`${Math.max(1, Math.round(leg.durationSeconds / 60))} min`);
  }
  if (leg.distanceMeters !== undefined && leg.distanceMeters > 0) {
    parts.push(
      leg.distanceMeters < 1000
        ? `${Math.round(leg.distanceMeters / 50) * 50}m`
        : `${(leg.distanceMeters / 1000).toFixed(1)}km`,
    );
  }
  return parts.join(" · ");
}

/** Status wording — never colour alone, per PRODUCT.md. */
function statusLabel(journey: JourneyView): string {
  switch (journey.status) {
    case "cancelled":
      return "Cancelled";
    case "delayed":
      return journey.delayMinutes ? `${journey.delayMinutes} min late` : "Delayed";
    case "on-time":
      return "On time";
    default:
      return "Scheduled";
  }
}

interface Props {
  stations: StationOption[];
}

export function MapShell({ stations }: Props) {
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [sheet, setSheet] = useState<SheetPosition>("half");
  const [from, setFrom] = useState<StationOption | null>(null);
  const [to, setTo] = useState<DestinationValue | null>(null);
  const [plan, setPlan] = useState<PlanState>({ status: "idle" });
  const [selectedJourney, setSelectedJourney] = useState(0);
  const [selectedLeg, setSelectedLeg] = useState<number | null>(null);

  const journeys = plan.status === "done" ? plan.journeys : [];
  const active = journeys[selectedJourney];

  // Same filter the /journeys list uses: a same-station "walk" is transfer
  // time, not a leg to draw.
  const legs = useMemo(
    () => (active?.legs ?? []).filter((l) => !(l.mode === "walk" && l.originCrs === l.destCrs)),
    [active],
  );

  // Keep the map's usable area clear of the sheet, so a fitted route isn't
  // framed underneath it.
  const fitPadding = useMemo(() => {
    const bottom = Math.round(sheetHeightFraction(sheet) * 100);
    return { top: 72, bottom: bottom + 24, left: 40, right: 40 };
  }, [sheet]);

  const search = useCallback(async () => {
    if (!from || !to) return;
    const toParam =
      to.kind === "station" ? to.crs : to.kind === "place" ? `place:${to.uprn}` : `postcode:${to.text}`;

    setPlan({ status: "loading" });
    setSelectedJourney(0);
    setSelectedLeg(null);
    try {
      const params = new URLSearchParams({ from: from.crs, to: toParam });
      const res = await fetch(`/api/journeys?${params}`);
      if (!res.ok) {
        setPlan({
          status: "error",
          message:
            res.status === 503
              ? "The routing engine is offline. Try again shortly."
              : "Couldn't plan that journey.",
        });
        return;
      }
      // A "no journeys" outcome comes back as 200 with ok:false and no
      // journeys array — see app/api/journeys/route.ts — so an ok check is
      // needed as well as the HTTP status.
      const data = (await res.json()) as
        | { ok: true; journeys: JourneyView[] }
        | { ok: false; reason: string };
      const found = data.ok ? data.journeys : [];
      setPlan(
        found.length > 0
          ? { status: "done", journeys: found }
          : { status: "error", message: "No journeys found for that route." },
      );
      if (found.length > 0) setSheet("half");
    } catch {
      setPlan({ status: "error", message: "Couldn't reach the planner. Check your connection." });
    }
  }, [from, to]);

  // Clicking a route line on the map selects that leg, so the map and the
  // sheet stay two views of one selection rather than drifting apart.
  useEffect(() => {
    if (!map) return;
    const layer = "journey-route-line";
    function onClick(e: maplibregl.MapLayerMouseEvent) {
      const index = e.features?.[0]?.properties?.legIndex;
      if (typeof index === "number") setSelectedLeg(index);
    }
    function onEnter() {
      if (map) map.getCanvas().style.cursor = "pointer";
    }
    function onLeave() {
      if (map) map.getCanvas().style.cursor = "";
    }
    map.on("click", layer, onClick);
    map.on("mouseenter", layer, onEnter);
    map.on("mouseleave", layer, onLeave);
    return () => {
      map.off("click", layer, onClick);
      map.off("mouseenter", layer, onEnter);
      map.off("mouseleave", layer, onLeave);
    };
  }, [map]);

  return (
    <div className="map-shell">
      <LiveMap onMapReady={setMap} />
      <JourneyMapLayer map={map} legs={legs} selectedLeg={selectedLeg} fitPadding={fitPadding} />

      <MapSheet position={sheet} onPositionChange={setSheet} label="Journey planner">
        <form
          className="map-sheet-search"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <StationInput
            label="From"
            name="from"
            stations={stations}
            value={from}
            onChange={setFrom}
            placeholder="Station or code"
          />
          <DestinationInput
            label="To"
            name="to"
            value={to}
            onChange={setTo}
            placeholder="Station, place or postcode"
          />
          <button type="submit" className="btn-primary" disabled={!from || !to || plan.status === "loading"}>
            {plan.status === "loading" ? "Planning…" : "Plan journey"}
          </button>
        </form>

        {/* Announced politely so a result arriving doesn't interrupt typing. */}
        <div aria-live="polite" className="map-sheet-results">
          {plan.status === "error" && <p className="notice notice-warn">{plan.message}</p>}

          {plan.status === "done" && (
            <>
              <ol className="map-journey-list">
                {journeys.map((journey, i) => (
                  <li key={journey.id}>
                    <button
                      type="button"
                      className="map-journey-row"
                      aria-pressed={i === selectedJourney}
                      onClick={() => {
                        setSelectedJourney(i);
                        setSelectedLeg(null);
                      }}
                    >
                      <span className="map-journey-times">
                        {t(journey.liveDeparts ?? journey.departs)} → {t(journey.liveArrives ?? journey.arrives)}
                      </span>
                      <span className="map-journey-meta">
                        {durationLabel(journey.durationMinutes)} ·{" "}
                        {journey.changes === 0
                          ? "direct"
                          : `${journey.changes} change${journey.changes === 1 ? "" : "s"}`}
                      </span>
                      <span className={`map-journey-status status-${journey.status}`}>
                        {statusLabel(journey)}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>

              {active && (
                <ol className="map-leg-list">
                  {legs.map((leg, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className="map-leg-row"
                        aria-pressed={selectedLeg === i}
                        onClick={() => setSelectedLeg(selectedLeg === i ? null : i)}
                      >
                        <span className="map-leg-time">{t(leg.departs)}</span>
                        {/* Ties the sheet row to the line drawn on the map.
                            Decorative only — the mode is always named in text
                            beside it, so colour is never the sole cue. */}
                        <span
                          className="map-leg-swatch"
                          aria-hidden="true"
                          style={{ background: legSwatchColour(leg.mode, leg.lineId) }}
                        />
                        <span className="map-leg-body">
                          <span className="map-leg-station">{leg.originName}</span>
                          <span className="map-leg-mode">
                            {leg.mode === "walk" ? walkLabel(leg) : (leg.lineName ?? leg.operator ?? "Rail service")}
                            {leg.geometry ? "" : " · route not shown"}
                          </span>
                          <span className="map-leg-station">{leg.destName}</span>
                        </span>
                      </button>
                      {/* Live board for the stop you'd actually be standing
                          at — only for TfL legs; rail legs have their own
                          departure boards. */}
                      {selectedLeg === i && leg.mode !== "rail" && leg.mode !== "walk" && (
                        <LegLiveArrivals naptanId={leg.originCrs} lineId={leg.lineId} />
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      </MapSheet>
    </div>
  );
}
