#!/usr/bin/env bash
# Aplica migrations do iasaraie7 APENAS no container confirmado.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$REPO_ROOT/migrations}"

if [ -z "${IASARAI_DB_CONTAINER:-}" ]; then
  echo "ERRO: defina IASARAI_DB_CONTAINER com o ID do container iasarai-db."
  echo "Rode antes: bash scripts/vps/01-discover-databases.sh"
  exit 1
fi

if [ "${MIGRATE_CONFIRM:-}" != "yes-iasarai-db" ]; then
  echo "ERRO: confirmação obrigatória."
  echo "  export MIGRATE_CONFIRM=yes-iasarai-db"
  echo "  export IASARAI_DB_CONTAINER=<id>"
  exit 1
fi

CID="$IASARAI_DB_CONTAINER"

# scp do Windows pode criar /tmp/iasarai-migrations/migrations/*.sql
if [ ! -f "$MIGRATIONS_DIR/0001_schema.sql" ] && [ -f "$MIGRATIONS_DIR/migrations/0001_schema.sql" ]; then
  MIGRATIONS_DIR="$MIGRATIONS_DIR/migrations"
fi
if [ ! -f "$MIGRATIONS_DIR/0001_schema.sql" ] && [ -f "/tmp/migrations/0001_schema.sql" ]; then
  MIGRATIONS_DIR="/tmp/migrations"
fi

echo "=============================================="
echo " MIGRATIONS iasaraie7"
echo " Container: $CID"
echo " Image: $(docker inspect -f '{{.Config.Image}}' "$CID")"
echo " Dir: $MIGRATIONS_DIR"
echo "=============================================="

docker inspect -f '{{.Config.Image}}' "$CID" | grep -q 'supabase/postgres:17' \
  || { echo "ABORTADO: imagem não é supabase/postgres:17.x"; exit 1; }

ORDER=(
  0000_bootstrap_roles.sql
  0001_schema.sql
  0002_cron.sql
  0003_user_roles.sql
  0004_tools_integrations.sql
  0006_templates.sql
  0007_template_variables.sql
  0008_fix_templates_schema.sql
  0009_agent_settings.sql
  0010_fix_enc_columns.sql
  0011_clinicorp_dentist.sql
  0012_clinicorp_multi_professional.sql
  0013_template_clinicorp_dental.sql
  0014_fix_template_settings_keys.sql
  0015_multichannel_conversations.sql
  0016_deduplicate_conversations_before_session_index.sql
  0017_agent_stages.sql
)

for f in "${ORDER[@]}"; do
  path="$MIGRATIONS_DIR/$f"
  if [ ! -f "$path" ]; then
    echo "ERRO: arquivo ausente: $path"
    exit 1
  fi
  echo
  echo ">>> Aplicando $f ..."
  docker exec -i "$CID" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$path"
  echo "    OK"
done

echo
echo ">>> Pulando 0005_cron_update.sql (rodar manualmente após APP_BASE_URL na Coolify)"
echo
echo "Migrations base concluídas."
docker exec "$CID" psql -U postgres -d postgres -c \
  "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1;"
