// Follow-ups reais (set/2026) que não podiam ter saído. Ver followup-guard.ts.
import { describe, expect, it } from "vitest";
import {
  agendaUnicaDoAgente,
  avaliarTextoDoFollowup,
  diasFechadosDoExpediente,
  linhaDiasFechados,
  recorteSemValores,
} from "./followup-guard";

// Expediente real da Clínica Bomfim: domingo desligado, sábado sem término.
const BOMFIM =
  '{"dom":{"active":false,"start":"08:00","end":"18:00"},"seg":{"active":true,"start":"10:00","end":"20:00"},"sab":{"active":true,"start":"09:00","lunch_start":"13:00","lunch_end":"","end":""}}';

describe("diasFechadosDoExpediente", () => {
  it("só o dia desligado de propósito conta como fechado", () => {
    expect(diasFechadosDoExpediente(BOMFIM)).toEqual(["domingo"]);
  });
  it("formato antigo (listas) e lixo", () => {
    expect(
      diasFechadosDoExpediente('{"sabado":[],"segunda":[{"inicio":"08:00","fim":"12:00"}]}'),
    ).toEqual(["sabado"]);
    expect(diasFechadosDoExpediente("não é json")).toEqual([]);
    expect(diasFechadosDoExpediente(null)).toEqual([]);
  });
});

describe("follow-up com preço (Janete Rosa, Clínica Bomfim, 30/09)", () => {
  it.each([
    "Perfeito, Janete! O valor de investimento da consulta é R$ 275,00. Aí depois, a gente conversa sobre as melhores formas de pagamento para você.",
    "Perfeito! Vou agendar sua Consulta de Diagnóstico com a gente. O investimento é R$ 275,00. Me passa seu nome aí? 😊",
    "Oi! 12 dentes em resina saem entre R$ 3.500 e R$ 30 mil, mas o valor exato sai na consulta.",
    "as lentes saem a partir de 250 reais por dente",
  ])("barra: %s", (t) => {
    expect(avaliarTextoDoFollowup(t).action).toBe("skip");
  });

  it("falar de investimento sem valor não é barrado", () => {
    expect(
      avaliarTextoDoFollowup(
        "Fico curioso — você está pensando em quantos dentes? Isso faz diferença no investimento e no resultado final! 😊",
      ).action,
    ).toBe("send");
  });
});

describe("follow-up afirmando agendamento que não existe", () => {
  it.each([
    "Perfeito! Seu agendamento está confirmado para quinta-feira, 01/10 às 09:00 em Jacarepaguá. A gente te espera lá!",
    "Ótimo, Cesario! Sua Consulta de Diagnóstico está confirmada para sexta-feira, 02/10 às 10:00.",
    "Perfeito! Fica marcado pra sexta-feira, 02/10 às 10:00. Você confirma presença comigo?",
    "Sexta às 17h tá ok pra você? Já vou agendar! 😊",
  ])("barra: %s", (t) => {
    expect(avaliarTextoDoFollowup(t).action).toBe("skip");
  });

  it("perguntar se pode mostrar horários é permitido", () => {
    expect(
      avaliarTextoDoFollowup(
        "Oi Janete! Posso te mostrar os horários disponíveis para sua avaliação? 😊",
      ).action,
    ).toBe("send");
  });
});

describe("follow-up com dia em que a clínica não abre", () => {
  const fechados = diasFechadosDoExpediente(BOMFIM);

  it("barra o domingo na Bomfim (Janete)", () => {
    expect(
      avaliarTextoDoFollowup(
        "Ótimo, Janete! Que dia você prefere agendar? Sábado, domingo ou segunda até 15h? 😊",
        {
          diasFechados: fechados,
        },
      ).action,
    ).toBe("skip");
  });

  it("sábado aberto na Bomfim passa", () => {
    expect(
      avaliarTextoDoFollowup("Oi Alex! Um sábado de manhã funcionaria pra você?", {
        diasFechados: fechados,
      }).action,
    ).toBe("send");
  });

  it("sem dias fechados informados, não barra dia nenhum", () => {
    expect(avaliarTextoDoFollowup("Tá pronta pro sábado? Quer saber algo mais?").action).toBe(
      "send",
    );
  });
});

describe("agenda múltipla não usa o expediente do agente", () => {
  it("Central MF Beauty (2 unidades Clinic Experts) fica de fora", () => {
    expect(agendaUnicaDoAgente({ clinicExpertsUnidades: [{}, {}] })).toBe(false);
    expect(agendaUnicaDoAgente({ googleAgendas: [{}, {}] })).toBe(false);
    expect(agendaUnicaDoAgente({ googleAgendas: [{}], clinicExpertsUnidades: [] })).toBe(true);
  });
});

describe("recorte do prompt da clínica sem as linhas de valor", () => {
  it("tira a frase da emergência e mantém o resto", () => {
    const prompt =
      '## 0. TRAVA DA EMERGÊNCIA\n2. A mensagem "O valor de investimento da consulta é R$ 275,00" já apareceu?\n## 1. PAPEL\nVocê é a Flávia.';
    const r = recorteSemValores(prompt, 3000);
    expect(r).not.toMatch(/275/);
    expect(r).toMatch(/Você é a Flávia/);
  });
});

describe("linha de dias fechados no prompt do atendimento", () => {
  it("Bomfim: domingo", () => {
    expect(linhaDiasFechados(BOMFIM)).toMatch(/NÃO atendemos: domingo\./);
  });
  it("sem dia fechado, sem linha", () => {
    expect(linhaDiasFechados('{"seg":{"active":true}}')).toBe("");
  });
});
