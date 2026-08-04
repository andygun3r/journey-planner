import { loadFares } from "./load-fares.js";
import { railCorridors } from "./rail-corridors.js";
import { guarded } from "./run-guard.js";
import { importOrmSignals } from "./orm-signals.js";
import { snapStations } from "./snap-stations.js";
import { trackModel } from "./track-model.js";
import { syncTrackModelFromSftp } from "./track-model-sftp.js";
import { fares, packageCommand, postprocessOnly, timetable } from "./commands.js";
import { startServer } from "./server.js";

// HTTP_PORT set (etl-cron / etl app in standing-service mode) starts the
// internal HTTP server instead of dispatching a one-off CLI command — see
// server.ts for what web/etl-cron call now that they're separate Coolify
// apps with no shared Docker socket. The one-off `docker run --rm etl
// <command>` CLI path (below) is unaffected either way.
const httpPort = process.env.HTTP_PORT ? Number(process.env.HTTP_PORT) : undefined;
if (httpPort) {
  startServer(httpPort);
} else {
  const command = process.argv[2];
  switch (command) {
    // Everything that touches the MariaDB scratch or truncates a Postgres table
    // runs under a lock — see run-guard.ts for why.
    case "timetable":
      await guarded("etl-timetable", "timetable", () => timetable(process.argv[3]));
      break;
    case "package":
      await guarded("etl-timetable", "timetable", () => packageCommand(process.argv[3]));
      break;
    case "postprocess":
      await guarded("etl-timetable", "timetable", () => postprocessOnly(process.argv[3]));
      break;
    case "fares":
      await guarded("etl-fares", "fares", () => fares(process.argv[3]));
      break;
    case "snap-stations":
      // Recompute station.track_lat/lon from the orm-db PostGIS import.
      // Run after each `orm-import`; independent of the timetable pipeline.
      await snapStations();
      break;
    case "orm-signals":
      // Recompute physical signal positions from the orm-db OpenRailwayMap import.
      // Run after each `orm-import`; independent of live TD/SOP aspect decoding.
      await importOrmSignals();
      break;
    case "rail-corridors":
      // Recompute track-following geometry between adjacent calling points.
      // Depends on snap-stations having run (it uses track_lat/lon as the
      // corridor endpoints) and on Darwin schedules being loaded, since the
      // pair list comes from real calling patterns.
      await railCorridors();
      break;
    case "track-model":
      // Recompute station ELR/mileage positions and the national track network
      // from data/NWR_TrackModel (override via TRACK_MODEL_DIR). A manual,
      // occasional re-run — like snap-stations/rail-corridors, not a scheduled
      // feed. Depends on snap-stations having run for the best station
      // coordinates, though falls back to station.lat/lon if not.
      await trackModel();
      break;
    case "track-model-sftp":
      // Pull NWR_TrackModel* files from SFTP, import them, then delete the remote
      // files after a successful load.
      await syncTrackModelFromSftp();
      break;
    case "load-fares":
      // Re-load fares from the MariaDB scratch DB into Postgres (skips download/import).
      await guarded("etl-fares", "fares", () => loadFares());
      break;
    case "server":
      // Explicit alternative to HTTP_PORT for local/manual runs.
      startServer(Number(process.argv[3] ?? 4000));
      break;
    default:
      console.error(
        "Usage: etl <timetable|package|fares|load-fares|postprocess|snap-stations|orm-signals|rail-corridors|track-model|track-model-sftp|server>",
      );
      process.exit(1);
  }
}
