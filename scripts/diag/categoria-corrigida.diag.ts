// Read-only: o PR #49 destravou o agendamento da Odonto Sorrisos?
//
// Antes (24/08 a 19/09): 300 conversas, 18 com horário escolhido, ZERO
// agendamentos, 15 escaladas com falha_tecnica_agendamento — todas pelo 400
// "CategoryDescription não encontrada: Avaliação".
//
// Depois do deploy, o que confirma a correção, em ordem de força:
//   1. appointment_id novo  → agendou de verdade (prova definitiva)
//   2. zero booking_error de categoria em turno que chamou criar_agendamento
//      → o reenvio sem categoria funcionou (o erro nem chega a virar falha)
//   3. ainda aparecendo erro de categoria → NÃO está no ar (ou não funcionou)
//
// Marco padrão: merge do PR #49. Sobrescreva com MARCO=2026-09-21T18:00:00Z
// para contar só a partir do deploy.
//
//   npx vitest run --config scripts/diag/vitest.diag.config.ts scripts/diag/categoria-corrigida.diag.ts

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-categoria-corrigida.txt");
const R: string[] = [];
const log = (l = "") => {
  R.push(l);
  fs.writeFileSync(OUT, `${R.join("\n")}\n`, "utf8");
};

function loadEnv() {
  const txt = fs.readFileSync(path.resolve(process.cwd(), ".env.production"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const sb = getSelfhost();

const ACC = "ba2a7d4d-7ff9-4eca-9378-8bc8ebb8412b"; // Odonto Sorrisos
const MARCO = process.env.MARCO || "2026-09-21T13:46:38Z"; // merge do PR #49
const BR = (s: string) =>
  new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

type Msg = { conversation_id: string; meta: Record<string, unknown>; criado_em: string };
type Conv = { id: string; meta: Record<string, unknown>; criado_em: string; atualizado_em: string };

describe("categoria corrigida", () => {
  it("confere", async () => {
    log(`marco = ${BR(MARCO)}   (agora: ${BR(new Date().toISOString())})`);

    const { data: ags } = await sb.from("agents").select("id").eq("account_id", ACC);
    const agentIds = ((ags ?? []) as Record<string, unknown>[]).map((a) => a.id as string);

    // ── 1. Agendamentos criados depois do marco ─────────────────────────────
    const { data: convsRaw } = await sb
      .from("conversations")
      .select("id, meta, criado_em, atualizado_em")
      .in("agent_id", agentIds)
      .gte("atualizado_em", MARCO)
      .order("atualizado_em", { ascending: true });
    const convs = (convsRaw ?? []) as Conv[];

    const ld = (c: Conv) => ((c.meta ?? {}).lead_data ?? {}) as Record<string, unknown>;
    const agendadas = convs.filter((c) => ld(c).appointment_id);
    const comSlot = convs.filter((c) => ld(c).selected_slot_iso);
    const escaladasTec = convs.filter((c) => ld(c).escalation_reason === "falha_tecnica_agendamento");

    log(`\n── conversas da Odonto Sorrisos tocadas desde o marco: ${convs.length}`);
    log(`   com horário escolhido: ${comSlot.length}`);
    log(`   COM appointment_id:    ${agendadas.length}`);
    log(`   escaladas por falha técnica: ${escaladasTec.length}`);
    for (const c of agendadas) {
      const d = ld(c);
      log(
        `     ✅ ${BR(c.atualizado_em)} conv=${c.id.slice(0, 8)} ${String(d.name ?? "?")} appt=${JSON.stringify(d.appointment_id)} slot=${String(d.selected_slot_iso ?? "?")}`,
      );
    }
    for (const c of escaladasTec) {
      const d = ld(c);
      log(
        `     ⚠️  ${BR(c.atualizado_em)} conv=${c.id.slice(0, 8)} ${String(d.name ?? "?")} slot=${String(d.selected_slot_iso ?? "?")}`,
      );
    }

    // ── 2. O erro de categoria ainda aparece? ───────────────────────────────
    const convIds = convs.map((c) => c.id);
    let erros: Msg[] = [];
    for (let i = 0; i < convIds.length; i += 150) {
      const { data } = await sb
        .from("messages")
        .select("conversation_id, meta, criado_em")
        .in("conversation_id", convIds.slice(i, i + 150))
        .not("meta->>booking_error", "is", null)
        .gte("criado_em", MARCO);
      erros = erros.concat((data ?? []) as Msg[]);
    }
    const deCategoria = erros.filter((m) =>
      /CategoryDescription/i.test(String(m.meta.booking_error ?? "")),
    );

    log(`\n── booking_error desde o marco: ${erros.length} (de categoria: ${deCategoria.length})`);
    for (const m of deCategoria) {
      log(`     ❌ ${BR(m.criado_em)} conv=${m.conversation_id.slice(0, 8)}`);
    }
    for (const m of erros.filter((e) => !deCategoria.includes(e))) {
      log(
        `     ·  ${BR(m.criado_em)} conv=${m.conversation_id.slice(0, 8)} ${String(m.meta.booking_error).slice(0, 90)}`,
      );
    }

    // ── 3. Veredito ─────────────────────────────────────────────────────────
    log("\n── veredito ──");
    if (deCategoria.length > 0) {
      log("❌ O erro de categoria AINDA acontece — o deploy não saiu, ou o reenvio não pegou.");
    } else if (agendadas.length > 0) {
      log(`✅ CONFIRMADO: ${agendadas.length} agendamento(s) criado(s) e zero erro de categoria.`);
    } else if (comSlot.length > 0) {
      log(
        `⚠️  ${comSlot.length} lead(s) chegaram a escolher horário e nenhum agendou, mas sem erro de categoria — investigar outra causa.`,
      );
    } else {
      log(
        "⏳ Inconclusivo: nenhum lead chegou a escolher horário desde o marco. Sem tentativa de agendamento não há o que confirmar — rodar de novo mais tarde.",
      );
    }
    expect(true).toBe(true);
  }, 600_000);
});
