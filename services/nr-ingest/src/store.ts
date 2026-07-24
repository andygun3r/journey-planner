import { createDb, darwinTrain, nrCorpus, nrSmart, nrTrainPosition } from "@mainline/db";
import { and, eq, sql } from "drizzle-orm";
import type { BerthStep, MovementReport } from "./parse.js";

const db = createDb();

// --- In-memory reference caches (loaded once, refreshed hourly) ---
let stanoxToCrs = new Map<string, { crs: string | null; tiploc: string | null }>();
let berthToStanox = new Map<string, string>(); // `${area}|${from}|${to}` -> stanox
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
    })
    .from(nrSmart);
  const b2s = new Map<string, string>();
  for (const r of smart) {
    if (r.stanox) b2s.set(`${r.tdArea}|${r.fromBerth ?? ""}|${r.toBerth ?? ""}`, r.stanox);
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

  await db
    .insert(nrTrainPosition)
    .values({
      trainId: m.trainId,
      lastStanox: m.stanox,
      lastTiploc: tiploc,
      lastCrs: crs,
      lastEventType: m.eventType,
      lastReportedAt: new Date(m.actualTimestampMs),
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
        lastReportedAt: new Date(m.actualTimestampMs),
        lateness: m.latenessSeconds ?? null,
        updatedAt: new Date(),
      },
    });
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

export async function applyBerthStep(b: BerthStep): Promise<string | undefined> {
  await ensureRef();
  const stanox = berthToStanox.get(`${b.tdArea}|${b.fromBerth ?? ""}|${b.toBerth ?? ""}`);
  const crs = stanox ? (stanoxToCrs.get(stanox)?.crs ?? null) : null;

  // TD is keyed by headcode, not train_id. Update any position row we can match
  // by headcode; otherwise record the berth against the headcode as the key so
  // the service layer can still surface "train X near <area>".
  await db
    .insert(nrTrainPosition)
    .values({
      trainId: `TD:${b.headcode}`,
      headcode: b.headcode,
      tdArea: b.tdArea,
      berth: b.toBerth ?? b.fromBerth ?? null,
      lastStanox: stanox ?? null,
      lastCrs: crs,
      lastEventType: "PASS",
      lastReportedAt: new Date(b.timestampMs),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: nrTrainPosition.trainId,
      set: {
        headcode: b.headcode,
        tdArea: b.tdArea,
        berth: b.toBerth ?? b.fromBerth ?? null,
        lastStanox: stanox ?? null,
        lastCrs: crs,
        lastEventType: "PASS",
        lastReportedAt: new Date(b.timestampMs),
        updatedAt: new Date(),
      },
    });
  return crs ?? undefined;
}

void findRidForHeadcode;
