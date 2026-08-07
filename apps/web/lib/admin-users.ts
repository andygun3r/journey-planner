import { user } from "@signaller/db";
import { asc, eq } from "drizzle-orm";
import { getDb } from "./db";

export interface AdminUserRecord {
  id: string;
  email: string;
  role: string;
  createdAt: Date;
}

/** Every registered user, for the admin user-management list. */
export async function listUsers(): Promise<AdminUserRecord[]> {
  return getDb()
    .select({ id: user.id, email: user.email, role: user.role, createdAt: user.createdAt })
    .from(user)
    .orderBy(asc(user.email));
}

export async function setUserRole(userId: string, role: "user" | "admin"): Promise<void> {
  await getDb().update(user).set({ role }).where(eq(user.id, userId));
}
