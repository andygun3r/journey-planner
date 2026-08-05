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

Every service deploys as its own Coolify app — not one Docker Compose stack.
That means one failing service can't take the rest down with it, and you can
restart or redeploy any single app on its own. Apps talk to each other over
plain HTTP, using env vars you set explicitly in Coolify's UI — no shared
Docker socket, no shared volumes, no guessing container names.

Follow the steps below **in order**. Each one tells you which Coolify app to
create, exactly which env vars to set, and what to check before moving on.

### Before you start

Generate four secrets once — you'll paste each into two different apps later
(the app that calls, and the app that receives):

```sh
openssl rand -base64 32   # ETL_INTERNAL_KEY
openssl rand -base64 32   # NR_INGEST_INTERNAL_KEY
openssl rand -base64 32   # MOTIS_REIMPORT_KEY
openssl rand -base64 32   # BETTER_AUTH_SECRET
```

Decide now whether you want the live map (`/map`). If yes, fork
[hiddewie/OpenRailwayMap-vector](https://github.com/hiddewie/OpenRailwayMap-vector)
on GitHub and create a **second, separate Coolify project** pointed at your
fork — the map stack's 5 apps live there, not in this project. If you're
skipping the map for now, ignore every step below marked **(map only)**.

---

### Step 1 — `postgres` and `redis`

Two Coolify apps. Use Coolify's managed Postgres/Redis if it offers them, or
the plain images `postgres:17-alpine` / `redis:8-alpine`. No public port on
either.

**`postgres` env vars:**
```
POSTGRES_USER=mainline
POSTGRES_PASSWORD=mainline
POSTGRES_DB=mainline
```
(Or your own values — whatever you put here must match `DATABASE_URL` on
every other app below.)

**`redis`**: no env vars needed.

---

### Step 2 — `web`

Coolify app, **Dockerfile** build type. This is your one public app —
port 3000, this is what you route your domain to.

**Base Directory**: `/` (repo root) — **Dockerfile Location**:
`apps/web/Dockerfile`. Don't put `apps/web/Dockerfile` into the Base
Directory field: unlike `orm-db`/`orm-import` in step 8, this Dockerfile's
`COPY` commands (`COPY apps ./apps`, `COPY packages ./packages`, etc.) need
the build context to be the whole repo, not just `apps/web/`. Putting the
full path in the wrong field fails with
`mkdir: can't create directory '.../apps/web/Dockerfile': File exists` —
Coolify tries to treat the file path as a directory to create.

**Build arg:**
```
NEXT_PUBLIC_TILES_URL=https://<your-eventual-orm-proxy-domain>
```
(Only matters if you're doing `/map`. Baked into the client bundle at build
time — if you don't have your `orm-proxy` domain yet, leave it blank and
come back to rebuild once step 8 is done.)

**Runtime env vars:**
```
DATABASE_URL=postgres://mainline:mainline@<postgres-host>:5432/mainline
REDIS_URL=redis://<redis-host>:6379
MOTIS_URL=http://<motis-host>:8080
ETL_URL=http://<etl-cron-host>:4000
ETL_INTERNAL_KEY=<from step 0>
NR_INGEST_URL=http://<nr-ingest-host>:4001
NR_INGEST_INTERNAL_KEY=<from step 0>
MOTIS_REIMPORT_URL=http://<motis-sidecar-host>:4002
MOTIS_REIMPORT_KEY=<from step 0>
BETTER_AUTH_SECRET=<from step 0>
BETTER_AUTH_URL=https://<your-real-public-domain>
RESEND_API_KEY=<from resend.com, for magic-link sign-in>
RUN_DB_MIGRATIONS=1
```

`BETTER_AUTH_URL` must be your **real public domain**, not `localhost` —
sign-in derives a security check from it and breaks silently if it's wrong.
`RUN_DB_MIGRATIONS=1` is only for this first deploy (see the checkpoint
below) — unset it afterward.

**Optional, one per feature — skip anything you don't need yet, nothing
below crashes the app if it's missing, the feature just won't work:**
```
LDBWS_API_KEY=...           LDBWS_BASE_URL=...            # departure boards
LDBWS_SERVICE_API_KEY=...   LDBWS_SERVICE_BASE_URL=...    # per-service calling pattern
DISRUPTIONS_API_KEY=...     DISRUPTIONS_BASE_URL=...      # disruptions feed
TFL_APP_KEY=...             TFL_BASE_URL=...              # TfL last-mile data
VAPID_PUBLIC_KEY=...                                      # commute-alert push (pairs with darwin-ingest, step 4)
DTD_SFTP_HOST=...                                         # shows SFTP status on /settings/timetable
```

**Deploy this app now**, then check:

```sh
curl https://<your-domain>/api/health
```

Confirm the response shows the database schema as present. If it doesn't,
check `web`'s logs for `[web] applying database migrations` — if you see
`[web] skipping database migrations` instead, `RUN_DB_MIGRATIONS` isn't set.

---

### Step 3 — Sign up and become admin

Visit your domain and sign up (passkey or magic link). Then, using Coolify's
container terminal on the `postgres` app (or `psql` if you've exposed a
port):

```sql
update "user" set role = 'admin' where email = 'you@example.com';
```

You can unset `RUN_DB_MIGRATIONS` on `web` now.

---

### Step 4 — `darwin-ingest` and `nr-ingest`

Two Coolify apps, **Dockerfile** build type: `services/darwin-ingest/Dockerfile`
and `services/nr-ingest/Dockerfile`. Neither is public.

**`darwin-ingest` env vars:**
```
DATABASE_URL=postgres://mainline:mainline@<postgres-host>:5432/mainline
REDIS_URL=redis://<redis-host>:6379
MOTIS_URL=http://<motis-host>:8080
```
Plus, only if you have an RDM Darwin subscription — **set all five together,
or none of them**:
```
RDM_KAFKA_BOOTSTRAP_SERVERS=...
RDM_KAFKA_TOPIC=...
RDM_CONSUMER_KEY=...
RDM_CONSUMER_SECRET=...
RDM_KAFKA_GROUP_ID=...
```
`RDM_KAFKA_GROUP_ID` falls back to your consumer key if unset, so it *looks*
optional in the code — but RDM's Confluent Cloud broker can enforce ACLs
scoped to a specific consumer-group-id pattern. If yours does and you leave
this unset, connecting fails with `TOPIC_AUTHORIZATION_FAILED` and the
service crash-loops, even though every other credential is correct. Check
your RDM subscription for the expected group id format and set it exactly.

Plus, for commute-alert push notifications:
```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

**`nr-ingest` env vars:**
```
DATABASE_URL=postgres://mainline:mainline@<postgres-host>:5432/mainline
REDIS_URL=redis://<redis-host>:6379
HTTP_PORT=4001
NR_INGEST_INTERNAL_KEY=<from step 0>
```
Plus, only if you have a Network Rail Open Data account — **set both
together, or neither**:
```
NETWORKRAIL_USERNAME=...
NETWORKRAIL_PASSWORD=...
```
Plus, only if you're using RailData Kafka for Train Describer (optional —
falls back to STOMP without it) — **set all five together, or none**:
```
NR_TD_KAFKA_BOOTSTRAP_SERVERS=...
NR_TD_KAFKA_TOPIC=...
NR_TD_KAFKA_USERNAME=...
NR_TD_KAFKA_PASSWORD=...
NR_TD_KAFKA_GROUP_ID=mainline-nr-td-ingest
```
Same caveat as `RDM_KAFKA_GROUP_ID` above — check RailData's subscription
docs for whether your broker enforces a specific consumer-group-id pattern
before assuming the default is fine.

⚠️ **The "all together, or none" rule matters.** Both services are meant to
idle harmlessly (not crash) when a whole feed's credentials are unset — but
setting *some* of a feed's vars and missing others makes the service crash
instead of idling, because the code only checks one variable to decide
"is this feed configured." Don't leave a feed half-configured.

It's fine to deploy both apps now with feed credentials missing entirely —
they'll sit idle until you add credentials later. `nr-ingest` won't respond
to sync requests without `HTTP_PORT` set, even with no feed configured.

---

### Step 5 — `motis` + `motis-sidecar`

**One Coolify app, two containers.** `motis` runs the routing engine;
`motis-sidecar` is a small second container in the same app that has the
things `motis` itself doesn't need — Docker socket access, to trigger
reimports.

**`motis` container:**
- Image: `ghcr.io/motis-project/motis:latest`
- Command:
  ```sh
  sh -c 'until [ -f /data/config.yml ]; do echo "waiting for imported routing data"; sleep 300; done; exec /motis server'
  ```
  (This makes it wait patiently instead of crash-looping before the first
  timetable import exists.)
- No env vars needed. Not public.

**`motis-sidecar` container:**
- Dockerfile: `services/motis-sidecar/Dockerfile`
- Mount the host's Docker socket: `/var/run/docker.sock`
- Env vars:
  ```
  HTTP_PORT=4002
  MOTIS_REIMPORT_KEY=<from step 0>
  MOTIS_CONTAINER_NAME=motis
  ```
  (`MOTIS_CONTAINER_NAME` should match whatever Coolify actually names the
  `motis` container — check `docker ps` if reimports later fail to find it.
  `MOTIS_IMAGE` and `MOTIS_IMPORT_MEMORY` are optional overrides, defaults
  are fine for most setups.)

**Deploy this app now.**

---

### Step 6 — `mariadb` and `etl-cron`

**`mariadb`**: Coolify app, image `mariadb:11`. Give it 4GB+ memory — it's
idle almost all day, busy for one nightly job.
```
MARIADB_ROOT_PASSWORD=etl
MARIADB_DATABASE=dtd
```

**`etl-cron`**: Coolify app, **Dockerfile** build type: `services/etl/Dockerfile`.
**Leave Coolify's start command AND "Custom Docker Options"/entrypoint
override fields completely empty — don't touch either of them.** The
image's own default (`CMD ["timetable"]`, appended to
`ENTRYPOINT ["pnpm", "tsx", "src/index.ts"]`) never actually gets used here:
`HTTP_PORT` being set below makes `src/index.ts` switch into standing-server
mode automatically before it ever looks at argv (see the top of that file).
`HTTP_PORT`+`ETL_CRON` as plain **environment variables** (not a command
override) are the only things that need setting.

Two specific mistakes to avoid, both looking plausible but both wrong:
- Setting the start command to `server` fails with
  `exec: "server": executable file not found in $PATH` — Coolify replaces
  the container's entrypoint with that single word, and Docker tries to run
  a binary called `server`, which doesn't exist.
- Setting a Custom Docker Option like `--entrypoint pnpm tsx src/index.ts server`
  also fails, differently: `--entrypoint` only takes the *first* following
  word as the entrypoint binary (`pnpm`), and the rest (`tsx src/index.ts
  server`) get passed to it as plain arguments — which pnpm doesn't
  recognize, so it just prints its own help text and the container never
  starts your code at all.

If you've set either of these, delete it and redeploy — the Dockerfile
already does the right thing on its own once `HTTP_PORT`/`ETL_CRON` are set.
```
DATABASE_URL=postgres://mainline:mainline@<postgres-host>:5432/mainline
ETL_MYSQL_URL=mysql://root:etl@<mariadb-host>:3306/dtd
HTTP_PORT=4000
ETL_CRON=1
ETL_INTERNAL_KEY=<from step 0>
MOTIS_REIMPORT_URL=http://<motis-sidecar-host>:4002
MOTIS_REIMPORT_KEY=<from step 0>
NR_INGEST_URL=http://<nr-ingest-host>:4001
NR_INGEST_INTERNAL_KEY=<from step 0>
```
Plus one way of pulling the DTD timetable feed — either:
```
NRDP_USERNAME=...
NRDP_PASSWORD=...
```
or (RDG's SFTP delivery):
```
DTD_SFTP_HOST=...
DTD_SFTP_USERNAME=...
DTD_SFTP_PASSWORD=...
```
`ETL_CRON=1` starts the nightly 2am sweep as a background job inside this
same app (see `services/etl/cron/timetable-daily`) — you don't need a
separate cron app.

If doing `/map`, add `ORM_DATABASE_URL` pointing at `orm-db` — see step 8
for why this needs the full external address, not an internal hostname.

**Deploy this app now.**

---

### Step 7 — Trigger the first timetable import

```sh
curl -X POST -H "x-internal-key: <ETL_INTERNAL_KEY>" http://<etl-cron-host>:4000/timetable
```

This downloads and processes the full timetable, then automatically pushes
the result to `motis-sidecar` and triggers a reimport — no separate manual
step needed. It can take a while and use significant memory; if your server
is small, see "Low-memory server" below instead.

Optionally, load Network Rail positioning reference data once (run from your
own machine against the deployed `DATABASE_URL`, or as a Coolify one-off
command):
```sh
pnpm --filter @mainline/nr-ingest start reference
```

---

### Step 8 — Map stack (map only)

**In your separate Coolify project** (the fork you created in "Before you
start"), create 5 apps, all **Dockerfile** build type, pointed at your fork:

| App | Base Directory | Dockerfile Location | Public? |
|---|---|---|---|
| `orm-db` | `db` | `Dockerfile` | no |
| `orm-import` | `import` | `Dockerfile` | no (one-off, run once) |
| `orm-martin` | `/` | `martin.Dockerfile` | no |
| `orm-api` | `/` | `api.Dockerfile` | no |
| `orm-proxy` | `/` | `proxy.Dockerfile` | **yes** |

⚠️ **Base Directory matters, not just Dockerfile Location.** `orm-db` and
`orm-import`'s Dockerfiles `COPY` files relative to their own folder (e.g.
`db/Dockerfile` expects `extensions.sql` inside `db/`). If Coolify's build
context is the repo root while the Dockerfile path is `db/Dockerfile`, the
build fails with `"/extensions.sql": not found`. Set **Base Directory** to
`db` (or `import`) and **Dockerfile Location** to just `Dockerfile` — not
`db/Dockerfile` again, since it's now relative to that base directory.

**`orm-db` env vars** (all three required, or Postgres refuses to start):
```
POSTGRES_HOST_AUTH_METHOD=trust
PGDATA=/data/postgresql
POSTGRES_DB=gis
```
⚠️ **Also turn off Coolify's default healthcheck for `orm-db`.** This image
has no `curl`/`wget`, so Coolify's default healthcheck always reports
"unhealthy" and rolls the deploy back, even once Postgres has started fine.
Disable the healthcheck toggle in this app's settings.

**`orm-martin` env vars:**
```
DATABASE_URL=postgresql://postgres@<orm-db-host>:5432/gis
```

**`orm-api` env vars:**
```
PORT=5000
HOST=0.0.0.0
POSTGRES_USER=postgres
POSTGRES_HOST=<orm-db-host>
POSTGRES_DB=gis
```

**`orm-proxy` env vars:**
```
TILES_UPSTREAM=<orm-martin-host>:3000
API_UPSTREAM=<orm-api-host>:5000
PUBLIC_PROTOCOL=https
ORM_PUBLIC_HOST=<orm-proxy's own public domain, no protocol>
```

Deploy `orm-db` first, wait for it to be healthy, then run `orm-import` once
(follow that repo's own `SETUP.md` for the GB OSM data download it needs).
Then deploy `orm-martin`, `orm-api`, `orm-proxy`.

Once `orm-proxy` has a public domain, go back to `web` (step 2) and set/fix
`NEXT_PUBLIC_TILES_URL` to match, then rebuild.

Also go back to `etl-cron` (step 6) and set `ORM_DATABASE_URL` — since
`orm-db` lives in a different Coolify project, use whatever external
address/port that project exposes it on, not an internal-only hostname.

---

### You're done — what's optional from here

- **Feed credentials**: the board (LDBWS) and journey planning already work
  without Darwin/NR live feeds. Add `RDM_*`, `NETWORKRAIL_*`, and
  `NR_TD_KAFKA_*` credentials to `darwin-ingest`/`nr-ingest` (step 4) as
  subscriptions come online — no redeploy of anything else needed.
- **Keeping the timetable current**: once `ETL_CRON=1` is set on `etl-cron`
  (step 6), it runs the SFTP sweep nightly at 2am automatically — timetable,
  fares, NR reference/Track Model sync, then a MOTIS reimport. You can also
  trigger the same sweep on demand from `/settings/timetable` in the app
  ("Sync all SFTP data").
- **Security note**: `motis-sidecar` (step 5) mounts the host's Docker
  socket — full control-plane access, scoped to that one small container.
  Be aware of that before giving shell/exec access to that container to
  anyone else, or running unrelated workloads on the same host.

### Low-memory server: import locally, upload the bundle

`dtd2mysql` (the CIF → GTFS conversion inside `/timetable`, step 7) is the
memory-heavy part of the pipeline. On a small server it can struggle or OOM.
Run the full monthly import on your own machine instead:

```sh
pnpm --filter @mainline/etl exec tsx src/index.ts package
```

This needs a local MariaDB scratch DB (`ETL_MYSQL_URL` pointed at it, not
the server's). It packages the result into `bundle-<feedVersion>.tar.gz`
instead of loading into Postgres — no MariaDB or `dtd2mysql` ever touches
the server for this path.

Upload it from `/settings/timetable` on your deployed site. The web app
loads the station/trip-mapping data into Postgres directly, then uploads the
bundled GTFS zip to `motis-sidecar` and triggers a reimport — skipping the
heavy conversion step on the server entirely.

`etl-cron`'s nightly sweep still handles **daily** delta updates via
`DTD_SFTP_*` — those files are much smaller than a full monthly extract, so
leave that running server-side unless it also proves too heavy, in which
case repeat the same `package` + upload flow for daily deltas.

## Data & licensing

Timetable, fares and Darwin data © RDG / National Rail, used under the relevant
Rail Data Marketplace licences. This is a personal project; check feed licence
terms before any public deployment.
