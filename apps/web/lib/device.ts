import { device } from "@mainline/db";
import { cookies, headers } from "next/headers";
import { DEVICE_COOKIE, DEVICE_HEADER } from "../middleware";
import { getDb } from "./db";

/**
 * Reads the current device id from the cookie (set by middleware.ts), falling
 * back to the request header the middleware mirrors it onto for the first
 * render. Returns null if neither is present (should not happen behind the
 * middleware, but callers handle it defensively).
 */
export async function getDeviceId(): Promise<string | null> {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(DEVICE_COOKIE)?.value;
  if (fromCookie) return fromCookie;
  const headerStore = await headers();
  return headerStore.get(DEVICE_HEADER);
}

/**
 * Ensures a `device` row exists for the given id and bumps `lastSeenAt`.
 * Call this only on paths that persist device-scoped data (commutes, holidays,
 * push) so read-only pages stay a single cheap query.
 */
export async function ensureDevice(id: string): Promise<void> {
  await getDb()
    .insert(device)
    .values({ id })
    .onConflictDoUpdate({ target: device.id, set: { lastSeenAt: new Date() } });
}

/**
 * Reads the device id and guarantees the row exists. Throws if no id is present
 * (i.e. the request bypassed the middleware) — callers in mutation paths treat
 * that as a 400.
 */
export async function requireDevice(): Promise<string> {
  const id = await getDeviceId();
  if (!id) throw new Error("No device id — request did not pass through middleware");
  await ensureDevice(id);
  return id;
}
