"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { StationInput, type StationOption } from "./station-input";
import { recordRecent } from "./use-recents";

interface Props {
  stations?: StationOption[];
  initialFrom?: StationOption | null;
  initialTo?: StationOption | null;
}

export function SearchForm({ stations, initialFrom = null, initialTo = null }: Props) {
  const router = useRouter();
  const [from, setFrom] = useState<StationOption | null>(initialFrom);
  const [to, setTo] = useState<StationOption | null>(initialTo);
  const [when, setWhen] = useState("");
  const [arriveBy, setArriveBy] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const ready = Boolean(from && to && from.crs !== to.crs);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || !from || !to) return;
    setSubmitting(true);
    recordRecent({ from: from.crs, fromName: from.name, to: to.crs, toName: to.name });
    const params = new URLSearchParams({ from: from.crs, to: to.crs });
    if (when) params.set("when", new Date(when).toISOString());
    // arriveBy only meaningful with an explicit time.
    if (when && arriveBy) params.set("arriveBy", "1");
    router.push(`/journeys?${params}`);
  }

  return (
    <form className="search-panel" onSubmit={submit}>
      <div className="search-grid">
        <StationInput
          label="From"
          name="from"
          stations={stations}
          value={from}
          onChange={setFrom}
          placeholder="Station name or code"
        />
        <button
          type="button"
          className="swap-btn"
          aria-label="Swap origin and destination"
          onClick={() => {
            setFrom(to);
            setTo(from);
          }}
        >
          ⇅
        </button>
        <StationInput
          label="To"
          name="to"
          stations={stations}
          value={to}
          onChange={setTo}
          placeholder="Station name or code"
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
    </form>
  );
}
