// A etiqueta inicial de "não agendado" é escolhida por semelhança de nome entre
// as etiquetas do CRM. Na Doutor Equilíbrio (05/10) o sinônimo "N/A Não
// Agendado" contém a etiqueta "AGENDADO", e todo lead novo era marcado como
// agendado na primeira resposta.
import { beforeEach, describe, expect, it, vi } from "vitest";

let tagsDoCrm: string[] = [];
vi.mock("@/lib/helena.server", () => ({
  listHelenaTags: vi.fn(async () => tagsDoCrm.map((name, i) => ({ id: String(i), name }))),
  setHelenaContactTags: vi.fn(),
  loadHelenaContactById: vi.fn(),
}));

const { NOT_SCHEDULED_SYNONYMS, SCHEDULED_SYNONYMS, resolveOneOf, temNegacao } =
  await import("./helena-tags.server");

let n = 0;
const conta = () => ({ id: `conta-${++n}`, baseUrl: "https://x", token: "t" }); // cache por conta

describe("etiqueta inicial de não agendado", () => {
  beforeEach(() => {
    tagsDoCrm = [];
  });

  it("Doutor Equilíbrio: nunca resolve para AGENDADO", async () => {
    tagsDoCrm = [
      "Novo Lead",
      "IA Desligada",
      "AGENDADO",
      "Desqualificado",
      "IA Agendou",
      "Protese Protocolo",
    ];
    expect(await resolveOneOf(conta(), NOT_SCHEDULED_SYNONYMS)).toBe("Novo Lead");
  });

  it("conta com Novo Lead e N/A: Novo Lead vem primeiro", async () => {
    tagsDoCrm = ["N/A Não Agendado", "Novo Lead", "AGENDADO"];
    expect(await resolveOneOf(conta(), NOT_SCHEDULED_SYNONYMS)).toBe("Novo Lead");
  });

  it("clínica com 'N/A Não Agendado' continua igual", async () => {
    tagsDoCrm = ["N/A Não Agendado", "IA Agendou", "AGENDADO"];
    expect(await resolveOneOf(conta(), NOT_SCHEDULED_SYNONYMS)).toBe("N/A Não Agendado");
  });

  it("sem nenhuma etiqueta de não agendado, não aplica nada", async () => {
    tagsDoCrm = ["AGENDADO", "IA Agendou", "Paciente"];
    expect(await resolveOneOf(conta(), NOT_SCHEDULED_SYNONYMS)).toBeNull();
  });

  it("etiqueta de agendado nunca vira a de não agendado", async () => {
    tagsDoCrm = ["N/A Não Agendado", "Agendado"];
    expect(await resolveOneOf(conta(), SCHEDULED_SYNONYMS)).toBe("Agendado");
  });

  it("detector de negação", () => {
    expect(temNegacao("n/a nao agendado")).toBe(true);
    expect(temNegacao("nao compareceu")).toBe(true);
    expect(temNegacao("agendado")).toBe(false);
    expect(temNegacao("novo lead")).toBe(false);
  });
});
