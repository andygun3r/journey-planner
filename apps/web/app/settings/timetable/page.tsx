import { TimetableUploadForm } from "@/components/timetable-upload-form";
import { TimetableSftpSyncForm } from "@/components/timetable-sftp-sync-form";

export const dynamic = "force-dynamic";

export default function TimetableSettingsPage() {
  return (
    <main>
      <div className="results-head">
        <h1>Timetable upload</h1>
      </div>
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
