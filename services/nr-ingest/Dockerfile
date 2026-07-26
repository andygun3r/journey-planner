FROM node:22-alpine
RUN npm install -g pnpm@11
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/nr-ingest ./services/nr-ingest
RUN pnpm install --frozen-lockfile --filter @mainline/nr-ingest...
RUN pnpm exec turbo build --filter=@mainline/nr-ingest^...
WORKDIR /app/services/nr-ingest
CMD ["pnpm", "tsx", "src/index.ts"]
