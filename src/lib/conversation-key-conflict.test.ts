// Chave da conversa nova quando o telefone já é chave de OUTRO contato da
// Helena. `unique (agent_id, phone)` fazia o INSERT falhar e o 500 desativava
// o webhook da conta (Dental Clinic Corcovado, 15/10, fixo da clínica
// (21) 2543-1807 já usado por outro contato desde julho).
import { describe, expect, it } from "vitest";
import {
  buildConversationKey,
  contactScopedConversationKey,
} from "./conversation-channel.server";

describe("contactScopedConversationKey", () => {
  it("usa o id do contato com prefixo ct:", () => {
    expect(contactScopedConversationKey("4833c3c0-da18-4e5b-8e12-466e1f0a3a17")).toBe(
      "ct:4833c3c0-da18-4e5b-8e12-466e1f0a3a17",
    );
  });

  it("é estável entre sessões do mesmo contato (a sessão muda, o contato não)", () => {
    const id = " 4833c3c0-da18-4e5b-8e12-466e1f0a3a17 ";
    expect(contactScopedConversationKey(id)).toBe(contactScopedConversationKey(id.trim()));
  });

  it("nunca coincide com uma chave natural de telefone", () => {
    const natural = buildConversationKey({
      channel: "whatsapp",
      fromDetails: null,
      instagram: null,
      messengerId: null,
      sessionId: "6d8e87f0-b692-4025-9f53-02df185c5757",
      contactPhone: "+55|2125431807",
      leadPhone: null,
    });
    expect(natural).toBe("2125431807");
    expect(contactScopedConversationKey("4833c3c0-da18-4e5b-8e12-466e1f0a3a17")).not.toBe(natural);
  });
});
