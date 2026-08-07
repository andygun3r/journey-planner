import { headers } from "next/headers";
import { auth } from "./auth";

/** The signed-in user's id, or null if nobody is signed in. */
export async function getUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user?.id ?? null;
}

/**
 * The signed-in user's id and role, or null if nobody is signed in. Used by
 * the root layout to decide nav visibility (e.g. the admin link) without a
 * second session lookup per page.
 */
export async function getSessionUser(): Promise<{ id: string; role: string } | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  const user = session?.user as { id: string; role?: string } | undefined;
  if (!user) return null;
  return { id: user.id, role: user.role ?? "user" };
}

/**
 * Reads the signed-in user's id. Throws if nobody is signed in — callers on
 * mutation paths (server actions, route handlers) treat that as a 401.
 */
export async function requireUser(): Promise<string> {
  const id = await getUserId();
  if (!id) throw new Error("No signed-in user");
  return id;
}
