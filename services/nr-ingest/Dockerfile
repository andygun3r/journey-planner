FROM node:22-alpine
RUN npm install -g pnpm@11
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/nr-ingest ./services/nr-ingest
RUN pnpm install --frozen-lockfile --filter @mainline/nr-ingest...
# Build the service too, not only its dependencies — the `^` here meant
# "dependencies of, excluding itself", which left this running from source.
RUN pnpm exec turbo build --filter=@mainline/nr-ingest...
WORKDIR /app/services/nr-ingest
# Compiled output, not tsx. tsx transpiles at startup and keeps the
# compiler resident for the life of the process — pointless for a daemon
# that is built during the image build anyway.
CMD ["node", "dist/index.js"]
