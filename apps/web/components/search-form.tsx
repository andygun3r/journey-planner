"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DestinationInput, type DestinationValue } from "./destination-input";
import { StationInput, type StationOption } from "./station-input";
import { recordRecent } from "./use-recents";

interface Props {
  stations?: StationOption[];
  initialFrom?: StationOption | null;
  initialTo?: StationOption | null;
}

type Origin =
  | { mode: "gps"; status: "idle" | "locating" | "denied" | "timeout" | "unsupported"; lat?: number; lon?: number }
  | { mode: "manual"; station: StationOption | null };

const GPS_TIMEOUT_MS = 8000;

function locate(): Promise<{ lat: number; lon: number } | "denied" | "timeout" | "unsupported"> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve("unsupported");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => resolve(err.code === err.TIMEOUT ? "timeout" : "denied"),
      { timeout: GPS_TIMEOUT_MS },
    );
  });
}

export function SearchForm({ stations, initialFrom = null, initialTo = null }: Props) {
  const router = useRouter();
  const [origin, setOrigin] = useState<Origin>({ mode: "gps", status: "idle" });
  const [to, setTo] = useState<DestinationValue | null>(
    initialTo ? { kind: "station", crs: initialTo.crs, name: initialTo.name } : null,
  );
  const [when, setWhen] = useState("");
  const [arriveBy, setArriveBy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const manualFrom = origin.mode === "manual" ? origin.station : initialFrom;

  const ready =
    to !== null &&
    (origin.mode === "manual" ? origin.station !== null : true) &&
    !(to.kind === "station" && origin.mode === "manual" && origin.station?.crs === to.crs);

  async function useMyLocation() {
    setOrigin({ mode: "gps", status: "locating" });
    const result = await locate();
    if (result === "denied" || result === "timeout" || result === "unsupported") {
      setOrigin({ mode: "gps", status: result });
      return;
    }
    setOrigin({ mode: "gps", status: "idle", lat: result.lat, lon: result.lon });
  }

  function switchToManual() {
    setOrigin({ mode: "manual", station: manualFrom });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (!ready || !to) return;

    let fromParam: string;
    let fromLabel: string;
    if (origin.mode === "manual") {
      if (!origin.station) return;
      fromParam = origin.station.crs;
      fromLabel = origin.station.name;
    } else if (origin.lat !== undefined && origin.lon !== undefined) {
      fromParam = `geo:${origin.lat},${origin.lon}`;
      fromLabel = "Your location";
    } else {
      // GPS chip tapped "Find trains" before a fix resolved (or after a
      // denial) — request it now rather than submitting nothing.
      setOrigin({ mode: "gps", status: "locating" });
      const result = await locate();
      if (result === "denied" || result === "timeout" || result === "unsupported") {
        setOrigin({ mode: "gps", status: result });
        setNotice(
          result === "denied"
            ? "Location access was denied — search by station instead."
            : result === "timeout"
              ? "Couldn't get a location fix in time — search by station instead."
              : "Location isn't available on this device — search by station instead.",
        );
        return;
      }
      setOrigin({ mode: "gps", status: "idle", lat: result.lat, lon: result.lon });
      fromParam = `geo:${result.lat},${result.lon}`;
      fromLabel = "Your location";
    }

    const toParam = to.kind === "station" ? to.crs : `postcode:${to.text}`;
    const toLabel = to.kind === "station" ? to.name : to.text;

    setSubmitting(true);
    recordRecent({ from: fromParam, fromName: fromLabel, to: toParam, toName: toLabel });
    const params = new URLSearchParams({ from: fromParam, to: toParam });
    if (when) params.set("when", new Date(when).toISOString());
    // arriveBy only meaningful with an explicit time.
    if (when && arriveBy) params.set("arriveBy", "1");
    router.push(`/journeys?${params}`);
  }

  return (
    <form className="search-panel" onSubmit={submit}>
      <div className="search-grid">
        {origin.mode === "gps" ? (
          <div className="field">
            <span className="field-label-row">
              <label>From</label>
            </span>
            <div className="origin-chip-row">
              <button
                type="button"
                className="origin-chip"
                onClick={() => void useMyLocation()}
                disabled={origin.status === "locating"}
              >
                <span aria-hidden="true">📍</span>{" "}
                {origin.status === "locating"
                  ? "Finding your location…"
                  : origin.status === "denied"
                    ? "Location denied — tap to retry"
                    : origin.status === "timeout"
                      ? "Couldn't get a fix — tap to retry"
                      : origin.status === "unsupported"
                        ? "Location unavailable"
                        : origin.lat !== undefined
                          ? "Your location"
                          : "Use my location"}
              </button>
              <button type="button" className="origin-change-btn" onClick={switchToManual}>
                Change
              </button>
            </div>
          </div>
        ) : (
          <StationInput
            label="From"
            name="from"
            stations={stations}
            value={origin.station}
            onChange={(station) => setOrigin({ mode: "manual", station })}
            placeholder="Station name or code"
          />
        )}
        <button
          type="button"
          className="swap-btn"
          aria-label="Swap origin and destination"
          aria-disabled={origin.mode === "gps"}
          disabled={origin.mode === "gps"}
          onClick={() => {
            if (origin.mode !== "manual" || to?.kind !== "station") return;
            const prevFrom = origin.station;
            setOrigin({ mode: "manual", station: to });
            setTo(prevFrom ? { kind: "station", crs: prevFrom.crs, name: prevFrom.name } : null);
          }}
        >
          ⇅
        </button>
        <DestinationInput
          label="To"
          name="to"
          value={to}
          onChange={setTo}
          placeholder="Station, postcode or code"
        />
      </div>
      <div className="search-row-2">
        <div className="field">
          <span className="field-label-row">
            <label htmlFor="when">{arriveBy ? "Arrive by" : "Leaving"}</label>
            <span className="when-toggle" role="group" aria-label="Time basis">
              <button
                type="button"
                className={!arriveBy ? "when-toggle-on" : ""}
                aria-pressed={!arriveBy}
                onClick={() => setArriveBy(false)}
              >
                Leave
              </button>
              <button
                type="button"
                className={arriveBy ? "when-toggle-on" : ""}
                aria-pressed={arriveBy}
                onClick={() => setArriveBy(true)}
              >
                Arrive
              </button>
            </span>
          </span>
          <input
            id="when"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            aria-describedby="when-hint"
          />
        </div>
        <button className="btn" type="submit" disabled={!ready || submitting}>
          {submitting ? "Finding trains…" : "Find trains"}
        </button>
        <span id="when-hint" className="jmeta">
          {arriveBy ? "Pick a time to arrive by" : "Leave blank for now"}
        </span>
      </div>
      {notice && (
        <p className="jmeta" role="status">
          {notice}
        </p>
      )}
    </form>
  );
}
