#!/bin/sh
# Runs the timetable pipeline; on success, reimports the refreshed GTFS zip
# into motis and restarts it to serve the new data (MOTIS has no live-reload
# API — see CLAUDE.md's DTD static feeds section). `motis server` only ever
# serves whatever's already preprocessed under /data/data — restarting alone
# does NOT reimport, `motis import` must run first. Requires the docker CLI
# + the host socket mounted into this container (see docker-compose.yml's
# etl-cron).
set -eu

cd /app/services/etl
pnpm tsx src/index.ts timetable

MOTIS_CONTAINER="${MOTIS_CONTAINER_NAME:-mainline-motis-1}"
echo "Timetable refresh succeeded — reimporting into $MOTIS_CONTAINER"
docker exec "$MOTIS_CONTAINER" /motis import -d /data/data -c /data/config.yml
echo "Reimport done — restarting $MOTIS_CONTAINER to serve the new data"
docker restart "$MOTIS_CONTAINER"
