#!/usr/bin/env bash
# Starts the full local stack: postgres, redis, web, darwin-ingest, nr-ingest.
# MOTIS and the ETL are excluded on purpose — MOTIS needs GTFS output to exist
# first, and the ETL is run-to-completion, not part of a normal dev session.
set -euo pipefail
set -m  # each background job gets its own process group, so dev-down.sh can kill the whole tree
cd "$(dirname "${BASH_SOURCE[0]}")/.."

LOG_DIR=.dev-logs
PID_FILE=.dev-logs/pids
mkdir -p "$LOG_DIR"
: > "$PID_FILE"

echo "==> Starting postgres + redis"
docker compose up -d postgres redis

echo "==> Waiting for postgres + redis health checks"
until [ "$(docker compose ps -q postgres | xargs docker inspect -f '{{.State.Health.Status}}')" = "healthy" ] \
   && [ "$(docker compose ps -q redis | xargs docker inspect -f '{{.State.Health.Status}}')" = "healthy" ]; do
  sleep 1
done

ROOT="$(pwd)"

start_bg() {
  local name="$1"; shift
  echo "==> Starting $name"
  "$@" > "$ROOT/$LOG_DIR/$name.log" 2>&1 &
  echo $! >> "$ROOT/$PID_FILE"
}

start_bg web pnpm --filter web dev
start_bg darwin-ingest bash -c "cd services/darwin-ingest && exec node --env-file=$ROOT/.env --import tsx src/index.ts"
start_bg nr-ingest bash -c "cd services/nr-ingest && exec node --env-file=$ROOT/.env --import tsx src/index.ts"

echo
echo "All services started. Logs in $LOG_DIR/, PIDs in $PID_FILE."
echo "Web:    http://localhost:3000"
echo "Health: curl localhost:3000/api/health"
echo "Stop:   pnpm dev:down"
