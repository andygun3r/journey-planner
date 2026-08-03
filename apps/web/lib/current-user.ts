import { headers } from "next/headers";
import { auth } from "./auth";

/** The signed-in user's id, or null if nobody is signed in. */
export async function getUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user?.id ?? null;
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
