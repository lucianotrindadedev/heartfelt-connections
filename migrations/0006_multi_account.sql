-- 0006_multi_account.sql
-- Desacopla o ID interno da conta Sarai do ID da conta no CRM Helena.
-- Permite múltiplos agentes Sarai (contas internas) por conta Helena CRM.

-- Adiciona coluna que armazena o ID real da conta no Helena (pode repetir).
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS helena_account_id text;

-- Contas existentes: o accounts.id ERA o id_conta do Helena — copia o valor.
UPDATE public.accounts
  SET helena_account_id = id
  WHERE helena_account_id IS NULL;

-- Índice para buscas por conta Helena (embed selector, webhook routing).
CREATE INDEX IF NOT EXISTS idx_accounts_helena_account_id
  ON public.accounts (helena_account_id);
