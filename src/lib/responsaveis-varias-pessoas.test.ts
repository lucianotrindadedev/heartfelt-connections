// Caso real (Maple Bear Guarujá, 13 98200-8544, 07/10/2026): o pai mandou os
// dois responsáveis com nome completo — 8 a 9 palavras — e o preflight, com o
// limite de UM nome (6 palavras), apagava o campo a cada turno. A IA pediu os
// responsáveis oito vezes em 20 minutos, alternando com "me diz qual dia da
// semana", até a consultora assumir a conversa.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BOOKING_FIELDS_SCHOOL,
  getMissingBookingFields,
  preflightBookingFields,
  resolveBookingLeadName,
  sanitizeLeadDataPatch,
  splitGuardianNames,
  tryAutoCaptureBookingAnswer,
} from "./booking-template";
import { repeticaoEhDoCadastro } from "./agents/duplicate-fallback";
import type { LeadData } from "./agents/stage";

const FIELDS = DEFAULT_BOOKING_FIELDS_SCHOOL;
const SETTINGS = { booking_fields_json: JSON.stringify(FIELDS) };

function leadCom(guardians: string): LeadData {
  return {
    name: "Marcelo",
    custom_fields: {
      child_name: "Isaac Gonçalves",
      child_birth_date: "26/04/2022",
      guardians,
    },
  };
}

// As mensagens que o lead mandou, exatamente como chegaram.
const ENVIADAS = [
  "Marcelo Santos da Silva\nThaís Gonçalves da Silva",
  "Marcelo Santos da Silva e Thaís Gonçalves da Silva",
  "Thaís Gonçalves da Silva e Marcelo Santos da Silva",
  "Responsáveis: Marcelo Santos da Silva e Thaís Gonçalves da Silva",
];

describe("splitGuardianNames", () => {
  it("separa por quebra de linha, vírgula, ponto e vírgula, barra e ' e '", () => {
    expect(splitGuardianNames("Marcelo Santos da Silva\nThaís Gonçalves da Silva")).toEqual([
      "Marcelo Santos da Silva",
      "Thaís Gonçalves da Silva",
    ]);
    expect(splitGuardianNames("Ana Souza, João Lima e Rita Alves")).toEqual([
      "Ana Souza",
      "João Lima",
      "Rita Alves",
    ]);
    expect(splitGuardianNames("Ana Souza; João Lima")).toEqual(["Ana Souza", "João Lima"]);
    expect(splitGuardianNames("Ana Souza / João Lima")).toEqual(["Ana Souza", "João Lima"]);
  });

  it("tira o rótulo da lista e o de cada pessoa", () => {
    expect(
      splitGuardianNames("Responsáveis: Marcelo Santos da Silva e Thaís Gonçalves da Silva"),
    ).toEqual(["Marcelo Santos da Silva", "Thaís Gonçalves da Silva"]);
    expect(splitGuardianNames("os responsáveis são Ana Souza e João Lima")).toEqual([
      "Ana Souza",
      "João Lima",
    ]);
    expect(splitGuardianNames("o responsável é Ana Souza")).toEqual(["Ana Souza"]);
    expect(splitGuardianNames("Mãe: Ana Souza\nPai: João Lima")).toEqual([
      "Ana Souza",
      "João Lima",
    ]);
  });

  it("um nome só continua um nome só", () => {
    expect(splitGuardianNames("Marcelo Santos da Silva")).toEqual(["Marcelo Santos da Silva"]);
  });
});

describe("preflightBookingFields — responsáveis com nome completo", () => {
  it.each(ENVIADAS)("aceita %j", (g) => {
    expect(preflightBookingFields(FIELDS, leadCom(g))).toEqual({ ok: true, issues: [] });
  });

  it("o limite de palavras continua valendo POR PESSOA", () => {
    const res = preflightBookingFields(
      FIELDS,
      leadCom("Marcelo e eu acho que a gente vai junto com a avó dele"),
    );
    expect(res.ok).toBe(false);
    expect(res.issues[0]?.reason).toBe("too_many_words_in_name");
  });

  it("frase de intenção / agendamento no campo continua barrada", () => {
    expect(preflightBookingFields(FIELDS, leadCom("Olá, gostaria de saber o valor")).ok).toBe(
      false,
    );
    expect(
      preflightBookingFields(FIELDS, leadCom("pode marcar a visita no dia 10/10 as 10hs")).ok,
    ).toBe(false);
  });

  it("só o rótulo, sem nome, é barrado", () => {
    expect(preflightBookingFields(FIELDS, leadCom("Responsáveis:")).ok).toBe(false);
  });

  it("criança e lead continuam com o limite de UM nome", () => {
    const ld = leadCom("Marcelo Santos da Silva");
    ld.custom_fields!.child_name = "Isaac Gonçalves e Pedro Gonçalves da Silva Santos";
    expect(preflightBookingFields(FIELDS, ld).ok).toBe(false);
  });
});

describe("getMissingBookingFields / sanitizeLeadDataPatch — lista com vírgula", () => {
  // Inteira, "Ana Maria Souza, João Pedro Lima" tem tokens com vírgula e 6
  // palavras — o classificador de UM nome chamava de frase.
  const LISTA = "Ana Maria Souza, João Pedro Lima";

  it("não conta o campo como pendente", () => {
    expect(getMissingBookingFields(FIELDS, leadCom(LISTA))).toEqual([]);
  });

  it("não descarta a lista que o LLM gravou", () => {
    const patch = sanitizeLeadDataPatch({ custom_fields: { guardians: LISTA } });
    expect(patch.custom_fields?.guardians).toBe(LISTA);
  });

  it("continua descartando frase", () => {
    const patch = sanitizeLeadDataPatch({
      custom_fields: { guardians: "Olá, gostaria de mais informações sobre a escola" },
    });
    expect(patch.custom_fields?.guardians).toBeUndefined();
  });
});

describe("tryAutoCaptureBookingAnswer — captura os responsáveis da mensagem", () => {
  const ld: LeadData = {
    name: "Marcelo",
    custom_fields: { child_name: "Isaac Gonçalves", child_birth_date: "26/04/2022" },
  };
  const pergunta = "Perfeito! Agora me informa, por favor, o nome dos responsáveis.";

  it.each(ENVIADAS)("grava %j normalizado", (msg) => {
    const patch = tryAutoCaptureBookingAnswer(
      "NAME_COLLECT",
      ld,
      [
        { role: "assistant", content: pergunta },
        { role: "user", content: msg },
      ],
      SETTINGS,
    );
    const g = patch.custom_fields?.guardians ?? "";
    expect(splitGuardianNames(g).sort()).toEqual(
      ["Marcelo Santos da Silva", "Thaís Gonçalves da Silva"].sort(),
    );
    expect(g).not.toMatch(/respons|\n/i);
  });

  it("não captura frase como responsável", () => {
    const patch = tryAutoCaptureBookingAnswer(
      "NAME_COLLECT",
      ld,
      [
        { role: "assistant", content: pergunta },
        { role: "user", content: "Gostaria de saber o valor da mensalidade" },
      ],
      SETTINGS,
    );
    expect(patch.custom_fields?.guardians).toBeUndefined();
  });
});

describe("resolveBookingLeadName — primeiro responsável", () => {
  it("usa o primeiro nome da lista, sem rótulo nem quebra de linha", () => {
    expect(
      resolveBookingLeadName({
        custom_fields: {
          guardians: "Responsáveis: Marcelo Santos da Silva\nThaís Gonçalves da Silva",
        },
      }),
    ).toBe("Marcelo Santos da Silva");
  });
});

describe("repeticaoEhDoCadastro — trava anti-repetição não oferece horário de novo", () => {
  it("BOOKING com horário escolhido é cadastro (caso Maple Bear Guarujá)", () => {
    expect(
      repeticaoEhDoCadastro({
        stage: "BOOKING",
        effectiveStage: "BOOKING",
        selectedSlotIso: "2026-10-10T10:00:00-03:00",
      }),
    ).toBe(true);
  });

  it("NAME_COLLECT continua sendo cadastro", () => {
    expect(repeticaoEhDoCadastro({ stage: "NAME_COLLECT", effectiveStage: "BOOKING" })).toBe(true);
  });

  it("BOOKING sem horário escolhido NÃO é (segue a oferta de horário)", () => {
    expect(repeticaoEhDoCadastro({ stage: "BOOKING", effectiveStage: "BOOKING" })).toBe(false);
  });

  it("lead que recusou/reclamou em BOOKING não recebe cobrança de cadastro", () => {
    expect(
      repeticaoEhDoCadastro({
        stage: "BOOKING",
        effectiveStage: "BOOKING",
        selectedSlotIso: "2026-10-10T10:00:00-03:00",
        leadRecusouOuReclamou: true,
      }),
    ).toBe(false);
  });
});
