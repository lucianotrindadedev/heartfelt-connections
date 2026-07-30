// Tool `consultar_planilha` (Google Sheets): montagem da tool por conta,
// guardrail de preço e resolução do rótulo da planilha.
//
// O guardrail é o ponto sensível: sem planilha, o agente segue PROIBIDO de
// falar valor (foi assim que apareceu o "R$ 150,00" alucinado sob insistência
// do lead). Com planilha, o valor passa a ser permitido — mas só o que a tool
// devolveu. Um regride aqui volta a soltar preço inventado.

import { describe, it, expect } from "vitest";
import type { AgentContext } from "./context";
import {
  buildConsultarPlanilhaTool,
  buildPriceGuardrail,
  buildSheetsPromptBlock,
} from "./sheets.server";
import { querySheet, extractSpreadsheetId } from "@/lib/tools/google-sheets.server";
import { joinAba, splitAba } from "@/lib/sheets-range";

const ctx = (planilhas: { label: string; spreadsheetId: string; descricao?: string }[]) =>
  ({
    accountId: "acc",
    integrations: {
      clinicorp: false,
      clinup: false,
      googleCalendar: false,
      clinicExperts: false,
      escalation: false,
      googleSheets: planilhas.length > 0,
    },
    googleSheets: planilhas,
  }) as unknown as AgentContext;

describe("buildConsultarPlanilhaTool", () => {
  it("sem planilha cadastrada, a conta não recebe a tool", () => {
    expect(buildConsultarPlanilhaTool(ctx([]))).toBeNull();
  });

  it("com 1 planilha, nenhum parâmetro é obrigatório", () => {
    const tool = buildConsultarPlanilhaTool(
      ctx([{ label: "Preços", spreadsheetId: "abc", descricao: "tabela de preços" }]),
    );
    expect(tool?.function.name).toBe("consultar_planilha");
    const params = tool!.function.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.required).toEqual([]);
    expect(params.properties.planilha).toBeUndefined();
    expect(params.properties.busca).toBeDefined();
  });

  it("com 2+ planilhas, injeta o enum de rótulos e exige a escolha", () => {
    const tool = buildConsultarPlanilhaTool(
      ctx([
        { label: "Preços", spreadsheetId: "abc" },
        { label: "Convênios", spreadsheetId: "def" },
      ]),
    );
    const params = tool!.function.parameters as {
      properties: { planilha?: { enum?: string[] } };
      required: string[];
    };
    expect(params.properties.planilha?.enum).toEqual(["Preços", "Convênios"]);
    expect(params.required).toContain("planilha");
  });
});

describe("buildPriceGuardrail", () => {
  it("sem planilha, mantém a proibição total de citar valor", () => {
    const rule = buildPriceGuardrail(ctx([]));
    expect(rule).toContain("NUNCA informe preço");
    expect(rule).not.toContain("consultar_planilha");
  });

  it("com planilha, libera SÓ o valor vindo da tool", () => {
    const rule = buildPriceGuardrail(ctx([{ label: "Preços", spreadsheetId: "abc" }]));
    expect(rule).toContain("consultar_planilha");
    expect(rule).toMatch(/LITERALMENTE/);
    expect(rule).toMatch(/NUNCA invente/);
  });
});

describe("buildSheetsPromptBlock", () => {
  it("vazio quando a conta não tem planilha (não polui o prompt)", () => {
    expect(buildSheetsPromptBlock(ctx([]))).toBe("");
  });

  it("lista rótulo e descrição de cada planilha", () => {
    const block = buildSheetsPromptBlock(
      ctx([{ label: "Preços", spreadsheetId: "abc", descricao: "valores dos procedimentos" }]),
    );
    expect(block).toContain('"Preços"');
    expect(block).toContain("valores dos procedimentos");
  });
});

describe("aba ↔ intervalo A1 (painel)", () => {
  it("aba simples faz round-trip sem aspas", () => {
    expect(joinAba("Tabela", "")).toBe("Tabela");
    expect(splitAba("Tabela")).toEqual({ tab: "Tabela", range: "" });
  });

  it("aba + intervalo faz round-trip", () => {
    const a = joinAba("Tabela", "A1:F500");
    expect(a).toBe("Tabela!A1:F500");
    expect(splitAba(a)).toEqual({ tab: "Tabela", range: "A1:F500" });
  });

  it("aba com espaço/acento é citada e volta sem as aspas", () => {
    const a = joinAba("Tabela de Preços", "");
    expect(a).toBe("'Tabela de Preços'");
    // Sem o unquote, o dropdown não casaria com o nome vindo da API e a aba
    // salva apareceria como "não encontrada".
    expect(splitAba(a)).toEqual({ tab: "Tabela de Preços", range: "" });
    expect(splitAba(joinAba("Tabela de Preços", "A1:C9"))).toEqual({
      tab: "Tabela de Preços",
      range: "A1:C9",
    });
  });

  it("aspa no nome da aba não quebra o round-trip", () => {
    const a = joinAba("Preço d'Água", "A1:B2");
    expect(splitAba(a)).toEqual({ tab: "Preço d'Água", range: "A1:B2" });
  });

  it("sem aba, devolve vazio (agente lê a primeira aba)", () => {
    expect(joinAba("", "A1:F9")).toBe("");
    expect(splitAba("")).toEqual({ tab: "", range: "" });
  });
});

describe("extractSpreadsheetId", () => {
  it("aceita a URL colada do navegador", () => {
    expect(
      extractSpreadsheetId("https://docs.google.com/spreadsheets/d/1AbC-_9xyz/edit#gid=0"),
    ).toBe("1AbC-_9xyz");
  });

  it("aceita o ID puro (valor vindo do dropdown)", () => {
    expect(extractSpreadsheetId("1AbC-_9xyz")).toBe("1AbC-_9xyz");
  });
});

describe("querySheet — resolução do rótulo (sem tocar na API)", () => {
  it("conta sem planilha devolve erro explicativo", async () => {
    const res = await querySheet("acc", [], {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Nenhuma planilha configurada/);
  });

  it("rótulo inexistente lista os válidos em vez de chutar uma planilha", async () => {
    const res = await querySheet(
      "acc",
      [
        { label: "Preços", spreadsheetId: "abc" },
        { label: "Convênios", spreadsheetId: "def" },
      ],
      { label: "Tabela" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Preços");
    expect(res.error).toContain("Convênios");
  });

  it("com 2+ planilhas e sem rótulo, cobra a escolha (não assume a primeira)", async () => {
    const res = await querySheet(
      "acc",
      [
        { label: "Preços", spreadsheetId: "abc" },
        { label: "Convênios", spreadsheetId: "def" },
      ],
      {},
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/várias planilhas/i);
  });
});
