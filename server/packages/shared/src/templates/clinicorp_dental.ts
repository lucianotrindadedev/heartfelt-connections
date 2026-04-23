/**
 * Template extraído dos fluxos n8n 01/06/07/08.
 * O `default_prompt` deve ser preenchido com o conteúdo do nó "Agent" do fluxo 01.
 */
export const clinicorpDental = {
  key: "clinicorp_dental",
  label: "Clínica odontológica (Clinicorp)",
  required_integrations: ["helena_crm", "clinicorp", "evolution_api"] as const,
  optional_integrations: ["google_drive", "elevenlabs", "central360", "groq"] as const,
  default_tools: [
    "escalar_humano",
    "enviar_midia",
    "buscar_ou_criar_contato",
    "buscar_agendamentos",
    "criar_agendamento",
    "cancelar_agendamento",
    "listar_arquivos",
    "refletir",
  ],
  default_prompt: `Você é a Sarai, atendente virtual da clínica. ...`, // TODO: colar do fluxo 01
  followup_defaults: {
    cron: "*/10 8-21 * * *",
    max: 3,
    prompts: [
      "Olá! Vi que você ficou sem responder. Posso te ajudar a agendar?",
      "Continuo por aqui caso queira retomar — me chama!",
      "Vou encerrar por enquanto. Quando quiser, é só chamar :)",
    ],
  },
  warmup_defaults: {
    wu1: 96,
    wu2: 72,
    wu3: 48,
    wu4: 24,
    wu5: 2,
    prompts: {
      wu1: "Oi! Confirmando seu agendamento daqui a 4 dias.",
      wu2: "Faltam 3 dias para sua consulta — tudo certo?",
      wu3: "Lembrete: sua consulta é em 2 dias.",
      wu4: "Amanhã é o dia! Posso te enviar o endereço?",
      wu5: "Sua consulta é daqui a 2h. Te aguardamos!",
    },
  },
  automations: [
    {
      trigger: "tag_changed",
      conditions: { tag: "FUF Financeiro" },
      actions: [{ type: "pause_ai" }],
    },
  ],
} as const;
