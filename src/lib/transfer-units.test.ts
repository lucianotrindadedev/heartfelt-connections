// Central de lojas: cadastro, escolha da loja pela IA e bloco do prompt.
import { describe, expect, it } from "vitest";
import {
  buildTransferUnitsPromptBlock,
  normalizeUnitPhone,
  parseTransferUnits,
  resolveTransferUnit,
  serializeTransferUnits,
} from "./transfer-units";

const CADASTRO = serializeTransferUnits([
  { name: "Madureira Shopping", phone: "(21) 97067-2747", hint: "Zona Norte" },
  { name: "Barra Shopping", phone: "21 99999-0000", hint: "Barra e Recreio" },
  { name: "Nova América", phone: "+55 21 98888-1111" },
]);

describe("normalizeUnitPhone", () => {
  it("aceita DDD+número e +55, devolve só dígitos com 55", () => {
    expect(normalizeUnitPhone("(21) 97067-2747")).toBe("5521970672747");
    expect(normalizeUnitPhone("+55 21 98888-1111")).toBe("5521988881111");
    expect(normalizeUnitPhone("2125431807")).toBe("552125431807");
  });
  it("rejeita o que não é telefone BR", () => {
    expect(normalizeUnitPhone("123")).toBeNull();
    expect(normalizeUnitPhone("")).toBeNull();
    expect(normalizeUnitPhone("120363405859054725@g.us")).toBeNull();
  });
});

describe("parseTransferUnits", () => {
  it("lê o cadastro do painel", () => {
    const u = parseTransferUnits(CADASTRO);
    expect(u).toEqual([
      { name: "Madureira Shopping", phone: "5521970672747", hint: "Zona Norte" },
      { name: "Barra Shopping", phone: "5521999990000", hint: "Barra e Recreio" },
      { name: "Nova América", phone: "5521988881111", hint: "" },
    ]);
  });
  it("ignora linha sem nome ou com WhatsApp inválido, e JSON quebrado", () => {
    expect(parseTransferUnits('[{"nome":"","whatsapp":"21999990000"},{"nome":"X","whatsapp":"12"}]')).toEqual([]);
    expect(parseTransferUnits("não é json")).toEqual([]);
    expect(parseTransferUnits(undefined)).toEqual([]);
  });
});

describe("resolveTransferUnit", () => {
  const units = parseTransferUnits(CADASTRO);
  it("nome exato, sem acento/caixa", () => {
    expect(resolveTransferUnit(units, "madureira shopping")?.name).toBe("Madureira Shopping");
    expect(resolveTransferUnit(units, "NOVA AMÉRICA")?.name).toBe("Nova América");
  });
  it("nome parcial único", () => {
    expect(resolveTransferUnit(units, "Madureira")?.name).toBe("Madureira Shopping");
  });
  it("ambíguo ou inexistente → null (não alerta a loja errada)", () => {
    expect(resolveTransferUnit(units, "Shopping")).toBeNull();
    expect(resolveTransferUnit(units, "Copacabana")).toBeNull();
    expect(resolveTransferUnit(units, "")).toBeNull();
    expect(resolveTransferUnit([], "Madureira")).toBeNull();
  });
});

describe("bloco do prompt", () => {
  it("lista as lojas com observação e explica como transferir", () => {
    const b = buildTransferUnitsPromptBlock(parseTransferUnits(CADASTRO));
    expect(b).toContain("- Madureira Shopping — Zona Norte");
    expect(b).toContain("- Nova América");
    expect(b).toContain('next_stage="ESCALATED"');
    expect(b).toContain("transfer_unit");
    // o WhatsApp interno da loja não vai para o modelo
    expect(b).not.toContain("5521970672747");
  });
  it("sem lojas cadastradas, nada entra no prompt", () => {
    expect(buildTransferUnitsPromptBlock([])).toBe("");
  });
});
