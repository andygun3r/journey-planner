import { TimetableUploadForm } from "@/components/timetable-upload-form";
import { timetableStatus } from "@/lib/timetable-status";
import { requireAdmin } from "@/lib/require-admin";

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

/**
 * Admin-only: this page can trigger a full timetable reload, so it's gated on
 * role "admin" the same way the ETL routes themselves are (see
 * lib/etl-auth.ts) rather than trusting the UI alone to hide the buttons.
 */
export default async function AdminTimetablePage() {
  await requireAdmin();

  const sftpAvailable = Boolean(process.env.DTD_SFTP_HOST);

  return (
    <main>
      <div className="results-head">
        <h1>Timetable</h1>
      </div>
      <CurrentState />

      <TimetableUploadForm sftpAvailable={sftpAvailable} />

      <details className="notice" style={{ marginTop: "1.5rem" }}>
        <summary>How this works</summary>
        <p>
          {sftpAvailable &&
            "\"Get latest timetable\" fetches only timetable files. \"Sync all SFTP data\" also handles fares, Network Rail SMART/TPS reference files, and Track Model drops. "}
          You can also upload a timetable file directly — either the original zip from the data
          provider, or a bundle produced by the <code>etl package</code> tool. Either way it&apos;s
          loaded in automatically, and journey planning uses it as soon as it&apos;s done.
        </p>
      </details>
    </main>
  );
}
