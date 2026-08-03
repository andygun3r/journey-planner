"use client";

import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

/**
 * Client-side Better Auth instance — used from the /login page and anywhere
 * else that needs to sign in, sign out, or read the current session in a
 * client component. Points at this app's own origin, same as every other
 * same-origin fetch in apps/web.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient(), passkeyClient()],
});
