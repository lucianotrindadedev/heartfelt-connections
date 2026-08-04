-- Clinic Experts multi-unidade: mesma semântica do array `agendas` do Google
-- Calendar (migração 0033). Um cliente com VÁRIAS contas do Clinic Experts (uma
-- por localidade) atende numa central única: o agente pergunta a localidade e
-- agenda na conta certa.
--
-- Semântica de `unidades`:
--   []        → campos top-level (api_token_enc/procedure/professionals) como
--               hoje — contas existentes seguem intactas;
--   1 item    → a unidade é a fonte da config, SEM parâmetro novo pro LLM;
--   2+ itens  → o agente recebe o parâmetro `agenda` (enum dos labels, o MESMO
--               do multi-agenda GCal) e trava a unidade na conversa
--               (lead_data.selected_agenda).
--
-- Item: { "uid": "u_...", "label": "Recreio", "descricao": "...",
--         "api_token_enc": "<encryptValue>", "procedure_id": 123,
--         "procedure_name": "Avaliação", "duracao_consulta": 40,
--         "professionals": [{ "uuid", "name", "duracao_minutos",
--                             "business_hours_json" }] }
-- `uid` é estável (gerado no cliente) e existe só pro merge do token no save —
-- renomear o label não pode perder o api_token_enc.

alter table public.clinic_experts_config
  add column if not exists unidades jsonb not null default '[]'::jsonb;

comment on column public.clinic_experts_config.unidades is
  'Unidades [{uid,label,descricao,api_token_enc,procedure_id,procedure_name,duracao_consulta,professionals[]}]. Vazio = config top-level (uma unidade).';
