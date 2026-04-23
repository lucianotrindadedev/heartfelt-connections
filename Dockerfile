# ---------- Stage 1: build (Bun + Node 22 LTS) ----------
# Usamos a imagem oficial do Bun baseada em Debian, fixada em uma versão
# recente cujo Node embutido satisfaz o requisito do Vite (>= 22.12).
FROM oven/bun:1.2.21-debian AS builder

WORKDIR /app

# Lockfile do Bun fica consistente com o package.json
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

COPY . .

# A URL da API é injetada no bundle em build-time via VITE_API_URL
ARG VITE_API_URL=https://yyggvih3qzox0cl5jbftnvf2.72.62.104.184.sslip.io
ENV VITE_API_URL=$VITE_API_URL
ENV BUILD_TARGET=static
ENV NODE_ENV=production

RUN bun run build

# TanStack Start (target=static) gera o shell SPA em dist/client/_shell.html.
# Renomeia para index.html para o Nginx servir como fallback de SPA.
RUN cp /app/dist/client/_shell.html /app/dist/client/index.html

# ---------- Stage 2: runtime (Nginx) ----------
FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist/client /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
