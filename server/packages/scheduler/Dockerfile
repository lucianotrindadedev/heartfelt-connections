FROM oven/bun:1.1-alpine
WORKDIR /app
COPY package.json bun.lockb* ./
COPY packages/shared/package.json packages/shared/
COPY packages/scheduler/package.json packages/scheduler/
RUN bun install --frozen-lockfile || bun install
COPY packages/shared packages/shared
COPY packages/scheduler packages/scheduler
ENV NODE_ENV=production SVC_NAME=scheduler
CMD ["bun", "packages/scheduler/src/index.ts"]
