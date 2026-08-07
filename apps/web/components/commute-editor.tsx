"use client";

import { useState, useTransition } from "react";
import { deleteCommuteAction, saveCommuteAction } from "@/app/commute/actions";
import type { CommuteWithLegs } from "@/lib/commutes";
import type { PinDraft } from "./pinned-leg-picker";
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
    const pinDraft = (p: (typeof leg.pins)[number]): PinDraft => ({
      sequence: p.sequence,
      trainUid: p.trainUid,
      gtfsTripId: p.gtfsTripId,
      originCrs: p.originCrs,
      originLabel: p.originLabel,
      schedDep: p.schedDep.slice(0, 5),
      destCrs: p.destCrs,
      destLabel: p.destLabel,
      schedArr: p.schedArr.slice(0, 5),
      toc: p.toc,
      pickedServiceDate: p.pickedServiceDate,
    });
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
      amPins: leg.pins
        .filter((p) => p.direction === "am")
        .sort((a, b) => a.sequence - b.sequence)
        .map(pinDraft),
      pmPins: leg.pins
        .filter((p) => p.direction === "pm")
        .sort((a, b) => a.sequence - b.sequence)
        .map(pinDraft),
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
    setDays((prev) =>
      prev.map((d, i) => {
        if (i !== dow) return d;
        const next = { ...d, ...patch };
        // Pre-fill the fallback window from the pinned journey's own times
        // whenever pins change — forward-only, never clears an edited window
        // when the last pin is removed (decision: window stays independently
        // editable after pre-fill).
        if (patch.amPins) {
          const sorted = [...patch.amPins].sort((a, b) => a.sequence - b.sequence);
          if (sorted.length > 0) {
            next.amStart = sorted[0]!.schedDep;
            next.amEnd = sorted[sorted.length - 1]!.schedArr;
          }
        }
        if (patch.pmPins) {
          const sorted = [...patch.pmPins].sort((a, b) => a.sequence - b.sequence);
          if (sorted.length > 0) {
            next.pmStart = sorted[0]!.schedDep;
            next.pmEnd = sorted[sorted.length - 1]!.schedArr;
          }
        }
        return next;
      }),
    );
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
        pins: [
          ...d.amPins.map((p) => ({ ...p, direction: "am" as const })),
          ...d.pmPins.map((p) => ({ ...p, direction: "pm" as const })),
        ],
      }));
    return {
      label: label.trim(),
      homeCrs: home?.crs ?? "",
      homeLabel: homeLabel.trim() || "Home",
      priority,
      legs,
    };
  }

  /** Leg N+1 must start where leg N ended — a hard block, not a warning. */
  function findChainGap(pins: PinDraft[]): string | null {
    const sorted = [...pins].sort((a, b) => a.sequence - b.sequence);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (prev.destCrs !== cur.originCrs) {
        return `"${prev.destLabel}" doesn't match "${cur.originLabel}" — pick a leg that starts where the previous one ends, or remove the gap.`;
      }
    }
    return null;
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
      const amGap = findChainGap(leg.pins.filter((p) => p.direction === "am"));
      if (amGap) return amGap;
      const pmGap = findChainGap(leg.pins.filter((p) => p.direction === "pm"));
      if (pmGap) return pmGap;
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
        Turn on the days you travel and set where you&rsquo;re heading. Pick real trains for a
        precise plan, or just set a rough time window — pinned trains always come first when both
        are set, and we&rsquo;ll switch to a live search automatically if one stops running.
      </p>

      <WeeklyGrid
        stations={stations}
        days={days}
        onChange={patchDay}
        homeCrs={home?.crs ?? ""}
        homeLabel={homeLabel}
      />

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
