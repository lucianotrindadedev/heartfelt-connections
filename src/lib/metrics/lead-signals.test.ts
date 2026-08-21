import { describe, expect, it } from "vitest";

import {
  classifyObjections,
  interestKey,
  isUsableInterest,
  median,
  normalizeText,
  percentile,
  topCounts,
} from "./lead-signals";

describe("normalizeText", () => {
  it("tira acento e caixa", () => {
    expect(normalizeText("PREÇO Não É Ótimo")).toBe("preco nao e otimo");
    expect(normalizeText("  muito   longe  ")).toBe("muito longe");
  });
});

describe("classifyObjections", () => {
  it("reconhece objeção de preço em várias formas", () => {
    for (const t of [
      "quanto custa?",
      "Qual o valor da lipo?",
      "achei muito caro",
      "não tenho condições agora",
      "tem desconto?",
    ]) {
      expect(classifyObjections(t), t).toContain("preco");
    }
  });

  it("reconhece horário, distância e 'vou pensar'", () => {
    expect(classifyObjections("não posso nesse horário")).toContain("agenda");
    expect(classifyObjections("só saio do trabalho às 18h")).toContain("agenda");
    expect(classifyObjections("fica muito longe pra mim")).toContain("distancia");
    expect(classifyObjections("vou pensar e te aviso")).toContain("pensar");
  });

  it("reconhece decisão com terceiro, medo e dúvida de resultado", () => {
    expect(classifyObjections("preciso falar com meu marido")).toContain("terceiro");
    expect(classifyObjections("tenho medo de doer")).toContain("medo");
    expect(classifyObjections("isso funciona mesmo?")).toContain("duvida_resultado");
  });

  it("reconhece pedido de humano e pagamento", () => {
    expect(classifyObjections("quero falar com um atendente")).toContain("quer_humano");
    expect(classifyObjections("vocês aceitam convênio?")).toContain("pagamento");
    expect(classifyObjections("pode parcelar?")).toContain("pagamento");
  });

  it("uma frase pode trazer DUAS objeções — juntar apagaria metade", () => {
    const r = classifyObjections("achei caro e ainda fica muito longe");
    expect(r).toContain("preco");
    expect(r).toContain("distancia");
  });

  it("resposta de fluxo NÃO é objeção", () => {
    // O agente pergunta "manhã ou tarde?" e o lead responde. Sem este piso, um
    // "não" solto respondendo pergunta fechada viraria "sem interesse" e a
    // métrica mais importante do painel nasceria inflada.
    for (const t of ["sim", "ok", "tarde", "Magé", "10:30", "não", "Anete"]) {
      expect(classifyObjections(t), t).toHaveLength(0);
    }
  });

  it("fala do AGENTE citando preço/endereço não é contada (só entra texto do lead)", () => {
    // Blindagem de contrato: a função é chamada só com mensagem do lead. Se um
    // dia alguém passar a fala do agente, o teste abaixo mostra o estrago —
    // ela CASA, então o filtro por origem no chamador é obrigatório.
    expect(classifyObjections("O valor da avaliação é gratuito!")).toContain("preco");
  });

  it("aceita texto vazio ou lixo sem quebrar", () => {
    expect(classifyObjections("")).toHaveLength(0);
    expect(classifyObjections("   ")).toHaveLength(0);
    expect(classifyObjections("😊😊")).toHaveLength(0);
  });
});

describe("interesses", () => {
  it("agrupa variações do mesmo interesse", () => {
    expect(interestKey("Lipo Enzimática")).toBe(interestKey("lipo enzimatica"));
    expect(interestKey("  PREENCHIMENTO  ")).toBe("preenchimento");
  });

  it("descarta frase solta e lixo", () => {
    expect(isUsableInterest("Preenchimento")).toBe(true);
    expect(isUsableInterest("Botox")).toBe(true);
    expect(isUsableInterest("")).toBe(false);
    expect(isUsableInterest("ok")).toBe(false);
    expect(isUsableInterest("quero saber mais sobre o procedimento que vocês fazem")).toBe(false);
    expect(isUsableInterest("12345")).toBe(false);
  });
});

describe("topCounts", () => {
  it("conta por chave e devolve ordenado", () => {
    const r = topCounts(
      [
        { key: "botox", label: "Botox" },
        { key: "botox", label: "botox" },
        { key: "lipo", label: "Lipo" },
      ],
      5,
    );
    expect(r[0]).toEqual({ label: "Botox", count: 2 });
    expect(r[1]).toEqual({ label: "Lipo", count: 1 });
  });

  it("respeita o limite", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, label: `L${i}` }));
    expect(topCounts(entries, 3)).toHaveLength(3);
  });
});

describe("estatística", () => {
  it("mediana com lista ímpar e par", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3); // (2+3)/2 arredondado
    expect(median([])).toBe(0);
  });

  it("p90 fica no topo da distribuição", () => {
    const vals = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(vals, 90)).toBe(90);
    expect(percentile(vals, 50)).toBe(50);
    expect(percentile([], 90)).toBe(0);
  });

  it("não muda a lista original", () => {
    const vals = [5, 1, 3];
    median(vals);
    percentile(vals, 90);
    expect(vals).toEqual([5, 1, 3]);
  });
});
