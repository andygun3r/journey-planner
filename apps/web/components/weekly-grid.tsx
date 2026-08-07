"use client";

import { useState } from "react";
import { type PinDraft, PinnedLegPicker } from "./pinned-leg-picker";
import { StationInput, type StationOption } from "./station-input";

/** Draft state for one day-of-week row in the editor. */
export interface DayDraft {
  active: boolean;
  work: StationOption | null;
  workLabel: string;
  amStart: string;
  amEnd: string;
  pmStart: string;
  pmEnd: string;
  /** Optional backup station(s) for this day, offered when the usual route is disrupted. */
  backupWork: StationOption | null;
  backupHome: StationOption | null;
  backupNote: string;
  /**
   * Per-direction origin/destination override — when set, that direction runs
   * between these stations instead of the usual home<->work pair (e.g. a
   * Saturday commute home from somewhere other than work). Null/unset means
   * "use home<->work as normal".
   */
  amOrigin: StationOption | null;
  amDest: StationOption | null;
  pmOrigin: StationOption | null;
  pmDest: StationOption | null;
  /** Pinned real services for this day, primary over the am/pm window when set. */
  amPins: PinDraft[];
  pmPins: PinDraft[];
}

export function emptyDay(): DayDraft {
  return {
    active: false,
    work: null,
    workLabel: "",
    amStart: "",
    amEnd: "",
    pmStart: "",
    pmEnd: "",
    backupWork: null,
    backupHome: null,
    backupNote: "",
    amOrigin: null,
    amDest: null,
    pmOrigin: null,
    pmDest: null,
    amPins: [],
    pmPins: [],
  };
}

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Whether a day already has a plan worth warning about before overwriting it. */
function dayHasPlan(d: DayDraft): boolean {
  return d.active && (Boolean(d.work) || d.amPins.length > 0 || d.pmPins.length > 0);
}

interface CopyDayControlProps {
  fromDow: number;
  days: DayDraft[];
  onCopy: (fromDow: number, toDows: number[]) => void;
}

/** "Copy this day's plan to other days" — ticks the target weekdays, confirms before overwriting. */
function CopyDayControl({ fromDow, days, onCopy }: CopyDayControlProps) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());

  function toggle(dow: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(dow)) next.delete(dow);
      else next.add(dow);
      return next;
    });
  }

  function apply() {
    const toDows = [...checked];
    if (toDows.length === 0) return;
    const overwriting = toDows.filter((dow) => dayHasPlan(days[dow]!));
    if (overwriting.length > 0) {
      const names = overwriting.map((dow) => DAY_NAMES[dow]).join(", ");
      if (!confirm(`${names} already ${overwriting.length === 1 ? "has" : "have"} a plan — replace it with this day's plan?`)) {
        return;
      }
    }
    onCopy(fromDow, toDows);
    setChecked(new Set());
    setOpen(false);
  }

  if (!open) {
    return (
      <button type="button" className="btn-link" onClick={() => setOpen(true)}>
        Copy to other days…
      </button>
    );
  }

  return (
    <div className="copy-day-picker">
      <p className="editor-hint">Copy this day&rsquo;s plan to:</p>
      <div className="copy-day-options">
        {DAY_NAMES.map((name, dow) =>
          dow === fromDow ? null : (
            <label key={name} className="copy-day-option">
              <input type="checkbox" checked={checked.has(dow)} onChange={() => toggle(dow)} />
              {DAY_SHORT[dow]}
            </label>
          ),
        )}
      </div>
      <div className="copy-day-actions">
        <button type="button" className="btn btn-secondary" onClick={apply} disabled={checked.size === 0}>
          Apply
        </button>
        <button type="button" className="btn-link" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

interface DirectionFieldsetProps {
  legend: string;
  hint: string;
  pins: PinDraft[];
  onPinsChange: (pins: PinDraft[]) => void;
  chainOriginCrs: string;
  chainOriginLabel: string;
  chainDestCrs: string;
  chainDestLabel: string;
  windowStart: string;
  windowEnd: string;
  onWindowStartChange: (v: string) => void;
  onWindowEndChange: (v: string) => void;
  dayOfWeek: number;
  stations: StationOption[];
  origin: StationOption | null;
  onOriginChange: (s: StationOption | null) => void;
  dest: StationOption | null;
  onDestChange: (s: StationOption | null) => void;
  defaultOriginLabel: string;
  defaultDestLabel: string;
  idPrefix: string;
}

/** One AM or PM leg's full editor: legend, picker, fallback window, and origin/destination override. */
function DirectionFieldset({
  legend,
  hint,
  pins,
  onPinsChange,
  chainOriginCrs,
  chainOriginLabel,
  chainDestCrs,
  chainDestLabel,
  windowStart,
  windowEnd,
  onWindowStartChange,
  onWindowEndChange,
  dayOfWeek,
  stations,
  origin,
  onOriginChange,
  dest,
  onDestChange,
  defaultOriginLabel,
  defaultDestLabel,
  idPrefix,
}: DirectionFieldsetProps) {
  const overridden = Boolean(origin || dest);
  return (
    <fieldset className="window">
      <legend>
        {overridden ? `${chainOriginLabel} → ${chainDestLabel}` : legend}
      </legend>
      <p className="editor-hint">{hint}</p>
      <PinnedLegPicker
        pins={pins}
        onChange={onPinsChange}
        chainOriginCrs={chainOriginCrs}
        chainOriginLabel={chainOriginLabel}
        chainDestCrs={chainDestCrs}
        chainDestLabel={chainDestLabel}
        windowStart={windowStart || "00:00"}
        dayOfWeek={dayOfWeek}
      />
      <div className="window-times">
        <label>
          From{pins.length > 0 ? " (fallback)" : ""}
          <input type="time" value={windowStart} onChange={(e) => onWindowStartChange(e.target.value)} />
        </label>
        <label>
          To{pins.length > 0 ? " (fallback)" : ""}
          <input type="time" value={windowEnd} onChange={(e) => onWindowEndChange(e.target.value)} />
        </label>
      </div>

      <details className="day-override">
        <summary>{overridden ? "Change origin/destination (set)" : "Change origin/destination"}</summary>
        <p className="editor-hint">
          Not commuting {defaultOriginLabel} → {defaultDestLabel} this day? Set where this leg
          actually starts and ends instead — e.g. commuting home from somewhere else.
        </p>
        <div className="day-work">
          <StationInput
            label="Starts at"
            name={`${idPrefix}-origin`}
            stations={stations}
            value={origin}
            onChange={onOriginChange}
            placeholder={defaultOriginLabel}
          />
          <StationInput
            label="Ends at"
            name={`${idPrefix}-dest`}
            stations={stations}
            value={dest}
            onChange={onDestChange}
            placeholder={defaultDestLabel}
          />
        </div>
        {overridden && (
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              onOriginChange(null);
              onDestChange(null);
            }}
          >
            Reset to {defaultOriginLabel} → {defaultDestLabel}
          </button>
        )}
      </details>
    </fieldset>
  );
}

interface Props {
  stations: StationOption[];
  days: DayDraft[];
  onChange: (dayOfWeek: number, patch: Partial<DayDraft>) => void;
  /** The commute's home station + label — the AM chain's starting point / PM chain's end. */
  homeCrs: string;
  homeLabel: string;
  onCopyDay: (fromDow: number, toDows: number[]) => void;
}

export function WeeklyGrid({ stations, days, onChange, homeCrs, homeLabel, onCopyDay }: Props) {
  return (
    <div className="weekly-grid">
      {days.map((day, i) => {
        const defaultHomeLabel = homeLabel || "Home";
        const defaultWorkLabel = day.workLabel || day.work?.name || "Work";
        const amOriginCrs = day.amOrigin?.crs || homeCrs;
        const amOriginLabel = day.amOrigin?.name || defaultHomeLabel;
        const amDestCrs = day.amDest?.crs || day.work?.crs || "";
        const amDestLabel = day.amDest?.name || defaultWorkLabel;
        const pmOriginCrs = day.pmOrigin?.crs || day.work?.crs || "";
        const pmOriginLabel = day.pmOrigin?.name || defaultWorkLabel;
        const pmDestCrs = day.pmDest?.crs || homeCrs;
        const pmDestLabel = day.pmDest?.name || defaultHomeLabel;

        return (
          <div key={i} className={`day-row ${day.active ? "day-active" : "day-off"}`}>
            <div className="day-head">
              <label className="day-toggle">
                <input
                  type="checkbox"
                  checked={day.active}
                  onChange={(e) => onChange(i, { active: e.target.checked })}
                  aria-label={`Commute on ${DAY_NAMES[i]}`}
                />
                <span className="day-name">
                  <span className="day-name-full">{DAY_NAMES[i]}</span>
                  <span className="day-name-short" aria-hidden="true">
                    {DAY_SHORT[i]}
                  </span>
                </span>
              </label>
              {day.active && <CopyDayControl fromDow={i} days={days} onCopy={onCopyDay} />}
            </div>

            {day.active && (
              <div className="day-body">
                <div className="day-work">
                  <StationInput
                    label="Work location"
                    name={`work-${i}`}
                    stations={stations}
                    value={day.work}
                    onChange={(s) => onChange(i, { work: s })}
                    placeholder="Where do you work this day?"
                  />
                  <div className="field">
                    <label htmlFor={`worklabel-${i}`}>Label</label>
                    <input
                      id={`worklabel-${i}`}
                      type="text"
                      maxLength={60}
                      placeholder="Head office"
                      value={day.workLabel}
                      onChange={(e) => onChange(i, { workLabel: e.target.value })}
                    />
                  </div>
                </div>

                <div className="day-windows">
                  <DirectionFieldset
                    legend="Morning · home → work"
                    hint="Pick real trains below, or just set a rough time window — pinned trains take priority when both are set."
                    pins={day.amPins}
                    onPinsChange={(pins) => onChange(i, { amPins: pins })}
                    chainOriginCrs={amOriginCrs}
                    chainOriginLabel={amOriginLabel}
                    chainDestCrs={amDestCrs}
                    chainDestLabel={amDestLabel}
                    windowStart={day.amStart}
                    windowEnd={day.amEnd}
                    onWindowStartChange={(v) => onChange(i, { amStart: v })}
                    onWindowEndChange={(v) => onChange(i, { amEnd: v })}
                    dayOfWeek={i}
                    stations={stations}
                    origin={day.amOrigin}
                    onOriginChange={(s) => onChange(i, { amOrigin: s })}
                    dest={day.amDest}
                    onDestChange={(s) => onChange(i, { amDest: s })}
                    defaultOriginLabel={defaultHomeLabel}
                    defaultDestLabel={defaultWorkLabel}
                    idPrefix={`am-override-${i}`}
                  />

                  <DirectionFieldset
                    legend="Evening · work → home"
                    hint="Pick real trains below, or just set a rough time window — pinned trains take priority when both are set."
                    pins={day.pmPins}
                    onPinsChange={(pins) => onChange(i, { pmPins: pins })}
                    chainOriginCrs={pmOriginCrs}
                    chainOriginLabel={pmOriginLabel}
                    chainDestCrs={pmDestCrs}
                    chainDestLabel={pmDestLabel}
                    windowStart={day.pmStart}
                    windowEnd={day.pmEnd}
                    onWindowStartChange={(v) => onChange(i, { pmStart: v })}
                    onWindowEndChange={(v) => onChange(i, { pmEnd: v })}
                    dayOfWeek={i}
                    stations={stations}
                    origin={day.pmOrigin}
                    onOriginChange={(s) => onChange(i, { pmOrigin: s })}
                    dest={day.pmDest}
                    onDestChange={(s) => onChange(i, { pmDest: s })}
                    defaultOriginLabel={defaultWorkLabel}
                    defaultDestLabel={defaultHomeLabel}
                    idPrefix={`pm-override-${i}`}
                  />
                </div>

                <details className="day-backup">
                  <summary>Backup route (optional)</summary>
                  <p className="editor-hint">
                    If your usual station is disrupted, we&rsquo;ll offer this as a quick alternative —
                    we still search live for the best train, this just points us where to look.
                  </p>
                  <div className="day-work">
                    <StationInput
                      label="Backup work station"
                      name={`backup-work-${i}`}
                      stations={stations}
                      value={day.backupWork}
                      onChange={(s) => onChange(i, { backupWork: s })}
                      placeholder="e.g. a nearby station"
                    />
                    <StationInput
                      label="Backup home station"
                      name={`backup-home-${i}`}
                      stations={stations}
                      value={day.backupHome}
                      onChange={(s) => onChange(i, { backupHome: s })}
                      placeholder="e.g. a nearby station"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`backup-note-${i}`}>Note</label>
                    <input
                      id={`backup-note-${i}`}
                      type="text"
                      maxLength={120}
                      placeholder="e.g. via Clapham Junction if Waterloo branch disrupted"
                      value={day.backupNote}
                      onChange={(e) => onChange(i, { backupNote: e.target.value })}
                    />
                  </div>
                </details>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
