// Read-only: quando o código entende que o lead pediu um TURNO, a oferta
// seguinte respeita esse turno?
//
// Medição contínua dos PRs #57/#58 (Sorriso Saúde, Marcelene 27 99703-3358,
// 22/09/2026): ela escreveu "Pela manhã tenho compromisso", o sistema leu
// PEDIDO de manhã, marcou 08:30 e a conversa desandou.
//
//   CONTA="Sorriso Saude" DIAS=7 npx vitest run \
//     --config scripts/diag/vitest.diag.config.ts \
//     scripts/diag/sorriso-turno-respeitado.diag.ts
//
// A referência do que o lead pediu é a PRÓPRIA requestedPeriodoFromText, nunca
// um detector escrito aqui. A primeira versão deste diag tinha um regex de
// impedimento próprio e acusou como erro um caso em que o código estava certo
// ("na parte da tarde, aí eu quero" foi rotulado como veto à tarde). Quem mede
// não pode reimplementar o que está medindo.
//
// Por isso o diag separa o que ele SABE do que ele só LISTA:
//   • pedido reconhecido  -> confere a oferta seguinte (veredito automático);
//   • turno citado sem pedido reconhecido -> só lista, para olho humano.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-turno-respeitado.txt");
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
    if (!process.env[k])
      process.env[k] = line
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const { requestedPeriodoFromText, turnoDeMinutos } = await import("@/lib/booking-template");
const sb = getSelfhost();

const CONTA = process.env.CONTA || "Sorriso Saude";
const DIAS = Number(process.env.DIAS || 7);
const BR = (s: string) => new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

/** Palavra de turno na fala. "amanhã" contém "manh" e NÃO conta. */
const CITA_TURNO = /\b(manh[ãa]|tarde|noite)\b/i;

/** Horários concretos citados num texto ("14:00", "14h30", "às 14h"). */
function horariosCitados(texto: string): number[] {
  const out: number[] = [];
  for (const m of texto.matchAll(/\b(\d{1,2})[:h](\d{2})\b/g)) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h <= 23 && mi <= 59) out.push(h * 60 + mi);
  }
  for (const m of texto.matchAll(/\b[àa]s\s+(\d{1,2})\s*h\b/gi)) {
    const h = Number(m[1]);
    if (h <= 23) out.push(h * 60);
  }
  return out;
}

const curto = (s: string, n = 100) => s.replace(/\s+/g, " ").slice(0, n);

type Msg = {
  role: string;
  content: string;
  meta: Record<string, unknown> | null;
  criado_em: string;
};

describe("turno pedido x turno ofertado", () => {
  it("mede", async () => {
    const desde = new Date(Date.now() - DIAS * 86400_000).toISOString();

    const { data: accs } = await sb.from("accounts").select("id, nome").ilike("nome", `%${CONTA}%`);
    const contas = (accs ?? []) as { id: string; nome: string }[];
    log(`contas: ${contas.map((c) => c.nome).join(", ") || "(nenhuma)"}`);
    log(`janela: últimos ${DIAS} dias (desde ${BR(desde)})\n`);
    if (contas.length === 0) {
      log("nenhuma conta casou com CONTA — nada a medir.");
      expect(true).toBe(true);
      return;
    }

    const { data: ags } = await sb
      .from("agents")
      .select("id")
      .in(
        "account_id",
        contas.map((c) => c.id),
      );
    const agentIds = ((ags ?? []) as { id: string }[]).map((a) => a.id);

    const { data: convs } = await sb
      .from("conversations")
      .select("id, phone, lead_phone")
      .in("agent_id", agentIds)
      .gte("atualizado_em", desde);

    let pedidos = 0;
    let respeitado = 0;
    let violado = 0;
    let semOferta = 0;
    const violacoes: string[] = [];
    const ok: string[] = [];
    const semVeredito: string[] = [];

    for (const c of (convs ?? []) as Record<string, unknown>[]) {
      const { data: msgs } = await sb
        .from("messages")
        .select("role, content, meta, criado_em")
        .eq("conversation_id", c.id as string)
        .gte("criado_em", desde)
        .order("criado_em", { ascending: true });
      const rows = ((msgs ?? []) as Msg[]).filter((m) => {
        const mm = m.meta ?? {};
        return mm.is_echo !== true && String(m.content ?? "").trim();
      });
      const tel = String(c.lead_phone ?? c.phone ?? "?");

      for (let i = 0; i < rows.length; i++) {
        const m = rows[i]!;
        if ((m.meta ?? {}).origem !== "lead") continue;
        const texto = String(m.content);
        if (!CITA_TURNO.test(texto)) continue;

        const pedido = requestedPeriodoFromText(texto);
        const proxima = rows
          .slice(i + 1)
          .find(
            (x) =>
              (x.meta ?? {}).origem === "agente" && horariosCitados(String(x.content)).length > 0,
          );

        if (!pedido) {
          // O código decidiu NÃO filtrar. Pode ser impedimento ("de manhã não
          // posso") ou menção solta ("boa tarde"). Sem veredito automático.
          semVeredito.push(
            `   ${BR(m.criado_em)} tel=${tel}\n      lead: ${JSON.stringify(curto(texto))}` +
              (proxima
                ? `\n      oferta: ${JSON.stringify(curto(String(proxima.content), 80))}`
                : `\n      (sem oferta depois)`),
          );
          continue;
        }

        pedidos++;
        if (!proxima) {
          semOferta++;
          continue;
        }
        const turnos = new Set(
          horariosCitados(String(proxima.content)).map((mi) => turnoDeMinutos(mi)),
        );
        const atendeu = turnos.has(pedido);
        const linha =
          `   ${BR(m.criado_em)} tel=${tel}  pedido=${pedido}  ofertado=${[...turnos].join("/")}\n` +
          `      lead: ${JSON.stringify(curto(texto))}\n` +
          `      oferta: ${JSON.stringify(curto(String(proxima.content)))}`;
        if (atendeu) {
          respeitado++;
          ok.push(`   ✅${linha.slice(3)}`);
        } else {
          violado++;
          violacoes.push(`   ❌${linha.slice(3)}`);
        }
      }
    }

    log(`── falas em que o código RECONHECEU pedido de turno: ${pedidos} ──`);
    log(`   oferta seguinte no turno pedido:  ${respeitado}`);
    log(`   oferta seguinte em OUTRO turno:   ${violado}`);
    log(`   sem oferta depois:                ${semOferta}`);
    log(`\n── falas citando turno SEM pedido reconhecido: ${semVeredito.length} ──`);
    log(`   (impedimento corretamente ignorado, ou menção solta — conferência humana)`);

    log(`\n── veredito ──`);
    if (pedidos === 0) {
      log(`⏳ Nenhum pedido de turno reconhecido na janela. Rodar com DIAS maior.`);
    } else if (violado === 0) {
      log(`✅ Todas as ${respeitado} ofertas caíram no turno que o lead pediu.`);
    } else {
      log(`⚠️  ${violado} de ${respeitado + violado} ofertas fora do turno pedido.`);
      log(`    Atenção: a oferta pode estar certa se o turno pedido não tinha vaga —`);
      log(`    conferir a agenda do dia antes de tratar como bug.`);
    }

    if (violacoes.length) {
      log(`\n── ofertas fora do turno pedido ──`);
      for (const l of violacoes) log(l);
    }
    if (ok.length) {
      log(`\n── ofertas no turno pedido ──`);
      for (const l of ok.slice(0, 15)) log(l);
    }
    if (semVeredito.length) {
      log(`\n── turno citado, sem pedido reconhecido (só listagem) ──`);
      for (const l of semVeredito.slice(0, 20)) log(l);
    }
    expect(true).toBe(true);
  }, 600_000);
});
