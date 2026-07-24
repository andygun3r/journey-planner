import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Load the repo-root .env (single source of truth for the whole monorepo).
// Next only auto-loads .env files under apps/web, so we apply the root one
// here. Values already set in the real environment (e.g. docker compose
// injects DATABASE_URL) win and are not overwritten.
function loadRootEnv(): void {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const envPath = resolve(here, "../../.env");
    const contents = readFileSync(envPath, "utf8");
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No root .env (e.g. in a container where env is injected directly) — fine.
  }
}

loadRootEnv();

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@mainline/shared", "@mainline/db", "@mainline/routing-adapter"],
};

export default nextConfig;
