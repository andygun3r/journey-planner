#!/usr/bin/env bash
# Stops everything started by dev-up.sh.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PID_FILE=.dev-logs/pids

if [ -f "$PID_FILE" ]; then
  echo "==> Stopping web, darwin-ingest, nr-ingest (and their child processes)"
  while read -r pid; do
    [ -n "$pid" ] && kill -- "-$pid" 2>/dev/null
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

# Belt-and-braces: pnpm/next reparent children outside the process group in
# some cases, so the kill above can miss them. Sweep by command pattern too.
sleep 1
pkill -f "next dev" 2>/dev/null
pkill -f "next-server" 2>/dev/null
pkill -f "\-\-import tsx src/index.ts" 2>/dev/null
true

echo "==> Stopping postgres + redis"
docker compose stop postgres redis

echo "Done."
