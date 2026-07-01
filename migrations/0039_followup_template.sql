-- 0039_followup_template.sql
-- Template oficial (HSM) por step de follow-up, usado quando o disparo cai
-- FORA da janela de 24h do WhatsApp (ex.: retorno agendado "me chama amanhã").
--
-- Dentro de 24h da última mensagem do lead → texto livre (mode message/contextual).
-- Fora de 24h → o WhatsApp só entrega template aprovado; o cron usa este nome
-- para resolver o templateId via findHelenaTemplateByName e enviar via HSM.
-- Vazio = sem fallback (fora de 24h o step é pulado, pois texto livre não entrega).

alter table followup_steps
  add column if not exists helena_template_name text;
