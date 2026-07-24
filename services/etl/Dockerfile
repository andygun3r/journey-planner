# node:22 for pnpm 11; dtd2mysql is old but plain CJS and runs here — if it
# ever breaks, split it into its own stage with an older Node.
FROM node:22-alpine
RUN apk add --no-cache zip unzip && npm install -g pnpm@11 dtd2mysql
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/etl ./services/etl
RUN pnpm install --frozen-lockfile --filter @mainline/etl...
WORKDIR /app/services/etl
ENTRYPOINT ["pnpm", "tsx", "src/index.ts"]
CMD ["timetable"]
