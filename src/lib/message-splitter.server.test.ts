// Testes do splitter de mensagens — política "no máximo 2 balões" (a Meta
// cobra por balão): 1 balão sempre que couber, 2 só quando passa de
// SINGLE_BUBBLE_MAX_CHARS, nunca cortando um bloco protegido
// ([[NOSPLIT]]...[[/NOSPLIT]]). O splitter é determinístico (sem DB/LLM),
// então splitMessage é testado direto.

import { describe, expect, it } from "vitest";

import {
  MAX_BUBBLES,
  SINGLE_BUBBLE_MAX_CHARS,
  splitMessage,
  stripProtectedMarkers,
} from "./message-splitter.server";

const PRICE_BLOCK = `[[NOSPLIT]]para 170 convidados + 10 de cortesia:🐶

Segunda à Quinta-feira: R$11.930,00

Sexta à Domingo e Feriados: R$13.230,00

Obs: Crianças de 0 à 6 anos não contam como pagantes…[[/NOSPLIT]]`;

const SERVICES_BLOCK = `[[NOSPLIT]]Serviços Inclusos no nosso Pacote: 🐶

- Bolo 🎂
- Docinho Volante
- Salgados Variados

4 horas de Duração da Festa[[/NOSPLIT]]`;

/** Frase de ~60 chars repetida até passar do tamanho pedido. */
function longText(minChars: number, sentence = "A avaliação é feita pela nossa equipe e dura cerca de trinta minutos. ") {
  let s = "";
  while (s.length < minChars) s += sentence;
  return s.trim();
}

describe("stripProtectedMarkers", () => {
  it("remove marcadores de abertura e fechamento", () => {
    expect(stripProtectedMarkers("[[NOSPLIT]]a\n\nb[[/NOSPLIT]]")).toBe("a\n\nb");
  });
  it("remove marcadores soltos (bloco mal formado)", () => {
    expect(stripProtectedMarkers("x [[NOSPLIT]] y")).toBe("x  y");
  });
  it("tolera variacoes de caixa/espaco", () => {
    expect(stripProtectedMarkers("[[ nosplit ]]a[[ / NoSplit ]]")).toBe("a");
  });
});

describe("splitMessage — um balão sempre que couber", () => {
  it("mensagem curta vai inteira", async () => {
    expect(await splitMessage("Tudo bem! Como posso ajudar?")).toEqual(["Tudo bem! Como posso ajudar?"]);
  });

  it("saudação + contexto + pergunta com \\n\\n fica em UM balão (parágrafos preservados)", async () => {
    const reply =
      "Oi Paulo! 👋 Tudo bem?\n\nEntendo que você quer saber o valor, mas como cada caso é diferente, o ideal é uma avaliação.\n\nO que você gostaria de resolver no seu sorriso?";
    expect(await splitMessage(reply)).toEqual([reply]);
  });

  it("até o limite de caracteres continua em um balão, mesmo com várias quebras", async () => {
    const reply = longText(SINGLE_BUBBLE_MAX_CHARS - 80).replace(/\. /g, ".\n\n");
    const parts = await splitMessage(reply);
    expect(parts).toHaveLength(1);
  });

  it("vazio → nenhum balão", async () => {
    expect(await splitMessage("   ")).toEqual([]);
  });
});

describe("splitMessage — dois balões só quando fica muito grande", () => {
  it("texto longo com parágrafos corta no parágrafo mais perto do meio", async () => {
    const p = longText(300);
    const reply = `${p}\n\n${p}\n\n${p}\n\n${p}`;
    const parts = await splitMessage(reply);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(`${p}\n\n${p}`);
    expect(parts[1]).toBe(`${p}\n\n${p}`);
  });

  it("NUNCA passa de dois balões, por mais parágrafos que haja", async () => {
    const reply = Array.from({ length: 12 }, (_, i) => `Parágrafo ${i + 1}: ${longText(120)}`).join("\n\n");
    const parts = await splitMessage(reply);
    expect(parts.length).toBeLessThanOrEqual(MAX_BUBBLES);
    expect(parts).toHaveLength(2);
    expect(parts.join("\n\n")).toBe(reply);
  });

  it("parágrafo único longo corta no fim de frase, sem perder texto", async () => {
    const reply = longText(SINGLE_BUBBLE_MAX_CHARS + 200);
    const parts = await splitMessage(reply);
    expect(parts).toHaveLength(2);
    expect(parts[0].endsWith(".")).toBe(true);
    expect(`${parts[0]} ${parts[1]}`).toBe(reply);
    // corte equilibrado: nenhum lado fica com menos de 1/4 do texto
    expect(Math.min(parts[0].length, parts[1].length)).toBeGreaterThan(reply.length / 4);
  });

  it("não trata 'Dra.' como fim de frase", async () => {
    const half = longText(SINGLE_BUBBLE_MAX_CHARS / 2, "Você será atendido pela Dra. Michelle na nossa unidade da Barra. ");
    const reply = `${half} ${half}`;
    const parts = await splitMessage(reply);
    for (const p of parts) expect(p.endsWith("Dra.")).toBe(false);
  });

  it("saudação curta no início não vira um balão sozinha", async () => {
    const reply = `Oi, Paulo!\n\n${longText(SINGLE_BUBBLE_MAX_CHARS + 100)}`;
    const parts = await splitMessage(reply);
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(reply.length / 4);
  });

  it("sem nenhum ponto de corte válido, vai inteiro mesmo sendo grande", async () => {
    const reply = "x".repeat(SINGLE_BUBBLE_MAX_CHARS + 50);
    expect(await splitMessage(reply)).toEqual([reply]);
  });
});

describe("splitMessage — blocos protegidos", () => {
  it("bloco curto com linhas em branco vai em UM balão, sem marcadores", async () => {
    const parts = await splitMessage(PRICE_BLOCK);
    expect(parts).toHaveLength(1);
    expect(parts[0]).not.toMatch(/NOSPLIT/i);
    expect(parts[0]).toContain("R$11.930,00");
    expect(parts[0]).toContain("Obs: Crianças");
  });

  it("intro + dois blocos curtos: ainda cabe em um balão", async () => {
    const parts = await splitMessage(`Segue o pacote:\n\n${PRICE_BLOCK}\n\n${SERVICES_BLOCK}`);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain("Segue o pacote:");
    expect(parts[0]).toContain("4 horas de Duração da Festa");
  });

  it("texto longo nunca corta DENTRO de um bloco protegido", async () => {
    const intro = longText(400);
    const reply = `${intro}\n\n${PRICE_BLOCK}\n\n${longText(400)}`;
    const parts = await splitMessage(reply);
    expect(parts).toHaveLength(2);
    const comBloco = parts.find((p) => p.includes("R$11.930,00"));
    expect(comBloco).toBeDefined();
    expect(comBloco).toContain("Obs: Crianças");
    for (const p of parts) expect(p).not.toMatch(/NOSPLIT/i);
  });

  it("bloco protegido gigante cercado de texto: corta fora dele, 2 balões no máximo", async () => {
    const bigBlock = `[[NOSPLIT]]${longText(900).replace(/\. /g, ".\n\n")}[[/NOSPLIT]]`;
    const reply = `${longText(200)}\n\n${bigBlock}\n\n${longText(200)}`;
    const parts = await splitMessage(reply);
    expect(parts.length).toBeLessThanOrEqual(2);
    const inner = stripProtectedMarkers(bigBlock);
    expect(parts.some((p) => p.includes(inner))).toBe(true);
  });
});
