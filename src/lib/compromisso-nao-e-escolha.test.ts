// Sorriso Saúde, Marcelene 27 99703-3358, 22/09: ofertado "quarta-feira, 23/09
// às 08:30 ou 09:00", ela respondeu "Pela manhã tenho compromisso" e o sistema
// SELECIONOU 08:30 — o horário que ela acabara de descartar. Na sequência a IA
// ofertou uma tarde de quinta que não existe na agenda, o follow-up repetiu o
// horário inventado, o juiz de intenção segurou o agendamento e ela cobrou:
// "uma hora você fala que tem 14h30, outra hora não tem e agora tem. Resolve aí".
import { describe, expect, it } from "vitest";
import { looksLikeStallReply } from "./agents/stage-signals";
import {
  looksLikeSentenceNotName,
  mentionsScheduleConflict,
  signalsRefusalOrComplaint,
  stripNameIntroduction,
  requestedPeriodoFromText,
  scrubInventedTimeOffers,
  tryAutoSelectOfferedSlot,
  withChosenSlotAllowed,
} from "./booking-template";

const MANHA_23 = [
  { iso: "2026-09-23T08:30:00-03:00", date_label: "quarta-feira, 23/09", time_label: "08:30" },
  { iso: "2026-09-23T09:00:00-03:00", date_label: "quarta-feira, 23/09", time_label: "09:00" },
];

describe("compromisso não é escolha de horário", () => {
  it.each([
    "Pela manhã tenho compromisso",
    "Quarta já tenho compromisso",
    "Amanhã eu tenho médico",
    "tenho consulta de manhã",
    "Estou com reunião nesse horário",
  ])("reconhece conflito: %s", (msg) => {
    expect(mentionsScheduleConflict(msg)).toBe(true);
  });

  it.each(["Pode ser quarta às 08:30", "Quero muito resolver isso", "Tenho 3 dentes quebrados"])(
    "não confunde com escolha: %s",
    (msg) => {
      expect(mentionsScheduleConflict(msg)).toBe(false);
    },
  );

  it("não seleciona o horário que o lead acabou de descartar", () => {
    const history = [
      {
        role: "assistant" as const,
        content:
          "Tenho dois horários pela manhã: quarta-feira, 23/09 às 08:30 ou quarta-feira, 23/09 às 09:00. Qual fica melhor para você?",
      },
      { role: "user" as const, content: "Pela manhã tenho compromisso" },
    ];
    expect(
      tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: MANHA_23 }, history)
        .selected_slot_iso,
    ).toBeUndefined();
  });

  it("escolha normal continua funcionando", () => {
    const history = [
      {
        role: "assistant" as const,
        content: "quarta-feira, 23/09 às 08:30 ou quarta-feira, 23/09 às 09:00?",
      },
      { role: "user" as const, content: "09:00 pode ser" },
    ];
    expect(
      tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: MANHA_23 }, history)
        .selected_slot_iso,
    ).toBe("2026-09-23T09:00:00-03:00");
  });
});

describe("turno citado uma vez só também pode ser o indisponível", () => {
  it.each([
    "Pela manhã tenho compromisso",
    "Estou trabalhando de manhã",
    "Tenho aula de manhã",
    "de manhã eu trabalho",
  ])("não vira preferência: %s", (msg) => {
    expect(requestedPeriodoFromText(msg)).toBeNull();
  });

  it.each([
    ["Só posso à tarde", "tarde"],
    ["prefiro de manhã", "manha"],
    ["pode ser à noite", "noite"],
  ])("preferência real continua valendo: %s", (msg, esperado) => {
    expect(requestedPeriodoFromText(msg as string)).toBe(esperado);
  });
});

describe("oferta inventada com horário já escolhido", () => {
  const reply =
    "Entendi. Verifiquei aqui e consigo abrir um encaixe para você na parte da tarde.\n\nTenho quinta-feira, 24/09 às 14:00 ou quinta-feira, 24/09 às 14:30. Qual desses fica melhor para você?";

  it("a tarde inventada é removida mesmo com um slot selecionado", () => {
    const permitidos = withChosenSlotAllowed(MANHA_23, "2026-09-23T08:30:00-03:00");
    const r = scrubInventedTimeOffers(reply, permitidos);
    expect(r.scrubbed).toBe(true);
    expect(r.reply).not.toMatch(/14:30/);
  });

  it("citar o horário JÁ escolhido não é oferta inventada", () => {
    const permitidos = withChosenSlotAllowed([], "2026-09-23T08:30:00-03:00");
    const ok = "Seu horário é quarta-feira, 23/09 às 08:30. Posso confirmar?";
    expect(scrubInventedTimeOffers(ok, permitidos).scrubbed).toBe(false);
  });
});

describe("nome do lead", () => {
  it.each([
    ["Meu nome é Jéssica", "Jéssica"],
    ["me chamo Ana Souza", "Ana Souza"],
    ["sou o Carlos", "Carlos"],
    ["Nome: Pedro Silva", "Pedro Silva"],
    ["Oi, meu nome completo é Marcelene Borges", "Marcelene Borges"],
    // Nomes reais de produção que agora seriam reprovados como frase ("Eu ...").
    ["Eu me chamo claudeth", "claudeth"],
    ["Eu sou o Jonathan", "Jonathan"],
    ["Eu já sou Ademilza", "Ademilza"],
  ])("extrai o nome de %s", (msg, esperado) => {
    expect(stripNameIntroduction(msg)).toBe(esperado);
  });

  it("'Eu sou de <lugar>' não vira nome", () => {
    expect(looksLikeSentenceNotName(stripNameIntroduction("Eu sou de SC"))).toBe(true);
    expect(looksLikeSentenceNotName(stripNameIntroduction("Eu sou da Bahia"))).toBe(true);
  });

  it("nome normal passa intacto", () => {
    expect(stripNameIntroduction("Marcelene Borges")).toBe("Marcelene Borges");
    expect(looksLikeSentenceNotName("Marcelene Borges")).toBe(false);
  });

  it.each(["Esse E isso", "Esse nome mesmo", "Nome privado", "é isso mesmo", "Pra que meu nome"])(
    "recusa como nome: %s",
    (txt) => {
      expect(looksLikeSentenceNotName(stripNameIntroduction(txt))).toBe(true);
    },
  );
});

describe("recusa e reclamação no meio da mensagem", () => {
  it("reconhece a ruptura do lead (27 99874-4428)", () => {
    expect(
      signalsRefusalOrComplaint(
        "Tô fora, foi com vcs que eu gastei o que não podia, fizeram um serviço péssimo, onde eu não consigo ficar com a dentadura nem cinco na boca que dói muito, obrigado, quero distância daí",
      ),
    ).toBe(true);
  });

  it.each(["desisto disso", "não quero mais nada", "nunca mais volto aí", "vou no Procon"])(
    "reconhece: %s",
    (m) => expect(signalsRefusalOrComplaint(m)).toBe(true),
  );

  it.each(["Pode ser quarta às 09:00", "Quero muito fazer", "Tô com dor"])(
    "não confunde: %s",
    (m) => expect(signalsRefusalOrComplaint(m)).toBe(false),
  );
});

describe("despedida acolhedora não é enrolação", () => {
  it('"em algum momento" não casa mais com "um momento"', () => {
    expect(
      looksLikeStallReply(
        "Entendo sua frustração e sinto muito pela experiência ruim. Se em algum momento você quiser conversar ou buscar uma segunda opinião, estarei por aqui.",
      ),
    ).toBe(false);
  });

  it("enrolação de verdade continua detectada", () => {
    expect(looksLikeStallReply("Só um momento que já te retorno com os horários")).toBe(true);
    expect(looksLikeStallReply("Deixa eu verificar os horários e já te falo")).toBe(true);
  });
});
