#!/bin/sh
# Nightly timetable refresh: run the pipeline, then reload MOTIS.
#
# Requires the docker CLI + the host socket mounted into this container (see
# docker-compose.yml's etl-cron).
set -eu

HERE="$(dirname "$0")"

# Free memory for the run.
#
# The import is the heaviest thing this box does, and it has run the server out
# of memory. The map tile stack is roughly 1.8GB of containers serving a page
# nobody is looking at in the middle of the night, so it stands down for the
# duration. Restored in a trap so it comes back even if the pipeline fails.
#
# Set ETL_KEEP_TILES=1 to skip this if you'd rather keep the map up.
#
# Names carry the compose project prefix, same caveat as MOTIS_CONTAINER_NAME —
# Coolify renames projects, so override ETL_TILE_CONTAINERS if these don't match
# `docker ps` on your host.
TILE_SERVICES="${ETL_TILE_CONTAINERS:-mainline-orm-proxy-1 mainline-orm-martin-1 mainline-orm-api-1 mainline-orm-db-1}"
restore_tiles() {
  if [ "${ETL_KEEP_TILES:-0}" != "1" ]; then
    echo "Bringing the map tile stack back up…"
    # shellcheck disable=SC2086
    docker start $TILE_SERVICES 2>/dev/null || true
  fi
}

if [ "${ETL_KEEP_TILES:-0}" != "1" ]; then
  trap restore_tiles EXIT INT TERM
  echo "Stopping the map tile stack to free memory for the import…"
  # Names, not compose service ids: this script may run from a container that
  # has the socket but not the compose project. Failure is not fatal — if the
  # names don't match this deployment, we just run with less headroom.
  # shellcheck disable=SC2086
  docker stop $TILE_SERVICES 2>/dev/null || echo "  (none stopped — check container names)"
fi

cd /app/services/etl
pnpm tsx src/index.ts timetable

echo "Timetable refresh succeeded — reloading MOTIS"
sh "$HERE/motis-reimport.sh"

echo "Syncing DTD fares from SFTP…"
pnpm tsx src/index.ts fares

echo "Syncing Network Rail reference files from SFTP…"
NR_REFERENCE_SYNC_CONTAINER="${NR_REFERENCE_SYNC_CONTAINER_NAME:-mainline-nr-reference-sync-1}"
docker exec "$NR_REFERENCE_SYNC_CONTAINER" node dist/index.js reference-sftp

echo "Syncing Network Rail Track Model from SFTP…"
pnpm tsx src/index.ts track-model-sftp
