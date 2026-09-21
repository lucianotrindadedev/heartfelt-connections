# iasaraie7 — deploy Coolify (Node 22, processo persistente)
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Coolify pode injetar NODE_ENV=production — NPM_CONFIG_PRODUCTION=false ainda instala devDeps (vite, esbuild)
ENV NPM_CONFIG_PRODUCTION=false

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .

# Commit do deploy. A Coolify passa SOURCE_COMMIT como build arg, mas um build
# arg só existe dentro do build se for DECLARADO com ARG — sem estas linhas ele
# nunca chegava ao build:coolify e /api/health respondia commit="unknown".
# O fallback `git rev-parse` do build-vercel.mjs também não salva: .git está no
# .dockerignore E a imagem slim não tem o binário do git. Declarar aqui é o
# único caminho. Fica DEPOIS do npm ci para não invalidar a camada de deps.
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT

# Somente VITE_* devem ser build args na Coolify (não CRON_SECRET, PGCRYPTO, etc.)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY

# Vite/SSR deve emitir jsx (production), não jsxDEV — senão o runtime em NODE_ENV=production quebra
ENV NODE_ENV=production
RUN npm run build:coolify

# Após o build, remove as devDependencies (vite, esbuild, typescript...) IN-PLACE.
# jsdom/pdf-parse estão em "dependencies" e sobrevivem ao prune — são os únicos que
# o runtime precisa (o bundle os externaliza). Evita um SEGUNDO `npm ci` (estágio
# proddeps anterior), que dobrava disco/memória no build e podia estourar a VPS.
RUN npm prune --omit=dev

# ── runtime ──
FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Também no runtime: se o define do esbuild falhar, /api/health ainda acha o
# commit por aqui. ARG não atravessa estágio — precisa ser redeclarado.
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT

COPY --from=builder /app/.vercel/output ./.vercel/output
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/scripts/start-coolify.cjs ./scripts/start-coolify.cjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/start-coolify.cjs"]
