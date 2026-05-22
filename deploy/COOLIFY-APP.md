# Deploy iasaraie7 na Coolify

## Pré-requisitos na VPS

- Postgres `iasarai-db` (migrations já aplicadas)
- Redis (opcional por enquanto — app ainda usa fila no Postgres)
- Stack Supabase com **Kong/PostgREST** para API (`SELFHOST_SUPABASE_URL`) — o Postgres 17 sozinho não basta

## 1. Criar Application

Coolify → **+ New Resource** → **Application**

| Campo | Valor |
|--------|--------|
| Source | GitHub (repo `iasaraie7`) ou upload |
| Branch | `main` |
| Build Pack | **Dockerfile** |
| Dockerfile | `/Dockerfile` (raiz) |
| Port exposes | `3000` |
| Domain | domínio gerado pela Coolify (HTTPS) |

## 2. Rede

Na app, conecte à **mesma rede** dos serviços `iasarai-db` e Redis (Coolify → Network).

## 3. Variáveis de ambiente

**Runtime** (Environment Variables):

```env
NODE_ENV=production
PORT=3000

APP_BASE_URL=https://SEU-DOMINIO-DA-APP.sslip.io
CRON_SECRET=<string longa>

SELFHOST_SUPABASE_URL=https://db.72.62.104.184.sslip.io
SELFHOST_SUPABASE_SERVICE_ROLE_KEY=...
SELFHOST_SUPABASE_ANON_KEY=...

PGCRYPTO_KEY=...
```

**Build** (Build Arguments / Docker Build Args — obrigatório para o login no painel):

```env
VITE_SUPABASE_URL=https://db.72.62.104.184.sslip.io
VITE_SUPABASE_PUBLISHABLE_KEY=<anon key>
```

Redis: a app ainda não usa Redis no código; pode subir `REDIS_URL` depois.

## 4. Deploy

Clique **Deploy**. Build roda `npm run build:vercel` dentro do Docker (~3–5 min).

Teste: abra `https://SEU-DOMINIO/` → tela de login.

## 5. Webhook Helena

```
https://SEU-DOMINIO/api/public/webhook/helena/8b8c63cf-c6d3-4e78-b2df-6fbbc732fb1b
```

## 6. Cron no Postgres (opcional)

No container `iasarai-db`:

```sql
ALTER DATABASE postgres SET app.base_url = 'https://SEU-DOMINIO-DA-APP';
ALTER DATABASE postgres SET app.cron_secret = '<CRON_SECRET>';
```

Depois rode `migrations/0005_cron_update.sql`.

## 7. Desligar Vercel

Quando Coolify estiver estável, pare deploy em `iasarai.vercel.app`.
