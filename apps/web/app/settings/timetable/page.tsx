import { TimetableUploadForm } from "@/components/timetable-upload-form";
import { TimetableSftpSyncForm } from "@/components/timetable-sftp-sync-form";
import { timetableStatus } from "@/lib/timetable-status";

export const dynamic = "force-dynamic";

const when = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/London",
});

/**
 * Current state, shown before the forms.
 *
 * This page used to be write-only — two forms and no indication of what was
 * already loaded. Nothing anywhere read etl_run, so a nightly import that
 * stopped left MOTIS serving an ageing timetable with no sign of it. This is the
 * page you'd come to when you suspected that, so it should answer the question.
 *
 * Wording carries the state, not just colour — a red border alone would fail the
 * contrast and colour-blindness rules in PRODUCT.md.
 */
async function CurrentState() {
  const status = await timetableStatus();
  if (!status) return null;

  const headline = status.lastSuccessAt
    ? `Last loaded ${when.format(new Date(status.lastSuccessAt))}` +
      (status.lastSuccessVersion ? ` — ${status.lastSuccessVersion}` : "")
    : "No timetable has been loaded yet";

  const age =
    status.hoursSinceSuccess === null
      ? null
      : status.hoursSinceSuccess < 48
        ? `${Math.round(status.hoursSinceSuccess)} hours ago`
        : `${Math.round(status.hoursSinceSuccess / 24)} days ago`;

  return (
    <div className={status.ok ? "notice" : "notice notice-danger"}>
      <h2>{status.ok ? "Timetable up to date" : "Timetable needs attention"}</h2>
      <p>
        {headline}
        {age ? ` (${age}).` : "."}
      </p>
      {status.stale && status.lastSuccessAt ? (
        <p>
          That is older than expected. RDG sends a daily update, so a healthy deployment loads one
          every night — check the nightly job is still running.
        </p>
      ) : null}
      {status.lastAttemptFailed ? (
        <p>
          The most recent attempt failed
          {status.lastFailureAt ? ` at ${when.format(new Date(status.lastFailureAt))}` : ""}
          {status.lastFailureDetail ? `: ${status.lastFailureDetail}` : "."}
        </p>
      ) : null}
    </div>
  );
}

export default function TimetableSettingsPage() {
  return (
    <main>
      <div className="results-head">
        <h1>Timetable upload</h1>
      </div>
      <CurrentState />
      <div className="notice">
        <p>
          Run <code>docker compose --profile etl run --rm etl package</code> locally to produce a bundle
          (this runs dtd2mysql on your own machine, not the server), then upload it here. The server
          loads the station and trip mapping data into Postgres, drops the GTFS zip into the shared
          volume, and restarts MOTIS to reimport — no heavy conversion runs on the server.
        </p>
      </div>
      <TimetableUploadForm />

      <div className="results-head">
        <h1>SFTP sync</h1>
      </div>
      <div className="notice">
        <p>
          Pulls every timetable file from the RDG SFTP folder not yet imported — RDG drops a full
          timetable monthly plus daily updates in the same folder, and this applies whatever's new,
          oldest first, same as the nightly 2am cron. Runs dtd2mysql inside the etl-cron container, so
          it needs <code>DTD_SFTP_HOST</code> configured there.
        </p>
      </div>
      <TimetableSftpSyncForm />
    </main>
  );
}
