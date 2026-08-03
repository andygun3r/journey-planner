import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { apiKey } from "@better-auth/api-key";
import { Resend } from "resend";
import * as schema from "@mainline/db";
import { getDb } from "./db";

/**
 * The app's one Better Auth server instance. Sign-in is passkey (WebAuthn) or
 * a magic link emailed via Resend — no passwords, no OAuth providers, per the
 * product decision to keep this to exactly what's needed.
 *
 * Every signed-up user gets role "user". There is no sign-up UI for "admin" —
 * promote yourself by hand after your first sign-in:
 *
 *   update "user" set role = 'admin' where email = 'you@example.com';
 *
 * The apiKey plugin exists for one caller: the unattended etl-cron job hitting
 * the ETL routes with no human session (see lib/etl-auth.ts).
 */

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Same default the rest of the app uses for its own base URL — see
// BETTER_AUTH_URL in .env.example.
const appUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const appOrigin = new URL(appUrl).hostname;

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), { provider: "pg", schema }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: appUrl,
  emailAndPassword: { enabled: false },
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "user",
        // Never settable from the sign-up request body — only the manual SQL
        // promotion above (or a future admin action) can grant "admin".
        input: false,
      },
    },
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        if (!resend) {
          throw new Error("RESEND_API_KEY is not set — cannot send magic link emails");
        }
        await resend.emails.send({
          from: "Mainline <onboarding@resend.dev>",
          to: email,
          subject: "Sign in to Mainline",
          text: `Sign in to Mainline by opening this link:\n\n${url}\n\nIf you didn't request this, you can ignore this email.`,
        });
      },
    }),
    passkey({
      rpID: appOrigin,
      rpName: "Mainline",
      origin: appUrl,
    }),
    apiKey(),
  ],
});
