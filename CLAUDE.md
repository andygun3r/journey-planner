# CLAUDE.md

Guidance for Claude Code when working in this repository.

During coding, you must use clear language, short sentences and stray away from overly technical language. 

## What this is

**Signaller** — a fast, self-reliant UK rail journey & commute planner. It runs its
own routing engine (MOTIS) over the national timetable, layers live status from
Darwin and Network Rail, and computes indicative fares. It exists because the owner
has RDG data access but **no National Rail journey-planner licence** — so it computes
everything itself rather than proxying nationalrail.co.uk.

Product intent, brand and design principles live in [PRODUCT.md](PRODUCT.md); read it
before touching UI. Short version: departure-board energy, tabular density, dark-first,
WCAG 2.2 AA, one-hand/five-second use. Status is never colour-only.

## Monorepo layout

pnpm + Turbo workspace, Node ≥ 22, TypeScript everywhere.

- `apps/web` — Next.js 16 app: pages, API routes, and the SSE live-update stream.
- `services/darwin-ingest` — RDM Darwin Push Port Kafka consumer → Postgres/Redis, plus commute-alert matching and nightly corridor precompute.
- `services/nr-ingest` — Network Rail STOMP consumer (TRUST movements + Train Describer + VSTP/TSR/RTPPM) → Postgres, publishes CRS deltas to Redis.
- `services/etl` — batch DTD timetable/fares download → GTFS conversion (dtd2mysql) → MOTIS + Postgres. Runs as a one-off CLI command, or as a standing service (`ETL_CRON=1`, exposes an HTTP API — see `src/server.ts`) for the nightly cron + on-demand calls from `web`.
- `services/motis-sidecar` — small HTTP-triggered wrapper around `docker run .../motis import` + `docker restart` for the MOTIS reimport-after-timetable-update step (MOTIS has no live-reload API). Deployed as a second container alongside `motis` in the same Coolify app, since it needs the host Docker socket to control its sibling container.
- `packages/shared` — domain types (zod) + CRS/TIPLOC/NLC/STANOX code utilities.
- `packages/db` — Drizzle schema, migrations, client.
- `packages/routing-adapter` — engine-agnostic `plan()`/`departures()`; MOTIS v2 (nigiri) implementation.

## Common commands

```sh
pnpm install
pnpm dev                       # turbo dev across the workspace
pnpm --filter web dev          # web only → http://localhost:3000
pnpm build | lint | typecheck  # via turbo
pnpm db:generate               # drizzle-kit generate (after schema.ts edits)
pnpm db:migrate                # apply migrations
pnpm etl:timetable             # run the timetable ETL

pnpm dev:up                    # postgres/redis (plain docker containers, host ports 5434/6380) + web + darwin-ingest + nr-ingest
pnpm dev:down                  # stop everything dev:up started
```

**Host ports are non-standard on purpose**: Postgres is `5434` and Redis is `6380`
(5432/5433 and 6379 are held by other local projects). `DATABASE_URL` for local work is
`postgres://mainline:mainline@localhost:5434/mainline`.

Health check: `curl localhost:3000/api/health` → `{ ok, postgres, redis }`.

## Conventions & gotchas

- **Config is env-only** (12-factor). Copy `.env.example` → `.env`; never commit secrets.
- Ingest services have **no dotenv loader** — start them with env injected, e.g.
  `node --env-file=../../.env --import tsx src/index.ts` from the service dir.
- **Drizzle migration ordering**: the generator sometimes emits `ADD PRIMARY KEY` before
  `ADD COLUMN`. Reorder the generated SQL before applying, or the migration fails.
- **TRUST/TD timestamps are UK-local wall-clock expressed as epoch-ms**, not true UTC —
  during BST they read one hour ahead. `nr-ingest` corrects them via `trustTsToUtcMs`;
  do the same for any new NR timestamp field.
- **LDBWS is the board's primary live source**; Darwin/NR are the deeper feeds. The board
  still works if the ingest services are down.
- **After a long darwin-ingest outage**, the committed Kafka offset ages out and it resumes
  from live. Schedule (SC) messages already sent earlier that day are *not* re-broadcast, so
  live progress/tracking stays sparse until each train sends a fresh TS/SC. Expected recovery,
  not a bug.
- MOTIS namespaces GTFS stop ids with a dataset tag (`gb-railgtfs_KGX`); the routing adapter
  adds/strips it so the rest of the app speaks bare CRS. Trip ids are composite
  (`<date>_<time>_<tag>_<gtfsTripId>`) — join on the bare GTFS trip id.

---

# Data feeds reference

Two providers, two very different access models. **RDG Rail Data Marketplace (RDM)** and
**National Rail Data Portal (NRDP)** cover timetable, fares, live boards and disruptions.
**Network Rail Open Data (NROD)** covers train positioning and signalling. Every feed is
configured purely through env vars — the tables below give the exact ones.

## A. RDG / National Rail feeds

### 1. Darwin — Real-Time Push Port (v18) *(via RDM, Kafka)*
The deep real-time feed: schedule (SC), train status/forecast (TS), formations, loading,
deactivations for every GB passenger service. Powers journey-wide live status, the SSE
delta layer, and commute alerting.

- **Transport**: Kafka on **Confluent Cloud**, `SASL_SSL` + `PLAIN`.
- **Auth**: subscription **consumer key = SASL username**, **secret = SASL password**.
- **Consumer**: `services/darwin-ingest` (kafkajs). Parser in `pushport.ts`; writes `darwin_*` tables.
- **Env**: `RDM_KAFKA_BOOTSTRAP_SERVERS`, `RDM_KAFKA_TOPIC`, `RDM_KAFKA_GROUP_ID` (optional), `RDM_CONSUMER_KEY`, `RDM_CONSUMER_SECRET`.

### 1a. NWR Train Describer (TD) *(via RailData, Kafka)*
Live TD stream for berth movements and S-Class signalling state. This is a separate
RailData product and uses separate consumer credentials from Darwin.

- **Transport**: Kafka on **Confluent Cloud**, `SASL_SSL` + `PLAIN`.
- **Topic**: `TD_ALL_SIG_AREA`.
- **Auth**: TD subscription **consumer key = SASL username**, **secret = SASL password**.
- **Consumer**: `services/nr-ingest` (kafkajs) when `NR_TD_KAFKA_*` is set. TRUST movements remain on Network Rail STOMP.
- **Env**: `NR_TD_KAFKA_BOOTSTRAP_SERVERS`, `NR_TD_KAFKA_TOPIC`, `NR_TD_KAFKA_GROUP_ID`, `NR_TD_KAFKA_USERNAME`, `NR_TD_KAFKA_PASSWORD`.

### 2. LDBWS — Live Departure Board *(RDM REST)*
**Primary** board source: one call per station gives real platforms, live estimates,
cancellations, operator and NRCC messages. Staff-style `GetDepBoardWithDetails`.

- **Auth**: consumer key in the **`x-apikey`** header.
- **Client**: `apps/web/lib/ldbws.ts` → `GET {base}/GetDepBoardWithDetails/{CRS}` (`filterCrs`/`filterType` for "calling at").
- **Env**: `LDBWS_API_KEY`, `LDBWS_BASE_URL` (`…/1010-live-departure-board-dep1_2/LDBWS/api/20220120`).

### 3. Service Details *(RDM REST — separate product/key)*
Per-train calling pattern for a single service id. Distinct RDM product from LDBWS, so it
has its own key even though the base URL shape matches.

- **Auth**: consumer key in `x-apikey`.
- **Env**: `LDBWS_SERVICE_API_KEY`, `LDBWS_SERVICE_BASE_URL` (`…/1010-service-details1_2/LDBWS/api/20220120`).

### 4. National Rail Disruptions *(RDM REST)*
Two views: station incidents (`/stations/disruptions/incidents?crsCode=…`) and per-TOC
service indicators (`/tocs/serviceIndicators`).

- **Auth**: consumer key in `x-apikey`.
- **Client**: `apps/web/lib/disruptions.ts`.
- **Env**: `DISRUPTIONS_API_KEY`, `DISRUPTIONS_BASE_URL` (`…/1010-disruptions-experience-api-11_1`).

### 5. Knowledgebase *(RDM REST)*
Station facilities/accessibility (static, ~daily) plus an incidents feed (mostly
planned engineering work with date ranges). Exact endpoint paths/response shape are
unconfirmed until RDM registration — see `services/etl/src/kb-client.ts`.

- **Facilities**: nightly ETL job (`etl kb-facilities`, part of the nightly cron)
  syncs into `station_facility`, surfaced on `/boards/[crs]` via
  `apps/web/lib/stations.ts`'s `stationFacilities()`.
- **Incidents**: `services/etl`'s standing service polls every 5 minutes
  (`kb-incidents`, only runs when `ETL_CRON=1`) into `kb_incident`, surfaced as
  "Planned engineering works" on `/status` via `apps/web/lib/kb-incidents.ts`. Kept
  separate from the Disruptions API (§4) — not merged/deduped — since Disruptions
  stays the primary live-status source and this is a forward-looking layer.
- **Auth**: consumer key in `x-apikey` (same as other RDM REST feeds; adjust
  `kb-client.ts` if the real product differs).
- **Env**: `KB_API_KEY`, `KB_BASE_URL`.

### 6. DTD static feeds — Timetable & Fares *(NRDP downloads)*
Batch bulk data driving the routing engine and fares, **not** RDM APIs. Downloaded from
`opendata.nationalrail.co.uk`: `POST /authenticate` → token → `GET` staticfeed with an
`X-Auth-Token` header. Versioned filenames arrive via `Content-Disposition` (e.g. `RJTTF512.ZIP`).

| Feed | NRDP path | Product code |
|------|-----------|--------------|
| Timetable | `/api/staticfeeds/3.0/timetable` | **RJTTF** |
| Fares | `/api/staticfeeds/2.0/fares` | **RJFAF** |
| Routeing | `/api/staticfeeds/2.0/routeing` | **RJRG** |

- **Pipeline**: `services/etl` → dtd2mysql (MariaDB scratch) → GTFS (`gb-rail.gtfs.zip`) → MOTIS import + Postgres load. MariaDB is scratch only; **canonical storage is Postgres**.
- **Env**: `NRDP_USERNAME`, `NRDP_PASSWORD` (register at opendata.nationalrail.co.uk); `NRDP_BASE_URL` optional. `ETL_MYSQL_URL` for the scratch DB.
- RDM file-feed URLs can be substituted later; the ETL accepts an explicit local zip path as its source argument.
- **SFTP delivery alternative**: RDG also offers push/pull SFTP delivery of the same
  RJTTF/RJFAF products, on a separate account from `NRDP_USERNAME`/`PASSWORD`. Set
  `DTD_SFTP_HOST` (+ `DTD_SFTP_USERNAME`/`PASSWORD`/`PORT`/`*_DIR` vars) to switch the ETL
  from the NRDP HTTPS download to pulling the newest `.zip` over SFTP — see
  `services/etl/src/sftp-download.ts`.
- **Track Model SFTP**: `pnpm --filter @signaller/etl exec tsx src/index.ts track-model-sftp`
  pulls `NWR_TrackModel*`, imports it into `track_model_line` /
  `station_track_model_position`, then deletes the remote files after a successful
  load. It uses `NR_SFTP_*` credentials, falling back to `DTD_SFTP_*`.
- **Nightly cron (2am)**: the `etl-cron` Coolify app (the etl image running in
  standing-service mode, `ETL_CRON=1`) runs `services/etl/cron/run-and-reload-motis.sh` via a
  baked-in busybox crontab. One run does four SFTP pulls in sequence, each deleting its
  remote files after a successful load:
  1. **Timetable** (`etl timetable`) — DTD RJTTF, through dtd2mysql → GTFS → pushes to the
     MOTIS sidecar and triggers reimport + restart.
  2. **Fares** (`etl fares`) — DTD RJFAF, loaded into Postgres.
  3. **NR reference files** — SMART (`nr_smart`) + TPS data, via a `POST /reference-sftp`
     call to the `nr-ingest` service (only runs if `NR_INGEST_URL` /
     `NR_INGEST_INTERNAL_KEY` are set; otherwise this step is skipped).
  4. **Track Model** (`etl track-model-sftp`) — see above.

  The same etl image also runs as a one-off `docker run --rm etl <command>` for manual
  invocations of any single step.

## B. Network Rail Open Data (NROD) feeds

Different account and auth model from RDG. **No API key** — use your
`datafeeds.networkrail.co.uk` **account email as the STOMP login** and **account password
as the passcode**. You must also *tick each feed on the "My Feeds" page*, or the broker
authenticates but returns "not authorized to read from topic".

- **Broker**: `publicdatafeeds.networkrail.co.uk:61618` (STOMP). Overridable via `NR_STOMP_HOST` / `NR_STOMP_PORT`.
- **Consumer**: `services/nr-ingest` (`stompit`). Durable subscriptions keyed by a stable client id (`NR_CLIENT_ID`), so a reconnect resumes rather than restarts.
- **Env**: `NETWORKRAIL_USERNAME`, `NETWORKRAIL_PASSWORD`.
- **Connection design**: TRUST positioning stays on STOMP. TD uses RailData Kafka when `NR_TD_KAFKA_*` is configured, otherwise it falls back to the STOMP TD topic. VSTP/TSR/RTPPM run on a **second** STOMP connection — an unsubscribed feed errors the *whole* connection, and that must never take down positioning.

### Live STOMP topics (`services/nr-ingest/src/stomp.ts` → `TOPICS`)

| Topic | Purpose | Parsed messages |
|-------|---------|-----------------|
| `/topic/TRAIN_MVT_ALL_TOC` | **TRUST** train movements | `0001` activation, `0002` cancellation, `0003` arrival/departure (STANOX, platform, lateness) |
| `/topic/TD_ALL_SIG_AREA` | **Train Describer** | C-class `CA_MSG`/`CC_MSG` berth steps (position) **and** S-class `SF_MSG`/`SG_MSG`/`SH_MSG` signalling state |
| `/topic/VSTP_ALL` | Very Short Term Planning schedules | short-notice schedule inserts |
| `/topic/TSR_ALL_ROUTE` | Temporary Speed Restrictions | active TSRs by route |
| `/topic/RTPPM_ALL` | Real-Time Public Performance Measure | network/operator punctuality |

### NROD supporting reference files (`services/nr-ingest/src/reference.ts`)
Gzipped JSON behind the same account auth (HTTP Basic), `/ntrod/SupportingFileAuthenticate?type=…`.
Load once before the live feed means anything: `nr-ingest reference`.

- **CORPUS** — STANOX ↔ TIPLOC ↔ CRS ↔ NLC map. Movements report STANOX; this translates to CRS/TIPLOC to line up with Darwin. → `nr_corpus`.
- **SMART** — TD berth steps → STANOX + event, so "berth A→B" becomes "train passed <location>". Also provides berth topology (`from_berth→to_berth`) for signalling-diagram auto-layout. → `nr_smart`.
- **SOP / ECS** — per-TD-area bit→signal/aspect maps for decoding S-class. Load via `nr-ingest sop` from `data/sop/`. **Not** a live feed; sourced manually per area (Open Rail Data Wiki blocks automated fetch). Coverage is partial; unmapped areas degrade to track-occupancy only.
- **SFTP reference drops** — `nr-ingest reference-sftp` pulls `SMARTExtract.csv.gz` /
  `SMARTExtract.json.gz` and `TPS_Data.tar.gz` from RDG SFTP, processes them, then
  deletes the remote files after successful processing. `SMARTExtract.*` refreshes
  `nr_smart`; `TPS_Data.tar.gz` is staged under `NR_TPS_DIR` for the Train Planning
  Model importer work.

### Signalling data note
**Real signal aspects come only from TD S-class `SF_MSG` decoded against per-area SOP maps.**
The live TD feed already receives SF_MSG; see `parse.ts` `parseSClass`. SMART and
CORPUS locate berth movements, while SOP/ECS maps decode raw S-class bits into
named signals/aspects.

## Feed → capability map

| Capability | Feed(s) |
|------------|---------|
| Journey routing / planning | DTD Timetable (RJTTF) → GTFS → MOTIS |
| Fares | DTD Fares (RJFAF) |
| Live departure board | **LDBWS** (primary) |
| Per-train calling pattern | Service Details |
| Journey-wide live status, SSE deltas, commute alerts | **Darwin** Push Port |
| Between-station positioning / moving-train icon | Network Rail TRUST + TD (with CORPUS/SMART) |
| Disruptions & TOC service status | Disruptions API |
| Signalling diagram (aspects) | Network Rail TD S-class + SOP maps |
| Station facilities/accessibility, planned engineering works | Knowledgebase |

## Licensing

Timetable, fares and Darwin data © RDG / National Rail under the relevant Rail Data
Marketplace licences; Network Rail data under NROD terms. This is a personal project —
**check each feed's licence before any public deployment.**
