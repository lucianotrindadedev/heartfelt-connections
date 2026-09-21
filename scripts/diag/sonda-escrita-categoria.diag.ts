// ⚠️ ESCREVE EM PRODUÇÃO — o único diag deste projeto que não é somente leitura.
// Autorizado explicitamente pelo usuário em 21/09/2026 para confirmar o PR #49
// sem esperar um lead real passar pelo fluxo.
//
// O que faz, contra a agenda REAL da Odonto Sorrisos:
//   1. cria um agendamento num horário livre a ~5 semanas (último do dia)
//   2. observa os POSTs do create: espera 400 de categoria e reenvio SEM ela
//   3. CANCELA, em finally — cancela mesmo se a verificação falhar
//   4. confere pela agenda que o cancelamento pegou
//
// Deixa um rastro conhecido: o cadastro de paciente "TESTE INTEGRACAO CLAUDE"
// (87 99999-9999). A API não expõe exclusão de paciente — apagar à mão.
//
// Só roda com SONDA_CONFIRMO=sim.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-sonda-escrita.txt");
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

const mod = await import("@/lib/tools/clinicorp.server");
const ACC = "ba2a7d4d-7ff9-4eca-9378-8bc8ebb8412b"; // Odonto Sorrisos
const SLOT = process.env.SONDA_SLOT || "2026-10-26T18:00:00-03:00";
const TEL_TESTE = "87999999999";
// No fluxo real o profissional vem do slot ofertado (offered_slots[].
// dentist_person_id). A config da conta tem dentist_person_id=null, entao sem
// passar isso o create volta "E necessario informar dados de Profissional".
const DENTISTA = Number(process.env.SONDA_DENTISTA || 5439082296508417);
const NOME_TESTE = "TESTE INTEGRACAO CLAUDE";

// Espelha os POSTs do create para provar o reenvio (sem alterar o comportamento).
const posts: { temCategoria: boolean; status: number; corpo: string }[] = [];
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const res = await fetchOriginal(url as string, init);
  if (String(url).includes("create_appointment_by_api")) {
    const enviado = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const clone = res.clone();
    posts.push({
      temCategoria: enviado.CategoryDescription !== undefined,
      status: res.status,
      corpo: (await clone.text()).slice(0, 160),
    });
  }
  return res;
}) as typeof fetch;

describe("SONDA (escreve em produção)", () => {
  it("cria, confirma o reenvio sem categoria e cancela", async () => {
    if (process.env.SONDA_CONFIRMO !== "sim") {
      log("abortado: rode com SONDA_CONFIRMO=sim para escrever em produção.");
      return;
    }

    log(`slot alvo: ${SLOT}`);
    log(`paciente:  ${NOME_TESTE} / ${TEL_TESTE}\n`);

    let apptId: number | string | null = null;
    try {
      const r = await mod.createClinicorpAppointment(ACC, {
        phone: TEL_TESTE,
        name: NOME_TESTE,
        datetime: SLOT,
        dentistPersonId: DENTISTA,
        notes: "SONDA AUTOMATICA - IGNORAR - sera cancelada em segundos",
      });
      apptId = r.id;
      log(`✅ create devolveu id=${r.id} datetime=${r.datetime}`);

      log(`\n── POSTs no create_appointment_by_api: ${posts.length}`);
      for (const [i, p] of posts.entries()) {
        log(`   ${i + 1}. categoria=${p.temCategoria ? "SIM" : "não"} status=${p.status} ${p.corpo}`);
      }

      const comCat = posts.filter((p) => p.temCategoria);
      const semCat = posts.filter((p) => !p.temCategoria);
      log("\n── leitura ──");
      if (comCat.some((p) => p.status === 400) && semCat.some((p) => p.status < 400)) {
        log("✅ CONFIRMADO: o Clinicorp recusou a categoria (400) e o reenvio SEM ela agendou.");
      } else if (comCat.some((p) => p.status < 400)) {
        log("ℹ️  O Clinicorp ACEITOU a categoria desta vez — o bug não reproduziu agora.");
      } else {
        log("⚠️  Sequência inesperada — ver os POSTs acima.");
      }
    } catch (e) {
      log(`❌ create falhou: ${String(e).slice(0, 300)}`);
      log(`\n── POSTs: ${posts.length}`);
      for (const [i, p] of posts.entries()) {
        log(`   ${i + 1}. categoria=${p.temCategoria ? "SIM" : "não"} status=${p.status} ${p.corpo}`);
      }
    } finally {
      // Cancela SEMPRE que houve criação, dê no que der acima.
      if (apptId) {
        const c = await mod.cancelClinicorpAppointment(ACC, apptId, "sonda automatica");
        log(`\n── cancelamento: ok=${c.ok} ${c.message}`);

        // Confere pela agenda que sumiu de verdade.
        const dia = SLOT.slice(0, 10);
        const restantes = await mod.listClinicorpUpcomingAppointments(ACC, dia, dia);
        const aindaLa = restantes.filter((a) => String(a.id) === String(apptId));
        log(
          aindaLa.length === 0
            ? `✅ conferido na agenda de ${dia}: o agendamento ${apptId} não está mais lá.`
            : `❌ ATENÇÃO: ${apptId} AINDA aparece na agenda de ${dia} — cancelar à mão!`,
        );
      } else {
        log("\n── nada a cancelar (nenhum agendamento chegou a ser criado).");
      }
      globalThis.fetch = fetchOriginal;
    }
    expect(true).toBe(true);
  }, 300_000);
});
