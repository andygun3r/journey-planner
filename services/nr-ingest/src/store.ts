import {
  createDb,
  darwinTrain,
  nrCorpus,
  nrSignallingState,
  nrSmart,
  nrTrainPosition,
  nrTrainPositionHistory,
} from "@mainline/db";
import { and, eq, lt, sql } from "drizzle-orm";
import type { BerthStep, MovementReport, SClassReport } from "./parse.js";

const db = createDb();

const POSITION_HISTORY_RETENTION_DAYS = Number(
  process.env.NR_POSITION_HISTORY_RETENTION_DAYS ?? 7,
);

/** Cheap self-prune: no dedicated cron, just an occasional sweep on write. */
function maybePruneHistory(): void {
  if (Math.random() >= 0.001) return;
  const cutoff = new Date(Date.now() - POSITION_HISTORY_RETENTION_DAYS * 86_400_000);
  void db.delete(nrTrainPositionHistory).where(lt(nrTrainPositionHistory.recordedAt, cutoff));
}

// --- In-memory reference caches (loaded once, refreshed hourly) ---
let stanoxToCrs = new Map<string, { crs: string | null; tiploc: string | null }>();
// `${area}|${from}|${to}` -> stanox + SMART's own event code for this berth
// boundary ("A" arrival / "D" departure / other = a mid-section step, not a
// station event worth surfacing as "Passed <station>").
let berthToStanox = new Map<string, { stanox: string; eventType: string | null }>();
let refLoadedAt = 0;

async function ensureRef(): Promise<void> {
  if (stanoxToCrs.size > 0 && Date.now() - refLoadedAt < 3_600_000) return;
  const corpus = await db
    .select({ stanox: nrCorpus.stanox, crs: nrCorpus.crs, tiploc: nrCorpus.tiploc })
    .from(nrCorpus);
  const s2c = new Map<string, { crs: string | null; tiploc: string | null }>();
  for (const r of corpus) s2c.set(r.stanox, { crs: r.crs, tiploc: r.tiploc });

  const smart = await db
    .select({
      tdArea: nrSmart.tdArea,
      fromBerth: nrSmart.fromBerth,
      toBerth: nrSmart.toBerth,
      stanox: nrSmart.stanox,
      eventType: nrSmart.eventType,
    })
    .from(nrSmart);
  const b2s = new Map<string, { stanox: string; eventType: string | null }>();
  for (const r of smart) {
    if (r.stanox) {
      b2s.set(`${r.tdArea}|${r.fromBerth ?? ""}|${r.toBerth ?? ""}`, {
        stanox: r.stanox,
        eventType: r.eventType,
      });
    }
  }

  stanoxToCrs = s2c;
  berthToStanox = b2s;
  refLoadedAt = Date.now();
}

/** Correlate an NR train to a Darwin rid by headcode. Darwin rid isn't the
 * headcode, but darwin_train has uid; we match on the most recent train whose
 * schedule matches — best-effort, refined by activation train_uid later. */
async function findRidForHeadcode(_headcode: string): Promise<string | null> {
  // Best-effort placeholder: correlation by headcode alone is ambiguous without
  // the schedule feed. We link via activation train_uid where available (below);
  // headcode-only matching is intentionally conservative and returns null here.
  return null;
}

export async function applyMovement(m: MovementReport): Promise<string | undefined> {
  await ensureRef();
  const loc = stanoxToCrs.get(m.stanox);
  const crs = loc?.crs ?? null;
  const tiploc = loc?.tiploc ?? null;

  const reportedAt = new Date(m.actualTimestampMs);
  await db.transaction(async (tx) => {
    await tx
      .insert(nrTrainPosition)
      .values({
        trainId: m.trainId,
        lastStanox: m.stanox,
        lastTiploc: tiploc,
        lastCrs: crs,
        lastEventType: m.eventType,
        lastReportedAt: reportedAt,
        lateness: m.latenessSeconds ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: nrTrainPosition.trainId,
        set: {
          lastStanox: m.stanox,
          lastTiploc: tiploc,
          lastCrs: crs,
          lastEventType: m.eventType,
          lastReportedAt: reportedAt,
          lateness: m.latenessSeconds ?? null,
          updatedAt: new Date(),
        },
      });
    await tx.insert(nrTrainPositionHistory).values({
      trainId: m.trainId,
      lastStanox: m.stanox,
      lastTiploc: tiploc,
      lastCrs: crs,
      lastEventType: m.eventType,
      reportedAt,
      lateness: m.latenessSeconds ?? null,
    });
  });
  maybePruneHistory();
  return crs ?? undefined;
}

export async function applyActivation(trainId: string, trainUid?: string): Promise<void> {
  if (!trainUid) return;
  // Link to the most recent Darwin train with this uid (today's run).
  const match = await db
    .select({ rid: darwinTrain.rid })
    .from(darwinTrain)
    .where(and(eq(darwinTrain.uid, trainUid)))
    .orderBy(sql`${darwinTrain.updatedAt} desc`)
    .limit(1);
  const rid = match[0]?.rid ?? null;

  await db
    .insert(nrTrainPosition)
    .values({ trainId, rid, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: nrTrainPosition.trainId,
      set: { rid, updatedAt: new Date() },
    });
}

/**
 * Map SMART's own berth-boundary event code to a station-arrival/departure
 * label, or null for a mid-section step that isn't a station event at all.
 * Real SMART data uses "A" (arrival) / "D" (departure) / "B" / "C" for other
 * berth-step semantics (timing berths, etc.) — treating every berth step as
 * "PASS" regardless of this code previously reported a train as having
 * "Passed <station>" for berths that actually represent it *approaching* that
 * station's platform, before it had arrived.
 */
function smartEventToLastEventType(eventType: string | null): "ARRIVAL" | "DEPARTURE" | "PASS" | null {
  if (eventType === "A") return "ARRIVAL";
  if (eventType === "D") return "DEPARTURE";
  if (eventType === "B" || eventType === "C") return "PASS";
  return null;
}

export async function applyBerthStep(b: BerthStep): Promise<string | undefined> {
  await ensureRef();
  const smart = berthToStanox.get(`${b.tdArea}|${b.fromBerth ?? ""}|${b.toBerth ?? ""}`);
  const crs = smart ? (stanoxToCrs.get(smart.stanox)?.crs ?? null) : null;
  const lastEventType = smartEventToLastEventType(smart?.eventType ?? null);
  // No recognised station event for this berth boundary: don't report a
  // location at all rather than guessing "PASS" for a mid-section step.
  if (!crs || !lastEventType) return crs ?? undefined;

  // TD is keyed by headcode, not train_id. Update any position row we can match
  // by headcode; otherwise record the berth against the headcode as the key so
  // the service layer can still surface "train X near <area>".
  const reportedAt = new Date(b.timestampMs);
  const berth = b.toBerth ?? b.fromBerth ?? null;
  await db.transaction(async (tx) => {
    await tx
      .insert(nrTrainPosition)
      .values({
        trainId: `TD:${b.headcode}`,
        headcode: b.headcode,
        tdArea: b.tdArea,
        berth,
        lastStanox: smart?.stanox ?? null,
        lastCrs: crs,
        lastEventType,
        lastReportedAt: reportedAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: nrTrainPosition.trainId,
        set: {
          headcode: b.headcode,
          tdArea: b.tdArea,
          berth,
          lastStanox: smart?.stanox ?? null,
          lastCrs: crs,
          lastEventType,
          lastReportedAt: reportedAt,
          updatedAt: new Date(),
        },
      });
    await tx.insert(nrTrainPositionHistory).values({
      trainId: `TD:${b.headcode}`,
      headcode: b.headcode,
      tdArea: b.tdArea,
      berth,
      lastStanox: smart?.stanox ?? null,
      lastCrs: crs,
      lastEventType,
      reportedAt,
    });
  });
  maybePruneHistory();
  return crs ?? undefined;
}

/**
 * Store a batch of S-class signalling reports. Last-writer-wins per (area,
 * address): each row is the current byte at that address. Decoding to specific
 * signals/aspects is a read-time join against sop_mapping.
 */
export async function applySClass(reports: SClassReport[]): Promise<void> {
  if (reports.length === 0) return;
  // Collapse to the latest byte per address within this batch before writing.
  const latest = new Map<string, SClassReport>();
  for (const r of reports) {
    const key = `${r.tdArea}|${r.address}`;
    const prev = latest.get(key);
    if (!prev || r.timestampMs >= prev.timestampMs) latest.set(key, r);
  }
  const rows = [...latest.values()].map((r) => ({
    tdArea: r.tdArea,
    address: r.address,
    data: r.data,
    updatedAt: new Date(r.timestampMs),
  }));
  await db
    .insert(nrSignallingState)
    .values(rows)
    .onConflictDoUpdate({
      target: [nrSignallingState.tdArea, nrSignallingState.address],
      set: { data: sql`excluded.data`, updatedAt: sql`excluded.updated_at` },
    });
}

void findRidForHeadcode;
