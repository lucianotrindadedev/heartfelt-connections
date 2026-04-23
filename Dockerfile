# ---------- Stage 1: build ----------
FROM oven/bun:1.1-alpine AS builder

WORKDIR /app

# Instala dependências usando o lockfile do Bun (consistente no repo)
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

# Copia o restante do projeto e faz o build estático (SPA)
COPY . .

# A URL da API é injetada no bundle em build-time via VITE_API_URL
ARG VITE_API_URL=https://yyggvih3qzox0cl5jbftnvf2.72.62.104.184.sslip.io
ENV VITE_API_URL=$VITE_API_URL
ENV BUILD_TARGET=static
ENV NODE_ENV=production

RUN bun run build

# ---------- Stage 2: runtime ----------
FROM nginx:1.27-alpine AS runtime

# Configuração com fallback de SPA para o index.html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Saída do build (TanStack Start static => .output/public)
# Fallback para dist caso o output mude.
COPY --from=builder /app/.output/public /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
