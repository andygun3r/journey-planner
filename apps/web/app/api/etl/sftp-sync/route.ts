import { NextResponse } from "next/server";
import { startSftpSyncJob } from "@/lib/etl-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Triggers an on-demand SFTP pull-and-import inside the etl-cron container
 * (monthly full + daily updates, whatever's new since the last run — see
 * lib/etl-sftp-sync.ts) instead of waiting for the nightly cron.
 */
export async function POST(req: Request) {
  const token = process.env.ETL_UPLOAD_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "ETL_UPLOAD_TOKEN not configured" }, { status: 503 });
  }
  if (req.headers.get("x-etl-upload-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const jobId = startSftpSyncJob();
  return NextResponse.json({ jobId });
}
