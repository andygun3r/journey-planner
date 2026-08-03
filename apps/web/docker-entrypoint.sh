#!/bin/sh
set -eu

if [ "${RUN_DB_MIGRATIONS:-}" = "1" ] || [ "${RUN_DB_MIGRATIONS:-}" = "true" ]; then
  echo "[web] applying database migrations"
  node packages/db/dist/migrate.js
else
  echo "[web] skipping database migrations"
fi

exec "$@"
