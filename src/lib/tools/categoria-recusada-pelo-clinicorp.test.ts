// Caso real (Odonto Sorrisos, conta odontosorrisos, 24/08 a 19/09/2026).
//
// TODA criação de agendamento voltava:
//   400 {"Error":400,"Message":"CategoryDescription não encontrada: Avaliação"}
//
// A categoria EXISTE: list_categories devolve "Avaliação" (id 6125409908359168,
// cor #fff9c4), byte a byte igual à configurada (NFC, ç=U+00E7, ã=U+00E3), na
// mesma unidade (business 5759268241342464), usada por 38 agendamentos criados
// pela própria UI do Clinicorp. A única outra conta que envia categoria usa
// "LEADS" (ASCII puro) e nunca falhou — o create do Clinicorp não casa
// descrição com acento.
//
// Preço: 300 conversas criadas desde 24/08, 18 com horário escolhido, ZERO
// agendamentos, 15 escaladas com falha_tecnica_agendamento. Entre elas Rosa
// Maria de Souza (87 99996-1903, 19/09, sábado 11:00), que passou o nome,
// aceitou o horário e confirmou — e ouviu "tive uma dificuldade técnica".
//
// A cor do evento na agenda não vale um lead. Se o Clinicorp recusar a
// categoria, o agendamento vai sem ela.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCategoryNotFoundError } from "./clinicorp.server";

const ERRO_REAL = '{"Error":400,"Message":"CategoryDescription não encontrada: Avaliação"}';

describe("isCategoryNotFoundError", () => {
  it("reconhece o 400 real da Odonto Sorrisos", () => {
    expect(isCategoryNotFoundError(ERRO_REAL)).toBe(true);
  });

  it("reconhece sem acento e com caixa diferente (a mensagem é deles, pode mudar)", () => {
    expect(isCategoryNotFoundError('{"Message":"categorydescription nao  encontrada: X"}')).toBe(
      true,
    );
  });

  it("NÃO confunde com o conflito de horário (esse não pode virar reenvio)", () => {
    // Erro real de Clinica Bomfim / Costa Lima: slot ocupado. Reenviar sem
    // categoria aqui só geraria uma segunda falha idêntica.
    expect(
      isCategoryNotFoundError('{"Error":400,"Message":"O horário solicitado encontra-se ocupado"}'),
    ).toBe(false);
  });

  it("NÃO dispara em erro genérico nem em corpo vazio", () => {
    expect(isCategoryNotFoundError('{"Error":500,"Message":"Internal"}')).toBe(false);
    expect(isCategoryNotFoundError("")).toBe(false);
  });
});

// ── O reenvio sem categoria ────────────────────────────────────────────────

vi.mock("@/integrations/selfhost/client.server", () => ({
  getSelfhost: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              api_token_enc: "enc",
              subscriber_id: "odontosorrisos",
              business_id: 5759268241342464,
              agenda_id: "541382",
              dentist_person_id: null,
              duracao_consulta: 40,
              category_description: "Avaliação",
              category_color: "#fff9c4",
              uppercase_patient_name: false,
              ativo: true,
            },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/crypto.server", () => ({ decryptValue: async () => "token" }));

type Chamada = { url: string; body: Record<string, unknown> | null };

function stubFetch(respostasDoCreate: { status: number; body: string }[]) {
  const chamadas: Chamada[] = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    chamadas.push({ url: String(url), body });

    if (String(url).includes("/patient/get")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (String(url).includes("/patient/create")) {
      return new Response(JSON.stringify({ PatientId: 4242 }), { status: 200 });
    }
    if (String(url).includes("/appointment/create_appointment_by_api")) {
      const r = respostasDoCreate[i] ?? respostasDoCreate[respostasDoCreate.length - 1]!;
      i++;
      return new Response(r.body, { status: r.status });
    }
    throw new Error(`URL inesperada no teste: ${url}`);
  });
  return chamadas;
}

const creates = (chamadas: Chamada[]) =>
  chamadas.filter((c) => c.url.includes("/appointment/create_appointment_by_api"));

const ROSA = {
  phone: "5587999961903",
  name: "Rosa Maria de Souza",
  datetime: "2026-09-19T11:00:00-03:00",
};

describe("createClinicorpAppointment: categoria recusada", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reenvia SEM categoria e agenda — o caso da Rosa Maria agora fecha", async () => {
    const chamadas = stubFetch([
      { status: 400, body: ERRO_REAL },
      { status: 200, body: JSON.stringify({ id: 6349316306763777 }) },
    ]);
    const { createClinicorpAppointment } = await import("./clinicorp.server");

    const r = await createClinicorpAppointment("conta", ROSA);
    expect(r.id).toBe(6349316306763777);

    const posts = creates(chamadas);
    expect(posts).toHaveLength(2);
    // 1ª tentativa: com a categoria configurada.
    expect(posts[0]!.body).toMatchObject({
      CategoryDescription: "Avaliação",
      CategoryColor: "#fff9c4",
    });
    // 2ª: sem NENHUM campo de categoria — e com o resto do agendamento intacto.
    expect(posts[1]!.body).not.toHaveProperty("CategoryDescription");
    expect(posts[1]!.body).not.toHaveProperty("CategoryColor");
    expect(posts[1]!.body).toMatchObject({
      Patient_PersonId: 4242,
      fromTime: "11:00",
      Clinic_BusinessId: 5759268241342464,
    });
  });

  it("o reenvio não gasta a tentativa reservada para falha transitória", async () => {
    // Recusa a categoria, depois cai uma vez (500) — ainda deve sobrar tentativa.
    const chamadas = stubFetch([
      { status: 400, body: ERRO_REAL },
      { status: 500, body: "boom" },
      { status: 200, body: JSON.stringify({ id: 7 }) },
    ]);
    const { createClinicorpAppointment } = await import("./clinicorp.server");

    const r = await createClinicorpAppointment("conta", ROSA);
    expect(r.id).toBe(7);
    expect(creates(chamadas)).toHaveLength(3);
  });

  it("recusa persistente não vira loop: tenta sem categoria UMA vez e falha", async () => {
    const chamadas = stubFetch([{ status: 400, body: ERRO_REAL }]);
    const { createClinicorpAppointment } = await import("./clinicorp.server");

    await expect(createClinicorpAppointment("conta", ROSA)).rejects.toThrow(/CategoryDescription/);

    // 1 com categoria + 2 sem (as duas tentativas normais). Nunca infinito.
    expect(creates(chamadas)).toHaveLength(3);
    expect(creates(chamadas)[1]!.body).not.toHaveProperty("CategoryDescription");
  });

  it("conflito de horário NÃO vira reenvio sem categoria", async () => {
    const chamadas = stubFetch([
      {
        status: 400,
        body: '{"Error":400,"Message":"O horário solicitado encontra-se ocupado"}',
      },
    ]);
    const { createClinicorpAppointment } = await import("./clinicorp.server");

    await expect(createClinicorpAppointment("conta", ROSA)).rejects.toThrow(/ocupado/);

    // Só as 2 tentativas normais, ambas COM categoria.
    const posts = creates(chamadas);
    expect(posts).toHaveLength(2);
    for (const p of posts) expect(p.body).toHaveProperty("CategoryDescription");
  });
});
