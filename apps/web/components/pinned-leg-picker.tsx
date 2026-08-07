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
export function nearestDateForDayOfWeek(dow: number): string {
  const today = londonDate();
  const todayDow = londonDayOfWeek();
  const diff = (dow - todayDow + 7) % 7;
  if (diff === 0) return today;
  const base = new Date(`${today}T12:00:00Z`);
  return londonDate(new Date(base.getTime() + diff * 86_400_000));
}

/** Minutes between an arrival HH:MM and a candidate's scheduled instant, same day. */
function connectionMinutes(prevSchedArr: string, candidateScheduled: string): number | null {
  const [h, m] = prevSchedArr.split(":").map(Number);
  if (h === undefined || m === undefined) return null;
  const candidate = new Date(candidateScheduled);
  const arrival = new Date(candidate);
  arrival.setHours(h, m, 0, 0);
  const diffMin = Math.round((candidate.getTime() - arrival.getTime()) / 60_000);
  return diffMin;
}

const TIGHT_CONNECTION_MIN = 5;

/** One leg slot derived from the chain endpoints + declared change stations. */
interface Slot {
  index: number;
  originCrs: string;
  originLabel: string;
  destCrs: string;
  destLabel: string;
}

function buildSlots(
  chainOriginCrs: string,
  chainOriginLabel: string,
  changeStations: StationOption[],
  chainDestCrs: string,
  chainDestLabel: string,
): Slot[] {
  const points = [
    { crs: chainOriginCrs, label: chainOriginLabel },
    ...changeStations.map((s) => ({ crs: s.crs, label: s.name })),
    { crs: chainDestCrs, label: chainDestLabel },
  ];
  const slots: Slot[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    slots.push({
      index: i,
      originCrs: points[i]!.crs,
      originLabel: points[i]!.label,
      destCrs: points[i + 1]!.crs,
      destLabel: points[i + 1]!.label,
    });
  }
  return slots;
}

interface Props {
  pins: PinDraft[]; // this direction's current pins, sequence-ordered (== slot index)
  onChange: (pins: PinDraft[]) => void;
  /** Where the chain starts: home or work CRS for the first leg. */
  chainOriginCrs: string;
  chainOriginLabel: string;
  /** Where the chain ends — needed up front now the whole leg structure is declared before searching. */
  chainDestCrs: string;
  chainDestLabel: string;
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
  chainDestCrs,
  chainDestLabel,
  windowStart,
  dayOfWeek,
}: Props) {
  // Seed the change-station list from any pins already saved (editing an
  // existing commute) — each pin's destCrs, except the very last one, is a
  // change point. Intentionally only seeded once on mount: after that, the
  // change list is the source of truth and pins follow it, not the reverse.
  const [changeStations, setChangeStations] = useState<StationOption[]>(() =>
    pins
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, -1)
      .map((p) => ({ crs: p.destCrs, name: p.destLabel })),
  );
  const [newChange, setNewChange] = useState<StationOption | null>(null);
  const [searchDow, setSearchDow] = useState(dayOfWeek);
  const [candidates, setCandidates] = useState<PinCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingKey, setAddingKey] = useState<string | null>(null);

  const canDeclareStructure = Boolean(chainOriginCrs && chainDestCrs);
  const slots = useMemo(
    () => buildSlots(chainOriginCrs, chainOriginLabel, changeStations, chainDestCrs, chainDestLabel),
    [chainOriginCrs, chainOriginLabel, changeStations, chainDestCrs, chainDestLabel],
  );

  // The first slot with no pin yet — slots fill strictly in order, since a later
  // slot's search anchor only makes sense once the one before it is picked.
  const activeSlotIndex = slots.findIndex((s) => !pins.some((p) => p.sequence === s.index));
  const activeSlot = activeSlotIndex >= 0 ? slots[activeSlotIndex] : undefined;
  const previousPin = activeSlotIndex > 0 ? pins.find((p) => p.sequence === activeSlotIndex - 1) : undefined;
  const anchorHhmm = previousPin?.schedArr ?? (windowStart || "08:00");

  const searchDate = useMemo(() => nearestDateForDayOfWeek(searchDow), [searchDow]);
  const isToday = searchDate === londonDate();

  function addChangeStation() {
    if (!newChange) return;
    setChangeStations((prev) => [...prev, newChange]);
    setNewChange(null);
  }

  function removeChangeStation(idx: number) {
    // Removing a change station collapses the two slots either side of it back
    // into one — any pins already picked for those two slots (idx and idx+1)
    // no longer correspond to a real slot, so they're discarded. Pins for
    // slots entirely before or after the removed change point just shift
    // index and are re-sequenced below.
    if (pins.length > 0) {
      const affectsPickedLegs = pins.some((p) => p.sequence === idx || p.sequence === idx + 1);
      if (affectsPickedLegs && !confirm("Removing this change will discard the leg(s) picked either side of it. Continue?")) {
        return;
      }
    }
    setChangeStations((prev) => prev.filter((_, i) => i !== idx));
    // Drop pins for the two slots that collapse, re-sequence the rest against
    // the new (one-shorter) slot list.
    const kept = pins.filter((p) => p.sequence !== idx && p.sequence !== idx + 1);
    const resequenced = kept
      .sort((a, b) => a.sequence - b.sequence)
      .map((p, i) => ({ ...p, sequence: i }));
    onChange(resequenced);
    setCandidates(null);
  }

  function removePin(sequence: number) {
    const next = pins.filter((p) => p.sequence !== sequence);
    onChange(next);
    setCandidates(null);
  }

  async function search() {
    if (!activeSlot) return;
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
      const res = await fetch(
        `/api/boards/${encodeURIComponent(activeSlot.originCrs)}/pin-candidates?${params}`,
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
    if (!activeSlot) return;
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
          destCrs: activeSlot.destCrs,
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
        sequence: activeSlot.index,
        trainUid: data.trainUid,
        gtfsTripId: data.gtfsTripId ?? null,
        originCrs: activeSlot.originCrs,
        originLabel: activeSlot.originLabel,
        schedDep: t(c.scheduled),
        destCrs: activeSlot.destCrs,
        destLabel: activeSlot.destLabel,
        // Fall back to the departure time if we couldn't resolve a real
        // arrival — better than blocking the pick outright; the fallback
        // window (still saved alongside) covers the gap.
        schedArr: data.schedArr ?? t(c.scheduled),
        toc: c.operator ?? null,
        pickedServiceDate: searchDate,
      };
      onChange([...pins.filter((p) => p.sequence !== activeSlot.index), next]);
      setCandidates(null);
    } catch {
      setError("Couldn't add that service. Try again.");
    } finally {
      setAddingKey(null);
    }
  }

  return (
    <div className="pinned-leg-picker">
      <div className="pinned-changes">
        <p className="editor-hint">
          Changing trains? Add each station you change at, in order — we&rsquo;ll split the
          journey into legs and you pick a real train for each one.
        </p>
        {changeStations.length > 0 && (
          <ol className="pinned-changes-list">
            {changeStations.map((s, i) => (
              <li key={`${s.crs}-${i}`} className="pinned-changes-row">
                <span>{s.name}</span>
                <button
                  type="button"
                  className="btn-link-danger"
                  onClick={() => removeChangeStation(i)}
                  aria-label={`Remove change at ${s.name}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
        )}
        {canDeclareStructure && (
          <div className="pinned-changes-add">
            <StationInput
              label="Add a change at"
              name="pin-change-station"
              value={newChange}
              onChange={setNewChange}
              placeholder="Station you change at"
            />
            <button type="button" className="btn btn-secondary" onClick={addChangeStation} disabled={!newChange}>
              Add change
            </button>
          </div>
        )}
        {!canDeclareStructure && (
          <p className="editor-hint">Set both ends of this direction first.</p>
        )}
      </div>

      {slots.length > 0 && (
        <ol className="pinned-leg-list">
          {slots.map((slot) => {
            const pin = pins.find((p) => p.sequence === slot.index);
            if (pin) {
              return (
                <li key={slot.index} className="pinned-leg-row pinned-leg-row-filled">
                  <span className="pinned-leg-times">
                    {pin.schedDep} {pin.originLabel} → {pin.schedArr} {pin.destLabel}
                  </span>
                  {pin.toc && <span className="editor-hint">{pin.toc}</span>}
                  <button
                    type="button"
                    className="btn-link-danger"
                    onClick={() => removePin(slot.index)}
                    aria-label={`Remove leg ${pin.originLabel} to ${pin.destLabel}`}
                  >
                    Remove
                  </button>
                </li>
              );
            }
            const isActive = slot.index === activeSlotIndex;
            return (
              <li
                key={slot.index}
                className={`pinned-leg-row pinned-leg-row-empty ${isActive ? "pinned-leg-row-active" : ""}`}
              >
                <span className="pinned-leg-times">
                  {slot.originLabel} → {slot.destLabel}
                </span>
                <span className="editor-hint">
                  {isActive ? "Search below" : "Pick the previous leg first"}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {activeSlot && (
        <div className="pinned-leg-search">
          <p className="editor-hint">
            Searching {activeSlot.originLabel} → {activeSlot.destLabel} — you&rsquo;re picking a
            timetabled service; we&rsquo;ll check it still runs each day automatically.
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
          </div>
          <p className="editor-hint">
            Showing departures around {anchorHhmm} on {DAY_NAMES[searchDow]} ({searchDate}).
          </p>
          <button type="button" className="btn btn-secondary" onClick={search} disabled={loading}>
            {loading ? "Searching…" : "Search departures"}
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
                const connMin = previousPin ? connectionMinutes(previousPin.schedArr, c.scheduled) : null;
                const tight = connMin !== null && connMin >= 0 && connMin < TIGHT_CONNECTION_MIN;
                return (
                  <li key={key} className="pin-candidate-row">
                    <span className="pinned-leg-times">
                      {t(c.scheduled)} to {c.destinationName}
                    </span>
                    {c.operator && <span className="editor-hint">{c.operator}</span>}
                    {tight && <span className="chip chip-warn">Tight connection — {connMin}min</span>}
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
