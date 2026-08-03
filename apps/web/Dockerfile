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

FROM node:22-alpine AS runner
RUN apk add --no-cache docker-cli
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/packages/db/package.json ./packages/db/package.json
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/migrations ./packages/db/migrations
COPY apps/web/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "apps/web/server.js"]
