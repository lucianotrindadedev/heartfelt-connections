// Apelidos da consulta de agenda. Caso real (Bomfim, 17/10): o prompt cita
// `listar_horarios_clinicorp`, o qualifier só conhecia `listar_horarios` e o
// modelo respondeu "não tenho acesso à agenda" com o Clinicorp ativo.
import { describe, expect, it } from "vitest";
import {
  AGENDA_LISTING_TOOL,
  AGENDA_TOOL_ALIASES_NOTE,
  isAgendaListingTool,
} from "./agenda-tool-names";

describe("isAgendaListingTool", () => {
  it("aceita o nome canônico e os apelidos por provedor", () => {
    for (const n of [
      "listar_horarios",
      "listar_horarios_clinicorp",
      "listar_horarios_google_calendar",
      "listar_horarios_clinup",
      "clinup_buscar_horarios",
      "listar_horarios_clinic_experts",
    ]) {
      expect(isAgendaListingTool(n)).toBe(true);
    }
    expect(AGENDA_LISTING_TOOL).toBe("listar_horarios");
  });

  it("não confunde com outras tools", () => {
    for (const n of ["criar_agendamento", "buscar_paciente_clinicorp", "aplicar_tag_interesse", "", null, undefined]) {
      expect(isAgendaListingTool(n)).toBe(false);
    }
  });
});

describe("nota de apelidos na descrição da tool", () => {
  it("liga o nome do prompt à tool e proíbe dizer que não tem acesso à agenda", () => {
    expect(AGENDA_TOOL_ALIASES_NOTE).toContain("listar_horarios_clinicorp");
    expect(AGENDA_TOOL_ALIASES_NOTE).toMatch(/TEM acesso à agenda/);
    expect(AGENDA_TOOL_ALIASES_NOTE).toMatch(/nunca diga .*não tem acesso/i);
  });
});
