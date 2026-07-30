import { spawn } from "node:child_process";

/**
 * Wraps the dtd2mysql CLI (installed in the etl container image).
 * dtd2mysql reads DATABASE_* env vars for its MySQL/MariaDB scratch target.
 * VERIFY ON FIRST INTEGRATION: dtd2mysql is an older codebase — confirm it
 * runs on the container's Node version and that --gtfs-zip emits transfers.txt
 * and handles associations; postprocess-gtfs.ts fills any gaps.
 */

/**
 * Heap ceiling for dtd2mysql, in MB.
 *
 * dtd2mysql is a Node process, so it is bound by V8's old-space limit and not
 * just by how much RAM the box has — the default lands around 4GB, and once it
 * is hit the process dies with "JavaScript heap out of memory" even with memory
 * to spare. Converting the full GB timetable is the job that runs this server
 * out of memory, so give it room explicitly rather than relying on a default
 * that varies with the host.
 *
 * Raising this trades speed for completing at all: a bigger heap means more GC
 * pressure and more swapping, but a slow import beats a dead one. Set
 * ETL_DTD2MYSQL_HEAP_MB=0 to leave Node's default alone.
 */
const HEAP_MB = Number(process.env.ETL_DTD2MYSQL_HEAP_MB ?? 6144);

function mysqlEnv(): NodeJS.ProcessEnv {
  const url = new URL(process.env.ETL_MYSQL_URL ?? "mysql://root:etl@mariadb:3306/dtd");
  // Keep anything the operator already set; only add our own flag.
  const nodeOptions = [process.env.NODE_OPTIONS, HEAP_MB > 0 ? `--max-old-space-size=${HEAP_MB}` : ""]
    .filter(Boolean)
    .join(" ");
  return {
    ...process.env,
    ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
    DATABASE_HOSTNAME: url.hostname,
    DATABASE_PORT: url.port || "3306",
    DATABASE_USERNAME: decodeURIComponent(url.username),
    DATABASE_PASSWORD: decodeURIComponent(url.password),
    DATABASE_NAME: url.pathname.replace(/^\//, ""),
  };
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("dtd2mysql", args, { env: mysqlEnv(), stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`dtd2mysql ${args[0]} exited ${code}`)),
    );
  });
}

export async function importTimetable(zipPath: string): Promise<void> {
  await run(["--timetable", zipPath]);
}

export async function exportGtfs(outZip: string): Promise<void> {
  await run(["--gtfs-zip", outZip]);
}

export async function importFares(zipPath: string): Promise<void> {
  await run(["--fares", zipPath]);
  await run(["--fares-clean"]);
}
