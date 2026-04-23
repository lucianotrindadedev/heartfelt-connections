FROM oven/bun:1.1-alpine AS base
WORKDIR /app
COPY package.json bun.lockb* ./
COPY packages/shared/package.json packages/shared/
COPY packages/panel-api/package.json packages/panel-api/
RUN bun install --frozen-lockfile || bun install
COPY packages/shared packages/shared
COPY packages/panel-api packages/panel-api
ENV NODE_ENV=production SVC_NAME=panel-api
EXPOSE 8787
CMD ["bun", "packages/panel-api/src/server.ts"]
