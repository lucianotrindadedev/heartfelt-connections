#!/usr/bin/env bash
# Somente leitura — lista Postgres/Supabase na VPS sem alterar nada.
set -euo pipefail

echo "=============================================="
echo " DISCOVERY — Postgres / Supabase (read-only)"
echo " Host: $(hostname)  Date: $(date -Is)"
echo "=============================================="
echo

echo "--- Todos os containers (postgres/supabase no nome ou imagem) ---"
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' \
  | grep -iE 'postgres|supabase|NAME' || echo "(nenhum)"

echo
echo "--- Candidato iasarai-db (imagem 17.4.x + porta host 3000->5432) ---"
CANDIDATES=$(docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}' \
  | grep -E 'supabase/postgres:17' | grep '0.0.0.0:3000->5432' || true)

if [ -z "$CANDIDATES" ]; then
  echo "Nenhum container com supabase/postgres:17 E mapeamento 3000:5432."
  echo "Listando TODOS supabase/postgres:17:"
  docker ps --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}' \
    | grep -E 'supabase/postgres' || echo "(nenhum)"
else
  echo "$CANDIDATES"
  CID=$(echo "$CANDIDATES" | head -1 | cut -f1)
  echo
  echo "--- Teste de conexão no candidato $CID ---"
  docker exec "$CID" psql -U postgres -d postgres -c "SELECT version();" 2>/dev/null || echo "Falha psql"
  echo
  echo "--- Tabelas public existentes (se houver) ---"
  docker exec "$CID" psql -U postgres -d postgres -c \
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1 LIMIT 30;" 2>/dev/null || true
  echo
  echo ">>> Para migrar SOMENTE este container:"
  echo "    export IASARAI_DB_CONTAINER=$CID"
  echo "    bash scripts/vps/02-run-migrations.sh"
fi

echo
echo "--- Outros Postgres (NÃO usar para iasarai sem confirmar) ---"
docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}' \
  | grep -i postgres | grep -v 'supabase/postgres:17' || echo "(nenhum extra)"

echo
echo "Discovery concluído. Nenhuma alteração foi feita."
