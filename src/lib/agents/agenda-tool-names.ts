// Nomes aceitos para a consulta de horários da agenda.
//
// A tool exposta ao modelo se chama `listar_horarios`, mas prompts de
// proprietário escritos na época do n8n citam o nome por provedor
// (`listar_horarios_clinicorp` etc.). O scheduler já aceitava esses apelidos;
// o qualifier não — e o modelo, lendo no prompt um nome que não existe na lista
// de tools dele, concluía que não tinha agenda. Caso real (Clínica Bomfim,
// @andersonavelar310.aa, 17/10): "Consigo te ajudar, Anderson, mas agora não
// tenho acesso à agenda por aqui." — com o Clinicorp ativo e a tool disponível.

/** Nome canônico (o que vai para `tools_called`). */
export const AGENDA_LISTING_TOOL = "listar_horarios";

export const AGENDA_LISTING_TOOL_NAMES = new Set([
  AGENDA_LISTING_TOOL,
  "listar_horarios_clinicorp",
  "listar_horarios_google_calendar",
  "listar_horarios_clinup",
  "clinup_buscar_horarios",
  "listar_horarios_clinic_experts",
]);

export function isAgendaListingTool(name: string | null | undefined): boolean {
  return AGENDA_LISTING_TOOL_NAMES.has((name ?? "").trim());
}

/** Frase para a descrição da tool: o modelo liga o nome do prompt ao nome real. */
export const AGENDA_TOOL_ALIASES_NOTE =
  "Se o prompt do proprietário citar listar_horarios_clinicorp, listar_horarios_google_calendar, " +
  "listar_horarios_clinup ou listar_horarios_clinic_experts, é ESTA tool. " +
  "Você TEM acesso à agenda — nunca diga ao lead que não tem acesso à agenda ou que não consegue ver horários.";
