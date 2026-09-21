// A categoria de agendamento só é conferida no momento em que o dono da conta
// salva a configuração. Se escapar dali, o erro só aparece semanas depois — e
// aparece como "tive uma dificuldade técnica" no meio da conversa de um lead
// (ver categoria-recusada-pelo-clinicorp.test.ts).
//
// As 5 categorias reais da Odonto Sorrisos, como list_categories devolve.

import { describe, expect, it } from "vitest";

import { resolveClinicorpCategory } from "./clinicorp.server";

const CATEGORIAS = [
  { id: "4517710250704896", description: "Retorno", color: "#bcaaa4" },
  { id: "6743121785323520", description: "Cirurgia", color: "#e1bee7" },
  { id: "6125409908359168", description: "Avaliação", color: "#fff9c4" },
  { id: "5562459954937856", description: "Periódico", color: "#bbdefb" },
  { id: "5303612744990720", description: "Consulta", color: "#b2dfdb" },
];

describe("resolveClinicorpCategory", () => {
  it("aceita a descrição exata e devolve a cor de lá", () => {
    const r = resolveClinicorpCategory(CATEGORIAS, "Avaliação");
    expect(r).toEqual({
      ok: true,
      description: "Avaliação",
      color: "#fff9c4",
      ajustada: false,
    });
  });

  it("corrige caixa e espaço sobrando para a string exata do Clinicorp", () => {
    // O create casa por TEXTO: "avaliação " não é "Avaliação" para a API deles.
    for (const digitado of ["avaliação", "AVALIAÇÃO", " Avaliação ", "avaliaçãO"]) {
      const r = resolveClinicorpCategory(CATEGORIAS, digitado);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.description).toBe("Avaliação");
        expect(r.color).toBe("#fff9c4");
        expect(r.ajustada).toBe(true);
      }
    }
  });

  it("recusa o que não existe e diz quais são as opções", () => {
    const r = resolveClinicorpCategory(CATEGORIAS, "Avaliacao Inicial");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.disponiveis).toEqual(["Retorno", "Cirurgia", "Avaliação", "Periódico", "Consulta"]);
    }
  });

  it("acento diferente não casa por acaso (Periodico ≠ Periódico)", () => {
    expect(resolveClinicorpCategory(CATEGORIAS, "Periodico").ok).toBe(false);
  });

  it("categoria sem cor devolve color null, não string vazia", () => {
    const r = resolveClinicorpCategory([{ id: "1", description: "LEADS", color: "" }], "LEADS");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.color).toBeNull();
  });
});
