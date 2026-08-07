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
      {days.map((day, i) => (
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
                <fieldset className="window">
                  <legend>Morning · home → work</legend>
                  <p className="editor-hint">
                    Pick real trains below, or just set a rough time window — pinned trains take
                    priority when both are set.
                  </p>
                  <PinnedLegPicker
                    pins={day.amPins}
                    onChange={(pins) => onChange(i, { amPins: pins })}
                    chainOriginCrs={homeCrs}
                    chainOriginLabel={homeLabel || "Home"}
                    chainDestCrs={day.work?.crs ?? ""}
                    chainDestLabel={day.workLabel || day.work?.name || "Work"}
                    windowStart={day.amStart || "00:00"}
                    dayOfWeek={i}
                  />
                  <div className="window-times">
                    <label>
                      From{day.amPins.length > 0 ? " (fallback)" : ""}
                      <input
                        type="time"
                        value={day.amStart}
                        onChange={(e) => onChange(i, { amStart: e.target.value })}
                      />
                    </label>
                    <label>
                      To{day.amPins.length > 0 ? " (fallback)" : ""}
                      <input
                        type="time"
                        value={day.amEnd}
                        onChange={(e) => onChange(i, { amEnd: e.target.value })}
                      />
                    </label>
                  </div>
                </fieldset>

                <fieldset className="window">
                  <legend>Evening · work → home</legend>
                  <p className="editor-hint">
                    Pick real trains below, or just set a rough time window — pinned trains take
                    priority when both are set.
                  </p>
                  <PinnedLegPicker
                    pins={day.pmPins}
                    onChange={(pins) => onChange(i, { pmPins: pins })}
                    chainOriginCrs={day.work?.crs ?? ""}
                    chainOriginLabel={day.workLabel || day.work?.name || "Work"}
                    chainDestCrs={homeCrs}
                    chainDestLabel={homeLabel || "Home"}
                    windowStart={day.pmStart || "00:00"}
                    dayOfWeek={i}
                  />
                  <div className="window-times">
                    <label>
                      From{day.pmPins.length > 0 ? " (fallback)" : ""}
                      <input
                        type="time"
                        value={day.pmStart}
                        onChange={(e) => onChange(i, { pmStart: e.target.value })}
                      />
                    </label>
                    <label>
                      To{day.pmPins.length > 0 ? " (fallback)" : ""}
                      <input
                        type="time"
                        value={day.pmEnd}
                        onChange={(e) => onChange(i, { pmEnd: e.target.value })}
                      />
                    </label>
                  </div>
                </fieldset>
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
      ))}
    </div>
  );
}
