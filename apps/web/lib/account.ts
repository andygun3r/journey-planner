import { user } from "@signaller/db";
import { eq } from "drizzle-orm";
import { getDb } from "./db";

/**
 * Permanently deletes a user's account. Every table that references
 * user.id (session, account, passkey, apikey, commute, commute_holiday,
 * favourite_journey) has onDelete: "cascade", so this one delete is enough —
 * Postgres removes everything downstream.
 */
export async function deleteAccount(userId: string): Promise<void> {
  await getDb().delete(user).where(eq(user.id, userId));
}
