FROM node:22-alpine
RUN npm install -g pnpm@11
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/nr-ingest ./services/nr-ingest
RUN pnpm install --frozen-lockfile --filter @signaller/nr-ingest...
# Build the service too, not only its dependencies — the `^` here meant
# "dependencies of, excluding itself", which left this running from source.
RUN pnpm exec turbo build --filter=@signaller/nr-ingest...
WORKDIR /app/services/nr-ingest
# Compiled output, not tsx. tsx transpiles at startup and keeps the
# compiler resident for the life of the process — pointless for a daemon
# that is built during the image build anyway.
#
# Set HTTP_PORT to also start the internal server web calls for on-demand
# reference-sftp sync (see src/server.ts) — no separate nr-reference-sync
# image needed anymore, that job is an endpoint on this same daemon now.
EXPOSE 4001
CMD ["node", "dist/index.js"]
