"use client";

import { useState, useTransition } from "react";
import { deleteCommuteAction, saveCommuteAction } from "@/app/commute/actions";
import type { CommuteWithLegs } from "@/lib/commutes";
import { StationInput, type StationOption } from "./station-input";
import { type DayDraft, emptyDay, WeeklyGrid } from "./weekly-grid";

interface Props {
  stations: StationOption[];
  /** Existing commute when editing; null when creating. */
  commute: CommuteWithLegs | null;
}

function draftsFrom(commute: CommuteWithLegs | null, stations: StationOption[]): DayDraft[] {
  const byCrs = new Map(stations.map((s) => [s.crs, s]));
  const days = Array.from({ length: 7 }, emptyDay);
  for (const leg of commute?.legs ?? []) {
    days[leg.dayOfWeek] = {
      active: true,
      work: byCrs.get(leg.workCrs) ?? { crs: leg.workCrs, name: leg.workCrs },
      workLabel: leg.workLabel,
      amStart: leg.amWindowStart?.slice(0, 5) ?? "",
      amEnd: leg.amWindowEnd?.slice(0, 5) ?? "",
      pmStart: leg.pmWindowStart?.slice(0, 5) ?? "",
      pmEnd: leg.pmWindowEnd?.slice(0, 5) ?? "",
      backupWork: leg.backupWorkCrs
        ? (byCrs.get(leg.backupWorkCrs) ?? { crs: leg.backupWorkCrs, name: leg.backupWorkCrs })
        : null,
      backupHome: leg.backupHomeCrs
        ? (byCrs.get(leg.backupHomeCrs) ?? { crs: leg.backupHomeCrs, name: leg.backupHomeCrs })
        : null,
      backupNote: leg.backupNote ?? "",
    };
  }
  return days;
}

export function CommuteEditor({ stations, commute }: Props) {
  const stationByCrs = new Map(stations.map((s) => [s.crs, s]));
  const [label, setLabel] = useState(commute?.label ?? "My commute");
  const [home, setHome] = useState<StationOption | null>(
    commute?.homeCrs ? (stationByCrs.get(commute.homeCrs) ?? null) : null,
  );
  const [homeLabel, setHomeLabel] = useState(commute?.homeLabel ?? "Home");
  const [priority, setPriority] = useState(commute?.priority ?? 0);
  const [days, setDays] = useState<DayDraft[]>(() => draftsFrom(commute, stations));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function patchDay(dow: number, patch: Partial<DayDraft>) {
    setDays((prev) => prev.map((d, i) => (i === dow ? { ...d, ...patch } : d)));
  }

  function buildPayload() {
    const legs = days
      .map((d, dayOfWeek) => ({ d, dayOfWeek }))
      .filter(({ d }) => d.active)
      .map(({ d, dayOfWeek }) => ({
        dayOfWeek,
        workCrs: d.work?.crs ?? "",
        workLabel: d.workLabel.trim() || d.work?.name || "Work",
        am: { start: d.amStart || null, end: d.amEnd || null },
        pm: { start: d.pmStart || null, end: d.pmEnd || null },
        backupWorkCrs: d.backupWork?.crs || null,
        backupHomeCrs: d.backupHome?.crs || null,
        backupNote: d.backupNote.trim() || null,
      }));
    return {
      label: label.trim(),
      homeCrs: home?.crs ?? "",
      homeLabel: homeLabel.trim() || "Home",
      priority,
      legs,
    };
  }

  function clientValidate(payload: ReturnType<typeof buildPayload>): string | null {
    if (!payload.homeCrs) return "Choose a home station";
    if (payload.legs.length === 0) return "Turn on at least one day and set its details";
    for (const leg of payload.legs) {
      if (!leg.workCrs) return "Every active day needs a work location";
      const hasAm = leg.am.start && leg.am.end;
      const hasPm = leg.pm.start && leg.pm.end;
      if (!hasAm && !hasPm) return "Each active day needs a morning or evening time window";
      if ((leg.am.start ? 1 : 0) + (leg.am.end ? 1 : 0) === 1)
        return "Set both a From and To for the morning window";
      if ((leg.pm.start ? 1 : 0) + (leg.pm.end ? 1 : 0) === 1)
        return "Set both a From and To for the evening window";
    }
    return null;
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const payload = buildPayload();
    const clientError = clientValidate(payload);
    if (clientError) {
      setError(clientError);
      return;
    }
    startTransition(async () => {
      const result = await saveCommuteAction(commute?.id ?? null, payload);
      // On success the action redirects; we only get here on failure.
      if (result && !result.ok) setError(result.error);
    });
  }

  function onDelete() {
    if (!commute) return;
    if (!confirm("Delete this commute? Its alerts and schedule will be removed.")) return;
    startTransition(() => deleteCommuteAction(commute.id));
  }

  return (
    <form className="commute-editor" onSubmit={onSubmit}>
      <div className="editor-top">
        <div className="field">
          <label htmlFor="commute-label">Commute name</label>
          <input
            id="commute-label"
            type="text"
            maxLength={60}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Weekday commute"
          />
        </div>
        <StationInput
          label="Home station"
          name="home"
          stations={stations}
          value={home}
          onChange={setHome}
          placeholder="Your home station"
        />
        <div className="field">
          <label htmlFor="home-label">Home label</label>
          <input
            id="home-label"
            type="text"
            maxLength={60}
            value={homeLabel}
            onChange={(e) => setHomeLabel(e.target.value)}
            placeholder="Home"
          />
        </div>
        <div className="field">
          <label htmlFor="commute-priority">Default order</label>
          <input
            id="commute-priority"
            type="number"
            min={0}
            max={10}
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value) || 0)}
          />
          <p className="editor-hint">
            If two commutes run on the same day, the higher number shows on your dashboard by
            default. You can always switch to the other one.
          </p>
        </div>
      </div>

      <h2 className="editor-subhead">Weekly schedule</h2>
      <p className="editor-hint">
        Turn on the days you travel and set where you&rsquo;re heading and roughly when.
        Work can differ each day.
      </p>

      <WeeklyGrid stations={stations} days={days} onChange={patchDay} />

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="editor-actions">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : commute ? "Save changes" : "Create commute"}
        </button>
        {commute && (
          <button type="button" className="btn btn-danger-outline" onClick={onDelete} disabled={pending}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
