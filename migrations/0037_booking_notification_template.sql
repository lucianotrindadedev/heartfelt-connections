-- 0037 — Notificação de agendamento configurável pela UI admin.
--
-- Cada agente passa a poder definir:
--   * o TEMPLATE da mensagem (Markdown WhatsApp com {{variáveis}});
--   * a INSTRUÇÃO para o LLM que gera o {{resumo}};
--   * se o resumo IA deve ser GERADO ou não (economiza tokens quando off).
--
-- Defaults NULL/true preservam o comportamento atual: quem nunca configurou
-- continua recebendo a mensagem antiga renderizada pelo template hardcoded.

alter table public.agent_escalation
  add column if not exists notification_template text,
  add column if not exists notification_summary_enabled boolean not null default true,
  add column if not exists notification_summary_instruction text;

comment on column public.agent_escalation.notification_template is
  'Template Markdown WhatsApp com {{variaveis}} (nome, telefone, data, hora, evento, tipo_consulta, agenda, interesse, observacoes, resumo, agente, empresa, dia_semana, data_hora, cf.<chave>). NULL = usa default do codigo.';
comment on column public.agent_escalation.notification_summary_enabled is
  'Se false, nao chama o LLM para gerar o {{resumo}} (economiza tokens). Quando false, {{resumo}} renderiza vazio.';
comment on column public.agent_escalation.notification_summary_instruction is
  'Instrucao PT-BR para o LLM que gera o {{resumo}}. NULL = usa o prompt default.';
