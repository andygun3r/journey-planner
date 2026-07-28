/**
 * Ordering the departure board.
 *
 * There was no comparator anywhere in the board chain — rows came out in
 * whatever order LDBWS or MOTIS returned them, which is always booked order.
 * A train running 40 minutes late therefore sat in its original slot while
 * trains that would actually leave first were listed below it.
 *
 * The board now orders by when each train is genuinely expected to leave, so
 * the next thing off the platform is the top row. That is the direct reading of
 * "time is the interface" (PRODUCT.md) for someone standing on the concourse.
 *
 * Because rows can now move, each one that has been displaced from its booked
 * position is flagged so the UI can say so quietly. A row silently jumping the
 * queue reads as a glitch; a row that says "moved up" reads as information.
 */

export interface OrderableDeparture {
  /** ISO instant of the booked departure. */
  scheduled: string;
  /** ISO instant of the live estimate, when there is one. */
  live?: string;
  status: "on-time" | "delayed" | "cancelled" | "scheduled";
  tripId?: string;
  rid?: string;
}

/**
 * The instant this row is actually expected to depart.
 *
 * Cancelled services keep their booked time: they aren't going to depart at
 * all, so a live estimate would be meaningless, and moving them would scatter
 * them through the list instead of leaving them where a traveller expects.
 */
export function expectedDeparture<T extends OrderableDeparture>(d: T): number {
  const scheduled = Date.parse(d.scheduled);
  if (d.status === "cancelled") return scheduled;
  const live = d.live ? Date.parse(d.live) : Number.NaN;
  if (Number.isFinite(live)) return live;
  return scheduled;
}

/** Stable identity for a row, for detecting that it moved. */
function identity(d: OrderableDeparture, index: number): string {
  return d.tripId ?? d.rid ?? `${d.scheduled}#${index}`;
}

export interface Ordered<T> {
  departure: T;
  /** True when live running has displaced this row from its booked position. */
  movedFromSchedule: boolean;
}

/**
 * Order by expected departure, flagging rows that live running has displaced.
 *
 * Both comparisons work on real instants. Sorting "HH:MM" strings would put
 * 00:14 above 23:47 on a board that spans midnight, which is why every time in
 * this chain is an ISO instant by the time it reaches here.
 */
export function orderByExpectedDeparture<T extends OrderableDeparture>(
  departures: T[],
): Array<Ordered<T>> {
  const scheduledOrder = [...departures]
    .map((d, i) => ({ d, i, key: Date.parse(d.scheduled) }))
    .sort((a, b) => a.key - b.key || a.i - b.i);
  const scheduledRank = new Map<string, number>();
  scheduledOrder.forEach((entry, rank) => scheduledRank.set(identity(entry.d, entry.i), rank));

  const expectedOrder = [...departures]
    .map((d, i) => ({ d, i, key: expectedDeparture(d) }))
    // Ties keep their original relative order, so equal times don't shuffle
    // between refreshes.
    .sort((a, b) => a.key - b.key || a.i - b.i);

  return expectedOrder.map((entry, rank) => ({
    departure: entry.d,
    movedFromSchedule: scheduledRank.get(identity(entry.d, entry.i)) !== rank,
  }));
}
