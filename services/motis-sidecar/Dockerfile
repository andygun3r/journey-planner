# docker-cli + the host socket (mounted at deploy time) let this trigger
# `motis import` + restart on its sibling motis container — see src/index.ts.
FROM node:22-alpine
RUN apk add --no-cache docker-cli && npm install -g pnpm@11
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY services/motis-sidecar ./services/motis-sidecar
RUN pnpm install --frozen-lockfile --filter @signaller/motis-sidecar...
RUN pnpm exec turbo build --filter=@signaller/motis-sidecar...
WORKDIR /app/services/motis-sidecar
CMD ["node", "dist/index.js"]
