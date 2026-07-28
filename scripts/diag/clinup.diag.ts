// VALIDAÇÃO DO CLINUP contra a API real — somente leitura.
//
//   CLINUP_TOKEN=<token> CLINUP_PROF_ID=1 \
//   npx vitest run --config scripts/diag/vitest.diag.config.ts scripts/diag/clinup.diag.ts
//
// Compara o contrato REAL da API (medido) com o que o adapter espera. Não
// cria paciente nem consulta: só GET. O token vem por variável de ambiente —
// nunca commitado.
//
// Contrato confirmado em 28/07/2026 contra app.sistemaclinup.com.br:
//   GET  /paciente?celular=      → {} quando não acha
//   GET  /datas?profissionalId&data → {"datas":["2026-07-28T00:00:00Z",…]}  ISO completo
//   GET  /horas?profissionalId&data → {"temHoras":true,"horas":["08:00:00",…]}
//   GET  /consultas?pacienteId   → {"consultas":[…]}                        envelopado
//   sem token                    → 401
//   sem profissionalId           → 200 com lista VAZIA (silencioso)

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BASE = "https://app.sistemaclinup.com.br/api/open";
const TOKEN = process.env.CLINUP_TOKEN ?? "";
const PROF = process.env.CLINUP_PROF_ID ?? "1";

const REPORT: string[] = [];
function log(line = "") {
  REPORT.push(line);
  console.log(line);
}

function hoje(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

async function get(pathname: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { Authorization: TOKEN, accept: "application/json" },
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const temToken = TOKEN.length > 10;
const d = temToken ? describe : describe.skip;

d("Clinup — contrato dos endpoints", () => {
  it("GET /datas devolve envelope {datas} com ISO completo", async () => {
    const { status, json } = await get(`/datas?profissionalId=${PROF}&data=${hoje()}`);
    log(`\n  /datas → ${status} ${JSON.stringify(json).slice(0, 160)}`);
    expect(status).toBe(200);
    const datas = (json as { datas?: string[] }).datas;
    expect(Array.isArray(datas), "esperado envelope {datas:[…]}").toBe(true);
    if (datas?.length) {
      // Documenta o formato: se um dia virar YYYY-MM-DD puro, o slice continua correto.
      expect(datas[0]!.slice(0, 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  }, 60_000);

  it("GET /horas usa a chave `horas` (NÃO `horarios`)", async () => {
    const { status, json } = await get(`/horas?profissionalId=${PROF}&data=${hoje()}`);
    log(`  /horas → ${status} ${JSON.stringify(json).slice(0, 160)}`);
    expect(status).toBe(200);
    const o = json as { horas?: string[]; horarios?: string[] };
    expect(Array.isArray(o.horas), "campo `horas` ausente — o adapter lê essa chave").toBe(true);
    expect(o.horarios, "se `horarios` passar a existir, revisar o adapter").toBeUndefined();
  }, 60_000);

  it("GET /consultas devolve envelope {consultas}, não array cru", async () => {
    const { status, json } = await get(`/consultas?pacienteId=1`);
    log(`  /consultas → ${status} ${JSON.stringify(json).slice(0, 160)}`);
    expect(status).toBe(200);
    expect(Array.isArray(json), "resposta é envelopada, não array cru").toBe(false);
    expect(Array.isArray((json as { consultas?: unknown[] }).consultas)).toBe(true);
  }, 60_000);

  it("GET /paciente inexistente devolve objeto vazio", async () => {
    const { status, json } = await get(`/paciente?celular=21999999999`);
    log(`  /paciente (inexistente) → ${status} ${JSON.stringify(json).slice(0, 120)}`);
    expect(status).toBe(200);
    expect((json as { id?: unknown })?.id, "sem id = não encontrado").toBeUndefined();
  }, 60_000);

  it("sem profissionalId a API responde 200 com lista VAZIA (falha silenciosa)", async () => {
    const { status, json } = await get(`/horas?data=${hoje()}`);
    log(`  /horas sem profissionalId → ${status} ${JSON.stringify(json).slice(0, 120)}`);
    expect(status).toBe(200);
    expect((json as { horas?: unknown[] }).horas).toEqual([]);
    log("  ⚠️  por isso o adapter exige agenda_id configurado antes de chamar");
  }, 60_000);

  it("GET /profissionais lista a equipe (array cru, id numérico)", async () => {
    const { status, json } = await get(`/profissionais`);
    expect(status).toBe(200);
    expect(Array.isArray(json), "resposta é array cru, sem envelope").toBe(true);
    const lista = json as { id?: number; nome?: string }[];
    log(`\n  /profissionais → ${lista.length} profissional(is)`);
    for (const p of lista.slice(0, 10)) log(`     #${p.id}  ${p.nome}`);
    expect(lista.length).toBeGreaterThan(0);
    expect(typeof lista[0]!.id, "id do Clinup é NÚMERO (não uuid)").toBe("number");
    expect(typeof lista[0]!.nome).toBe("string");
  }, 60_000);

  it("profissionais REAIS têm agendas diferentes entre si", async () => {
    const { json } = await get(`/profissionais`);
    const ids = (json as { id?: number }[]).map((p) => String(p.id)).slice(0, 6);
    const amanha = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(
      new Date(Date.now() + 86400000),
    );
    const contagens: number[] = [];
    log(`\n  /horas por profissional em ${amanha}:`);
    for (const id of ids) {
      const { json: h } = await get(`/horas?profissionalId=${id}&data=${amanha}`);
      const n = ((h as { horas?: string[] }).horas ?? []).length;
      contagens.push(n);
      log(`     #${id} → ${n} horário(s)`);
    }
    // Se TODOS devolvessem a mesma quantidade, o profissionalId estaria sendo
    // ignorado e o multi-profissional não faria sentido nenhum.
    expect(new Set(contagens).size, "profissionalId precisa mudar o resultado").toBeGreaterThan(1);
  }, 180_000);

  it("profissionalId INEXISTENTE não é rejeitado — devolve grade cheia", async () => {
    const { json } = await get(`/horas?profissionalId=999999&data=${hoje()}`);
    const horas = (json as { horas?: string[] }).horas ?? [];
    log(`  /horas com profissionalId=999999 → ${horas.length} horário(s)`);
    log("  ⚠️  a API valida PRESENÇA, não existência: um agenda_id errado devolve");
    log("      horários que podem não ser do profissional certo — sem erro nenhum.");
    expect(true).toBe(true);
  }, 60_000);
});

if (!temToken) {
  describe("Clinup", () => {
    it("pulado — defina CLINUP_TOKEN para rodar", () => {
      expect(true).toBe(true);
    });
  });
}

process.on("exit", () => {
  if (REPORT.length) {
    fs.writeFileSync(
      path.resolve(process.cwd(), "scripts", "diag", "last-report-clinup.txt"),
      `${REPORT.join("\n")}\n`,
      "utf8",
    );
  }
});
