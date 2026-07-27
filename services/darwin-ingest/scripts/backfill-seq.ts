/**
 * One-off backfill: re-derive darwin_stop_forecast.seq from scheduled time.
 *
 * Before the applyTS seq-assignment fix, a stop first seen via a TS message
 * (i.e. the SC that would have seeded its correct position was missed) was
 * appended in message-arrival order rather than chronological order. That can
 * leave a rid's rows sorted incorrectly by seq, which callers rely on to
 * order the route.
 *
 * For each rid, this re-numbers seq by scheduled time (schedArr ?? schedDep),
 * only touching rids whose current seq order actually disagrees with time
 * order. Rows with no scheduled time at all (schedPass-only or day markers)
 * keep their position relative to their neighbours in the original seq order.
 *
 * Run once against the target DB: node --env-file=../../.env --import tsx scripts/backfill-seq.ts
 */
import { createDb, darwinStopForecast } from "@mainline/db";
import { asc, eq, sql } from "drizzle-orm";

const db = createDb();

interface Row {
  rid: string;
  tiploc: string;
  seq: number;
  schedArr: string | null;
  schedDep: string | null;
}

function timeOf(r: Row): string | null {
  return r.schedArr ?? r.schedDep ?? null;
}

async function main() {
  const rids = await db
    .selectDistinct({ rid: darwinStopForecast.rid })
    .from(darwinStopForecast);
  console.log(`Checking ${rids.length} rids...`);

  let fixed = 0;
  for (const { rid } of rids) {
    const rows = await db
      .select({
        rid: darwinStopForecast.rid,
        tiploc: darwinStopForecast.tiploc,
        seq: darwinStopForecast.seq,
        schedArr: darwinStopForecast.schedArr,
        schedDep: darwinStopForecast.schedDep,
      })
      .from(darwinStopForecast)
      .where(eq(darwinStopForecast.rid, rid))
      .orderBy(asc(darwinStopForecast.seq));

    const timed = rows.filter((r) => timeOf(r) !== null);
    if (timed.length < 2) continue;

    const byTime = [...timed].sort((a, b) => timeOf(a)!.localeCompare(timeOf(b)!));
    const alreadyOrdered = timed.every((r, i) => r.tiploc === byTime[i]!.tiploc);
    if (alreadyOrdered) continue;

    // Re-order the timed rows chronologically; each untimed row keeps riding
    // along immediately after whichever timed row precedes it in the
    // original seq order (so a mid-section pass-only marker, say, still sits
    // between the same two named stops it did before — only the disputed
    // chronology of the timed rows themselves is corrected).
    const newTimeIndex = new Map(byTime.map((r, i) => [r.tiploc, i]));
    let lastTimedNewIdx = -1;
    const allSorted = [...rows]
      .map((r) => {
        const t = timeOf(r);
        if (t !== null) {
          lastTimedNewIdx = newTimeIndex.get(r.tiploc)!;
          return { r, key: lastTimedNewIdx };
        }
        // Untimed row: anchor just after the most recent timed row seen so
        // far in original order, breaking ties by original seq.
        return { r, key: lastTimedNewIdx + 0.5 };
      })
      .sort((a, b) => a.key - b.key || a.r.seq - b.r.seq)
      .map((x) => x.r);

    const stillOrdered = rows.every((r, i) => r.tiploc === allSorted[i]!.tiploc);
    if (stillOrdered) continue;

    console.log(`Fixing rid ${rid}: ${rows.map((r) => r.tiploc).join(",")} -> ${allSorted.map((r) => r.tiploc).join(",")}`);

    await db.transaction(async (tx) => {
      for (let i = 0; i < allSorted.length; i++) {
        await tx
          .update(darwinStopForecast)
          .set({ seq: i })
          .where(sql`${darwinStopForecast.rid} = ${rid} and ${darwinStopForecast.tiploc} = ${allSorted[i]!.tiploc}`);
      }
    });
    fixed++;
  }

  console.log(`Done. Fixed ${fixed} rid(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
