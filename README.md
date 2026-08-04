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
  (see "Map stack" under Deploying — a separate repo/Coolify project, not part
  of this one). Positions are computed once and pushed to every viewer over
  SSE, not re-queried per tab.
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

The vector tile stack behind `/map` ([OpenRailwayMap-vector](https://github.com/hiddewie/OpenRailwayMap-vector))
is **not** part of this repo — it deploys as its own, separate Coolify
project, wired to `web` purely over HTTP env vars (`NEXT_PUBLIC_TILES_URL`/
`ORM_PUBLIC_HOST`), the same pattern as `MOTIS_URL` or `ETL_URL`. See "Map
stack" under Deploying.

## Getting started

```sh
git clone <repo-url>
pnpm install
cp .env.example .env          # fill in RDM credentials as feeds come online
pnpm dev:up                   # starts postgres/redis (plain docker containers) + web + darwin-ingest + nr-ingest
DATABASE_URL=postgres://mainline:mainline@localhost:5434/mainline pnpm db:migrate
```

`pnpm dev:up` (see `scripts/dev-up.sh`) starts Postgres and Redis as plain
named Docker containers (`mainline-dev-postgres`/`-redis`, host ports 5434/6380)
and runs `web`/`darwin-ingest`/`nr-ingest` directly with `pnpm`/`tsx` — no
Docker Compose, matching how each service deploys in production now (see
"Deploying" below). `pnpm dev:down` stops everything. Web is at
http://localhost:3000.

MOTIS and the ETL aren't part of the normal dev loop — MOTIS needs GTFS
output to exist first, and the ETL is run-to-completion, not a daemon. Run
them directly when you need them: `pnpm --filter @mainline/etl timetable`,
then start a local `motis` container by hand pointed at the resulting
`data/gtfs` output (see the `motis` app's config in "Deploying" below for the
image/command shape — locally you can run the same image directly with
`docker run`).

The live map (`/map`) additionally needs the OpenRailwayMap-vector tile stack
running — that's a separate repo entirely (see "Map stack" under Deploying),
so clone it separately and follow its own `SETUP.md` for local dev. Everything
else in this repo works without it.

Health check: `curl localhost:3000/api/health` → `{ ok, postgres, redis }`.

Operational metrics: `curl localhost:3000/api/metrics` → plain JSON (no
dashboard, just something to read with curl) covering Postgres connection
pool state, feed freshness, live-stream fan-out (computations vs. subscriber
count — the number that proves the SSE sharing above is actually working),
and board cache hit rate.

## Deploying (Coolify)

Each service is its own Coolify app now, not one Docker Compose stack — the
old setup meant a single failing container could take Coolify's health
tracking for the *whole* stack down with it, and there was no way to
restart/redeploy one service in isolation. Services talk to each other over
plain HTTP using env vars you set explicitly in Coolify's UI (see
`.env.example`'s "Internal service-to-service calls" section) — no shared
Docker socket, no shared volumes, no container-name guessing.

**Apps to create** (Coolify → New Resource → Dockerfile, one per row):

| App | Dockerfile | Standing or one-off | Public? |
|---|---|---|---|
| `postgres` | Coolify's managed Postgres, or `postgres:17-alpine` directly | standing | no |
| `redis` | Coolify's managed Redis, or `redis:8-alpine` directly | standing | no |
| `web` | `apps/web/Dockerfile` | standing | **yes** |
| `darwin-ingest` | `services/darwin-ingest/Dockerfile` | standing | no |
| `nr-ingest` | `services/nr-ingest/Dockerfile` | standing | no |
| `etl-cron` | `services/etl/Dockerfile`, command `server` | standing | no |
| `mariadb` | `mariadb:11` | standing (etl-cron's scratch DB) | no |
| `motis` | `ghcr.io/motis-project/motis:latest` — see below | standing | no |
| `motis-sidecar` | `services/motis-sidecar/Dockerfile` — second container in the `motis` app | standing | no |

**In a separate Coolify project**, built from your own fork of
[OpenRailwayMap-vector](https://github.com/hiddewie/OpenRailwayMap-vector) —
not this repo (see "Map stack", step 9):

| App | Dockerfile (in the fork) | Standing or one-off | Public? |
|---|---|---|---|
| `orm-db` | `db/Dockerfile` | standing | no |
| `orm-import` | `import/Dockerfile` | one-off (GB OSM import) | no |
| `orm-martin` | `martin.Dockerfile` | standing | no |
| `orm-api` | `api.Dockerfile` | standing | no |
| `orm-proxy` | `proxy.Dockerfile` | standing | **yes** |

### Quickstart

1. Fork [hiddewie/OpenRailwayMap-vector](https://github.com/hiddewie/OpenRailwayMap-vector)
   on GitHub, then create a **separate Coolify project** pointed at your
   fork (see "Map stack", step 9, for what goes there).
2. Generate the internal secrets (step 1 below).
3. Create `postgres`, `redis` (step 2).
4. Create `web`, set its env (step 3), including `RUN_DB_MIGRATIONS=1` and
   `NEXT_PUBLIC_TILES_URL` (build arg — you can set this to your eventual
   `orm-proxy` domain now, or come back and rebuild once that's up). Deploy,
   confirm `/api/health` shows the schema present.
5. Sign up, promote yourself to admin (first-deploy order, step 3).
6. Create `darwin-ingest`, `nr-ingest` (step 4).
7. Create `motis` + `motis-sidecar` as one two-container app (steps 7–8).
8. Create `mariadb` + `etl-cron` (steps 5–6).
9. Build the map stack in your fork's Coolify project: `orm-db`,
   `orm-import` (one-off, GB OSM import), `orm-martin`, `orm-api`,
   `orm-proxy` (step 9). Once `orm-proxy` has a public domain, set
   `ORM_PUBLIC_HOST` on it and confirm/rebuild `NEXT_PUBLIC_TILES_URL` on
   `web` to match.
10. Trigger the first timetable import (first-deploy order, step 5).
11. Optionally load NR reference data (first-deploy order, step 6).

That's the full path — each numbered step above maps to the matching
numbered step in the detailed reference below (its own 1–10, not this list's
numbering).

### Full reference
1. **Generate the internal secrets once** (`openssl rand -base64 32` each):
   `ETL_INTERNAL_KEY`, `NR_INGEST_INTERNAL_KEY`, `MOTIS_REIMPORT_KEY`. Each
   value is set on **both** the calling app and the receiving app — see
   `.env.example` for exactly which app needs which side.
2. **`postgres`/`redis`**: no public port, no special config beyond the
   defaults in `.env.example`'s "Core infrastructure" section.
3. **`web`**: build arg `NEXT_PUBLIC_TILES_URL` (baked into the client bundle
   at build time — changing it later needs a rebuild, not just a restart).
   Runtime env: `DATABASE_URL`, `REDIS_URL`, `MOTIS_URL`, `ETL_URL` +
   `ETL_INTERNAL_KEY`, `NR_INGEST_URL` + `NR_INGEST_INTERNAL_KEY`,
   `MOTIS_REIMPORT_URL` + `MOTIS_REIMPORT_KEY`.

   **Sign-in and migrations — easy to miss, and the most common cause of "the
   app looks healthy but I can't log in":**
   - `BETTER_AUTH_SECRET` — generate with `openssl rand -base64 32`. Sessions
     don't sign correctly without it.
   - `BETTER_AUTH_URL` — must equal the real public domain Coolify routes to
     `web` (not `localhost`). Passkey sign-in derives its `rpID` from this;
     a mismatch breaks sign-in silently, with no obvious error.
   - `RESEND_API_KEY` — required if you want magic-link sign-in (passkey
     works without it, but you need at least one working sign-in method).
   - `RUN_DB_MIGRATIONS=1` — **set this for the first deploy.** Without it,
     `web` starts against an empty, unmigrated database (no `user`/`session`
     tables), and every sign-in attempt fails even though Coolify shows the
     app as healthy — `/api/health` only checks that Postgres is reachable,
     not that the schema exists. It's safe to set on a first deploy because
     there's nothing yet to fail a migration against. Unset it again after
     confirming the schema is up, or run `pnpm db:migrate` as a one-off
     Coolify command instead — either way, migrations must run before anyone
     can sign in. See the first-deploy order below.
4. **`darwin-ingest`/`nr-ingest`**: `DATABASE_URL`, `REDIS_URL`, `MOTIS_URL`
   (darwin-ingest only, for corridor precompute), plus each service's own
   feed credentials (`RDM_KAFKA_*`/`RDM_CONSUMER_*` for darwin-ingest;
   `NETWORKRAIL_*`/`NR_TD_KAFKA_*` for nr-ingest). Both self-disable (stay
   alive, doing nothing) rather than crash-loop when their credentials are
   unset — deploy them before feed subscriptions are ready, add credentials
   later. `nr-ingest` also needs `NR_INGEST_INTERNAL_KEY` set (receiving
   side) for the `/reference-sftp` endpoint `web` calls.
5. **`etl-cron`**: command `server` (not the default `timetable`). Env:
   `DATABASE_URL`, `ETL_MYSQL_URL` (pointed at `mariadb`), `ORM_DATABASE_URL`
   (pointed at `orm-db`, if using `/map` — note `orm-db` lives in the
   separate map-stack Coolify project, so this crosses projects; use
   whatever address/port that project exposes it on, not an internal-only
   hostname), `HTTP_PORT=4000`, `ETL_CRON=1`
   (starts the nightly crond sweep as a child process — see
   `services/etl/cron/timetable-daily`), `ETL_INTERNAL_KEY` (receiving side),
   `MOTIS_REIMPORT_URL` + `MOTIS_REIMPORT_KEY` (to push GTFS + trigger
   reimport after each pipeline run), `NR_INGEST_URL` +
   `NR_INGEST_INTERNAL_KEY` (to trigger nr-ingest's reference sync as part of
   the nightly sweep), plus `NRDP_USERNAME`/`PASSWORD` or `DTD_SFTP_*`.
6. **`mariadb`**: plain `mariadb:11` image, `MARIADB_ROOT_PASSWORD=etl`,
   `MARIADB_DATABASE=dtd` — etl-cron's scratch DB for the `dtd2mysql`
   conversion step. Give it real memory (4GB+); it's idle almost all day and
   busy for one nightly job, so a generous limit here costs nothing most of
   the time.
7. **`motis`**: image `ghcr.io/motis-project/motis:latest`, command:
   ```sh
   sh -c 'until [ -f /data/config.yml ]; do echo "waiting for imported routing data"; sleep 300; done; exec /motis server'
   ```
   (stays alive waiting rather than exiting — MOTIS exits immediately if
   `/data/config.yml` doesn't exist yet, which would otherwise look like a
   crash loop before the first import). Not public — only `web`,
   `darwin-ingest`, and `motis-sidecar` need to reach it.
8. **`motis-sidecar`**: a **second container in the same Coolify app as
   `motis`**, built from `services/motis-sidecar/Dockerfile`. Needs
   `MOTIS_REIMPORT_KEY` (receiving side) and the host's Docker socket mounted
   (`/var/run/docker.sock`) — it's the one piece of this deployment that
   still needs Docker control-plane access, because MOTIS has no live-reload
   API and its only reimport mechanism (`motis import` + restart) requires
   it. Being in the same app as `motis` means its `docker run
   --volumes-from motis` / `docker restart motis` calls always target the
   right sibling container — no cross-app container-name guessing.
   `MOTIS_CONTAINER_NAME` defaults to `motis`; override it if Coolify names
   the container differently on your host (check `docker ps`).
9. **Map stack** (only if using `/map`): [OpenRailwayMap-vector](https://github.com/hiddewie/OpenRailwayMap-vector)
   deploys as a **separate Coolify project**, built from your own fork of
   that repo (fork it, then point Coolify's Git source at your fork — this
   sidesteps the recursive-submodule-clone issues of vendoring it inside this
   repo, and there's no runtime coupling to this app besides HTTP). Create
   `orm-db`/`orm-import`/`orm-martin`/`orm-api`/`orm-proxy` there, following
   its own `SETUP.md` for the GB OSM import, adapted to standalone Coolify
   apps instead of its documented Compose setup. `orm-proxy` is the only one
   that needs a public domain — point `NEXT_PUBLIC_TILES_URL` (on `web`,
   build-time) and `ORM_PUBLIC_HOST` (on `orm-proxy`) at it.
10. **First-deploy order** — a green dashboard across every app doesn't mean
    routing works or anyone can sign in; `web`'s healthcheck only checks
    Postgres/Redis/schema, and `motis` intentionally waits rather than
    serving until it's been imported:
    1. Deploy `postgres`, `redis` first.
    2. Deploy `web` with `RUN_DB_MIGRATIONS=1` set. Confirm
       `curl <your-domain>/api/health` reports the schema as present — if
       not, check `web`'s logs for
       `[web] applying database migrations` vs `[web] skipping...`.
    3. Sign up via the UI, then promote yourself to admin via direct DB
       access (Coolify's container terminal on the `postgres` app, or
       `psql` if you've exposed a port):
       ```sql
       update "user" set role = 'admin' where email = 'you@example.com';
       ```
    4. Deploy `darwin-ingest`, `nr-ingest`, `motis` + `motis-sidecar`,
       `mariadb`, `etl-cron`.
    5. Trigger a timetable import — either `POST /timetable` on `etl-cron`
       (with the `x-internal-key` header) or, on a low-memory server, the
       local-import-then-upload flow below. This pushes the produced GTFS to
       `motis-sidecar` and triggers the reimport automatically — no separate
       manual `motis import` step.
    6. For NR positioning, load reference data once against `nr-ingest`
       (Coolify's one-off command, or from your machine against the deployed
       `DATABASE_URL`): `pnpm --filter @mainline/nr-ingest start reference`
       or, if RDG SFTP is delivering `SMARTExtract.*.gz`, `... reference-sftp`,
       and the headcode map (re-run roughly daily):
       `pnpm --filter @mainline/nr-ingest start headcodes`.
11. The board (LDBWS) and journey planning work without Darwin/NR live
    feeds — deploy incrementally and add `RDM_*`, `NETWORKRAIL_*` and
    `NR_TD_KAFKA_*` credentials as each feed subscription comes online.
    `NR_TD_KAFKA_*` uses the separate RailData **NWR Train Describer (TD)**
    Kafka consumer key/secret, not the Darwin Kafka credentials.
12. **Keeping the timetable current**: `etl-cron`'s crond sweep (started by
    `ETL_CRON=1`) fires nightly at 2am per `services/etl/cron/timetable-daily`:
    timetable import + MOTIS reload, fares import, SMART/TPS reference sync,
    then Track Model sync. Set `DTD_SFTP_HOST` (+
    `DTD_SFTP_USERNAME`/`PASSWORD`/`PORT`/`*_DIR`) to pull via RDG's SFTP
    delivery instead of the NRDP HTTPS API — see `.env.example`. You can run
    the same sweep on demand from `/settings/timetable` with **Sync all SFTP
    data**. Network Rail reference/geometry SFTP drops are also available as
    individual commands: `pnpm --filter @mainline/nr-ingest start reference-sftp`
    processes `SMARTExtract.*.gz` and `TPS_Data.tar.gz`;
    `pnpm --filter @mainline/etl exec tsx src/index.ts track-model-sftp`
    processes the newest `NWR_TrackModel*` snapshot. Both delete remote files
    only after successful processing unless `NR_SFTP_DELETE_PROCESSED=false`.
13. **`motis-sidecar` mounts `/var/run/docker.sock`** (to run `motis import`
    in a throwaway container and restart `motis` — MOTIS has no live-reload
    API). This is full host Docker socket passthrough: anyone who can exec
    into that container can control every container on the host. It's scoped
    to a single small purpose-built container now, rather than shared across
    `web` and `etl-cron` as before — smaller blast radius, but still worth
    being aware of before exposing shell/exec access to anyone else, or
    running other sensitive workloads on the same host.

### Low-memory server: import locally, upload the bundle

`dtd2mysql` (the CIF → GTFS conversion step) is the memory-heavy part of the
timetable pipeline, run against a MariaDB scratch DB. On a small server this
can struggle or OOM. RDG doesn't offer a lighter-weight API for this data —
the full timetable (RJTTF) only comes as a CIF zip via NRDP HTTPS or SFTP,
so something has to run the same conversion; the fix is choosing *where*.

Run the full monthly import on your own machine instead of the server:

```sh
pnpm --filter @mainline/etl exec tsx src/index.ts package
```

This runs the same pipeline (download → `dtd2mysql` import → GTFS export →
postprocess) but instead of loading into Postgres, packages the result into
`bundle-<feedVersion>.tar.gz` (GTFS zip + derived station/trip-mapping CSVs +
manifest — see `services/etl/src/package-bundle.ts`). No MariaDB or
`dtd2mysql` ever runs on the server for this path — you need a local MariaDB
scratch DB for this command (`ETL_MYSQL_URL` pointed at it), not the server's.

Then upload it from the server's `/settings/timetable` page. The web app
loads the bundle's station/trip-mapping data straight into Postgres, then
uploads the bundled GTFS zip to `motis-sidecar` and triggers a reimport —
skipping the heavy conversion step on the server entirely.

`etl-cron` on the server keeps handling **daily** delta updates via
`DTD_SFTP_*` as in step 12 above — those files are much smaller than a full
monthly extract, so leave that running server-side unless it also proves to
be too heavy, in which case repeat the same `package` + upload flow for
daily deltas.

## Data & licensing

Timetable, fares and Darwin data © RDG / National Rail, used under the relevant
Rail Data Marketplace licences. This is a personal project; check feed licence
terms before any public deployment.
