import { TimetableUploadForm } from "@/components/timetable-upload-form";

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
    </main>
  );
}
