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

// ── payload REAL capturado em produção (30/07/2026 20:52 UTC) ─────────────
// Evento "Contato etiqueta alterada" da Helena = eventType CONTACT_TAG_UPDATE.
// O id do contato vem em `content.id` e `changeMetadata` é null — exatamente o
// formato que a extração rasa anterior não reconhecia (respondia
// {"ok":true,"skipped":"no-identifier"} e a automação morria).
const PAYLOAD_REAL = {
  eventType: "CONTACT_TAG_UPDATE",
  date: "2026-07-30T20:52:56.7729699Z",
  content: {
    id: "bab00406-e47a-4541-a9d6-3c6aa544413f",
    createdAt: "2026-01-28T12:58:40.013096Z",
    updatedAt: "2026-07-30T20:52:56.7126992Z",
    companyId: "379341ec-6385-48c0-af27-a174ceb26f82",
    name: "Luciano Trindade",
    nameWhatsapp: "Luciano Trindade",
    nameInstagram: null,
    nameMessenger: null,
    phonenumber: "+55|32991607088",
    phonenumberFormatted: "(32) 99160-7088",
    email: null,
    instagram: null,
    messengerId: null,
    usernameWhatsapp: null,
    pictureFileId: null,
    pictureUrl: null,
    active: true,
    annotation: null,
    tagsId: ["2ddc4c4a-00f1-416a-ad18-4f042630ac99", "dc641f08-e3d6-4ac7-adb2-ff2b9eefb494"],
    tags: ["FUF FINANCEIRO", "IA AGENDOU"],
    status: "ACTIVE",
    origin: "CREATED_FROM_HUB",
    utm: null,
    customFieldValues: {},
    metadata: null,
  },
  changeMetadata: null,
};

describe("CONTACT_TAG_UPDATE — payload real de produção", () => {
  it("extrai o contactId de content.id (o caso que falhava)", () => {
    expect(extractTagEventIds(PAYLOAD_REAL).contactId).toBe(
      "bab00406-e47a-4541-a9d6-3c6aa544413f",
    );
  });

  it("normaliza o telefone do formato '+55|DDDNUMERO' da Helena", () => {
    expect(extractTagEventIds(PAYLOAD_REAL).phone).toBe("5532991607088");
  });

  it("changeMetadata null não quebra a varredura", () => {
    expect(() => extractTagEventIds(PAYLOAD_REAL)).not.toThrow();
  });

  it("o esqueleto para log não expõe nome nem telefone do contato", () => {
    const json = JSON.stringify(payloadShape(PAYLOAD_REAL));
    expect(json).not.toContain("Luciano");
    expect(json).not.toContain("32991607088");
    expect(json).not.toContain("bab00406");
    expect(json).toContain("CONTACT_TAG_UPDATE".slice(0, 0) + "eventType");
  });
});
