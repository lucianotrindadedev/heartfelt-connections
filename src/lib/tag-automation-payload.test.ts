import { describe, expect, it } from "vitest";

import { extractTagEventIds, payloadShape } from "./tag-automation-payload";

const CID = "15e706fc-f3ba-454e-9080-7213ffdbc7e9";

describe("extractTagEventIds — envelopes do evento 'Contato etiqueta alterada'", () => {
  it("chave direta na raiz (formato que já funcionava)", () => {
    expect(extractTagEventIds({ contactId: CID }).contactId).toBe(CID);
  });

  it("changeMetadata.id (formato que já funcionava)", () => {
    expect(extractTagEventIds({ changeMetadata: { id: CID } }).contactId).toBe(CID);
  });

  // ── os que a versão anterior PERDIA ──────────────────────────────────────

  it("content.id — o ramo `content` não aceitava `id` (assimetria do bug)", () => {
    expect(extractTagEventIds({ content: { id: CID, tags: ["FUF Financeiro"] } }).contactId).toBe(
      CID,
    );
  });

  it("content.contact.id — contato aninhado (busca era rasa)", () => {
    expect(
      extractTagEventIds({
        eventType: "CONTACT_TAG_CHANGED",
        content: { contact: { id: CID, name: "Leonardo" } },
      }).contactId,
    ).toBe(CID);
  });

  it("content.contactId aninhado em outro nível", () => {
    expect(
      extractTagEventIds({ data: { payload: { contactId: CID } } }).contactId,
    ).toBe(CID);
  });

  it("entityId (evento genérico de entidade)", () => {
    expect(extractTagEventIds({ changeMetadata: { entityId: CID } }).contactId).toBe(CID);
  });

  it("dentro de array", () => {
    expect(extractTagEventIds({ changes: [{ contactId: CID }] }).contactId).toBe(CID);
  });

  // ── sessão e telefone ────────────────────────────────────────────────────

  it("cai para sessionId quando não há contactId", () => {
    const r = extractTagEventIds({ content: { sessionId: "sess-1" } });
    expect(r.contactId).toBeNull();
    expect(r.sessionId).toBe("sess-1");
  });

  it("cai para telefone (inclusive aninhado em details)", () => {
    const r = extractTagEventIds({ content: { details: { from: "5521967520254" } } });
    expect(r.phone).toBe("5521967520254");
  });

  // ── negativos ────────────────────────────────────────────────────────────

  it("payload sem identificador nenhum → tudo null", () => {
    const r = extractTagEventIds({ eventType: "PING", content: { foo: "bar" } });
    expect(r.contactId).toBeNull();
    expect(r.sessionId).toBeNull();
    expect(r.phone).toBeNull();
  });

  it("valores vazios não contam como identificador", () => {
    expect(extractTagEventIds({ contactId: "   " }).contactId).toBeNull();
    expect(extractTagEventIds({ contactId: null }).contactId).toBeNull();
  });

  it("não quebra com payload inválido", () => {
    expect(extractTagEventIds(null).contactId).toBeNull();
    expect(extractTagEventIds("texto").contactId).toBeNull();
    expect(extractTagEventIds(undefined).contactId).toBeNull();
  });
});

describe("payloadShape — diagnóstico sem vazar dado pessoal", () => {
  it("devolve só chaves e tipos, nunca os valores", () => {
    const shape = payloadShape({
      eventType: "CONTACT_TAG_CHANGED",
      content: { contact: { id: CID, name: "Leonardo", phone: "5521967520254" } },
    });
    const json = JSON.stringify(shape);
    expect(json).not.toContain(CID);
    expect(json).not.toContain("Leonardo");
    expect(json).not.toContain("5521967520254");
    expect(json).toContain("eventType");
    expect(json).toContain("contact");
    expect(json).toContain("string");
  });

  it("resume arrays com o tamanho", () => {
    expect(JSON.stringify(payloadShape({ tags: ["a", "b", "c"] }))).toContain("(3)");
  });
});

describe("prioridade entre identificadores inequívocos e ambíguos", () => {
  it("contact.id vence content.id (que pode ser id de mensagem)", () => {
    const r = extractTagEventIds({
      content: { id: "id-da-mensagem", contact: { id: CID } },
    });
    expect(r.contactId).toBe(CID);
  });

  it("contactId na raiz vence qualquer container", () => {
    const r = extractTagEventIds({ contactId: CID, content: { id: "outro" } });
    expect(r.contactId).toBe(CID);
  });
});
