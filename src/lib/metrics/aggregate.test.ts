import { describe, expect, it } from "vitest";

import { aggregateAgentMetrics, emptyMetrics, type ConvRow, type MsgRow } from "./aggregate";

const BASE = Date.parse("2026-08-20T12:00:00.000Z");
const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

function conv(over: Partial<ConvRow> & { id: string }): ConvRow {
  return {
    meta: null,
    channel: "whatsapp",
    criado_em: at(0),
    atualizado_em: at(0),
    ...over,
  };
}

function leadMsg(convId: string, offsetMs: number, content = "oi"): MsgRow {
  return {
    conversation_id: convId,
    role: "user",
    content,
    meta: { origem: "lead" },
    criado_em: at(offsetMs),
  };
}

function agentMsg(
  convId: string,
  offsetMs: number,
  meta: Record<string, unknown> = {},
): MsgRow {
  return {
    conversation_id: convId,
    role: "assistant",
    content: "resposta",
    meta: { origem: "agente", latency_ms: 5000, ...meta },
    criado_em: at(offsetMs),
  };
}

const run = (convs: ConvRow[], msgs: MsgRow[]) =>
  aggregateAgentMetrics({
    days: 30,
    agentName: "Teste",
    convs,
    msgs,
    sinceMs: BASE - 30 * 864e5,
    truncated: { conversas: false, mensagens: false },
  });

describe("tempo de resposta", () => {
  it("mede do lead até a PRIMEIRA resposta do agente", () => {
    const r = run([conv({ id: "c1" })], [leadMsg("c1", 0), agentMsg("c1", 30_000)]);
    expect(r.tempoResposta.medianaMs).toBe(30_000);
    expect(r.tempoResposta.amostra).toBe(1);
  });

  it("rajada do lead conta desde a PRIMEIRA mensagem, não a última", () => {
    // O lead manda três seguidas e espera desde a primeira. Marcar o relógio na
    // última faria o painel reportar um tempo de resposta menor que o real.
    const r = run(
      [conv({ id: "c1" })],
      [leadMsg("c1", 0), leadMsg("c1", 10_000), leadMsg("c1", 20_000), agentMsg("c1", 30_000)],
    );
    expect(r.tempoResposta.medianaMs).toBe(30_000);
    expect(r.tempoResposta.amostra).toBe(1);
  });

  it("resposta depois de 2h vira 'fora de expediente', não demora", () => {
    // Agente pausado / atendimento programado. Sem separar, um único caso
    // desses puxa a mediana e o dono acha que a IA está lenta.
    const r = run([conv({ id: "c1" })], [leadMsg("c1", 0), agentMsg("c1", 3 * 3600_000)]);
    expect(r.tempoResposta.amostra).toBe(0);
    expect(r.tempoResposta.foraDeExpediente).toBe(1);
  });

  it("separa espera do lead (com debounce) do tempo do modelo", () => {
    const r = run(
      [conv({ id: "c1" })],
      [leadMsg("c1", 0), agentMsg("c1", 28_000, { latency_ms: 8_000 })],
    );
    expect(r.tempoResposta.medianaMs).toBe(28_000);
    expect(r.tempoResposta.llmMedianaMs).toBe(8_000);
  });

  it("eco do CRM não conta como mensagem nem zera o relógio", () => {
    const r = run(
      [conv({ id: "c1" })],
      [
        leadMsg("c1", 0),
        { ...agentMsg("c1", 1_000), meta: { origem: "humano", is_echo: true } },
        agentMsg("c1", 30_000),
      ],
    );
    expect(r.tempoResposta.medianaMs).toBe(30_000);
    expect(r.kpis.mensagensAgente).toBe(1);
  });

  it("mensagens fora de ordem não quebram a medição", () => {
    const r = run([conv({ id: "c1" })], [agentMsg("c1", 30_000), leadMsg("c1", 0)]);
    expect(r.tempoResposta.medianaMs).toBe(30_000);
  });
});

describe("objeções", () => {
  it("conta uma vez por conversa, não por mensagem", () => {
    // Lead que repete "tá caro" cinco vezes é UM lead com objeção de preço.
    const msgs = [0, 1, 2, 3, 4].map((i) => leadMsg("c1", i * 1000, "achei muito caro"));
    const r = run([conv({ id: "c1" })], msgs);
    expect(r.objecoes).toEqual([{ key: "preco", count: 1 }]);
  });

  it("soma leads diferentes com a mesma objeção", () => {
    const r = run(
      [conv({ id: "c1" }), conv({ id: "c2" })],
      [leadMsg("c1", 0, "achei muito caro"), leadMsg("c2", 0, "quanto custa?")],
    );
    expect(r.objecoes).toEqual([{ key: "preco", count: 2 }]);
  });

  it("NÃO lê a fala do agente como objeção do lead", () => {
    // O agente cita preço, horário e endereço o tempo todo. Se a origem não
    // fosse filtrada, toda conversa apareceria com objeção de preço.
    const r = run(
      [conv({ id: "c1" })],
      [agentMsg("c1", 0, {}), { ...agentMsg("c1", 1000), content: "O valor é R$ 200" }],
    );
    expect(r.objecoes).toHaveLength(0);
  });
});

describe("agendamentos", () => {
  const convComAppt = conv({
    id: "c1",
    atualizado_em: at(999_000),
    meta: {
      stage: "CONFIRMED",
      lead_data: {
        name: "Rafaela Adriano",
        interest: "Lipo Enzimática",
        appointment_id: "abc",
        booked_slot_iso: "2026-08-28T14:30:00-03:00",
        selected_agenda: "MF Beauty Magé",
      },
    },
  });

  it("usa o turn que chamou a tool como 'marcado em', não o último toque", () => {
    // atualizado_em muda a cada mensagem nova; usá-lo faria a data do
    // agendamento andar sozinha sempre que o lead mandasse um "obrigado".
    const r = run([convComAppt], [agentMsg("c1", 5_000, { tools_called: ["criar_agendamento"] })]);
    expect(r.agendamentos[0]?.bookedAt).toBe(at(5_000));
    expect(r.agendamentos[0]?.name).toBe("Rafaela Adriano");
    expect(r.agendamentos[0]?.slotIso).toBe("2026-08-28T14:30:00-03:00");
  });

  it("cai pro último toque da conversa quando a tool não está na amostra", () => {
    const r = run([convComAppt], []);
    expect(r.agendamentos[0]?.bookedAt).toBe(at(999_000));
  });

  it("conversa SEM appointment_id não vira agendamento", () => {
    const semAppt = conv({
      id: "c2",
      meta: { stage: "CONFIRMED", lead_data: { name: "Fulano", selected_slot_iso: "2026-08-28T10:00:00-03:00" } },
    });
    const r = run([semAppt], []);
    expect(r.agendamentos).toHaveLength(0);
    expect(r.kpis.agendamentos).toBe(0);
  });

  it("taxa de agendamento é sobre o total de conversas", () => {
    const r = run([convComAppt, conv({ id: "c2" }), conv({ id: "c3" }), conv({ id: "c4" })], []);
    expect(r.kpis.taxaAgendamento).toBe(25);
  });

  it("mais recente primeiro", () => {
    const c2 = { ...convComAppt, id: "c2", atualizado_em: at(2_000_000) };
    const r = run([convComAppt, c2], []);
    expect(r.agendamentos[0]?.bookedAt).toBe(at(2_000_000));
  });
});

describe("funil e interesses", () => {
  it("segue a ordem do funil, não a do banco nem alfabética", () => {
    const r = run(
      [
        conv({ id: "a", meta: { stage: "CONFIRMED" } }),
        conv({ id: "b", meta: { stage: "RECEPTION" } }),
        conv({ id: "c", meta: { stage: "SLOT_OFFER" } }),
      ],
      [],
    );
    expect(r.funil.map((f) => f.stage)).toEqual(["RECEPTION", "SLOT_OFFER", "CONFIRMED"]);
  });

  it("expõe as conversas sem estágio — o funil não soma o total", () => {
    const r = run([conv({ id: "a", meta: { stage: "RECEPTION" } }), conv({ id: "b" })], []);
    expect(r.kpis.conversas).toBe(2);
    expect(r.funil.reduce((s, f) => s + f.count, 0)).toBe(1);
    expect(r.funilSemEstagio).toBe(1);
  });

  it("agrupa interesses equivalentes", () => {
    const r = run(
      [
        conv({ id: "a", meta: { lead_data: { interest: "Botox" } } }),
        conv({ id: "b", meta: { lead_data: { interest: "botox" } } }),
        conv({ id: "c", meta: { lead_data: { custom_fields: { procedimento: "Preenchimento" } } } }),
      ],
      [],
    );
    expect(r.interesses[0]).toEqual({ label: "Botox", count: 2 });
    expect(r.interesses[1]).toEqual({ label: "Preenchimento", count: 1 });
  });
});

describe("saúde do agendamento", () => {
  it("conta as travas que precisaram entrar", () => {
    const r = run(
      [conv({ id: "c1" })],
      [
        agentMsg("c1", 0, { false_confirmation_scrubbed: true }),
        agentMsg("c1", 1000, { booking_guard_hold: "intent_hold" }),
        agentMsg("c1", 2000, { false_confirmation_scrubbed: true }),
      ],
    );
    const byLabel = Object.fromEntries(r.saudeAgendamento.map((s) => [s.label, s.count]));
    expect(byLabel["Confirmação falsa corrigida"]).toBe(2);
    expect(byLabel["Agendamento segurado por trava"]).toBe(1);
  });
});

describe("vazio", () => {
  it("não quebra nem divide por zero", () => {
    const r = emptyMetrics(30);
    expect(r.kpis.conversas).toBe(0);
    expect(r.kpis.taxaAgendamento).toBe(0);
    expect(r.tempoResposta.medianaMs).toBe(0);
    expect(r.funil).toHaveLength(0);
    expect(r.daily).toHaveLength(0);
  });
});
