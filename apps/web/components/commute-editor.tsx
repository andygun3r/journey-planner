"use client";

import { useState, useTransition } from "react";
import { deleteCommuteAction, saveCommuteAction } from "@/app/commute/actions";
import type { CommuteWithLegs } from "@/lib/commutes";
import { nearestDateForDayOfWeek, type PinDraft } from "./pinned-leg-picker";
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
      amOrigin: leg.amOriginCrs
        ? (byCrs.get(leg.amOriginCrs) ?? { crs: leg.amOriginCrs, name: leg.amOriginLabel ?? leg.amOriginCrs })
        : null,
      amDest: leg.amDestCrs
        ? (byCrs.get(leg.amDestCrs) ?? { crs: leg.amDestCrs, name: leg.amDestLabel ?? leg.amDestCrs })
        : null,
      pmOrigin: leg.pmOriginCrs
        ? (byCrs.get(leg.pmOriginCrs) ?? { crs: leg.pmOriginCrs, name: leg.pmOriginLabel ?? leg.pmOriginCrs })
        : null,
      pmDest: leg.pmDestCrs
        ? (byCrs.get(leg.pmDestCrs) ?? { crs: leg.pmDestCrs, name: leg.pmDestLabel ?? leg.pmDestCrs })
        : null,
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

  /**
   * Copies one day's full plan (work station, windows, pinned legs) onto
   * other days — a pure client-side state copy, since persistence is
   * full-replace-all per save (see updateCommute in lib/commutes.ts); there's
   * no server-side linkage between days to maintain.
   */
  function copyDay(fromDow: number, toDows: number[]) {
    setDays((prev) => {
      const source = prev[fromDow];
      if (!source) return prev;
      return prev.map((d, i) => {
        if (!toDows.includes(i)) return d;
        // Pins carry a pickedServiceDate anchored to the day they were
        // searched on. The train_uid/times themselves stay valid — the whole
        // point of a pin is that trip_mapping revalidates it by day-of-week,
        // not by this stored date — but the date itself would be wrong for
        // the target day, so recompute it to what a fresh pick would store.
        const retarget = (p: PinDraft): PinDraft => ({ ...p, pickedServiceDate: nearestDateForDayOfWeek(i) });
        return {
          ...source,
          active: true,
          amPins: source.amPins.map(retarget),
          pmPins: source.pmPins.map(retarget),
        };
      });
    });
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
        amOriginCrs: d.amOrigin?.crs || null,
        amOriginLabel: d.amOrigin?.name || null,
        amDestCrs: d.amDest?.crs || null,
        amDestLabel: d.amDest?.name || null,
        pmOriginCrs: d.pmOrigin?.crs || null,
        pmOriginLabel: d.pmOrigin?.name || null,
        pmDestCrs: d.pmDest?.crs || null,
        pmDestLabel: d.pmDest?.name || null,
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

  /**
   * A direction's pins must form one unbroken chain from its real origin to
   * its real destination — checks both internal contiguity (leg N+1 starts
   * where leg N ended) and full coverage (the chain actually starts/ends
   * where it should, catching a slot the user declared via a change station
   * but never searched/picked — an empty slot just means the pins array is
   * shorter than the declared structure, which this also catches since the
   * last pin's destCrs won't match the real destination). A hard block, not
   * a warning.
   */
  function findChainProblem(pins: PinDraft[], originCrs: string, originLabel: string, destCrs: string, destLabel: string): string | null {
    if (pins.length === 0) return null; // window-only day, nothing pinned — fine
    const sorted = [...pins].sort((a, b) => a.sequence - b.sequence);
    if (sorted[0]!.originCrs !== originCrs) {
      return `The first leg doesn't start at ${originLabel} — pick a leg that starts there, or remove the change stations before it.`;
    }
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (prev.destCrs !== cur.originCrs) {
        return `"${prev.destLabel}" doesn't match "${cur.originLabel}" — pick a leg that starts where the previous one ends, or remove the gap.`;
      }
    }
    if (sorted[sorted.length - 1]!.destCrs !== destCrs) {
      return `You still need to pick a train for the last leg to ${destLabel}.`;
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
      const amProblem = findChainProblem(
        leg.pins.filter((p) => p.direction === "am"),
        leg.amOriginCrs ?? payload.homeCrs,
        leg.amOriginLabel ?? (homeLabel.trim() || "Home"),
        leg.amDestCrs ?? leg.workCrs,
        leg.amDestLabel ?? leg.workLabel,
      );
      if (amProblem) return amProblem;
      const pmProblem = findChainProblem(
        leg.pins.filter((p) => p.direction === "pm"),
        leg.pmOriginCrs ?? leg.workCrs,
        leg.pmOriginLabel ?? leg.workLabel,
        leg.pmDestCrs ?? payload.homeCrs,
        leg.pmDestLabel ?? (homeLabel.trim() || "Home"),
      );
      if (pmProblem) return pmProblem;
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
        onCopyDay={copyDay}
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
