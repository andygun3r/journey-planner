/**
 * One-off: mints a Better Auth API key for the etl-cron nightly job, which
 * has no human session to authenticate with (see lib/etl-auth.ts).
 *
 * Run once, after you've signed up and promoted yourself to admin (see the
 * comment on the `user` table in packages/db/src/schema.ts). Needs an admin
 * user id to own the key — pass your own.
 *
 *   pnpm --filter web exec tsx scripts/create-etl-api-key.ts <admin-user-id>
 *
 * Find your user id with:
 *
 *   select id, email, role from "user" where role = 'admin';
 *
 * The script prints the key once — Better Auth stores only its hash, so if
 * you lose it you have to run this again and update ETL_API_KEY.
 */
import { auth } from "../lib/auth";

async function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error("usage: tsx scripts/create-etl-api-key.ts <admin-user-id>");
    process.exit(1);
  }

  const result = await auth.api.createApiKey({
    body: {
      userId,
      name: "etl-cron",
    },
  });

  console.log("ETL_API_KEY value (copy this into .env now — it will not be shown again):");
  console.log(result.key);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
