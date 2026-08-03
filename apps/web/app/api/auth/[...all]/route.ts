import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

// Better Auth's own router handles sign-in, sign-up, sessions, magic link,
// passkey and API key endpoints under here — see lib/auth.ts for what's
// configured.
export const { GET, POST } = toNextJsHandler(auth);
