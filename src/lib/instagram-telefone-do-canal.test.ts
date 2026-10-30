// Instagram/Messenger: o "remetente" do webhook da Helena não é telefone.
// Caso real (Clínica Bomfim, Instagram, 26/10): contato SEM telefone na Helena
// chegou com um remetente com cara de celular; virou lead_phone e chave da
// conversa, o agente nunca pediu o WhatsApp e agendou com esse número.
import { describe, expect, it } from "vitest";
import { resolveEffectivePhone } from "./conversation-channel.server";

const FALSO = "20900001111"; // fictício, no formato que chega

describe("resolveEffectivePhone no Instagram/Messenger", () => {
  it("ignora lead_phone e chave da conversa vindos do remetente", () => {
    for (const channel of ["instagram", "messenger"] as const) {
      expect(
        resolveEffectivePhone({ channel, leadPhone: FALSO, conversationPhone: FALSO, contactPhone: null }),
      ).toEqual({ phone: null, source: null });
    }
  });

  it("vale o telefone do cadastro do contato na Helena", () => {
    expect(
      resolveEffectivePhone({ channel: "instagram", leadPhone: FALSO, contactPhone: "+55 21 99999-1234" }),
    ).toEqual({ phone: "21999991234", source: "crm" });
  });

  it("WhatsApp continua como antes: lead_phone, depois CRM, depois a chave", () => {
    expect(resolveEffectivePhone({ channel: "whatsapp", leadPhone: "21988887777" }).phone).toBe("21988887777");
    expect(resolveEffectivePhone({ channel: "whatsapp", conversationPhone: "5521977776666" }).phone).toBe(
      "21977776666",
    );
    expect(resolveEffectivePhone({ leadPhone: "21988887777" }).phone).toBe("21988887777");
  });
});
