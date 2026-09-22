// Caso real (Sorriso Saúde, Marcelene Borges, 27 99703-3358, 22/09/2026).
//
// Às 11:30 a IA ofertou quarta 23/09 às 08:30 ou 09:00, com busca real na
// agenda. A lead respondeu:
//
//     "Pela manhã tenho compromisso"
//
// A leitura de turno devolveu "manha" — PEDIDO de manhã, o oposto do que ela
// disse. A escolha automática então marcou 23/09 às 08:30, justamente o
// horário em que ela não podia, e o estágio avançou para NAME_COLLECT.
//
// Com selected_slot_iso preenchido no patch daquele turn, o guard de oferta
// inventada foi pulado (ver deveRodarScrubDeOferta). A resposta seguinte, com
// tools_called=[], inventou "quinta-feira, 24/09 às 14:00 ou 14:30" — a agenda
// da conta não tinha NENHUMA vaga de tarde naqueles dias. Ela aceitou 14:30,
// mandou o nome completo, e o agendamento morreu em "selected_slot_iso
// ausente". Tinha todos os dados; faltava um horário que existisse.
//
// Varredura de 120 dias: 114 falas de lead em 105 conversas dizem "nesse turno
// eu NÃO posso" e eram lidas como pedido daquele turno.
//
// Validado contra 3.613 falas reais: 107 impedimentos deixaram de virar
// pedido, 13 passaram a apontar o turno certo, ZERO pedidos legítimos perdidos.

import { describe, expect, it } from "vitest";

import { deveRodarScrubDeOferta, requestedPeriodoFromText } from "./booking-template";

describe("REGRESSÃO: turno negado não é pedido de turno", () => {
  it("a fala exata da Marcelene não vira pedido de manhã", () => {
    expect(requestedPeriodoFromText("Pela manhã tenho compromisso")).toBeNull();
  });

  it("as outras falas reais do mesmo tipo", () => {
    for (const fala of [
      "De manhã eu não posso. Tem horário após as 17:00?",
      "De manhã não dá pra mim",
      "De manhã não é possível",
      "De manhã to no trabalho",
      "Na parte da manhã não posso, estou no trabalho",
      "Pela manhã eu estou no trabalho",
      "Ai para mim é só à tarde não fico fazendo nada de manhã",
      "Acho que sim,não pode ser pela manhã",
    ]) {
      expect(requestedPeriodoFromText(fala), fala).toBeNull();
    }
  });

  it("impedimento em TODOS os turnos citados também não vira pedido", () => {
    expect(requestedPeriodoFromText("de manhã trabalho e à tarde tenho aula")).toBeNull();
  });
});

describe("pedido de turno CONTINUA sendo reconhecido", () => {
  it("as formas diretas", () => {
    expect(requestedPeriodoFromText("prefiro de manhã")).toBe("manha");
    expect(requestedPeriodoFromText("pode ser de manhã")).toBe("manha");
    expect(requestedPeriodoFromText("de manhã")).toBe("manha");
    expect(requestedPeriodoFromText("de tarde")).toBe("tarde");
    expect(requestedPeriodoFromText("só consigo à noite")).toBe("noite");
  });

  it("numa clínica, 'consulta' não é impedimento", () => {
    // Por isso "consulta" e "exame" ficaram FORA da lista de substantivos.
    expect(requestedPeriodoFromText("quero a consulta de manhã")).toBe("manha");
  });

  it("o impedimento de um turno elege o OUTRO", () => {
    // Já funcionava; aqui só trava que continua funcionando.
    expect(requestedPeriodoFromText("eu trabalho de manha só posso de tarde")).toBe("tarde");
    expect(requestedPeriodoFromText("de manhã não dá, tem que ser de tarde")).toBe("tarde");
    expect(
      requestedPeriodoFromText(
        "Na parte da manhã pode marcar qualquer dia, que eu só trabalho na parte da tarde",
      ),
    ).toBe("manha");
  });

  it("REGRESSÃO: um 'não' em outra frase não apaga o pedido", () => {
    // Fala real: o pedido está na 1ª frase, o "não puder" na 2ª. Varrendo o
    // texto inteiro, o impedimento matava a preferência — por isso a exclusão
    // é testada cláusula a cláusula.
    expect(
      requestedPeriodoFromText(
        "Eu prefiro ser atendido pela manhã. Se não puder na terça-feira pela manhã, embora não seja minha preferência, eu iria na sexta após as 17h",
      ),
    ).toBe("manha");
    expect(
      requestedPeriodoFromText(
        "Boa tarde, minha amiga. Olha só, amanhã pra mim não dá. Ou terça-feira, mas tem que ser na parte da manhã",
      ),
    ).toBe("manha");
  });
});

describe("deveRodarScrubDeOferta", () => {
  it("REGRESSÃO: escolha feita NESTE turn não desliga o guard", () => {
    // O gate antigo olhava também o patch do turn — foi o que deixou a oferta
    // inventada das 14:00/14:30 chegar à Marcelene.
    expect(deveRodarScrubDeOferta({ escolhaAnterior: undefined, stage: "NAME_COLLECT" })).toBe(
      true,
    );
  });

  it("escolha de um turn ANTERIOR desliga, como antes", () => {
    expect(
      deveRodarScrubDeOferta({
        escolhaAnterior: "2026-09-24T09:00:00-03:00",
        stage: "NAME_COLLECT",
      }),
    ).toBe(false);
  });

  it("string vazia não conta como escolha", () => {
    // lead_data guarda "" para LIMPAR o campo (stripNullishFields apagaria a
    // chave). Tratar isso como escolha desligaria o guard sem motivo.
    expect(deveRodarScrubDeOferta({ escolhaAnterior: "", stage: "SLOT_OFFER" })).toBe(true);
  });

  it("agendamento existente e escalada desligam", () => {
    expect(deveRodarScrubDeOferta({ appointmentId: 123, stage: "CONFIRMED" })).toBe(false);
    expect(deveRodarScrubDeOferta({ stage: "ESCALATED" })).toBe(false);
  });
});
