#!/bin/sh
# Nightly timetable refresh: run the pipeline (which pushes the produced GTFS
# to motis's sidecar and triggers a reimport+restart itself — see
# services/etl/src/commands.ts), then sync fares, NR reference files, and
# Track Model.
#
# No docker CLI or host socket needed here anymore: motis is reached over
# HTTP via MOTIS_REIMPORT_URL (see commands.ts), and the map tile stack
# (orm-*) is its own Coolify app with its own memory budget now, not
# something this container needs to stop/start to free RAM for the import.
set -eu

cd /app/services/etl
pnpm tsx src/index.ts timetable

echo "Syncing DTD fares from SFTP…"
pnpm tsx src/index.ts fares

echo "Syncing Network Rail reference files from SFTP…"
if [ -n "${NR_INGEST_URL:-}" ] && [ -n "${NR_INGEST_INTERNAL_KEY:-}" ]; then
  curl -sf -X POST -H "x-internal-key: $NR_INGEST_INTERNAL_KEY" "$NR_INGEST_URL/reference-sftp"
else
  echo "  NR_INGEST_URL/NR_INGEST_INTERNAL_KEY not set — skipping."
fi

echo "Syncing Network Rail Track Model from SFTP…"
pnpm tsx src/index.ts track-model-sftp

echo "Syncing National Rail Knowledgebase station facilities…"
pnpm tsx src/index.ts kb-facilities

echo "Syncing National Rail Knowledgebase TOC reference data…"
pnpm tsx src/index.ts kb-tocs
