import { describe, expect, it } from "vitest";

import { isPlatformNotice } from "./platform-notice";

// Os cinco textos que a plataforma injeta como se fossem fala do lead, tal como
// aparecem no banco (levantamento de 60 dias: 2.494 ocorrências).
const AVISOS = [
  "*Atenção:* o tipo da mensagem enviada pelo contato não é suportado.",
  "*Atenção:* _131060 - Contato enviou uma mensagem ou reação não suportada pela API WhatsApp no momento._\n _This message is unavailable._",
  "*Atenção:* _131051 - Contato enviou uma mensagem ou reação não suportada pela API WhatsApp no momento._\n _Message type unknown_",
  "*Atenção:* o contato tentou enviar conteúdo relacionado a um Pagamento, mas esse tipo de mensagem não é suportado.",
  "*Atenção:* o contato tentou enviar conteúdo relacionado a um Pedido, mas esse tipo de mensagem não é suportado.",
];

describe("isPlatformNotice", () => {
  it("reconhece todos os avisos vistos em produção", () => {
    for (const a of AVISOS) expect(isPlatformNotice(a)).toBe(true);
  });

  it("NÃO engole mensagem de gente que começa com 'Atenção:'", () => {
    // Texto real de um lead, sem os asteriscos do negrito da plataforma.
    expect(
      isPlatformNotice(
        "Atenção: Nossa tabela de preços foi reajustada. Consulte os novos valores para trabalhos enviados a partir de 1 de agosto de 2026",
      ),
    ).toBe(false);
  });

  it("exige as duas marcas — prefixo em negrito E o motivo de não-suporte", () => {
    expect(isPlatformNotice("*Atenção:* chegamos mais cedo hoje")).toBe(false);
    expect(isPlatformNotice("o tipo da mensagem não é suportado")).toBe(false);
  });

  it("é no-op em texto vazio", () => {
    expect(isPlatformNotice("")).toBe(false);
    expect(isPlatformNotice(null)).toBe(false);
    expect(isPlatformNotice(undefined)).toBe(false);
  });
});
