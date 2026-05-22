# iasaraie7 — deploy Coolify (Node 22, processo persistente)
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Coolify pode injetar NODE_ENV=production — NPM_CONFIG_PRODUCTION=false ainda instala devDeps (vite, esbuild)
ENV NPM_CONFIG_PRODUCTION=false

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .

# Somente VITE_* devem ser build args na Coolify (não CRON_SECRET, PGCRYPTO, etc.)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY

# Vite/SSR deve emitir jsx (production), não jsxDEV — senão o runtime em NODE_ENV=production quebra
ENV NODE_ENV=production
RUN npm run build:vercel

# ── runtime ──
FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/.vercel/output ./.vercel/output
COPY --from=builder /app/scripts/start-coolify.cjs ./scripts/start-coolify.cjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/start-coolify.cjs"]
