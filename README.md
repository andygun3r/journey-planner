# Mainline

UK rail journey & commute planner — live Darwin data, self-hosted routing (MOTIS), indicative fares. Built on Next.js 16, Postgres, Redis, and RDG Rail Data Marketplace feeds.

## Layout

- `apps/web` — Next.js 16 app (pages, API routes, SSE stream)
- `services/darwin-ingest` — RDM Darwin Kafka consumer → Postgres/Redis + GTFS-RT bridge for MOTIS
- `services/etl` — DTD timetable/fares download → GTFS conversion (dtd2mysql) → MOTIS + Postgres
- `packages/shared` — domain types (zod) + CRS/TIPLOC/NLC utilities
- `packages/db` — Drizzle schema, migrations, client
- `packages/routing-adapter` — engine-agnostic `plan()`/`departures()`; MOTIS implementation

## Getting started

```sh
pnpm install
cp .env.example .env          # fill in RDM credentials as feeds come online
docker compose up -d postgres redis   # host ports 5434 (pg) / 6380 (redis)
DATABASE_URL=postgres://mainline:mainline@localhost:5434/mainline pnpm db:migrate
pnpm --filter web dev         # http://localhost:3000
```

Full stack (web built into a container):

```sh
docker compose up --build
```

Health check: `curl localhost:3000/api/health` → `{ ok, postgres, redis }`.

## Deploying (Coolify)

`docker-compose.yml` is server-safe as-is: `postgres`/`redis` publish no host
ports (only `docker-compose.override.yml`, local-dev-only and not read by
Coolify, does that), and `web`/`motis`/`darwin-ingest`/`nr-ingest` all carry
healthchecks + `restart: unless-stopped`.

1. **New Resource → Docker Compose**, point it at this repo, compose file
   `docker-compose.yml`.
2. Set env vars in Coolify's UI (these become the values `${VAR:-}` in the
   compose file resolve to) — see `.env.example` for the full list:
   `RDM_KAFKA_*`, `NRDP_USERNAME`/`PASSWORD`, `LDBWS_*`, `DISRUPTIONS_API_KEY`,
   `NETWORKRAIL_USERNAME`/`PASSWORD`, `VAPID_*`.
3. Expose only `web`'s port 3000 through Coolify's proxy/domain. `motis` (8080)
   only needs to be reachable from `web`/`darwin-ingest` on the compose
   network — don't route a public domain to it.
4. **Bootstrap order matters** — MOTIS has nothing to serve and darwin-ingest's
   corridor precompute has nothing to resolve against until routing data
   exists:
   - `pnpm db:migrate` against the deployed `DATABASE_URL` (or run as a
     Coolify pre-deployment command).
   - Run the ETL once to populate the `gtfs-data` volume:
     `docker compose --profile etl run --rm etl timetable`
   - Then start/restart `motis` so it imports the fresh GTFS.
   - For NR positioning, load reference data once:
     `docker compose run --rm nr-ingest pnpm tsx src/index.ts reference`
     and the headcode map (re-run roughly daily):
     `docker compose run --rm nr-ingest pnpm tsx src/index.ts headcodes`
5. The board (LDBWS) and journey planning work without Darwin/NR live feeds —
   deploy incrementally and add `RDM_*`/`NETWORKRAIL_*` credentials as each
   feed subscription comes online.

## Data & licensing

Timetable, fares and Darwin data © RDG / National Rail, used under the relevant
Rail Data Marketplace licences. This is a personal project; check feed licence
terms before any public deployment.
