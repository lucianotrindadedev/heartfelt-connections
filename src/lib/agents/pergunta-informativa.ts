// Pergunta sobre o HORÁRIO DO SERVIÇO (aula, permanência, funcionamento) não é
// pedido de horário de visita/consulta.
//
// Caso real (Amazing CCZ, 44 99761-9505, 30/10/2026): o lead perguntou "os
// valores e os horários disponíveis" e, depois, esclareceu "os horários de
// permanência na escola, se é meio período ou integral". O qualifier chamou a
// agenda de visitas e ofertou "sexta às 13:00 ou 14:00"; com o stage em
// SLOT_OFFER o scheduler — cujas regras só mandavam chamar listar_horarios —
// ofertou visita de novo, com periodo=tarde. O prompt da conta tinha a resposta
// (Regular 7h30–12h, Semi-Integral 7h30–14h50, Integral 7h30–18h) e ela nunca
// foi enviada. Nenhum sinal determinístico disparou: foi decisão do modelo.
//
// Duas camadas: a regra fixa nos prompts (HORARIO_DO_SERVICO_RULE) e, quando o
// detector abaixo reconhece a pergunta na última rajada do lead, um alerta no
// ESTADO ATUAL do turno. PURO: sem I/O.

function normalizar(texto: string): string {
  return (texto ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

// Termos que só aparecem quando o assunto é a rotina/funcionamento do serviço.
// "integral" só no sentido de período escolar: "prótese integral" e "Bronze
// integral 10" (plano odontológico) apareceram na varredura de 60 dias.
const ROTINA_RE =
  /(?:^|\b)(permanencia|meio periodo|meio-periodo|semi[- ]?integral|(?:periodo|horario|turno|o|do|no|pro|para o|e) integral|integral (?:ou|bilingue|da escola)|ou integral|^integral\W*$|horarios? (?:de|da|das|do) (?:aula|aulas|escola|entrada|saida|funcionamento|atendimento|permanencia)|horarios? (?:que|em que) (?:a escola|voces?|a clinica) (?:abre|fecha|funciona|atende)|entrada e (?:a )?saida|que horas? (?:entra|sai|comeca|termina|abre|fecha|funciona)|ate que horas|a partir de que horas|turno da escola|grade horaria|rotina (?:da escola|escolar|das criancas|do aluno|dos alunos))\b/;

// Quando o lead fala de visita/agendamento, de um dia ou de uma hora concreta,
// a pergunta é sobre a agenda ("preciso de um horário de atendimento mais tarde,
// trabalho até as 19h") — ou é resposta automática de outra empresa ("nosso
// horário de atendimento é das 7h às 18h"). Nos dois casos, o alerta fica fora.
const AGENDA_RE =
  /\b(visita|visitar|agendar|agendamento|marcar|remarcar|consulta|avaliacao|conhecer a escola|ir ai|passar ai|amanha|hoje|semana que vem|segunda|terca|quarta|quinta|sexta|sabado|domingo|mais tarde|mais cedo|trabalho|trabalhar|nesse dia|neste dia|esse dia|\d{1,2}\/\d{1,2}|\d{1,2}\s?h(?:s|rs)?|\d{1,2}:\d{2})\b/;

/**
 * O lead perguntou sobre o horário DO SERVIÇO (aula, permanência, integral/meio
 * período, funcionamento) — e não sobre horário de visita/consulta?
 */
export function perguntaSobreHorarioDoServico(texto: string): boolean {
  const t = normalizar(texto);
  if (!t.trim() || !ROTINA_RE.test(t)) return false;
  return !AGENDA_RE.test(t);
}

/** Regra fixa das REGRAS ABSOLUTAS do qualifier e do scheduler. */
export const HORARIO_DO_SERVICO_RULE =
  '🕘 **HORÁRIO DO SERVIÇO ≠ HORÁRIO DE VISITA:** pergunta sobre a ROTINA do serviço — "permanência", "integral", "meio período", "horário de aula/entrada/saída/funcionamento", "que horas entra/sai" — se RESPONDE com o que o prompt do proprietário informa, sem chamar listar_horarios e sem ofertar horário; depois, se fizer sentido, pergunte se quer agendar. "Meio período"/"integral" NUNCA é turno de visita (não vira `periodo`). Se o lead pedir só "horários disponíveis" e o prompt do proprietário tiver horários de aula/rotina, responda a rotina e pergunte se ele também quer ver horários para a visita; sem rotina no prompt, trate como disponibilidade de agenda.';

/**
 * Alerta do ESTADO ATUAL quando a última rajada do lead é pergunta sobre o
 * horário do serviço. Vazio quando não é.
 */
export function linhaPerguntaHorarioDoServico(mensagensDoLead: string[]): string {
  if (!mensagensDoLead.some(perguntaSobreHorarioDoServico)) return "";
  return '- ⚠️ A ÚLTIMA MENSAGEM DO LEAD FALA DA ROTINA DO SERVIÇO (aula/permanência/integral/meio período/funcionamento), NÃO de horário de visita: responda à pergunta dele com o que o prompt do proprietário informa. NÃO chame listar_horarios e NÃO oferte horário neste turno — no máximo, termine perguntando se quer agendar.';
}
