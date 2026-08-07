"use client";

import { useMemo, useRef, useState } from "react";
import { londonDate, londonDayOfWeek, londonWallTimeToIso } from "@signaller/shared";
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

/** A pickable train for one leg, from /api/commute/leg-options. */
interface LegOption {
  gtfsTripId: string;
  originCrs: string;
  originName: string;
  destCrs: string;
  destName: string;
  departs: string;
  arrives: string;
  departsHhmm: string;
  arrivesHhmm: string;
  durationMinutes: number;
  operator?: string;
  callCount: number;
}

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

const TIGHT_CONNECTION_MIN = 5;

/**
 * Minutes between the previous leg's arrival (HH:MM UK local on `serviceDate`)
 * and a candidate departure instant.
 *
 * Resolves the HH:MM through the shared UK-timezone helper rather than a local
 * `setHours`, which would be wrong whenever the browser isn't on UK time. If
 * the result is strongly negative the connection runs past midnight, so the
 * arrival belongs to the previous day — add a day back.
 */
function connectionMinutes(prevArrHhmm: string, serviceDate: string, departsIso: string): number | null {
  const arrivalMs = Date.parse(londonWallTimeToIso(serviceDate, prevArrHhmm));
  const departMs = Date.parse(departsIso);
  if (Number.isNaN(arrivalMs) || Number.isNaN(departMs)) return null;
  let diff = Math.round((departMs - arrivalMs) / 60_000);
  if (diff < -720) diff += 1440;
  return diff;
}

/** Change-point stations implied by a sequence-ordered list of pins (all but the last leg's destination). */
function deriveChangesFromPins(pins: PinDraft[]): StationOption[] {
  return pins
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .slice(0, -1)
    .map((p) => ({ crs: p.destCrs, name: p.destLabel }));
}

function sameStations(a: StationOption[], b: StationOption[]): boolean {
  return a.length === b.length && a.every((s, i) => s.crs === b[i]?.crs);
}

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
  /** Where the chain ends — the whole leg structure is declared before searching. */
  chainDestCrs: string;
  chainDestLabel: string;
  /** The direction's window start — seeds the first leg's departure time. */
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
  // The change-station list is local (it needs to hold trailing, not-yet-picked
  // change points that have no pin to derive from yet), but it must re-sync
  // whenever `pins` changes from OUTSIDE this component — on mount, and
  // whenever something like "copy this day's plan to other days" replaces
  // pins wholesale. `lastEmittedPins` tracks the most recent pins array this
  // component itself produced via `emit()`; if the incoming `pins` prop isn't
  // that array, the change came from elsewhere and changeStations is
  // resynced from it. This runs during render (not a useEffect) so there's
  // no extra render/flash after an external update.
  const lastEmittedPins = useRef(pins);
  const [changeStations, setChangeStations] = useState<StationOption[]>(() => deriveChangesFromPins(pins));
  if (pins !== lastEmittedPins.current) {
    lastEmittedPins.current = pins;
    const resynced = deriveChangesFromPins(pins);
    if (!sameStations(resynced, changeStations)) setChangeStations(resynced);
  }

  function emit(nextPins: PinDraft[]) {
    lastEmittedPins.current = nextPins;
    onChange(nextPins);
  }

  const [newChange, setNewChange] = useState<StationOption | null>(null);
  const [searchDow, setSearchDow] = useState(dayOfWeek);
  /** Departure time to search around — editable, re-seeded per leg (see departAt). */
  const [departOverride, setDepartOverride] = useState<string | null>(null);
  const [options, setOptions] = useState<LegOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);

  const canDeclareStructure = Boolean(chainOriginCrs && chainDestCrs);
  const slots = useMemo(
    () => buildSlots(chainOriginCrs, chainOriginLabel, changeStations, chainDestCrs, chainDestLabel),
    [chainOriginCrs, chainOriginLabel, changeStations, chainDestCrs, chainDestLabel],
  );

  // Slots fill strictly in order — a later leg's departure time only makes
  // sense once the one before it has an arrival to follow on from.
  const activeSlotIndex = slots.findIndex((s) => !pins.some((p) => p.sequence === s.index));
  const activeSlot = activeSlotIndex >= 0 ? slots[activeSlotIndex] : undefined;
  const previousPin = activeSlotIndex > 0 ? pins.find((p) => p.sequence === activeSlotIndex - 1) : undefined;

  // Suggested departure for this leg: right after the previous leg lands, or
  // the direction's window start for the first leg. Always editable.
  const suggestedDepart = previousPin?.schedArr ?? (windowStart || "08:00");
  const departAt = departOverride ?? suggestedDepart;

  const searchDate = useMemo(() => nearestDateForDayOfWeek(searchDow), [searchDow]);
  const isToday = searchDate === londonDate();

  /** Reset the per-leg search state — called whenever which-leg-is-active changes. */
  function resetSearch() {
    setOptions(null);
    setDepartOverride(null);
    setError(null);
  }

  function addChangeStation() {
    if (!newChange) return;
    setChangeStations((prev) => [...prev, newChange]);
    setNewChange(null);
    resetSearch();
  }

  function removeChangeStation(idx: number) {
    // Removing a change station collapses the two slots either side of it back
    // into one — pins picked for those slots no longer describe a real leg, so
    // they go. Everything else keeps its relative order and is re-sequenced.
    if (pins.some((p) => p.sequence === idx || p.sequence === idx + 1)) {
      if (!confirm("Removing this change will discard the leg(s) picked either side of it. Continue?")) {
        return;
      }
    }
    setChangeStations((prev) => prev.filter((_, i) => i !== idx));
    const resequenced = pins
      .filter((p) => p.sequence !== idx && p.sequence !== idx + 1)
      .sort((a, b) => a.sequence - b.sequence)
      .map((p, i) => ({ ...p, sequence: i }));
    emit(resequenced);
    resetSearch();
  }

  function removePin(sequence: number) {
    emit(pins.filter((p) => p.sequence !== sequence));
    resetSearch();
  }

  async function search() {
    if (!activeSlot) return;
    setLoading(true);
    setError(null);
    setOptions(null);
    try {
      const params = new URLSearchParams({
        from: activeSlot.originCrs,
        to: activeSlot.destCrs,
        date: searchDate,
        around: departAt,
      });
      const res = await fetch(`/api/commute/leg-options?${params}`);
      const data = await res.json();
      if (data.ok) setOptions(data.options);
      else if (data.reason === "engine-offline") setError("Routing engine is offline right now.");
      else setError("Couldn't search that leg. Check both stations are right.");
    } catch {
      setError("Couldn't search that leg. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function addOption(o: LegOption) {
    if (!activeSlot) return;
    setAddingId(o.gtfsTripId);
    setError(null);
    try {
      // Resolve the engine's trip to its Network Rail train_uid — the stable
      // identity a pin is stored under. Times/stations come from the option
      // itself, which already knows this leg's real arrival.
      const res = await fetch("/api/commute/resolve-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gtfsTripId: o.gtfsTripId,
          crs: o.originCrs,
          scheduledHhmm: o.departsHhmm,
          destCrs: o.destCrs,
          targetDate: searchDate,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(
          isToday
            ? "Couldn't confirm that train against the timetable. Try another."
            : "Couldn't match that service to the timetable. Try a different one.",
        );
        return;
      }
      const next: PinDraft = {
        sequence: activeSlot.index,
        trainUid: data.trainUid,
        gtfsTripId: o.gtfsTripId,
        originCrs: activeSlot.originCrs,
        originLabel: activeSlot.originLabel,
        schedDep: o.departsHhmm,
        destCrs: activeSlot.destCrs,
        destLabel: activeSlot.destLabel,
        schedArr: o.arrivesHhmm,
        toc: o.operator ?? null,
        pickedServiceDate: searchDate,
      };
      emit([...pins.filter((p) => p.sequence !== activeSlot.index), next]);
      resetSearch();
    } catch {
      setError("Couldn't add that train. Try again.");
    } finally {
      setAddingId(null);
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
        {canDeclareStructure ? (
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
        ) : (
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
                  {isActive ? "Pick a train below" : "Pick the previous leg first"}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {activeSlot && (
        <div className="pinned-leg-search">
          <p className="editor-hint">
            Leg {activeSlot.index + 1}: {activeSlot.originLabel} → {activeSlot.destLabel}
          </p>
          <div className="pin-search-row">
            <label className="field">
              <span>Day</span>
              <select
                value={searchDow}
                onChange={(e) => {
                  setSearchDow(Number(e.target.value));
                  setOptions(null);
                }}
              >
                {DAY_NAMES.map((name, i) => (
                  <option key={name} value={i}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Departing around</span>
              <input
                type="time"
                value={departAt}
                onChange={(e) => {
                  setDepartOverride(e.target.value);
                  setOptions(null);
                }}
              />
            </label>
            <button type="button" className="btn btn-secondary" onClick={search} disabled={loading}>
              {loading ? "Searching…" : "Find trains"}
            </button>
          </div>
          {previousPin && (
            <p className="editor-hint">
              Previous leg arrives {previousPin.schedArr} at {previousPin.destLabel}.
            </p>
          )}

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          {options && options.length === 0 && (
            <p className="editor-hint">
              No direct trains found around then. Try another time, or add a change station if this
              leg needs one.
            </p>
          )}
          {options && options.length > 0 && (
            <ol className="pin-candidate-list">
              {options.map((o) => {
                const connMin = previousPin ? connectionMinutes(previousPin.schedArr, searchDate, o.departs) : null;
                const tight = connMin !== null && connMin >= 0 && connMin < TIGHT_CONNECTION_MIN;
                return (
                  <li key={o.gtfsTripId} className="pin-candidate-row">
                    <span className="pinned-leg-times">
                      {o.departsHhmm} → {o.arrivesHhmm}
                    </span>
                    <span className="editor-hint">
                      {o.durationMinutes}m
                      {o.callCount === 0 ? " · non-stop" : ` · ${o.callCount} stop${o.callCount === 1 ? "" : "s"}`}
                      {o.operator ? ` · ${o.operator}` : ""}
                    </span>
                    {tight && <span className="chip chip-warn">Tight — {connMin}min</span>}
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => addOption(o)}
                      disabled={addingId === o.gtfsTripId}
                    >
                      {addingId === o.gtfsTripId ? "Adding…" : "Add"}
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
