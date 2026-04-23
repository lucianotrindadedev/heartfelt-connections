FROM oven/bun:1.1-alpine
WORKDIR /app
COPY package.json bun.lockb* ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
RUN bun install --frozen-lockfile || bun install
COPY packages/shared packages/shared
COPY packages/engine packages/engine
ENV NODE_ENV=production SVC_NAME=engine
EXPOSE 8788
CMD ["bun", "packages/engine/src/server.ts"]
