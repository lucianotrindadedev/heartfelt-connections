// Marcador de modelo copiado para a resposta. Casos reais da varredura de 90
// dias (scripts/diag/placeholder-corpus.diag.ts).
import { describe, expect, it } from "vitest";
import { limparMarcadoresDeModelo } from "@/lib/placeholder-guard";

const limpa = (t: string, nome?: string | null) => limparMarcadoresDeModelo(t, nome).texto;

describe("limparMarcadoresDeModelo — [Nome] sem nome conhecido", () => {
  it("tira o vocativo com a vírgula (Odonto Carioca, 21 96554-7833)", () => {
    expect(limpa("Entendo perfeitamente, [Nome]. Fico feliz que você tenha me contado isso com sinceridade.")).toBe(
      "Entendo perfeitamente. Fico feliz que você tenha me contado isso com sinceridade.",
    );
  });
  it.each([
    ["Desculpa, [Nome]! Entendo a pressa.", "Desculpa! Entendo a pressa."],
    ["Poxa, [Nome], eu entendo como isso deve ser difícil.", "Poxa, eu entendo como isso deve ser difícil."],
    ["Oi, [Nome], sou Ana da Odonto Carioca.", "Oi, sou Ana da Odonto Carioca."],
    ["[Nome], tudo bem com você?", "Tudo bem com você?"],
    ["Que bom! [Nome], me conta mais.", "Que bom! Me conta mais."],
  ])("%s", (antes, depois) => {
    expect(limpa(antes)).toBe(depois);
  });
  it("marcador de nome fora de vocativo: a frase sai", () => {
    expect(limpa("Só confirmando: é [Nome Sobrenome], correto? Posso seguir?")).toBe("Posso seguir?");
  });
});

describe("limparMarcadoresDeModelo — [Nome] com nome conhecido", () => {
  it("preenche com o primeiro nome", () => {
    expect(limpa("Entendi, [Nome]. Poxa, deve ser frustrante.", "Chrislanny S. dos Santos")).toBe(
      "Entendi, Chrislanny. Poxa, deve ser frustrante.",
    );
  });
  it("marcador que pede sobrenome recebe o nome completo", () => {
    expect(limpa("Só confirmando, é [Nome Sobrenome], correto?", "Maria Arlene da Silva Costa")).toBe(
      "Só confirmando, é Maria Arlene da Silva Costa, correto?",
    );
  });
  it("aceita variações de grafia", () => {
    expect(limpa("Oi, [nome]!", "Ana Souza")).toBe("Oi, Ana!");
    expect(limpa("Oi, [primeiro nome]!", "Ana Souza")).toBe("Oi, Ana!");
  });
});

describe("limparMarcadoresDeModelo — outros marcadores: a frase sai", () => {
  it("endereço (Costa Lima, follow-up de 29/09)", () => {
    expect(
      limpa("Fica em [endereço da clínica]! Quer que eu mande a localização no mapa ou já prefere agendar?"),
    ).toBe("Quer que eu mande a localização no mapa ou já prefere agendar?");
  });
  it("preço (SpaçoIn, 23/09): cada linha com marcador some", () => {
    const antes =
      "Temos 4 modalidades:\n\n• Light — 12 meses: R$ [valor a confirmar]\n• Completo — 12 meses: R$ [valor a confirmar]\n\nQual te interessa?";
    const depois = limpa(antes);
    expect(depois).not.toContain("[valor");
    expect(depois).toContain("Qual te interessa?");
  });
  it("texto que era só marcador fica vazio (quem chama decide)", () => {
    expect(limpa("[Nome]")).toBe("");
  });
});

describe("limparMarcadoresDeModelo — não mexe no que é legítimo", () => {
  it.each([
    "Mande um e-mail para [atendimento.guaruja@maplebear.com.br](mailto:atendimento.guaruja@maplebear.com.br).",
    "[[NOSPLIT]]Consulta agendada para quinta às 10:00[[/NOSPLIT]]",
    "Seu horário é *quinta às 14:00*. Posso confirmar?",
    "Oi, Maria! Tudo bem?",
  ])("%s", (t) => {
    const r = limparMarcadoresDeModelo(t, null);
    expect(r.marcadores).toEqual([]);
    expect(r.texto).toBe(t);
  });
});
