"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { CommuteLegRecord } from "@signaller/shared";
import {
  clearDayOverrideAction,
  saveDayOverrideAction,
} from "@/app/commute/actions";
import type { DayOverride } from "@/lib/commute-overrides";

interface Props {
  commuteId: string;
  date: string;
  dayName: string;
  /** The weekly template behind this date, when there is one. */
  leg?: CommuteLegRecord;
  override?: DayOverride;
  onClose: () => void;
}

/** HH:MM for an input[type=time], from either an override or the template. */
const t = (v: string | null | undefined): string => (v ? v.slice(0, 5) : "");

/**
 * Edits one date of a commute.
 *
 * Every field starts from the weekly template, so opening a day and saving
 * without touching anything changes nothing meaningful. "Revert to usual"
 * deletes the override outright rather than writing the template's values back
 * as an override — the date then genuinely follows the template again, and
 * later edits to the template still reach it.
 *
 * The scope choice is the point: a one-off ("just this date") and a change of
 * routine ("every Tuesday from now on") look identical at the moment of
 * editing, and only the user knows which they meant.
 */
export function CommuteDayEditor({ commuteId, date, dayName, leg, override, onClose }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [skipped, setSkipped] = useState(override?.skipped ?? false);
  const [workLabel, setWorkLabel] = useState(override?.workLabel ?? leg?.workLabel ?? "");
  const [amStart, setAmStart] = useState(t(override?.amWindowStart ?? leg?.amWindowStart));
  const [amEnd, setAmEnd] = useState(t(override?.amWindowEnd ?? leg?.amWindowEnd));
  const [pmStart, setPmStart] = useState(t(override?.pmWindowStart ?? leg?.pmWindowStart));
  const [pmEnd, setPmEnd] = useState(t(override?.pmWindowEnd ?? leg?.pmWindowEnd));
  const [note, setNote] = useState(override?.note ?? "");
  const [scope, setScope] = useState<"date" | "future">("date");

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await saveDayOverrideAction({
        commuteId,
        date,
        scope,
        input: {
          skipped,
          workLabel: workLabel.trim() || null,
          amWindowStart: amStart || null,
          amWindowEnd: amEnd || null,
          pmWindowStart: pmStart || null,
          pmWindowEnd: pmEnd || null,
          note: note.trim() || null,
        },
      });
      if (!res.ok) setError(res.error);
      else {
        router.refresh();
        onClose();
      }
    });
  }

  function revert() {
    setError(null);
    startTransition(async () => {
      const res = await clearDayOverrideAction(commuteId, date);
      if (!res.ok) setError(res.error);
      else {
        router.refresh();
        onClose();
      }
    });
  }

  return (
    <div className="cal-editor" role="dialog" aria-label={`Edit ${date}`} aria-modal="false">
      <div className="cal-editor-head">
        <h3>
          {dayName} {date}
        </h3>
        <button type="button" className="cal-editor-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {!leg && (
        <p className="editor-hint">
          You don&rsquo;t normally commute on a {dayName}. Setting times here adds this date only.
        </p>
      )}

      <label className="cal-skip">
        <input type="checkbox" checked={skipped} onChange={(e) => setSkipped(e.target.checked)} />
        Not travelling this day
      </label>

      {!skipped && (
        <>
          <div className="field">
            <label htmlFor={`cal-work-${date}`}>Work label</label>
            <input
              id={`cal-work-${date}`}
              type="text"
              maxLength={60}
              value={workLabel}
              placeholder={leg?.workLabel ?? "Where are you going?"}
              onChange={(e) => setWorkLabel(e.target.value)}
            />
          </div>

          <fieldset className="window">
            <legend>Morning</legend>
            <div className="window-times">
              <label>
                From
                <input type="time" value={amStart} onChange={(e) => setAmStart(e.target.value)} />
              </label>
              <label>
                To
                <input type="time" value={amEnd} onChange={(e) => setAmEnd(e.target.value)} />
              </label>
            </div>
          </fieldset>

          <fieldset className="window">
            <legend>Evening</legend>
            <div className="window-times">
              <label>
                From
                <input type="time" value={pmStart} onChange={(e) => setPmStart(e.target.value)} />
              </label>
              <label>
                To
                <input type="time" value={pmEnd} onChange={(e) => setPmEnd(e.target.value)} />
              </label>
            </div>
          </fieldset>

          <div className="field">
            <label htmlFor={`cal-note-${date}`}>Note</label>
            <input
              id={`cal-note-${date}`}
              type="text"
              maxLength={120}
              value={note}
              placeholder="e.g. client meeting in town"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </>
      )}

      <fieldset className="cal-scope">
        <legend>Apply this to</legend>
        <label>
          <input
            type="radio"
            name="scope"
            checked={scope === "date"}
            onChange={() => setScope("date")}
          />
          Just {date}
        </label>
        <label>
          <input
            type="radio"
            name="scope"
            checked={scope === "future"}
            onChange={() => setScope("future")}
          />
          Every {dayName} from this date on
        </label>
      </fieldset>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="cal-editor-actions">
        <button type="button" className="btn btn-primary" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
        {override && (
          <button type="button" className="btn btn-secondary" onClick={revert} disabled={pending}>
            Revert to usual
          </button>
        )}
        <button type="button" className="btn-link" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
