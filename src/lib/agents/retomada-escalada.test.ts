import { describe, expect, it } from "vitest";

import { findBlockingTag, AI_DISABLED_TAG } from "@/lib/agent-block.server";
import { resolveNextStage, stageAfterResume, type LeadData } from "./stage";

// Caso real: Dental Clinic Corcovado, 21 99818-0091. A conversa foi escalada em
// 21/08 (assunto não era odontológico), o humano tirou a etiqueta "IA Desligada"
// do contato no CRM, e mesmo assim nenhuma mensagem posterior foi respondida —
// nem o "Teste IA" que a própria clínica mandou em 27/08. ESCALATED era terminal
// e NADA no fluxo de reativação mexia no stage.
describe("retomada de conversa escalada", () => {
  it("ESCALATED continua sem saída pela tabela de transições (o LLM não se desescala)", () => {
    expect(resolveNextStage("ESCALATED", "QUALIFICATION")).toBe("ESCALATED");
    expect(resolveNextStage("ESCALATED", "SLOT_OFFER")).toBe("ESCALATED");
    expect(resolveNextStage("ESCALATED", "CONFIRMED")).toBe("ESCALATED");
  });

  it("sem etiqueta 'IA Desligada' no contato = humano liberou a IA", () => {
    expect(findBlockingTag(["N/A Não agendado"], [AI_DISABLED_TAG])).toBeNull();
    expect(findBlockingTag(["IA Desligada"], [AI_DISABLED_TAG])).toBe("IA Desligada");
    // Sem acento / caixa diferente também bloqueia (normalizeBlockTag).
    expect(findBlockingTag(["ia desligada"], [AI_DISABLED_TAG])).toBe("ia desligada");
  });

  it("retoma no estágio que o lead_data comporta", () => {
    const escalada: LeadData = {
      notes: "Lead mencionou documentação de contratação",
      escalation_reason: "Contato recebido em erro",
    };
    // Caso 21 99818-0091: sem horário e sem agendamento → volta a qualificar.
    expect(stageAfterResume(escalada)).toBe("QUALIFICATION");
    expect(stageAfterResume({ ...escalada, offered_slots: [] })).toBe("QUALIFICATION");
  });

  it("quem já tinha horário escolhido volta pro SLOT_OFFER, não pro começo", () => {
    expect(stageAfterResume({ selected_slot_iso: "2026-09-01T14:00:00-03:00" })).toBe(
      "SLOT_OFFER",
    );
    expect(
      stageAfterResume({
        offered_slots: [{ iso: "2026-09-01T14:00:00-03:00", date_label: "01/09", time_label: "14:00" }],
      }),
    ).toBe("SLOT_OFFER");
  });

  it("quem já estava agendado volta pro CONFIRMED (não reoferta horário)", () => {
    expect(stageAfterResume({ appointment_id: 12345 })).toBe("CONFIRMED");
    // Agendamento manda mesmo com slot antigo pendurado no lead_data.
    expect(
      stageAfterResume({ appointment_id: "abc", selected_slot_iso: "2026-09-01T14:00:00-03:00" }),
    ).toBe("CONFIRMED");
  });

  it("nunca retoma em RECEPTION — a conversa já teve trocas", () => {
    expect(stageAfterResume({})).not.toBe("RECEPTION");
  });
});
