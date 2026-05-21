-- Corrige os settings_key das variáveis do template Clinicorp Dental.
-- Os valores anteriores usavam nomes em português (assistente_nome, clinica_nome)
-- que não correspondem aos campos reais de agent.settings (SETTINGS_FIELDS no front-end).
--
-- Mapeamento correto:
--   NOME_ASSISTENTE      → assistant_name
--   CARGO_ASSISTENTE     → assistant_role
--   NOME_CLINICA         → company_name
--   NOME_MEDICO_PRINCIPAL→ doctor_name
--   ENDERECO_CLINICA     → company_address
--   HORARIOS_FUNCIONAMENTO→ business_hours
--   DIFERENCIAIS_CLINICA → featured_services
--   FORMAS_PAGAMENTO     → payment_methods
--   TELEFONES_CLINICA    → notification_phone

UPDATE public.prompt_templates
SET variables = '[
  {"key":"NOME_ASSISTENTE","label":"Nome do assistente virtual","placeholder":"ex: Mariana","type":"text","required":true,"settings_key":"assistant_name"},
  {"key":"CARGO_ASSISTENTE","label":"Cargo / função do assistente","placeholder":"ex: consultora de relacionamento","type":"text","required":true,"settings_key":"assistant_role"},
  {"key":"NOME_CLINICA","label":"Nome da clínica","placeholder":"ex: Clínica Odontológica Bomfim","type":"text","required":true,"settings_key":"company_name"},
  {"key":"NOME_MEDICO_PRINCIPAL","label":"Nome do médico responsável pela consulta de diagnóstico","placeholder":"ex: Dr. Milton Galvão","type":"text","required":true,"settings_key":"doctor_name"},
  {"key":"ENDERECO_CLINICA","label":"Endereço completo da clínica","placeholder":"ex: Av. Geremário Dantas, 328, Loja A – Jacarepaguá/RJ","type":"text","required":true,"settings_key":"company_address"},
  {"key":"HORARIOS_FUNCIONAMENTO","label":"Horários de funcionamento","placeholder":"ex:\nSeg: 10h às 20h\nTer–Sex: 9h às 20h\nSáb: 9h às 13h\nIntervalo: 12h às 13h","type":"textarea","required":true,"settings_key":"business_hours"},
  {"key":"DURACAO_CONSULTA","label":"Duração média da Consulta de Diagnóstico","placeholder":"ex: 30 minutos","type":"text","required":false},
  {"key":"NOME_MEDICO_SECUNDARIO","label":"Nome do cirurgião / especialista (opcional)","placeholder":"ex: Dr. Thiago Bomfim","type":"text","required":false},
  {"key":"ESPECIALIDADE_SECUNDARIO","label":"Especialidade do médico secundário (opcional)","placeholder":"ex: cirurgião-chefe, especialista em implantes","type":"text","required":false},
  {"key":"DIFERENCIAIS_CLINICA","label":"Diferenciais da clínica (opcional — use 1 por linha)","placeholder":"ex:\n15 anos de história\nLaboratório próprio\nEquipe especializada","type":"textarea","required":false,"settings_key":"featured_services"},
  {"key":"FORMAS_PAGAMENTO","label":"Formas de pagamento aceitas (opcional)","placeholder":"ex: Dinheiro, Pix, cartões de débito e crédito, financiamento","type":"text","required":false,"settings_key":"payment_methods"},
  {"key":"TELEFONES_CLINICA","label":"Telefone(s) da clínica (opcional)","placeholder":"ex: (21) 99107-5313","type":"text","required":false,"settings_key":"notification_phone"},
  {"key":"PONTO_REFERENCIA","label":"Ponto de referência (opcional)","placeholder":"ex: Ao lado do Center Shopping, em frente ao Bradesco","type":"text","required":false}
]'::jsonb
WHERE nome = 'Agente Odontológico — Clinicorp';
