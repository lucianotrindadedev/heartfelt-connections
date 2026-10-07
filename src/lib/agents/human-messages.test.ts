// Caso real (Sorriamed, 21 95948-9650, 07/10/2026): a atendente ofereceu sábado
// sem pausar a IA; a IA leu a oferta como fala DELA e "se corrigiu" ("a gente
// não abre aos sábados"), e o follow-up, depois de a atendente concluir o
// agendamento, mandou "A gente funciona de segunda a sexta, ok?".
import { describe, expect, it } from "vitest";

import {
  HUMAN_STAFF_LABEL,
  classifyStaffMessage,
  isHumanStaffMessage,
  labelHumanStaff,
  lastSpeakerIsHumanStaff,
  stripHumanStaffLabel,
  type HistoryMsg,
} from "./human-messages";

const T = (hms: string) => `2026-10-07T${hms}.000Z`;
const lead = (hms: string, content: string): HistoryMsg => ({
  role: "user",
  content,
  meta: { origem: "lead" },
  criado_em: T(hms),
});
const agente = (hms: string, content: string): HistoryMsg => ({
  role: "assistant",
  content,
  meta: { origem: "agente" },
  criado_em: T(hms),
});
const humano = (hms: string, content: string, extra: Record<string, unknown> = {}): HistoryMsg => ({
  role: "assistant",
  content,
  meta: { origem: "humano", ...extra },
  criado_em: T(hms),
});

// Trecho real da conversa (horário UTC). Os assistant/humano das 20:13:22 e
// 20:14:55 são ECOS da resposta da IA — chegaram ~1s ANTES de ela ser gravada.
const SORRIAMED: HistoryMsg[] = [
  lead("20:12:39", "O jogo seria de marcar se der ou num sábado ou em um domingo"),
  humano(
    "20:13:22",
    "Entendi! Infelizmente não temos disponibilidade em sábados e domingos no momento. Mas consegui encontrar um horário bem pertinho pra você:",
  ),
  agente(
    "20:13:23",
    "Entendi! Infelizmente não temos disponibilidade em sábados e domingos no momento. Mas consegui encontrar um horário bem pertinho pra você:\n\n📅 Sexta-feira, 16/10 às 11:30",
  ),
  lead("20:13:39", "Tá bom, tá bom. E você manda também a localização, por favor, o endereço."),
  humano(
    "20:13:56",
    "Esse sábado agora não teria horário disponível,  mas tenho para o próximo sábado dia 17 de outubro 9:30h. Ou  11:30h.",
  ),
  lead("20:14:21", "ss"),
  humano("20:14:45", "Seria 11:30h. Posso confirmar?"),
  lead("20:14:52", "11hrs"),
  humano(
    "20:14:55",
    "Poxa, desculpa! Acabei de verificar e a gente não abre aos sábados. Nosso atendimento é de segunda a sexta.",
  ),
  agente(
    "20:14:56",
    "Poxa, desculpa! Acabei de verificar e a gente não abre aos sábados. Nosso atendimento é de segunda a sexta.\n\nPra eu já te trazer os horários certinhos da agenda: você prefere de manhã ou à tarde?",
  ),
  humano("20:15:03", "Por gentileza seu nome completo?"),
  lead("20:15:05", "jorge Luiz Barbosa Cardoso Pereira"),
  humano(
    "20:18:31",
    "Por gentileza desconsiderar mensagem acima eletrônicas,  Seu agendamento foi concluído,  obrigada",
  ),
];

describe("isHumanStaffMessage — atendente x eco da IA", () => {
  it("fala da atendente é humana", () => {
    for (const i of [4, 6, 10, 12]) expect(isHumanStaffMessage(SORRIAMED, i)).toBe(true);
  });

  it("eco gravado ANTES da resposta da IA não é humano", () => {
    expect(isHumanStaffMessage(SORRIAMED, 1)).toBe(false);
    expect(isHumanStaffMessage(SORRIAMED, 8)).toBe(false);
  });

  it("is_echo, lead, agente e evento vazio não são humanos", () => {
    const msgs = [humano("10:00:00", "Seria 11:30h. Posso confirmar?", { is_echo: true })];
    expect(isHumanStaffMessage(msgs, 0)).toBe(false);
    expect(isHumanStaffMessage(SORRIAMED, 0)).toBe(false);
    expect(isHumanStaffMessage(SORRIAMED, 2)).toBe(false);
    expect(isHumanStaffMessage([humano("10:00:00", "  ")], 0)).toBe(false);
  });

  it("eco fora da janela de 10 min não é confundido com a resposta", () => {
    const msgs = [
      agente("10:00:00", "Qual o melhor horário pra você, manhã ou tarde?"),
      humano("12:00:00", "Qual o melhor horário pra você, manhã ou tarde?"),
    ];
    expect(isHumanStaffMessage(msgs, 1)).toBe(true);
  });
});

describe("labelHumanStaff / stripHumanStaffLabel", () => {
  it("rotula e o rótulo nunca sai para o lead", () => {
    const rotulada = labelHumanStaff("Seria 11:30h. Posso confirmar?");
    expect(rotulada.startsWith(HUMAN_STAFF_LABEL)).toBe(true);
    expect(stripHumanStaffLabel(`${HUMAN_STAFF_LABEL} Combinado, Jorge!`)).toBe(
      "Combinado, Jorge!",
    );
    expect(stripHumanStaffLabel("Combinado, Jorge!")).toBe("Combinado, Jorge!");
  });
});

describe("classifyStaffMessage / lastSpeakerIsHumanStaff — follow-up", () => {
  it("atendente que concluiu o agendamento assume a conversa (caso Sorriamed)", () => {
    expect(classifyStaffMessage(SORRIAMED, 12)).toBe("takeover");
    expect(lastSpeakerIsHumanStaff(SORRIAMED)).toBe(true);
  });

  it("eco da nossa própria resposta no fim não conta como atendente", () => {
    const msgs = [
      lead("10:00:00", "Quero agendar"),
      agente("10:00:30", "Tenho sexta às 11:30 ou segunda às 14:00. Qual fica melhor pra você?"),
      humano("10:00:29", "Tenho sexta às 11:30 ou segunda às 14:00. Qual fica melhor pra você?"),
    ];
    expect(lastSpeakerIsHumanStaff(msgs)).toBe(false);
  });

  it("resposta automática instantânea do WhatsApp Business não é tomada", () => {
    const msgs = [
      agente("09:00:00", "Oi! Como posso te ajudar?"),
      lead("10:00:00", "Oi"),
      humano(
        "10:00:03",
        "Oi, normalmente respondo às mensagens entre 08:00 e 20:00. Retorno assim que possível.",
      ),
    ];
    expect(classifyStaffMessage(msgs, 2)).toBe("automatica");
    expect(lastSpeakerIsHumanStaff(msgs)).toBe(false);
  });

  it("aviso da plataforma e resposta a story não são tomada", () => {
    const base = [
      agente("09:00:00", "Oi! Como posso te ajudar?"),
      lead("09:30:00", "quero saber o valor"),
    ];
    expect(
      classifyStaffMessage(
        [...base, humano("10:00:00", "*Atenção:* o tipo da mensagem enviada não é suportado.")],
        2,
      ),
    ).toBe("automatica");
    expect(classifyStaffMessage([...base, humano("10:00:00", "Você respondeu ao story:")], 2)).toBe(
      "automatica",
    );
  });

  it("disparo da equipe sem o lead ter falado nas últimas 2h é prospecção — follow-up segue", () => {
    const msgs = [
      lead("06:00:00", "quero agendar"),
      agente("06:00:30", "Tenho sexta às 11:30. Pode ser?"),
      humano(
        "10:00:00",
        "Olá, me chamo Kelly tudo bom? Falo em nome da clínica, podemos verificar um horário para você?",
      ),
    ];
    expect(classifyStaffMessage(msgs, 2)).toBe("prospeccao");
    expect(lastSpeakerIsHumanStaff(msgs)).toBe(false);
  });

  it("conversa que a IA não conduzia nas últimas 24h não é tomada", () => {
    const msgs = [
      { ...agente("10:00:00", "Oi!"), criado_em: "2026-10-05T10:00:00.000Z" },
      lead("09:00:00", "bom dia"),
      humano("09:30:00", "Bom dia! Aqui é a Andressa, posso te ajudar?"),
    ];
    expect(classifyStaffMessage(msgs, 2)).toBe("sem_ia_recente");
    expect(lastSpeakerIsHumanStaff(msgs)).toBe(false);
  });

  it("lead respondeu depois da atendente: follow-up volta a valer", () => {
    expect(lastSpeakerIsHumanStaff([...SORRIAMED, lead("20:19:00", "obrigado!")])).toBe(false);
  });
});
