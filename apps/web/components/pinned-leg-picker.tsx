"use client";

import { useState } from "react";
import { StationInput, type StationOption } from "./station-input";

/** Draft shape for one pinned leg — matches CommuteLegPinInput minus `direction`. */
export interface PinDraft {
  sequence: number;
  trainUid: string;
  gtfsTripId: string | null;
  originCrs: string;
  originLabel: string;
  schedDep: string;
  destCrs: string;
  destLabel: string;
  schedArr: string;
  toc: string | null;
  pickedServiceDate: string;
}

interface PinCandidate {
  crs: string;
  name: string;
  scheduled: string;
  destinationName: string;
  destinationCrs?: string;
  operator?: string;
  tripId?: string;
  rid?: string;
  source: "ldbws" | "darwin" | "timetable";
}

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/London",
});
const t = (iso: string) => timeFmt.format(new Date(iso));

function todayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

interface Props {
  pins: PinDraft[]; // this direction's current pins, sequence-ordered
  onChange: (pins: PinDraft[]) => void;
  /** Where the chain starts: home or work CRS for the first leg. */
  chainOriginCrs: string;
  chainOriginLabel: string;
  /** The direction's window start — default "after" bound for the first leg. */
  windowStart: string;
}

export function PinnedLegPicker({ pins, onChange, chainOriginCrs, chainOriginLabel, windowStart }: Props) {
  const [searching, setSearching] = useState(false);
  const [station, setStation] = useState<StationOption | null>(null);
  const [candidates, setCandidates] = useState<PinCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingCrs, setAddingCrs] = useState<string | null>(null);

  const previous = pins[pins.length - 1];
  const searchOriginCrs = previous?.destCrs ?? chainOriginCrs;
  const searchOriginLabel = previous?.destLabel ?? chainOriginLabel;
  const afterHhmm = previous?.schedArr ?? windowStart;

  function removePin(sequence: number) {
    const next = pins
      .filter((p) => p.sequence !== sequence)
      .sort((a, b) => a.sequence - b.sequence)
      .map((p, i) => ({ ...p, sequence: i }));
    onChange(next);
  }

  async function search() {
    const crs = station?.crs ?? searchOriginCrs;
    if (!crs) return;
    setLoading(true);
    setError(null);
    setCandidates(null);
    try {
      const today = todayYmd();
      const when = `${today}T${afterHhmm || "00:00"}:00`;
      const res = await fetch(
        `/api/boards/${encodeURIComponent(crs)}/pin-candidates?after=${encodeURIComponent(when)}`,
      );
      const data = await res.json();
      if (data.ok) setCandidates(data.candidates);
      else setError("Couldn't load departures for that station.");
    } catch {
      setError("Couldn't load departures. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function addCandidate(c: PinCandidate) {
    setAddingCrs(c.crs + c.scheduled);
    setError(null);
    try {
      const res = await fetch("/api/commute/resolve-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rid: c.rid,
          serviceId: c.tripId,
          gtfsTripId: c.tripId,
          crs: c.crs,
          scheduledHhmm: t(c.scheduled),
          destCrs: c.destinationCrs,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError("Not confirmed yet — try again closer to departure.");
        return;
      }
      const next: PinDraft = {
        sequence: pins.length,
        trainUid: data.trainUid,
        gtfsTripId: data.gtfsTripId ?? null,
        originCrs: c.crs,
        originLabel: station?.name ?? c.name,
        schedDep: t(c.scheduled),
        destCrs: c.destinationCrs ?? "",
        destLabel: c.destinationName,
        // Fall back to the departure time if we couldn't resolve a real
        // arrival — better than blocking the pick outright; the fallback
        // window (still saved alongside) covers the gap.
        schedArr: data.schedArr ?? t(c.scheduled),
        toc: c.operator ?? null,
        pickedServiceDate: todayYmd(),
      };
      onChange([...pins, next]);
      setCandidates(null);
      setStation(null);
      setSearching(false);
    } catch {
      setError("Couldn't add that service. Try again.");
    } finally {
      setAddingCrs(null);
    }
  }

  return (
    <div className="pinned-leg-picker">
      {pins.length > 0 && (
        <ol className="pinned-leg-list">
          {pins.map((p) => (
            <li key={p.sequence} className="pinned-leg-row">
              <span className="pinned-leg-times">
                {p.schedDep} {p.originLabel} → {p.schedArr} {p.destLabel}
              </span>
              {p.toc && <span className="editor-hint">{p.toc}</span>}
              <button
                type="button"
                className="btn-link-danger"
                onClick={() => removePin(p.sequence)}
                aria-label={`Remove leg ${p.originLabel} to ${p.destLabel}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}

      {!searching ? (
        <button type="button" className="btn btn-secondary" onClick={() => setSearching(true)}>
          {pins.length === 0 ? "Add a leg" : "Add a change"}
        </button>
      ) : (
        <div className="pinned-leg-search">
          <p className="editor-hint">
            Search from {searchOriginLabel} — you&rsquo;re picking today&rsquo;s running of a
            timetabled service; we&rsquo;ll check it still runs each day automatically.
          </p>
          <StationInput
            label="Search from"
            name="pin-search-station"
            value={station}
            onChange={setStation}
            placeholder={searchOriginLabel}
          />
          <button type="button" className="btn btn-secondary" onClick={search} disabled={loading}>
            {loading ? "Searching…" : "Search departures"}
          </button>
          <button type="button" className="btn-link" onClick={() => setSearching(false)}>
            Cancel
          </button>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          {candidates && candidates.length === 0 && (
            <p className="editor-hint">No upcoming departures found.</p>
          )}
          {candidates && candidates.length > 0 && (
            <ol className="pin-candidate-list">
              {candidates.map((c) => (
                <li key={c.crs + c.scheduled} className="pin-candidate-row">
                  <span className="pinned-leg-times">
                    {t(c.scheduled)} to {c.destinationName}
                  </span>
                  {c.operator && <span className="editor-hint">{c.operator}</span>}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => addCandidate(c)}
                    disabled={addingCrs === c.crs + c.scheduled}
                  >
                    {addingCrs === c.crs + c.scheduled ? "Adding…" : "Add"}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
