// Testes do splitter de mensagens — foco nos BLOCOS PROTEGIDOS
// ([[NOSPLIT]]...[[/NOSPLIT]]), que devem ir em UMA bolha só (ex.: tabela de
// preços e lista de serviços do agente de festas). O caminho de bloco protegido
// retorna ANTES de qualquer acesso a DB/LLM, então é seguro testar splitMessage
// diretamente com um accountId fictício.

import { describe, expect, it } from "vitest";

import { splitMessage, stripProtectedMarkers } from "./message-splitter.server";

const PRICE_BLOCK = `[[NOSPLIT]]para 170 convidados + 10 de cortesia:🐶

Segunda à Quinta-feira: R$11.930,00

Sexta à Domingo e Feriados: R$13.230,00

Obs: Crianças de 0 à 6 anos não contam como pagantes…[[/NOSPLIT]]`;

const SERVICES_BLOCK = `[[NOSPLIT]]Serviços Inclusos no nosso Pacote: 🐶

- Bolo 🎂
- Docinho Volante
- Salgados Variados

4 horas de Duração da Festa[[/NOSPLIT]]`;

describe("stripProtectedMarkers", () => {
  it("remove marcadores de abertura e fechamento", () => {
    expect(stripProtectedMarkers("[[NOSPLIT]]oi[[/NOSPLIT]]")).toBe("oi");
  });

  it("remove marcadores soltos (bloco mal formado)", () => {
    expect(stripProtectedMarkers("texto [[NOSPLIT]] sem fechar")).toBe("texto  sem fechar".trim());
  });

  it("tolera variacoes de caixa/espaco", () => {
    expect(stripProtectedMarkers("[[ nosplit ]]x[[ / NOSPLIT ]]")).toBe("x");
  });
});

describe("splitMessage com blocos protegidos", () => {
  it("mantem um bloco com linhas em branco como UMA parte só", async () => {
    const parts = await splitMessage(PRICE_BLOCK, "acc-test");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain("R$11.930,00");
    expect(parts[0]).toContain("R$13.230,00");
    expect(parts[0]).not.toContain("NOSPLIT");
  });

  it("dois blocos protegidos → exatamente 2 partes, cada uma inteira", async () => {
    const parts = await splitMessage(`${PRICE_BLOCK}\n\n${SERVICES_BLOCK}`, "acc-test");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("convidados");
    expect(parts[1]).toContain("Bolo");
    expect(parts[1]).toContain("4 horas de Duração da Festa");
    expect(parts.join("")).not.toContain("NOSPLIT");
  });

  it("intro fora do bloco + bloco protegido: intro separada, bloco inteiro", async () => {
    const msg = `Claro! Olha os valores:\n\n${PRICE_BLOCK}`;
    const parts = await splitMessage(msg, "acc-test");
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[0]).toContain("Claro");
    const pricepart = parts.find((p) => p.includes("R$11.930,00"));
    expect(pricepart).toBeDefined();
    expect(pricepart).toContain("R$13.230,00"); // bloco nao foi quebrado
  });
});
