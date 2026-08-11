import { describe, expect, it } from "vitest";

import { requestedDateFromText, tryAutoSelectOfferedSlot } from "./booking-template";

// ── Datas DINÂMICAS ────────────────────────────────────────────────────────
// Já queimamos a mão três vezes com teste que fixa data: passa verde no dia em
// que foi escrito e quebra a main 24h depois. Tudo aqui deriva de Date.now().
const BRT = "America/Sao_Paulo";
const DAY = 86_400_000;
const MESES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/** Partes (em BRT) do dia que cai `n` dias à frente de hoje. */
function daqui(n: number) {
  const d = new Date(Date.now() + n * DAY);
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: BRT }).format(d);
  const [y, mm, dd] = iso.split("-").map(Number) as [number, number, number];
  return {
    iso,
    dd: String(dd).padStart(2, "0"),
    mm: String(mm).padStart(2, "0"),
    dia: dd,
    mesNome: MESES[mm - 1]!,
    ano: y,
  };
}

describe("requestedDateFromText — data ABSOLUTA (caso 21 99826-0816)", () => {
  // A frase literal do lead. Antes desta correção devolvia null: a rede
  // determinística só sabia ler datas RELATIVAS. Sem âncora, listar_horarios
  // começou em "hoje", o corte de 6 vagas encheu com o dia seguinte (33 vagas
  // contra 2 no dia pedido) e o agente inventou "a agenda de amanhã já está
  // fechada". Este é o teste que falha se a correção sumir.
  it("frase real: 'Posso agendar uma consulta para o dia 12 de agosto?'", () => {
    const alvo = daqui(1);
    const frase = `Posso agendar uma consulta para o dia ${alvo.dia} de ${alvo.mesNome}?`;
    expect(requestedDateFromText(frase)).toBe(alvo.iso);
  });

  it("reconhece as formas que o lead realmente escreve", () => {
    const a = daqui(3);
    const casos: [string, string][] = [
      [`${a.dia} de ${a.mesNome}`, a.iso],
      [`dia ${a.dia} de ${a.mesNome}`, a.iso],
      [`${a.dia} ${a.mesNome}`, a.iso],
      [`${a.dia} de ${a.mesNome} de ${a.ano}`, a.iso],
      [`${a.dd}/${a.mm}`, a.iso],
      [`dia ${a.dd}/${a.mm}`, a.iso],
      [`${a.dia}/${Number(a.mm)}`, a.iso], // sem zero à esquerda: "12/8"
      [`${a.dd}/${a.mm}/${a.ano}`, a.iso],
      [`consegue me encaixar no dia ${a.dd}/${a.mm} de manhã?`, a.iso],
    ];
    for (const [frase, esperado] of casos) {
      expect(requestedDateFromText(frase), frase).toBe(esperado);
    }
  });

  it("'dia N' sem mês → próxima ocorrência desse dia do mês", () => {
    const a = daqui(2);
    // daqui(2) só é "dia N deste mês" se não virou o mês no meio.
    if (a.dia > new Date().getDate()) {
      expect(requestedDateFromText(`pode ser no dia ${a.dia}?`)).toBe(a.iso);
    }
  });

  it("a data resolvida é sempre HOJE ou o futuro, nunca o passado", () => {
    const hoje = daqui(0).iso;
    for (let n = 0; n <= 40; n++) {
      const a = daqui(n);
      const r = requestedDateFromText(`quero ${a.dia} de ${a.mesNome}`);
      expect(r, `${a.dia} de ${a.mesNome}`).toBe(a.iso);
      expect(r! >= hoje).toBe(true);
    }
  });
});

describe("o que NÃO pode virar data — agendar no dia errado é o erro mais caro", () => {
  it("data de nascimento não vira pedido de agendamento", () => {
    for (const t of [
      "15/03/1990",
      "minha data de nascimento é 15/03/1990",
      "15 de março de 1990",
      "nasci em 07/12/1985",
      "15/03/90",
    ]) {
      expect(requestedDateFromText(t), t).toBeNull();
    }
  });

  it("telefone, CPF, horário, valor e endereço não viram data", () => {
    for (const t of [
      "meu número é 21 99826-0816",
      "cpf 123.456.789-00",
      "pode ser 14:30",
      "às 9h30",
      "14h",
      "Av. das Américas, 13.685",
      "tenho 12 anos",
      "Não sei o certo, 2/3 anos", // real: virava 2 de março
      "espero 1/2 hora",
      "são 2 semanas de espera",
      "atendem em 30 minutos?",
    ]) {
      expect(requestedDateFromText(t), t).toBeNull();
    }
  });

  it("data que não existe no calendário → null", () => {
    expect(requestedDateFromText("dia 31/02")).toBeNull();
    expect(requestedDateFromText("dia 31 de fevereiro")).toBeNull();
    expect(requestedDateFromText("dia 45/13")).toBeNull();
  });

  it("negação e afirmação-fato continuam bloqueadas (sem regressão)", () => {
    const a = daqui(3);
    expect(requestedDateFromText(`dia ${a.dd}/${a.mm} não consigo`)).toBeNull();
    expect(requestedDateFromText(`não posso ${a.dia} de ${a.mesNome}`)).toBeNull();
  });

  it("data recém-passada é ambígua → null (não pula para o ano que vem)", () => {
    const ontem = daqui(-1);
    // Só vale quando ontem está no mesmo ano — na virada 31/12 → 01/01 o
    // "ano que vem" é a leitura certa e o caso deixa de existir.
    if (ontem.ano === daqui(0).ano) {
      expect(requestedDateFromText(`${ontem.dia} de ${ontem.mesNome}`)).toBeNull();
    }
  });
});

// ── Ordem dos sinais ───────────────────────────────────────────────────────
// O lead cita mais de um sinal de data na mesma frase o tempo todo, e eles se
// contradizem. Os dois casos abaixo saíram da varredura de 15.000 mensagens
// reais e puxam para lados OPOSTOS — é o par que fixa a ordem.
describe("quando o lead cita dois sinais de data", () => {
  it("data com MÊS ganha do nome do dia da semana", () => {
    // Real: "Pode se possível dia 20/08/26 quinta feira". A data pedida é uma
    // quinta uma semana à frente; resolver pelo "quinta feira" pegava a próxima
    // quinta e antecipava o agendamento em 7 dias.
    const alvo = daqui(9);
    const diaSemana = new Intl.DateTimeFormat("pt-BR", { timeZone: BRT, weekday: "long" }).format(
      new Date(Date.now() + 9 * DAY),
    );
    const frase = `Pode se possível dia ${alvo.dd}/${alvo.mm}/${String(alvo.ano).slice(2)} ${diaSemana}`;
    expect(requestedDateFromText(frase), frase).toBe(alvo.iso);
  });

  it("dia da semana ganha do 'dia N' solto", () => {
    // Real: "vou deixar então pra terça, tá? Terça-feira, dia 8, às 10 horas".
    // O dia 8 já tinha passado — resolver por ele jogaria a busca pro mês que
    // vem. Sem mês junto, "dia N" é o sinal mais fraco e fica por último.
    const terca = (() => {
      // i começa em 0: nextWeekdayDateBrt inclui HOJE ("vamos na terça" dito
      // numa terça é hoje), então o esperado tem que seguir a mesma regra.
      for (let i = 0; i <= 7; i++) {
        const d = new Date(Date.now() + i * DAY);
        const nome = new Intl.DateTimeFormat("pt-BR", { timeZone: BRT, weekday: "long" }).format(d);
        if (nome.startsWith("ter")) {
          return new Intl.DateTimeFormat("en-CA", { timeZone: BRT }).format(d);
        }
      }
      throw new Error("sem terça");
    })();
    const ontem = daqui(-1).dia;
    expect(requestedDateFromText(`Terça-feira, dia ${ontem}, às 10 horas`)).toBe(terca);
  });

  it("'dia 31 de fevereiro' não vira 'dia 31' do mês corrente", () => {
    // O ramo forte devolve null (data inexistente) e o fraco NÃO pode reciclar
    // o número — seria inventar uma data que o lead não pediu.
    expect(requestedDateFromText("dia 31 de fevereiro")).toBeNull();
  });
});

describe("data relativa tem prioridade sobre a absoluta", () => {
  it("'amanhã' manda mesmo com uma data absoluta na frase", () => {
    // Ambos aparecem; o pedido é o relativo. ("hoje é dia 12" não serve de
    // exemplo: relativeDateIsExplanatory já barra "hoje é ..." antes daqui.)
    expect(requestedDateFromText("vi o dia 12 no instagram mas prefiro ir amanhã")).toBe(
      daqui(1).iso,
    );
  });
  it("relativo puro segue funcionando (sem regressão)", () => {
    expect(requestedDateFromText("pode ser amanhã")).toBe(daqui(1).iso);
    expect(requestedDateFromText("hoje")).toBe(daqui(0).iso);
  });
});

// ── Auto-seleção entre slots ofertados ─────────────────────────────────────
// Segundo ponto onde a data absoluta era ignorada: pickSlotByPreference. Com
// targetDate null, um "dia X às 14h" filtrava só pelo HORÁRIO — e as 14h de
// QUALQUER dia ofertado serviam.
describe("tryAutoSelectOfferedSlot — data absoluta desempata o dia", () => {
  const a = daqui(1);
  const b = daqui(2);
  const slots = [
    { iso: `${a.iso}T14:00:00-03:00`, date_label: `${a.dd}/${a.mm}`, time_label: "14:00" },
    { iso: `${b.iso}T14:00:00-03:00`, date_label: `${b.dd}/${b.mm}`, time_label: "14:00" },
  ];
  const hist = (msg: string) => [
    { role: "assistant" as const, content: `Tenho ${a.dd}/${a.mm} às 14:00 ou ${b.dd}/${b.mm} às 14:00.` },
    { role: "user" as const, content: msg },
  ];

  it("mesmo horário em dois dias: a data escolhe o certo", () => {
    const r = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slots }, hist(`dia ${b.dd}/${b.mm} às 14h`));
    expect(r?.selected_slot_iso).toBe(slots[1]!.iso);
  });

  it("data por extenso funciona igual", () => {
    const r = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slots }, hist(`${b.dia} de ${b.mesNome} às 14h`));
    expect(r?.selected_slot_iso).toBe(slots[1]!.iso);
  });
});
