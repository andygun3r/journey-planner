#!/bin/sh
# Runs the timetable pipeline; on success, restarts the motis container so it
# reimports the refreshed GTFS zip (MOTIS has no live-reload API — see
# CLAUDE.md's DTD static feeds section). Requires the docker CLI + the host
# socket mounted into this container (see docker-compose.yml's etl-cron).
set -eu

cd /app/services/etl
pnpm tsx src/index.ts timetable

MOTIS_CONTAINER="${MOTIS_CONTAINER_NAME:-mainline-motis-1}"
echo "Timetable refresh succeeded — restarting $MOTIS_CONTAINER to pick up new GTFS"
docker restart "$MOTIS_CONTAINER"
