#!/usr/bin/env bash
# Starts the full local stack: postgres, redis, web, darwin-ingest, nr-ingest.
# MOTIS and the ETL are excluded on purpose — MOTIS needs GTFS output to exist
# first, and the ETL is run-to-completion, not part of a normal dev session.
#
# postgres/redis run as plain named containers (mainline-dev-postgres/-redis),
# not docker compose — production is per-service Coolify apps now, so this
# script is the only place docker-compose-style local infra still lives, and
# even that's now just plain `docker run`.
set -euo pipefail
set -m  # each background job gets its own process group, so dev-down.sh can kill the whole tree
cd "$(dirname "${BASH_SOURCE[0]}")/.."

LOG_DIR=.dev-logs
PID_FILE=.dev-logs/pids
mkdir -p "$LOG_DIR"
: > "$PID_FILE"

PG_CONTAINER=mainline-dev-postgres
REDIS_CONTAINER=mainline-dev-redis

start_container_if_missing() {
  local name="$1"; shift
  if [ -z "$(docker ps -aq -f name="^${name}\$")" ]; then
    echo "==> Creating $name"
    docker run -d --name "$name" "$@"
  elif [ -z "$(docker ps -q -f name="^${name}\$")" ]; then
    echo "==> Starting existing $name"
    docker start "$name" >/dev/null
  else
    echo "==> $name already running"
  fi
}

start_container_if_missing "$PG_CONTAINER" \
  -p 5434:5432 \
  -e POSTGRES_USER=mainline -e POSTGRES_PASSWORD=mainline -e POSTGRES_DB=mainline \
  -v mainline-dev-pgdata:/var/lib/postgresql/data \
  postgres:17-alpine

start_container_if_missing "$REDIS_CONTAINER" \
  -p 6380:6379 \
  redis:8-alpine

echo "==> Waiting for postgres + redis health checks"
until docker exec "$PG_CONTAINER" pg_isready -U mainline >/dev/null 2>&1 \
   && docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1; do
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
