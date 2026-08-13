# Plan — remaining work

Tracks what's left of the map-first journey planner. Phases 1–5.1 are built and
merged; this file covers what isn't.

Written 2026-08-10.

---

## Status

| Phase | What | State |
|-------|------|-------|
| 1 | Geometry on journey legs | **Done** — verified live |
| 2 | Vector basemap (OpenFreeMap under OpenRailwayMap) | **Done** |
| 2a | Free-text address search (OS Places) | **Built, needs a key** |
| 3 | Map-first shell — search, results and legs over a persistent map | **Done** |
| 4 | Street routing (OSM → MOTIS) | **Built, needs enabling** |
| 5.1 | TfL deepened — line colours, geometry, live arrivals | **Built, unverified** |
| 5.2 | National bus/coach (BODS) | **Not started** |
| 5.3 | Cycling | **Not started** |

---

## Blockers first

These gate verification of work already written. None need code.

### 1. Local env precedence
`.env` sets `DATABASE_URL`/`REDIS_URL` to **production Coolify hostnames**, and it
wins over `.env.local`, which holds the correct local values. Local dev can't reach
Postgres or Redis until that's resolved — `/api/health` reports
`postgres: false, redis: false` even with the containers running healthily.

`TFL_APP_KEY` has the same split: empty in `.env`, real key in `.env.local`.

Decide which file is authoritative for local work and make it consistent.

### 2. No local MOTIS
`MOTIS_URL` is `http://localhost:8080`, where nothing is listening — so journey
planning returns `engine-offline` locally. Everything downstream of the engine has
been verified against a stub serving the real MOTIS v2 response shape, but the
engine itself hasn't run here.

### 3. OS Places key
`OS_PLACES_API_KEY` is unset, so free-text place search ("The Shard",
"14 Baker Street") is inert. The integration is complete and tested against the
unconfigured path; it activates with no code change. Register at
https://osdatahub.os.uk.

---

## Phase 4 — turn street routing on

All written; this is an operational sequence, deliberately staged because a
national OSM import is expensive in memory and time.

1. On **etl**: set `OSM_ENABLED=1` and an `OSM_EXTRACT_URL` for a small region
   first — e.g. Greater London (~90MB) — rather than the ~1.5GB GB default.
2. Run `pnpm --filter @signaller/etl exec tsx src/index.ts osm`. It downloads the
   extract, caches it, and uploads it to the MOTIS sidecar.
3. Run `etl timetable` (or wait for the 2am cron). The sidecar sees the extract and
   writes `osm:` + `street_routing: true` into `config.yml`.
4. **Measure the import**: peak memory and wall time. This is the number that
   decides whether full GB is viable on the current box, and it's why the rollout
   is staged.
5. On **web**: set `MOTIS_STREET_ROUTING=1`. `planFlexible` then routes to the
   destination coordinate instead of falling back to "nearest station + walking
   note".
6. Verify: plan postcode → postcode and confirm the first and last legs are real
   walking legs with geometry and distances, not `destinationWalkNote`.
7. Once happy, repeat with the full GB extract.

**Watch:** the nightly window. The OSM import lengthens it materially — the reason
`etl osm` is a separate command rather than part of the nightly job.

**Confirm on first real import:** the MOTIS request parameters
(`preTransitModes`, `postTransitModes`, `maxPreTransitTime`) follow the v2 API but
haven't run against the pinned release. `packages/routing-adapter/src/motis.ts` is
the single place to fix if they've drifted.

---

## Phase 5.1 — verify TfL

Built, but never exercised against the live API (no key was loaded during
development). Needs a pass with `TFL_APP_KEY` active:

- Line colours on drawn routes — Central red, Victoria light blue, and the 2024
  Overground names (Mildmay, Windrush, Lioness…).
- Geometry backfill: `clipPolyline` in `apps/web/lib/journeys.ts` fills in legs
  where TfL omits `path.lineString` (common on buses). Check it picks the right
  branch, and that it correctly draws *nothing* when it can't.
- Live arrivals on a selected TfL leg (`components/leg-live-arrivals.tsx`).
- Stop markers appear for tube/bus legs now that coordinates are threaded through.

---

## Phase 5.2 — national bus and coach (BODS)

**Treat as its own project, not a follow-on task.** This is the largest remaining
item by a wide margin.

The Bus Open Data Service gives GB-wide bus data in two parts, with different
shapes and cadences:

- **Timetables** — TransXChange XML, per-operator. Needs a TransXChange → GTFS
  conversion step in `services/etl`, then folding into the MOTIS import as a
  **second dataset** alongside `gb-railgtfs`. Note the routing adapter currently
  assumes one dataset tag (`MOTIS_DATASET_TAG`, stripped in
  `packages/routing-adapter/src/motis.ts`) — that assumption has to be revisited
  before a second dataset lands, or stop ids will be mangled.
- **Live positions** — SIRI-VM. A new small ingest service alongside
  `darwin-ingest`/`nr-ingest`, publishing to Redis like the others.

Open questions to settle before starting:
- Scale: GB bus timetables are far larger than the rail timetable. What does that
  do to the MOTIS import that Phase 4 has already made heavier?
- Coverage vs effort: is national coverage the goal, or a few regions?
- Overlap with TfL, which already covers London buses well. Deduplication policy?

---

## Phase 5.3 — cycling

Small, once Phase 4 is live: MOTIS can already route bicycles against the same OSM
data, so this is largely a mode flag plus UI.

- `accessModes: ["BIKE"]` is already plumbed through `plan()` in the routing
  adapter — needs exposing as a user choice.
- Leg rendering: a bike leg needs its own line treatment, distinct from walk's
  dashes and transit's solid, and not by colour alone.
- Optional and separate: TfL cycle-hire dock availability is its own small feed.

---

## Smaller things worth doing

- **Type duplication.** `packages/shared`'s zod `Journey`/`Leg` and the
  hand-written `JourneyView`/`JourneyLegView` in `apps/web/lib/journeys.ts` have
  drifted apart; the live pipeline only uses the latter. Phases 1 and 4 widened
  the gap. Worth reconciling before more is layered on.
- **File-sync conflicted copies.** A sync service (Dropbox/iCloud) keeps creating
  `filename 2.ts` duplicates in the working tree and in `.next/types/`. The `.ts`
  ones get picked up by vitest as duplicate test files, and the `.next` ones break
  `tsc`. Worth excluding the repo from sync, or adding the pattern to
  `.gitignore` and the vitest config.
- **Mobile app.** `apps/mobile` is still the Phase 0 spike: a static map screen,
  no live trains, no journey sheet. It shares the style loader from Phase 2 but
  none of the planner work. Also, `pnpm --filter mobile build` currently fails on
  a missing `react-native-web` dependency (pre-existing, unrelated to this work).
- **Map-first dashboard.** The plan originally had `/` redirecting to the map;
  that was rejected because the dashboard is genuinely useful. The more ambitious
  option — map at `/` with the commute panel and alerts inside the sheet's peek
  state — remains open if the map should become the true home.

---

## Verification

```sh
pnpm typecheck && pnpm --filter web test && pnpm --filter web build
pnpm dev:up && curl localhost:3000/api/health     # needs blocker 1 resolved
```

End-to-end, once the blockers are cleared:
- `/api/journeys?from=KGX&to=YRK` → legs carry `geometry` and coordinates.
- `/map` → search, journey draws end to end, tapping a leg frames it.
- Postcode → postcode → real walking legs (needs Phase 4 enabled).
- Accessibility: keyboard reachable, status never colour-only, WCAG 2.2 AA.
