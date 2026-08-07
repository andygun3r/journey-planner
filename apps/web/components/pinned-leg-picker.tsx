"use client";

import { useMemo, useState } from "react";
import { londonDate, londonDayOfWeek } from "@signaller/shared";
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

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** The nearest date (today or later) that falls on the given day-of-week (0=Mon..6=Sun). */
function nearestDateForDayOfWeek(dow: number): string {
  const today = londonDate();
  const todayDow = londonDayOfWeek();
  const diff = (dow - todayDow + 7) % 7;
  if (diff === 0) return today;
  const base = new Date(`${today}T12:00:00Z`);
  return londonDate(new Date(base.getTime() + diff * 86_400_000));
}

interface Props {
  pins: PinDraft[]; // this direction's current pins, sequence-ordered
  onChange: (pins: PinDraft[]) => void;
  /** Where the chain starts: home or work CRS for the first leg. */
  chainOriginCrs: string;
  chainOriginLabel: string;
  /** The direction's window start — default search anchor for the first leg. */
  windowStart: string;
  /** The commute leg's own day-of-week (0=Mon..6=Sun) — defaults the day selector. */
  dayOfWeek: number;
}

export function PinnedLegPicker({
  pins,
  onChange,
  chainOriginCrs,
  chainOriginLabel,
  windowStart,
  dayOfWeek,
}: Props) {
  const [searching, setSearching] = useState(false);
  const [station, setStation] = useState<StationOption | null>(null);
  const [searchDow, setSearchDow] = useState(dayOfWeek);
  const [candidates, setCandidates] = useState<PinCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingKey, setAddingKey] = useState<string | null>(null);

  const previous = pins[pins.length - 1];
  const searchOriginCrs = previous?.destCrs ?? chainOriginCrs;
  const searchOriginLabel = previous?.destLabel ?? chainOriginLabel;
  const anchorHhmm = previous?.schedArr ?? (windowStart || "08:00");

  const searchDate = useMemo(() => nearestDateForDayOfWeek(searchDow), [searchDow]);
  const isToday = searchDate === londonDate();

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
      const params = new URLSearchParams({
        date: searchDate,
        around: anchorHhmm,
        beforeMinutes: "30",
        afterMinutes: "90",
      });
      const res = await fetch(`/api/boards/${encodeURIComponent(crs)}/pin-candidates?${params}`);
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
    const key = c.crs + c.scheduled;
    setAddingKey(key);
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
          targetDate: searchDate,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(
          isToday
            ? "Not confirmed yet — try again closer to departure."
            : "Couldn't match that service to the timetable. Try a different one.",
        );
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
        pickedServiceDate: searchDate,
      };
      onChange([...pins, next]);
      setCandidates(null);
      setStation(null);
      setSearching(false);
    } catch {
      setError("Couldn't add that service. Try again.");
    } finally {
      setAddingKey(null);
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
            Search from {searchOriginLabel} — you&rsquo;re picking a timetabled service; we&rsquo;ll
            check it still runs each day automatically.
          </p>
          <div className="pin-search-row">
            <label className="field">
              <span>Day</span>
              <select value={searchDow} onChange={(e) => setSearchDow(Number(e.target.value))}>
                {DAY_NAMES.map((name, i) => (
                  <option key={name} value={i}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <StationInput
              label="Search from"
              name="pin-search-station"
              value={station}
              onChange={setStation}
              placeholder={searchOriginLabel}
            />
          </div>
          <p className="editor-hint">
            Showing departures around {anchorHhmm} on {DAY_NAMES[searchDow]} ({searchDate}).
          </p>
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
            <p className="editor-hint">No departures found in that window — try a wider search.</p>
          )}
          {candidates && candidates.length > 0 && (
            <ol className="pin-candidate-list">
              {candidates.map((c) => {
                const key = c.crs + c.scheduled;
                return (
                  <li key={key} className="pin-candidate-row">
                    <span className="pinned-leg-times">
                      {t(c.scheduled)} to {c.destinationName}
                    </span>
                    {c.operator && <span className="editor-hint">{c.operator}</span>}
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => addCandidate(c)}
                      disabled={addingKey === key}
                    >
                      {addingKey === key ? "Adding…" : "Add"}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
