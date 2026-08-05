FROM node:22-alpine AS builder
RUN npm install -g pnpm@11
WORKDIR /app
ENV DATABASE_URL=postgres://mainline:mainline@localhost:5432/mainline
ENV BETTER_AUTH_SECRET=build-time-placeholder-not-used-at-runtime-32chars
ENV BETTER_AUTH_URL=http://localhost:3000
ARG NEXT_PUBLIC_TILES_URL=
ENV NEXT_PUBLIC_TILES_URL=$NEXT_PUBLIC_TILES_URL
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY services ./services
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter web...
RUN pnpm exec turbo build --filter=web
# Next's standalone output only traces what the running server imports —
# migrate.js is a separate script the server never calls, so drizzle-orm/
# postgres never make it into .next/standalone/node_modules on their own.
# A self-contained prod install of just @mainline/db (with its own
# node_modules) sidesteps guessing which pnpm symlinks are safe to copy
# piecemeal across build stages.
RUN pnpm deploy --filter @mainline/db --prod --legacy /app/db-deploy

FROM node:22-alpine AS runner
RUN apk add --no-cache docker-cli
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/db-deploy ./packages/db
COPY apps/web/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "apps/web/server.js"]
