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

Decide now whether you want the live map (`/map`), and if your server has
capacity to self-host the tile stack (`orm-db`/`orm-import`/`orm-martin`/
`orm-api`/`orm-proxy` — a full separate Coolify project built from your own
fork of [hiddewie/OpenRailwayMap-vector](https://github.com/hiddewie/OpenRailwayMap-vector))
or would rather proxy the hosted instance through `web` itself (no extra
apps, no fork needed — see step 8 for both options). If you're skipping the
map for now, ignore every step below marked **(map only)**.

⚠️ **Set a fixed container name on every standalone (non-Compose) backend
app, before its first deploy.** By default, Coolify names each app's
container after an ephemeral build/instance ID (something like
`g3gq4jwibve817jmk934lu34-072451594731`) that **changes on every redeploy** —
Docker's internal DNS only resolves containers by that exact, changing name,
with no stable alias registered per app. Pointing `web`'s env vars at one of
these names works until the next redeploy of that backend app, then silently
breaks with `fetch failed` (Node's `fetch` can't resolve/connect to a
hostname that no longer exists). Look for a **Container Name** field in each
app's settings (General or Advanced tab, depending on your Coolify version)
and set it to something fixed before you deploy that app for the first time:

| App | Fixed container name |
|---|---|
| `etl-cron` | `mainline-etl` |
| `nr-ingest` | `mainline-nr-ingest` |
| `motis` | `mainline-motis` |
| `motis-sidecar` | `mainline-motis-sidecar` |

(`postgres`, `redis`, `darwin-ingest`, and `web` don't need this — nothing
else in this deploy calls them by container name over HTTP. `mariadb` only
needs it if you'd rather use a name than remember its auto-generated one for
`ETL_MYSQL_URL`.) Use these fixed names in the `http://<host>:<port>` URLs
throughout the rest of this guide, instead of anything copied from `docker
ps`.

⚠️ **Deploy `motis`/`motis-sidecar` as two standalone Coolify apps, not a
Docker Compose resource.** An earlier version of this guide ran them as one
Compose app, on the theory that they only need to reach each other. That
broke in practice: **a Compose resource runs on its own private Docker
network, separate from every standalone app's shared `coolify` network** —
so no hostname, fixed or otherwise, resolved between `motis`/`motis-sidecar`
and `etl-cron`/`web`/`darwin-ingest`, regardless of naming. Confirmed
directly on a real deploy: `etl-cron` couldn't resolve `motis-sidecar`'s
container name at all (`wget: bad address ...`) even though the container
was running fine, because
`docker inspect <container> --format '{{json .NetworkSettings.Networks}}'`
showed them on two different networks entirely (`coolify` vs. the Compose
project's own auto-generated network). Routing around that by publishing
host ports and reaching them via the host's Docker bridge address worked,
but is a second failure mode waiting to happen: that bridge address isn't
guaranteed stable, and the ports are reachable from anything else on the
host, not just Coolify's containers. Two standalone apps on the shared
`coolify` network sidesteps both problems — see step 5.

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
NEXT_PUBLIC_TILES_URL=https://<this-app's-own-domain>/api/map-tiles
```
(Only matters if you're doing `/map` — see step 8 for the self-hosted
alternative, which uses your `orm-proxy` domain here instead. Baked into the
client bundle at build time — if you don't have your domain finalized yet,
leave it blank and rebuild once you do.)

**Runtime env vars:**
```
DATABASE_URL=postgres://mainline:mainline@<postgres-host>:5432/mainline
REDIS_URL=redis://<redis-host>:6379
MOTIS_URL=http://mainline-motis:8080
ETL_URL=http://<etl-cron-host>:4000
ETL_INTERNAL_KEY=<from step 0>
NR_INGEST_URL=http://<nr-ingest-host>:4001
NR_INGEST_INTERNAL_KEY=<from step 0>
MOTIS_REIMPORT_URL=http://mainline-motis-sidecar:4002
MOTIS_REIMPORT_KEY=<from step 0>
BETTER_AUTH_SECRET=<from step 0>
BETTER_AUTH_URL=https://<your-real-public-domain>
RESEND_API_KEY=<from resend.com, for magic-link sign-in>
RUN_DB_MIGRATIONS=1
```

`BETTER_AUTH_URL` must be your **real public domain**, not `localhost` —
sign-in derives a security check from it and breaks silently if it's wrong.
`RUN_DB_MIGRATIONS=1` is only for this first deploy (see the checkpoint
below) — unset it afterward. `MOTIS_URL`/`MOTIS_REIMPORT_URL` use the fixed
container names set on `motis`/`motis-sidecar` in step 5 — both are
standalone apps on the shared `coolify` network, so container-name DNS
works the same way it does for `etl-cron`/`nr-ingest` above.

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
MOTIS_URL=http://mainline-motis:8080
```
(See step 5 — `motis` is deployed as a standalone app with a fixed container
name, so it's reachable by name over the shared `coolify` network.)
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
Optional overrides for the STOMP broker itself (defaults are correct for
Network Rail's public feed — only set these if you know you need something
different):
```
NR_STOMP_HOST=publicdatafeeds.networkrail.co.uk
NR_STOMP_PORT=61618
```
⚠️ Bare hostname, no `stomp://` scheme, same rule as `DTD_SFTP_HOST` in step
6 — the code passes this straight to a `connect({ host, port })` call.

Plus, only if you're using RailData Kafka for Train Describer (optional —
falls back to STOMP without it) — **set all five together, or none**:
```
NR_TD_KAFKA_BOOTSTRAP_SERVERS=broker1.example.com:9092
NR_TD_KAFKA_TOPIC=...
NR_TD_KAFKA_USERNAME=...
NR_TD_KAFKA_PASSWORD=...
NR_TD_KAFKA_GROUP_ID=mainline-nr-td-ingest
```
⚠️ `NR_TD_KAFKA_BOOTSTRAP_SERVERS` (and `RDM_KAFKA_BOOTSTRAP_SERVERS` on
`darwin-ingest` above) must be **bare `host:port`, comma-separated for
multiple brokers — no `SASL_SSL://` or any other scheme prefix.** Copying
the value straight from a Confluent Cloud dashboard sometimes includes a
scheme; strip it before pasting here, or the client can't parse the broker
list correctly. Same caveat as `RDM_KAFKA_GROUP_ID` above for the group id —
check RailData's subscription docs for whether your broker enforces a
specific consumer-group-id pattern before assuming the default is fine.

`nr-ingest`'s `/reference-sftp` endpoint (used by `web` and `etl-cron`'s
nightly sweep) needs its own SFTP credentials — falls back to `DTD_SFTP_*`
(step 6) if unset, so only set these if RDG issued separate SFTP access for
NR reference files:
```
NR_SFTP_HOST=...
NR_SFTP_PORT=...
NR_SFTP_USERNAME=...
NR_SFTP_PASSWORD=...
NR_SFTP_REFERENCE_DIR=/
```
Same bare-host rule as `DTD_SFTP_HOST`. `NR_SFTP_DELETE_PROCESSED` (default:
deletes remote files after successful processing) and `NR_TPS_DIR` (default
`/data/tps`, worth mounting a persistent volume if you rely on Track
Planning Model data surviving a redeploy) are documented alongside the
Track Model sync in step 6, since the same delete-by-default behavior and
directory pattern applies here too.

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

**Two standalone Coolify apps**, both on the shared `coolify` network — not
a Docker Compose resource. `motis` runs the routing engine; `motis-sidecar`
is a small separate app that has the things `motis` itself doesn't need —
Docker socket access, to trigger reimports.

⚠️ **Don't deploy these as one Docker Compose app.** An earlier version of
this guide did exactly that, on the theory that they only need to reach
each other. It broke in practice: **a Compose resource runs on its own
private Docker network, separate from every standalone app's shared
`coolify` network.** Confirmed directly on a real deploy: `etl-cron` and
`web` couldn't resolve `motis`/`motis-sidecar` by any container name at all
— container-name DNS that works fine between `etl-cron` and `nr-ingest`
(both standalone apps, same network) does not reach into a Compose app, no
matter what either container is named. Publishing both containers' ports to
the host and reaching them via the host's Docker bridge address works
around that, but it's a second failure mode: that bridge address isn't
guaranteed stable across hosts/reboots, and it makes both ports reachable by
anything on the Docker host, not just Coolify's own containers. Deploying
both as standalone apps avoids all of this — same network, same
fixed-container-name pattern as `etl-cron`/`nr-ingest` in the table near the
top of this section.

**`motis` app** (Coolify **Docker Image** build type — no Dockerfile needed):
- Image: `ghcr.io/motis-project/motis:latest`
- **Container Name**: `mainline-motis` (set before first deploy — see the
  fixed-container-name note near the top of this section)
- Command:
  ```sh
  sh -c 'until [ -f /data/config.yml ]; do echo "waiting for imported routing data"; sleep 300; done; exec /motis server'
  ```
  (This makes it wait patiently instead of crash-looping before the first
  timetable import exists.)
- No env vars needed.
- Persistent volume at `/data` — this is where the imported timetable/routing
  data lives; losing it means every app depending on `motis` goes back to
  "waiting for imported routing data" until the next full ETL import.
- No port publish needed — `web`/`darwin-ingest`/`etl-cron` reach it by
  container name (`mainline-motis:8080`) over the shared `coolify` network,
  not the host.

**`motis-sidecar` app** (Coolify **Dockerfile** build type):
- Dockerfile: `services/motis-sidecar/Dockerfile`
- **Container Name**: `mainline-motis-sidecar`
- Mount the host's Docker socket: `/var/run/docker.sock`
- Env vars:
  ```
  HTTP_PORT=4002
  MOTIS_REIMPORT_KEY=<from step 0>
  MOTIS_CONTAINER_NAME=mainline-motis
  ```
  (`MOTIS_CONTAINER_NAME` is used with the mounted Docker socket for
  `docker run --volumes-from`/`docker restart` against its `motis` sibling —
  this must be `motis`'s **actual Docker container name**, i.e. the fixed
  name set above, regardless of how the two apps reach each other over the
  network. `MOTIS_IMAGE` and `MOTIS_IMPORT_MEMORY` are optional overrides,
  defaults are fine for most setups.)
- No port publish needed, for the same reason as `motis` above.

**On every app that needs to reach `motis`/`motis-sidecar`** (`web`,
`darwin-ingest`, `etl-cron` — steps 2, 4, 6), use the fixed container names:
```
MOTIS_URL=http://mainline-motis:8080
MOTIS_REIMPORT_URL=http://mainline-motis-sidecar:4002
```
Confirm with a live test before trusting it — from inside `etl-cron`'s
container terminal:
```sh
wget -qO- --header="x-internal-key: <MOTIS_REIMPORT_KEY>" --post-data='' http://mainline-motis-sidecar:4002/reimport
```
A `bad address` error means the name isn't resolving (check both apps are
standalone, not Compose, and that the Container Name field is actually set);
a real response (even a 401 for a wrong key) means it's wired correctly.

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
MOTIS_REIMPORT_URL=http://mainline-motis-sidecar:4002
MOTIS_REIMPORT_KEY=<from step 0>
NR_INGEST_URL=http://<nr-ingest-host>:4001
NR_INGEST_INTERNAL_KEY=<from step 0>
```
(See step 5 — `motis-sidecar` is a standalone app with a fixed container
name, reachable directly over the shared `coolify` network.)
Plus one way of pulling the DTD timetable feed — either:
```
NRDP_USERNAME=...
NRDP_PASSWORD=...
```
or (RDG's SFTP delivery):
```
DTD_SFTP_HOST=<bare hostname or IP, e.g. sftp.example.com>
DTD_SFTP_PORT=<port number, e.g. 2222 — omit for the default, 22>
DTD_SFTP_USERNAME=...
DTD_SFTP_PASSWORD=...
```
⚠️ **`DTD_SFTP_HOST` must be a bare hostname or IP — no `sftp://` scheme, no
port.** The code passes it straight to an SFTP client's `connect({ host,
port })` call, which only accepts a plain host string. `DTD_SFTP_PORT` is
the *separate* var for the port. Setting `DTD_SFTP_HOST=sftp://host:2222`
fails with `getaddrinfo ENOTFOUND sftp://host:2222` — the whole string gets
treated as one hostname to resolve. This same bare-host-plus-separate-port
rule applies to every other host/port var pair below and on `nr-ingest`
(step 4) — none of them accept a URL.

Where SFTP files land on the remote server — the code's built-in defaults
are `/timetable` and `/fares`, but **RDG's actual delivery folder structure
varies per account** (some drop everything in the root folder instead).
Check what your account actually has before assuming the defaults are
right — an unset/wrong dir fails with `list: no such file <path>`. Set
explicitly:
```
DTD_SFTP_TIMETABLE_DIR=<the real remote path, e.g. / if files are in the root>
DTD_SFTP_FARES_DIR=<the real remote path, likewise>
```

**If your account uses one shared root folder for everything** (timetable,
fares, and NR Track Model files all mixed together — not separate
subfolders), you don't need to do anything extra: every candidate `.zip` is
downloaded and its contents inspected before being handed to the timetable
or fares pipeline (see `services/etl/src/classify-zip.ts`), so a Track Model
archive that happens to be newest in the folder gets skipped automatically
rather than crashing the run — you'll see `Skipping <file> — looks like
track-model, not timetable` in the logs, which is expected, not an error.

Optional: if your folder has many non-matching files (e.g. a long run of
Track Model archives ahead of the timetable file you actually want), set a
filename prefix to skip the wasted downloads rather than let content
detection reject them one by one:
```
DTD_SFTP_TIMETABLE_PREFIX=timetable
DTD_SFTP_FARES_PREFIX=fares
```
(Case-insensitive, matched against the start of each filename — adjust to
whatever your account's actual filenames start with.) This is purely a
bandwidth/time optimization — leave both blank and it still works correctly,
just downloads more before finding a match.

`ETL_CRON=1` starts the nightly 2am sweep as a background job inside this
same app (see `services/etl/cron/timetable-daily`) — you don't need a
separate cron app.

**Network Rail Track Model sync** (`track-model-sftp`, part of the nightly
sweep) uses its own SFTP credentials — falls back to the `DTD_SFTP_*` values
above if unset, so only set these if RDG issued separate SFTP access for
Track Model:
```
NR_SFTP_HOST=...
NR_SFTP_PORT=...
NR_SFTP_USERNAME=...
NR_SFTP_PASSWORD=...
NR_SFTP_TRACK_MODEL_DIR=/
```
Same bare-host rule as `DTD_SFTP_HOST` above.

⚠️ **`NR_SFTP_DELETE_PROCESSED` defaults to deleting remote files after
successful processing.** This applies to both the Track Model sync above and
`nr-ingest`'s reference-file sync (step 4) — set
`NR_SFTP_DELETE_PROCESSED=false` on whichever app runs the sync if you want
to keep processed files on the remote server, e.g. for a dry run or if
another process also needs them.

Two filesystem paths worth setting explicitly if you're mounting a
persistent volume for them (defaults are container-local and lost on
redeploy otherwise): `ETL_ARCHIVE_DIR` (default `/data/dtd/archive` —
downloaded/uploaded timetable zips) and `ETL_GTFS_OUT_DIR` (default
`/data/gtfs` — the produced GTFS output, pushed to `motis-sidecar` after
each run so losing this between runs isn't critical, just wasted
re-download work).

If the timetable import is running out of memory (see "Low-memory server"
below for the broader workaround), `ETL_DTD2MYSQL_HEAP_MB` (default `6144`)
is the one lever that directly controls the `dtd2mysql` conversion step's
heap size — lower it if the container's memory limit is tighter than 6GB,
though a lower value trades speed/reliability for headroom.

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

Self-hosting `orm-db`/`orm-import`/`orm-martin`/`orm-api`/`orm-proxy` needs
more server resources than every environment has available. If you can't
self-host it, `/map` can instead proxy the hosted instance of the same
project at [openrailwaymap.app](https://openrailwaymap.app) through `web`'s
own API — see `apps/web/app/api/map-tiles/[...path]/route.ts`.

**Why not point `NEXT_PUBLIC_TILES_URL` straight at `openrailwaymap.app`?**
Confirmed by testing directly: it sends no CORS headers on any response, so
a browser `fetch()` from your own domain is blocked outright before your app
ever sees a response. Its usage policy also requires a valid
`Referer`/`User-Agent` identifying a real application — generic or missing
ones get a 403. Routing every style/tile/sprite/glyph request through your
own server fixes both: the browser only ever talks to your domain, and the
proxy route controls what's sent upstream.

No self-hosted apps to create for this option — just set on `web` (step 2):
```
NEXT_PUBLIC_TILES_URL=https://<your-domain>/api/map-tiles
```
(Build-time, same as before — still needs a rebuild if you set/change it
after `web`'s already deployed.) No `ORM_PUBLIC_HOST` needed; that var was
specific to self-hosting `orm-proxy`.

⚠️ **openrailwaymap.app is a best-effort, volunteer-run community service —
expect occasional gaps, not guaranteed uptime.** When testing this, some of
its own tile sources (e.g. `electrification_railway_line_low`) returned 502
while others worked fine, independent of anything in this repo — that's
their upstream having a moment, not a bug in the proxy. `/map` will render
with whatever layers are currently up and self-heal as their service
recovers. If you need guaranteed uptime for the map, self-hosting (the
`orm-*` apps, requires spare server capacity) is the only alternative — see
this same project's own `SETUP.md` if you go that route later.

**One gap either way**: `etl-cron`'s `ORM_DATABASE_URL` (step 6, signal
position data) has no hosted equivalent — that's a direct PostGIS query, not
a tile/style request, so it only works against a self-hosted `orm-db`. Using
the hosted proxy means that one feature (signal positions feeding your own
database) has no data source; everything else on `/map` is unaffected.

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
