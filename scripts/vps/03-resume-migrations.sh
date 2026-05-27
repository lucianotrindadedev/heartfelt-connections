#!/usr/bin/env bash
# Continua migrations após 0001/0002 OK e falha em 0003+.
set -euo pipefail

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/tmp/iasarai-migrations/migrations}"
CID="${IASARAI_DB_CONTAINER:?defina IASARAI_DB_CONTAINER}"

ORDER=(
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
  echo ">>> $f"
  docker exec -i "$CID" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$MIGRATIONS_DIR/$f"
  echo "    OK"
done

echo "Concluído (0005_cron_update continua manual depois do APP_BASE_URL)."
