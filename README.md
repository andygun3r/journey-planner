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

## Data & licensing

Timetable, fares and Darwin data © RDG / National Rail, used under the relevant
Rail Data Marketplace licences. This is a personal project; check feed licence
terms before any public deployment.
