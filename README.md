# Mainline

UK rail journey & commute planner — live Darwin/Network Rail data, self-hosted routing (MOTIS), indicative fares, a live GB train map, and TfL integration for the first/last mile. Built on Next.js 16, Postgres, Redis, and RDG Rail Data Marketplace feeds.

## Features

- **Journey planning & fares** — self-hosted MOTIS routing over the full GB rail
  timetable, with indicative fares computed from DTD fares data (no National
  Rail journey-planner licence required — see "What this is" in CLAUDE.md).
- **Live departure and arrival boards** (`/boards/[crs]`) — LDBWS-backed, real
  platforms and live estimates; one board build is shared across everyone
  watching a station rather than one per viewer.
- **Per-service detail** (`/services/[id]`) — full calling pattern, coach/loading
  formation, live position, and history for a single train, pushed over a
  live stream rather than polled.
- **Live GB train map** (`/map`) — live Network Rail train positions plus TfL
  stops/buses, rendered over a self-hosted OpenRailwayMap-vector tile stack
  (see `vendor/openrailwaymap-vector`, a git submodule). Positions are
  computed once and pushed to every viewer over SSE, not re-queried per tab.
- **TfL integration** — tube/bus/DLR/Overground/Elizabeth line/tram data
  (`apps/web/lib/tfl*.ts`) stitched onto rail journeys for interchange status
  and last-mile bus arrivals.
- **Commute planner & alerts** (`/commute`) — weekly commute schedule, holiday
  overrides, and push-notification alerts (web push) when Darwin/NR detect
  disruption on a matched corridor.
- **Signalling diagrams** — real signal aspects decoded from Network Rail TD
  S-class messages against per-area SOP maps (see CLAUDE.md's signalling note).
  The static berth layout is sent once; aspects and train positions stream
  live after that.
- **Disruptions & favourites** — station incident/TOC status feed, saved
  favourite journeys/stations.
- **Status page** (`/status`) — feed/system health beyond the bare `/api/health` JSON.

The board, map, signalling diagram and per-service position all push updates
over Server-Sent Events rather than polling: one shared computation per
station/corridor/train regardless of how many people are watching, falling
back to polling automatically if Redis isn't configured or a proxy buffers
the stream.

## Layout

- `apps/web` — Next.js 16 app: boards, service detail, live map, commute
  planner, settings, API routes, SSE stream
- `services/darwin-ingest` — RDM Darwin Kafka consumer → Postgres/Redis;
  commute-alert matching and nightly corridor precompute
- `services/nr-ingest` — Network Rail STOMP consumer (TRUST movements + Train
  Describer + VSTP/TSR/RTPPM) → Postgres; live positioning and signalling data
- `services/etl` — DTD timetable/fares download → GTFS conversion (dtd2mysql) → MOTIS + Postgres
- `packages/shared` — domain types (zod) + CRS/TIPLOC/NLC/STANOX and NaPTAN code utilities, UK time helpers
- `packages/db` — Drizzle schema, migrations, client
- `packages/routing-adapter` — engine-agnostic `plan()`/`departures()`; MOTIS v2 (nigiri) implementation
- `vendor/openrailwaymap-vector` — git submodule, the vector tile stack behind `/map` (see [OpenRailwayMap-vector](https://github.com/hiddewie/OpenRailwayMap-vector))

## Getting started

```sh
git clone --recurse-submodules <repo-url>   # or: git submodule update --init
pnpm install
cp .env.example .env          # fill in RDM credentials as feeds come online
docker compose up -d postgres redis   # host ports 5434 (pg) / 6380 (redis)
DATABASE_URL=postgres://mainline:mainline@localhost:5434/mainline pnpm db:migrate
pnpm --filter web dev         # http://localhost:3000
```

The live map (`/map`) additionally needs the OpenRailwayMap-vector tile stack
running — see the `orm-db`/`orm-import`/`orm-martin`/`orm-api`/`orm-proxy`
services in `docker-compose.yml` for one-time setup (GB OSM import required).
Everything else works without it.

Full stack (web built into a container):

```sh
docker compose up --build
```

Health check: `curl localhost:3000/api/health` → `{ ok, postgres, redis }`.

Operational metrics: `curl localhost:3000/api/metrics` → plain JSON (no
dashboard, just something to read with curl) covering Postgres connection
pool state, feed freshness, live-stream fan-out (computations vs. subscriber
count — the number that proves the SSE sharing above is actually working),
and board cache hit rate.

## Deploying (Coolify)

`docker-compose.yml` is server-safe as-is: `postgres`/`redis` publish no host
ports (only `docker-compose.override.yml`, local-dev-only and not read by
Coolify, does that), and `web`/`motis`/`darwin-ingest`/`nr-ingest` all carry
healthchecks + `restart: unless-stopped`.

0. **Submodule**: `vendor/openrailwaymap-vector` is a git submodule (needed
   only for `/map`'s tile stack — `orm-db`/`orm-import`/`orm-martin`/`orm-api`/`orm-proxy`).
   Confirm Coolify's source settings actually do a **recursive** clone
   (check its Git source / "Submodules" option); a shallow, non-recursive
   clone leaves the directory empty and those five services' builds will
   fail with "path not found." If you don't need `/map`, you can remove
   those services from the compose file instead of fighting the clone config.
1. **New Resource → Docker Compose**, point it at this repo, compose file
   `docker-compose.yml`.
2. Set env vars in Coolify's UI (these become the values `${VAR:-}` in the
   compose file resolve to) before the first build — see `.env.example` for
   the full list:
   `RDM_KAFKA_*`, `NRDP_USERNAME`/`PASSWORD` (or `DTD_SFTP_*` — see below),
   `LDBWS_*` from the RDM Live Arrival and Departure Boards product,
   `DISRUPTIONS_API_KEY`, `NETWORKRAIL_USERNAME`/`PASSWORD`,
   `NR_TD_KAFKA_*` for the RailData TD product, `TFL_APP_KEY`, `VAPID_*`,
   and (for `/map`) `NEXT_PUBLIC_TILES_URL`/`ORM_PUBLIC_HOST`.
   `NEXT_PUBLIC_TILES_URL` is baked into the Next.js client bundle at image
   build time, so changing it later requires a rebuild/redeploy, not only a
   container restart.
3. Expose only `web`'s port 3000 (and, if using `/map`, `orm-proxy`'s port
   8000) through Coolify's proxy/domain. `motis` (8080) only needs to be
   reachable from `web`/`darwin-ingest` on the compose network — don't route
   a public domain to it.
   If `/map` is enabled, set `NEXT_PUBLIC_TILES_URL` to the public URL Coolify
   routes to `orm-proxy:8000`, and set `ORM_PUBLIC_HOST` to the same host
   without the protocol.
   On first deploy, `motis`, `darwin-ingest`, and `nr-ingest` intentionally
   stay alive in a waiting/disabled state when their prerequisites are missing
   (no imported routing data yet, or no feed credentials yet). That prevents
   Coolify from burning through its restart limit before the app has been
   bootstrapped.
4. **Bootstrap order matters** — MOTIS has nothing to serve and darwin-ingest's
   corridor precompute has nothing to resolve against until routing data
   exists. Note that Coolify showing the stack as "healthy" doesn't mean
   routing works — `web`'s healthcheck only checks Postgres/Redis, and
   `motis` intentionally has no `depends_on` gate from `web` (it needs this
   manual bootstrap first), so a green dashboard can still mean an
   unimported, empty MOTIS:
   - Run `pnpm db:migrate` against the deployed `DATABASE_URL` (or run it as
     a Coolify pre-deployment/one-off command). The `web` container can also
     run migrations before Next.js starts when `RUN_DB_MIGRATIONS=1`, but leave
     that unset if you do not want a failed migration to restart-loop the app.
   - Run the ETL once to populate the `gtfs-data` volume:
     `docker compose --profile etl run --rm etl timetable`
     — or, on a low-memory server, use the local-import-then-upload flow
     below instead of running this on the server.
   - Then run `motis import` (`docker exec <motis-container> /motis import -d /data/data -c /data/config.yml`)
     and restart `motis` so it serves the fresh GTFS — a restart alone does
     NOT reimport, `motis server` only ever serves whatever's already
     preprocessed under `/data/data`.
   - For NR positioning, load reference data once:
     `docker compose run --rm nr-ingest pnpm tsx src/index.ts reference`
     or, if RDG SFTP is delivering `SMARTExtract.csv.gz` /
     `SMARTExtract.json.gz`, use:
     `docker compose run --rm nr-ingest node dist/index.js reference-sftp`
     and the headcode map (re-run roughly daily):
     `docker compose run --rm nr-ingest pnpm tsx src/index.ts headcodes`
5. The board (LDBWS) and journey planning work without Darwin/NR live feeds —
   deploy incrementally and add `RDM_*`, `NETWORKRAIL_*` and `NR_TD_KAFKA_*`
   credentials as each feed subscription comes online. `NR_TD_KAFKA_*` uses the
   separate RailData **NWR Train Describer (TD)** Kafka consumer key/secret, not
   the Darwin Kafka credentials.
6. **Keeping the timetable current**: `etl-cron` runs in the default (non-profile)
   service set and runs the SFTP rail-data sweep nightly at 2am using the
   crontab in `services/etl/cron/timetable-daily`: timetable import + MOTIS
   reload, fares import, SMART/TPS reference sync, then Track Model sync. Set
   `DTD_SFTP_HOST` (+
   `DTD_SFTP_USERNAME`/`PASSWORD`/`PORT`/`*_DIR`) to pull via RDG's SFTP
   delivery instead of the NRDP HTTPS API — see `.env.example`. After each
   nightly run, `run-and-reload-motis.sh` runs `motis import` then restarts
   `motis` (or add an equivalent Coolify post-hook) so it serves the
   refreshed GTFS zip; it doesn't watch the volume for changes, and a bare
   restart without the import step is a no-op against stale preprocessed data.
   You can run the same sweep on demand from `/settings/timetable` with
   **Sync all SFTP data**. Network Rail reference/geometry SFTP drops are also
   available as individual commands:
   `pnpm --filter @mainline/nr-ingest start reference-sftp` processes
   `SMARTExtract.*.gz` and `TPS_Data.tar.gz`;
   `pnpm --filter @mainline/etl exec tsx src/index.ts track-model-sftp`
   processes the newest `NWR_TrackModel*` snapshot. Both delete remote files
   only after successful processing unless `NR_SFTP_DELETE_PROCESSED=false`.
7. **Container-name env vars**: `MOTIS_CONTAINER_NAME` and
   `ETL_CRON_CONTAINER_NAME` and `NR_REFERENCE_SYNC_CONTAINER_NAME` (all in
   `.env.example`) default to plain Docker
   Compose's `<project>-<service>-1` naming, which Coolify's compose deploys
   often don't match (Coolify prefixes/suffixes project names). If the
   restart-after-timetable-apply step, the on-demand SFTP sync endpoint, or
   SMART/TPS reference sync fails, check the actual container names in
   Coolify's UI (or `docker ps`) and override these env vars to match.
8. **`web` and `etl-cron` mount `/var/run/docker.sock`** (to restart `motis`
   after a timetable reload — MOTIS has no live-reload API). This is full
   host Docker socket passthrough: anyone who can exec into either container
   can control every container on the host. Acceptable for a personal
   single-tenant deploy; be aware of it before exposing shell/exec access to
   anyone else, or before running other sensitive workloads on the same host.

### Low-memory server: import locally, upload the bundle

`dtd2mysql` (the CIF → GTFS conversion step) is the memory-heavy part of the
timetable pipeline, run against a MariaDB scratch DB. On a small server this
can struggle or OOM. RDG doesn't offer a lighter-weight API for this data —
the full timetable (RJTTF) only comes as a CIF zip via NRDP HTTPS or SFTP,
so something has to run the same conversion; the fix is choosing *where*.

Run the full monthly import on your own machine instead of the server:

```sh
docker compose --profile etl run --rm etl package
```

This runs the same pipeline (download → `dtd2mysql` import → GTFS export →
postprocess) but instead of loading into Postgres, packages the result into
`bundle-<feedVersion>.tar.gz` (GTFS zip + derived station/trip-mapping CSVs +
manifest — see `services/etl/src/package-bundle.ts`). No MariaDB or
`dtd2mysql` ever runs on the server for this path.

Then upload it from the server's `/settings/timetable` page. The server
loads the bundle straight into Postgres, then runs `motis import` and
restarts `motis` to serve the new data — skipping the heavy conversion step
entirely.

`etl-cron` on the server keeps handling **daily** delta updates via
`DTD_SFTP_*` as in step 6 above — those files are much smaller than a full
monthly extract, so leave that running server-side unless it also proves to
be too heavy, in which case repeat the same `package` + upload flow for
daily deltas.

## Data & licensing

Timetable, fares and Darwin data © RDG / National Rail, used under the relevant
Rail Data Marketplace licences. This is a personal project; check feed licence
terms before any public deployment.
