import { favouriteJourney } from "@mainline/db";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "./db";
import { stationName } from "./stations";

export interface FavouriteJourney {
  id: string;
  fromCrs: string;
  toCrs: string;
  fromName: string;
  toName: string;
  lastUsedAt: string;
}

/** A device's saved journeys, most-recently-used first, with station names. */
export async function listFavourites(deviceId: string): Promise<FavouriteJourney[]> {
  const rows = await getDb()
    .select()
    .from(favouriteJourney)
    .where(eq(favouriteJourney.deviceId, deviceId))
    .orderBy(desc(favouriteJourney.lastUsedAt));

  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      fromCrs: r.fromCrs,
      toCrs: r.toCrs,
      fromName: await stationName(r.fromCrs),
      toName: await stationName(r.toCrs),
      lastUsedAt: r.lastUsedAt.toISOString(),
    })),
  );
}

/** Whether a device has saved a given from→to pair. */
export async function isFavourite(
  deviceId: string,
  fromCrs: string,
  toCrs: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ id: favouriteJourney.id })
    .from(favouriteJourney)
    .where(
      and(
        eq(favouriteJourney.deviceId, deviceId),
        eq(favouriteJourney.fromCrs, fromCrs),
        eq(favouriteJourney.toCrs, toCrs),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Save a journey (idempotent per from→to); bumps lastUsedAt if it exists. */
export async function addFavourite(
  deviceId: string,
  fromCrs: string,
  toCrs: string,
): Promise<void> {
  const db = getDb();
  const existing = await db
    .select({ id: favouriteJourney.id })
    .from(favouriteJourney)
    .where(
      and(
        eq(favouriteJourney.deviceId, deviceId),
        eq(favouriteJourney.fromCrs, fromCrs),
        eq(favouriteJourney.toCrs, toCrs),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(favouriteJourney)
      .set({ lastUsedAt: new Date() })
      .where(eq(favouriteJourney.id, existing[0]!.id));
    return;
  }
  await db.insert(favouriteJourney).values({ deviceId, fromCrs, toCrs });
}

export async function removeFavourite(deviceId: string, fromCrs: string, toCrs: string): Promise<void> {
  await getDb()
    .delete(favouriteJourney)
    .where(
      and(
        eq(favouriteJourney.deviceId, deviceId),
        eq(favouriteJourney.fromCrs, fromCrs),
        eq(favouriteJourney.toCrs, toCrs),
      ),
    );
}

/** Bump lastUsedAt when a saved journey is re-run, so ordering reflects use. */
export async function touchFavourite(deviceId: string, fromCrs: string, toCrs: string): Promise<void> {
  await getDb()
    .update(favouriteJourney)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(favouriteJourney.deviceId, deviceId),
        eq(favouriteJourney.fromCrs, fromCrs),
        eq(favouriteJourney.toCrs, toCrs),
      ),
    );
}
