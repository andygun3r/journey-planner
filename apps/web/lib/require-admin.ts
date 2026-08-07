import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";

export interface SessionUser {
  id: string;
  email: string;
  role: string;
}

/** True if the given user (from a Better Auth session) has the admin role. */
export function isAdminUser(user: { role?: string } | null | undefined): boolean {
  return user?.role === "admin";
}

/**
 * Gate for admin-only server components (e.g. everything under /admin).
 * Redirects to /login if nobody's signed in, or to / if they're signed in
 * but not an admin — a plain redirect rather than an "access denied" page,
 * so a non-admin poking at the URL learns nothing beyond "not here".
 */
export async function requireAdmin(): Promise<SessionUser> {
  const session = await auth.api.getSession({ headers: await headers() });
  const user = session?.user as { id: string; email: string; role?: string } | undefined;
  if (!user) redirect("/login");
  if (!isAdminUser(user)) redirect("/");
  return { id: user.id, email: user.email, role: user.role ?? "user" };
}
