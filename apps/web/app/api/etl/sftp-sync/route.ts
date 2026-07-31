import { NextResponse } from "next/server";
import { startSftpSyncJob } from "@/lib/etl-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Triggers an on-demand SFTP pull-and-import inside the etl-cron container
 * (monthly full + daily updates, whatever's new since the last run — see
 * lib/etl-sftp-sync.ts) instead of waiting for the nightly cron.
 */
export async function POST() {
  const jobId = startSftpSyncJob();
  return NextResponse.json({ jobId });
}
