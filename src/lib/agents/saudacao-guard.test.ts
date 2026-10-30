import { describe, expect, it } from "vitest";

import { corrigirSaudacao, linhaSaudacaoDoHorario, saudacaoDoHorario } from "./saudacao-guard";

/** Horário de São Paulo (-03:00) num dia fixo. */
const sp = (hhmm: string) => new Date(`2026-10-26T${hhmm}:00-03:00`);

describe("saudacaoDoHorario", () => {
  it("segue os cortes de 12h e 18h", () => {
    expect(saudacaoDoHorario(sp("11:59"))).toBe("Bom dia");
    expect(saudacaoDoHorario(sp("12:00"))).toBe("Boa tarde");
    expect(saudacaoDoHorario(sp("17:59"))).toBe("Boa tarde");
    expect(saudacaoDoHorario(sp("18:00"))).toBe("Boa noite");
  });

  it("madrugada é boa noite e bom dia começa às 5h", () => {
    expect(saudacaoDoHorario(sp("00:17"))).toBe("Boa noite");
    expect(saudacaoDoHorario(sp("04:59"))).toBe("Boa noite");
    expect(saudacaoDoHorario(sp("05:00"))).toBe("Bom dia");
  });

  it("linha do prompt traz a saudação calculada", () => {
    expect(linhaSaudacaoDoHorario(sp("17:14"))).toContain('"Boa tarde"');
  });
});

describe("corrigirSaudacao", () => {
  // Caso real: Amazing CCZ, (21) 97558-2703, 26/10/2026 17:15.
  it("troca boa noite por boa tarde às 17:15", () => {
    const r = corrigirSaudacao(
      "Boa noite! Que bom ter você por aqui, seja bem-vindo(a) ao AmazingCCZ.\n\nComo posso te ajudar hoje?",
      ["Gostaria de mais informações"],
      sp("17:15"),
    );
    expect(r.texto).toBe(
      "Boa tarde! Que bom ter você por aqui, seja bem-vindo(a) ao AmazingCCZ.\n\nComo posso te ajudar hoje?",
    );
    expect(r).toMatchObject({ de: "Boa noite", para: "Boa tarde" });
  });

  it("corrige depois de Olá mantendo a caixa", () => {
    const r = corrigirSaudacao("Olá, boa tarde! Tudo bem?", ["Quero agendar"], sp("09:32"));
    expect(r.texto).toBe("Olá, bom dia! Tudo bem?");
  });

  it("mantém quando a IA repete a saudação do lead", () => {
    const texto = "Bom dia! Como posso ajudar?";
    const r = corrigirSaudacao(texto, ["Bom dia"], sp("12:00"));
    expect(r.texto).toBe(texto);
    expect(r.de).toBeUndefined();
  });

  it("considera a rajada inteira do lead, sem acento e caixa", () => {
    const texto = "Boa noite! Claro.";
    expect(corrigirSaudacao(texto, ["Oi BOA NOITE", "é em Botafogo?"], sp("17:45")).texto).toBe(texto);
  });

  it("não mexe quando a saudação já está certa", () => {
    const texto = "Boa tarde! Como posso ajudar?";
    expect(corrigirSaudacao(texto, ["oi"], sp("15:00"))).toEqual({ texto });
  });

  it("não mexe em texto sem saudação nem em saudação no meio", () => {
    expect(corrigirSaudacao("Claro! Tenho segunda às 10:00.", [], sp("20:00")).texto).toBe(
      "Claro! Tenho segunda às 10:00.",
    );
    const meio = "Perfeito. Tenha uma boa noite!";
    expect(corrigirSaudacao(meio, [], sp("10:00")).texto).toBe(meio);
  });

  it("de madrugada aceita bom dia e corrige só boa tarde", () => {
    expect(corrigirSaudacao("Bom dia! Tudo bem?", [], sp("04:55")).texto).toBe("Bom dia! Tudo bem?");
    expect(corrigirSaudacao("Boa tarde! Tudo bem?", [], sp("00:30")).texto).toBe("Boa noite! Tudo bem?");
  });

  // Caso real: Spaço In abria sempre com "Oi! Bom dia! 👋", inclusive às 22h.
  it("corrige depois de 'Oi!'", () => {
    expect(corrigirSaudacao("Oi! Bom dia! 👋 Eu sou a Sofia.", ["Olá!"], sp("22:02")).texto).toBe(
      "Oi! Boa noite! 👋 Eu sou a Sofia.",
    );
  });

  it("não confunde 'bom diagnóstico' com saudação", () => {
    const texto = "Bom diagnóstico depende da avaliação.";
    expect(corrigirSaudacao(texto, [], sp("20:00")).texto).toBe(texto);
  });
});
