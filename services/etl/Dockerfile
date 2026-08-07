# node:22 for pnpm 11; dtd2mysql is old but plain CJS and runs here — if it
# ever breaks, split it into its own stage with an older Node.
# curl: the nightly cron script pings nr-ingest's HTTP endpoint for reference
# file sync (see cron/run-and-reload-motis.sh) — no docker CLI or host socket
# needed here anymore, motis reimport now goes over HTTP to its own sidecar
# (see src/motis-reimport.ts).
FROM node:22-alpine
RUN apk add --no-cache zip unzip dcron curl && npm install -g pnpm@11 dtd2mysql
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/etl ./services/etl
RUN pnpm install --frozen-lockfile --filter @signaller/etl... \
  && chmod +x services/etl/cron/run-and-reload-motis.sh
RUN pnpm exec turbo build --filter=@signaller/etl^...
COPY services/etl/cron/timetable-daily /etc/crontabs/root
WORKDIR /app/services/etl

# Downloaded feed archives (ETL_ARCHIVE_DIR) and exported GTFS
# (ETL_GTFS_OUT_DIR) both live under /data by default — this must be backed
# by a real persistent volume in Coolify's Storages tab (destination
# /data), not just this declaration. Without one, every redeploy of this
# app wipes /data and any in-progress or not-yet-uploaded archive with it —
# the VOLUME instruction alone doesn't give Coolify a stable volume to
# reattach across redeploys.
VOLUME ["/data"]

# Two ways to run this image:
#   docker run --rm etl timetable                     (one-off CLI command)
#   HTTP_PORT=4000 ETL_CRON=1 docker run etl server    (the etl-cron Coolify
#     app — starts crond for the nightly sweep as a child process, plus the
#     internal HTTP server web calls on demand; see src/server.ts)
EXPOSE 4000
ENTRYPOINT ["pnpm", "tsx", "src/index.ts"]
CMD ["timetable"]
