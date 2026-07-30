#!/bin/sh
# Reimport the refreshed GTFS into MOTIS, then restart it to serve the new data.
#
# MOTIS has no live-reload API. `motis server` only ever serves whatever is
# already preprocessed under /data/data, so a restart on its own does NOT pick
# up a new GTFS zip — the import has to run first. Every caller must do both,
# which is why this lives in one script instead of being repeated.
#
# The import runs as its OWN throwaway container, not `docker exec` into the
# serving one. Two reasons:
#
#   1. Memory. Preprocessing the GB-wide dataset is the heaviest step in the
#      whole pipeline. Run via exec, it shared the serving container's memory
#      cgroup with the live server process — so the server's own footprint ate
#      into the import's budget, and a limit sized for serving would kill the
#      import.
#   2. Isolation. A crashing import can no longer take the serving process down
#      with it.
#
# Needs the docker CLI and the host socket (see docker-compose.yml).
set -eu

MOTIS_CONTAINER="${MOTIS_CONTAINER_NAME:-mainline-motis-1}"
MOTIS_IMAGE="${MOTIS_IMAGE:-ghcr.io/motis-project/motis:latest}"

# Reuse the serving container's volumes so the import writes to the same place
# it reads from. --volumes-from keeps this correct even if the volume names are
# prefixed by the deploy tool (Coolify renames compose projects).
echo "Reimporting GTFS into MOTIS (separate container)…"
docker run --rm \
  --volumes-from "$MOTIS_CONTAINER" \
  ${MOTIS_IMPORT_MEMORY:+--memory "$MOTIS_IMPORT_MEMORY"} \
  -w /data \
  "$MOTIS_IMAGE" \
  /motis import -d /data/data -c /data/config.yml

echo "Reimport done — restarting $MOTIS_CONTAINER to serve the new data"
docker restart "$MOTIS_CONTAINER"
