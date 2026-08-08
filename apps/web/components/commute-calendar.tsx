"use client";

import { useMemo, useState } from "react";
import type { CommuteLegRecord } from "@signaller/shared";
import type { DayOverride } from "@/lib/commute-overrides";
import { CommuteDayEditor } from "@/components/commute-day-editor";

const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** YYYY-MM-DD for a UTC-noon date, matching the resolver's date handling. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 0 = Monday ... 6 = Sunday, matching commute_leg.day_of_week. */
function dowOf(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

interface CalendarCell {
  date: string;
  dayOfMonth: number;
  dow: number;
  leg?: CommuteLegRecord;
  override?: DayOverride;
  isHoliday: boolean;
  isToday: boolean;
  isPast: boolean;
}

/**
 * Builds the cells for one month, Monday-first, padded so the first row starts
 * on the correct weekday. All arithmetic is at UTC noon: it keeps YYYY-MM-DD
 * stable across BST/GMT, the same trick dayOfWeekForDate uses.
 */
function buildMonth(
  year: number,
  month: number,
  legs: CommuteLegRecord[],
  overrides: Map<string, DayOverride>,
  holidays: Set<string>,
  today: string,
): (CalendarCell | null)[] {
  const first = new Date(Date.UTC(year, month, 1, 12));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
  const lead = dowOf(first);

  const cells: (CalendarCell | null)[] = Array(lead).fill(null);
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(Date.UTC(year, month, day, 12));
    const date = ymd(d);
    const dow = dowOf(d);
    cells.push({
      date,
      dayOfMonth: day,
      dow,
      leg: legs.find((l) => l.dayOfWeek === dow),
      override: overrides.get(date),
      isHoliday: holidays.has(date),
      isToday: date === today,
      isPast: date < today,
    });
  }
  return cells;
}

/** "07:00–09:00" / "07:00" / "" — the compact window summary on a cell. */
function windowSummary(cell: CalendarCell): string {
  const o = cell.override;
  const leg = cell.leg;
  const amStart = o?.amWindowStart ?? leg?.amWindowStart ?? null;
  const pmStart = o?.pmWindowStart ?? leg?.pmWindowStart ?? null;
  const parts: string[] = [];
  if (amStart) parts.push(amStart.slice(0, 5));
  if (pmStart) parts.push(pmStart.slice(0, 5));
  return parts.join(" · ");
}

interface Props {
  commuteId: string;
  legs: CommuteLegRecord[];
  overrides: DayOverride[];
  holidayDates: string[];
  /** Today's UK-local date, passed from the server so the grid doesn't depend
   *  on the browser's clock or timezone. */
  today: string;
}

/**
 * Month view of a commute, so individual dates can be edited rather than only
 * the weekly template.
 *
 * The weekly grid answers "what does a normal Tuesday look like"; this answers
 * "what is happening on the 14th". Cells that follow the template render from
 * the template — only genuinely changed dates carry an override, so an
 * untouched month shows the usual pattern without storing anything.
 */
export function CommuteCalendar({ commuteId, legs, overrides, holidayDates, today }: Props) {
  const todayDate = new Date(`${today}T12:00:00Z`);
  const [year, setYear] = useState(todayDate.getUTCFullYear());
  const [month, setMonth] = useState(todayDate.getUTCMonth());
  const [editing, setEditing] = useState<CalendarCell | null>(null);

  const overrideMap = useMemo(
    () => new Map(overrides.map((o) => [o.date, o])),
    [overrides],
  );
  const holidaySet = useMemo(() => new Set(holidayDates), [holidayDates]);

  const cells = useMemo(
    () => buildMonth(year, month, legs, overrideMap, holidaySet, today),
    [year, month, legs, overrideMap, holidaySet, today],
  );

  function step(delta: number) {
    const next = new Date(Date.UTC(year, month + delta, 1, 12));
    setYear(next.getUTCFullYear());
    setMonth(next.getUTCMonth());
  }

  return (
    <section className="cal" aria-label="Commute calendar">
      <div className="cal-head">
        <button type="button" className="cal-nav" onClick={() => step(-1)} aria-label="Previous month">
          ‹
        </button>
        <h2 className="cal-title">
          {MONTHS[month]} {year}
        </h2>
        <button type="button" className="cal-nav" onClick={() => step(1)} aria-label="Next month">
          ›
        </button>
      </div>

      <div className="cal-weekdays" aria-hidden="true">
        {DAY_SHORT.map((d) => (
          <span key={d} className="cal-weekday">
            {d}
          </span>
        ))}
      </div>

      <div className="cal-grid" role="grid">
        {cells.map((cell, i) => {
          if (!cell) return <span key={`pad-${i}`} className="cal-cell cal-cell-pad" />;

          const scheduled = Boolean(cell.leg);
          const skipped = cell.override?.skipped ?? false;
          const changed = Boolean(cell.override) && !skipped;
          const workLabel = cell.override?.workLabel ?? cell.leg?.workLabel ?? "";

          // A date is "on" if the template gives it a leg and nothing has
          // switched it off. Holidays win over both — they're account-wide.
          const travelling = scheduled && !skipped && !cell.isHoliday;

          return (
            <button
              key={cell.date}
              type="button"
              role="gridcell"
              className={[
                "cal-cell",
                travelling ? "cal-cell-on" : "cal-cell-off",
                cell.isToday ? "cal-cell-today" : "",
                cell.isPast ? "cal-cell-past" : "",
                changed ? "cal-cell-changed" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => setEditing(cell)}
              aria-label={`${cell.dayOfMonth} ${MONTHS[month]} — ${
                cell.isHoliday
                  ? "holiday"
                  : skipped
                    ? "not travelling"
                    : travelling
                      ? `commuting${workLabel ? ` to ${workLabel}` : ""}`
                      : "nothing scheduled"
              }${changed ? ", changed for this date" : ""}`}
            >
              <span className="cal-daynum">{cell.dayOfMonth}</span>
              {cell.isHoliday ? (
                <span className="cal-tag">Holiday</span>
              ) : skipped ? (
                <span className="cal-tag">Off</span>
              ) : travelling ? (
                <>
                  <span className="cal-work">{workLabel}</span>
                  <span className="cal-window">{windowSummary(cell)}</span>
                </>
              ) : null}
              {/* Marked with a word as well as the dot, so "this date differs"
                  is never carried by colour alone. */}
              {changed && <span className="cal-changed-tag">Edited</span>}
            </button>
          );
        })}
      </div>

      {editing && (
        <CommuteDayEditor
          commuteId={commuteId}
          date={editing.date}
          dayName={DAY_NAMES[editing.dow]!}
          leg={editing.leg}
          override={editing.override}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
