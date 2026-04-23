FROM oven/bun:1.2.21-debian AS base
WORKDIR /app
COPY package.json bun.lockb* ./
COPY packages/shared/package.json packages/shared/
COPY packages/panel-api/package.json packages/panel-api/
RUN bun install --frozen-lockfile || bun install
COPY packages/shared packages/shared
COPY packages/panel-api packages/panel-api
ENV NODE_ENV=production SVC_NAME=panel-api
EXPOSE 8787
# Roda migrations automaticamente se RUN_MIGRATIONS=true (default true)
CMD ["sh", "-c", "if [ \"${RUN_MIGRATIONS:-true}\" = \"true\" ]; then bun packages/shared/src/db/migrate.ts; fi && bun packages/panel-api/src/server.ts"]
