// Lembrete para paciente que nunca falou com o agente: a sessão vem direto da
// Helena pelo telefone (o que o fluxo n8n "04. Buscar ou criar contato +
// conversa" fazia para a Implanto).
import { afterEach, describe, expect, it, vi } from "vitest";
import { findHelenaSessionByPhone, sendHelenaTemplateToPhone, type HelenaAccount } from "./helena.server";

const conta = { baseUrl: "https://helena.test/", token: "tok" } as HelenaAccount;

function api(rotas: Record<string, { status: number; body: unknown }>) {
  const chamadas: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace("https://helena.test", "");
      chamadas.push(path);
      const r = rotas[path] ?? { status: 404, body: {} };
      return new Response(JSON.stringify(r.body), { status: r.status });
    }),
  );
  return chamadas;
}

afterEach(() => vi.unstubAllGlobals());

describe("findHelenaSessionByPhone", () => {
  it("contato pelo telefone → sessão mais recente dele", async () => {
    api({
      "/core/v1/contact/phonenumber/31999990000": { status: 200, body: { id: "c1" } },
      "/chat/v2/session?ContactId=c1": {
        status: 200,
        body: {
          items: [
            { id: "s-velha", channelId: "ch", updatedAt: "2026-09-01T10:00:00Z" },
            { id: "s-nova", channelId: "ch", updatedAt: "2026-10-30T10:00:00Z" },
          ],
        },
      },
    });
    expect(await findHelenaSessionByPhone(conta, "(31) 99999-0000")).toEqual({
      sessionId: "s-nova",
      contactId: "c1",
      channelId: "ch",
    });
  });

  it("tenta também com o 55 na frente", async () => {
    const chamadas = api({
      "/core/v1/contact/phonenumber/5531999990000": { status: 200, body: { id: "c2" } },
      "/chat/v2/session?ContactId=c2": { status: 200, body: { items: [{ id: "s1", channelId: null }] } },
    });
    expect((await findHelenaSessionByPhone(conta, "31999990000"))?.sessionId).toBe("s1");
    expect(chamadas[0]).toBe("/core/v1/contact/phonenumber/31999990000");
  });

  it("sem contato ou sem sessão na Helena → null (não cria nada)", async () => {
    api({});
    expect(await findHelenaSessionByPhone(conta, "31999990000")).toBeNull();
    api({
      "/core/v1/contact/phonenumber/31999990000": { status: 200, body: { id: "c3" } },
      "/chat/v2/session?ContactId=c3": { status: 200, body: { items: [] } },
    });
    expect(await findHelenaSessionByPhone(conta, "31999990000")).toBeNull();
  });

  it("telefone inválido nem consulta a Helena", async () => {
    const chamadas = api({});
    expect(await findHelenaSessionByPhone(conta, "123")).toBeNull();
    expect(chamadas).toEqual([]);
  });
});

describe("sendHelenaTemplateToPhone (paciente sem conversa na Helena)", () => {
  it("POST /chat/v1/message/send com from do canal, to com 55 e o modelo", async () => {
    const corpos: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        corpos.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: "m1", status: "Queued", sessionId: "s9" }), { status: 200 });
      }),
    );
    const r = await sendHelenaTemplateToPhone(conta, {
      from: "+55 31 99999-8400",
      to: "(31) 98888-7777",
      templateId: "t1",
      parameters: { horario: "05/11 às 09:00" },
    });
    expect(r).toMatchObject({ ok: true, sessionId: "s9" });
    expect(corpos[0]).toEqual({
      url: "https://helena.test/chat/v1/message/send",
      body: {
        from: "5531999998400",
        to: "5531988887777",
        body: { templateId: "t1", parameters: { horario: "05/11 às 09:00" } },
      },
    });
  });

  it("falha da Helena volta como ok=false com o corpo para o registro", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 400 })));
    const r = await sendHelenaTemplateToPhone(conta, { from: "5531999998400", to: "31988887777", templateId: "t1" });
    expect(r).toMatchObject({ ok: false, status: 400, body: "bad", sessionId: null });
  });
});
