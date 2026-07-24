"use client";

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
}

export function emptyDay(): DayDraft {
  return { active: false, work: null, workLabel: "", amStart: "", amEnd: "", pmStart: "", pmEnd: "" };
}

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface Props {
  stations: StationOption[];
  days: DayDraft[];
  onChange: (dayOfWeek: number, patch: Partial<DayDraft>) => void;
}

export function WeeklyGrid({ stations, days, onChange }: Props) {
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
                  <div className="window-times">
                    <label>
                      From
                      <input
                        type="time"
                        value={day.amStart}
                        onChange={(e) => onChange(i, { amStart: e.target.value })}
                      />
                    </label>
                    <label>
                      To
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
                  <div className="window-times">
                    <label>
                      From
                      <input
                        type="time"
                        value={day.pmStart}
                        onChange={(e) => onChange(i, { pmStart: e.target.value })}
                      />
                    </label>
                    <label>
                      To
                      <input
                        type="time"
                        value={day.pmEnd}
                        onChange={(e) => onChange(i, { pmEnd: e.target.value })}
                      />
                    </label>
                  </div>
                </fieldset>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
