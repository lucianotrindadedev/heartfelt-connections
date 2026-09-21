#!/usr/bin/env bash
# Roda o diag de confirmação em laço e emite UMA linha quando houver veredito.
# Silêncio = nenhum lead chegou a tentar agendar ainda (inconclusivo).
# Uso: bash scripts/diag/vigia-categoria.sh
set -u
cd "$(dirname "$0")/../.." || exit 1
REL="scripts/diag/last-report-categoria-corrigida.txt"

while true; do
  if ! npx vitest run --config scripts/diag/vitest.diag.config.ts \
        scripts/diag/categoria-corrigida.diag.ts >/dev/null 2>&1; then
    echo "FALHA: o diag não rodou (banco/env). Vou tentar de novo no próximo ciclo."
    sleep 300
    continue
  fi

  VEREDITO=$(sed -n '/── veredito ──/,$p' "$REL" | tail -n +2 | head -1)
  case "$VEREDITO" in
    *Inconclusivo*)
      : # sem tentativa de agendamento ainda — não vale notificação
      ;;
    "")
      echo "FALHA: relatório sem linha de veredito — conferir $REL"
      exit 1
      ;;
    *)
      echo "$VEREDITO"
      sed -n '/conversas da Odonto Sorrisos/,/booking_error desde/p' "$REL"
      exit 0
      ;;
  esac
  sleep 300
done
