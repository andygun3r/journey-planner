# node:22 for pnpm 11; dtd2mysql is old but plain CJS and runs here — if it
# ever breaks, split it into its own stage with an older Node.
# docker-cli: etl-cron restarts the motis container after a successful
# nightly import (see cron/run-and-reload-motis.sh) — needs the host's
# docker socket mounted in, see docker-compose.yml's etl-cron service.
FROM node:22-alpine
RUN apk add --no-cache zip unzip dcron docker-cli && npm install -g pnpm@11 dtd2mysql
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/etl ./services/etl
RUN pnpm install --frozen-lockfile --filter @mainline/etl... \
  && chmod +x services/etl/cron/run-and-reload-motis.sh
COPY services/etl/cron/timetable-daily /etc/crontabs/root
WORKDIR /app/services/etl

# Two ways to run this image:
#   docker compose --profile etl run --rm etl timetable   (one-off, exits when done)
#   docker compose up -d etl-cron                          (long-running, fires nightly per crontab)
ENTRYPOINT ["pnpm", "tsx", "src/index.ts"]
CMD ["timetable"]
