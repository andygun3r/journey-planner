"use client";

import { useMemo, useState, useTransition } from "react";
import { addHolidayAction, deleteHolidayAction } from "@/app/commute/actions";
import type { HolidayRecord } from "@/lib/holidays";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const rangeFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** YYYY-MM-DD for a Date's local calendar day (dates here are date-only, UTC-noon). */
function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

function parseYmd(s: string): Date {
  return new Date(`${s}T12:00:00Z`);
}

/** Monday-indexed day-of-week (0 = Mon) for a UTC-noon date. */
function mondayDow(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

interface Props {
  holidays: HolidayRecord[];
}

export function HolidayManager({ holidays }: Props) {
  const today = useMemo(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
  }, []);
  const [viewYear, setViewYear] = useState(today.getUTCFullYear());
  const [viewMonth, setViewMonth] = useState(today.getUTCMonth());
  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const [rangeEnd, setRangeEnd] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const monthLabel = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(
    new Date(Date.UTC(viewYear, viewMonth, 1, 12)),
  );

  const cells = useMemo(() => {
    const first = new Date(Date.UTC(viewYear, viewMonth, 1, 12));
    const lead = mondayDow(first);
    const daysInMonth = new Date(Date.UTC(viewYear, viewMonth + 1, 0, 12)).getUTCDate();
    const out: (Date | null)[] = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let day = 1; day <= daysInMonth; day++) out.push(new Date(Date.UTC(viewYear, viewMonth, day, 12)));
    return out;
  }, [viewYear, viewMonth]);

  function inSelection(s: string): boolean {
    if (!rangeStart) return false;
    const end = rangeEnd ?? rangeStart;
    const lo = rangeStart <= end ? rangeStart : end;
    const hi = rangeStart <= end ? end : rangeStart;
    return s >= lo && s <= hi;
  }

  function onDayClick(d: Date) {
    const s = ymd(d);
    setError(null);
    if (!rangeStart || (rangeStart && rangeEnd)) {
      setRangeStart(s);
      setRangeEnd(null);
    } else {
      // Second click completes the range (order-independent).
      if (s < rangeStart) {
        setRangeEnd(rangeStart);
        setRangeStart(s);
      } else {
        setRangeEnd(s);
      }
    }
  }

  function prevMonth() {
    const m = viewMonth - 1;
    if (m < 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else setViewMonth(m);
  }
  function nextMonth() {
    const m = viewMonth + 1;
    if (m > 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else setViewMonth(m);
  }

  function onAdd() {
    if (!rangeStart) {
      setError("Pick a date (or a range) on the calendar");
      return;
    }
    const startDate = rangeStart;
    const endDate = rangeEnd ?? rangeStart;
    startTransition(async () => {
      const result = await addHolidayAction({
        startDate,
        endDate,
        label: label.trim() || null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRangeStart(null);
      setRangeEnd(null);
      setLabel("");
    });
  }

  function onDelete(id: string) {
    startTransition(() => deleteHolidayAction(id));
  }

  const selectionText =
    rangeStart &&
    (rangeEnd && rangeEnd !== rangeStart
      ? `${rangeFmt.format(parseYmd(rangeStart))} – ${rangeFmt.format(parseYmd(rangeEnd))}`
      : rangeFmt.format(parseYmd(rangeStart)));

  return (
    <div className="holiday-manager">
      <div className="holiday-calendar">
        <div className="cal-head">
          <button type="button" className="cal-nav" onClick={prevMonth} aria-label="Previous month">
            ‹
          </button>
          <span className="cal-month">{monthLabel}</span>
          <button type="button" className="cal-nav" onClick={nextMonth} aria-label="Next month">
            ›
          </button>
        </div>
        <div className="cal-grid" role="grid" aria-label="Select holiday dates">
          {WEEKDAYS.map((w) => (
            <span key={w} className="cal-weekday" aria-hidden="true">
              {w}
            </span>
          ))}
          {cells.map((d, i) =>
            d === null ? (
              <span key={`b${i}`} className="cal-cell cal-blank" />
            ) : (
              <button
                key={ymd(d)}
                type="button"
                className={`cal-cell ${inSelection(ymd(d)) ? "cal-selected" : ""} ${
                  ymd(d) === ymd(today) ? "cal-today" : ""
                }`}
                aria-pressed={inSelection(ymd(d))}
                onClick={() => onDayClick(d)}
              >
                {d.getUTCDate()}
              </button>
            ),
          )}
        </div>

        <div className="holiday-add">
          <div className="field">
            <label htmlFor="holiday-label">
              {selectionText ? `Selected: ${selectionText}` : "Select dates above"}
            </label>
            <input
              id="holiday-label"
              type="text"
              maxLength={60}
              placeholder="Reason (optional) — e.g. Annual leave"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <button type="button" className="btn btn-primary" onClick={onAdd} disabled={pending || !rangeStart}>
            Add holiday
          </button>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="holiday-list">
        <h2 className="editor-subhead">Your holidays</h2>
        {holidays.length === 0 ? (
          <p className="editor-hint">
            No holidays yet. Add dates you&rsquo;re off so we don&rsquo;t alert you about your commute.
          </p>
        ) : (
          <ul className="holiday-rows">
            {holidays.map((h) => (
              <li key={h.id} className="holiday-row">
                <span className="holiday-dates">
                  {h.startDate === h.endDate
                    ? rangeFmt.format(parseYmd(h.startDate))
                    : `${rangeFmt.format(parseYmd(h.startDate))} – ${rangeFmt.format(parseYmd(h.endDate))}`}
                </span>
                {h.label && <span className="holiday-label-text">{h.label}</span>}
                <button
                  type="button"
                  className="btn-link-danger"
                  onClick={() => onDelete(h.id)}
                  disabled={pending}
                  aria-label={`Remove holiday ${h.startDate}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
