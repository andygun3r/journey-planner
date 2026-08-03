#!/bin/sh
set -eu

if [ "${SKIP_DB_MIGRATIONS:-}" = "1" ] || [ "${SKIP_DB_MIGRATIONS:-}" = "true" ]; then
  echo "[web] skipping database migrations"
else
  echo "[web] applying database migrations"
  node packages/db/dist/migrate.js
fi

exec "$@"
