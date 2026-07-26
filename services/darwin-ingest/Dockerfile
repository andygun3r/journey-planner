FROM node:22-alpine
RUN npm install -g pnpm@11
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/darwin-ingest ./services/darwin-ingest
RUN pnpm install --frozen-lockfile --filter @mainline/darwin-ingest...
RUN pnpm exec turbo build --filter=@mainline/darwin-ingest^...
WORKDIR /app/services/darwin-ingest
CMD ["pnpm", "tsx", "src/index.ts"]
