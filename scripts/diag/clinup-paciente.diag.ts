// VALIDAÇÃO DO FLUXO DE PACIENTE DO CLINUP — busca → cria → usa o id.
//
//   npx vitest run --config scripts/diag/vitest.diag.config.ts scripts/diag/clinup-paciente.diag.ts
//
// Roda o findClinupPatient DE PRODUÇÃO (não uma réplica) contra a conta que
// está configurada no banco. Somente LEITURA: exercita a metade "buscar" do
// fluxo. A metade "criar" não é testada aqui de propósito — criaria cadastro
// real na clínica, que foi exatamente o estrago do bug de 28/07.
//
// A conta-alvo é a primeira com clinup_config.ativo=true.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";

function loadEnv() {
  const txt = fs.readFileSync(path.resolve(process.cwd(), ".env.production"), "utf8");
  for (const l of txt.split(/\r?\n/)) {
    if (!l || l.startsWith("#") || !l.includes("=")) continue;
    const i = l.indexOf("=");
    const k = l.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const { findClinupPatient } = await import("@/lib/tools/clinup.server");

const sb = getSelfhost();
let accountId = "";

beforeAll(async () => {
  const { data } = await sb
    .from("clinup_config")
    .select("account_id")
    .eq("ativo", true)
    .limit(1)
    .maybeSingle();
  accountId = (data?.account_id as string) ?? "";
});

/** Telefone com cadastro conhecido. Sem ele, os testes viram no-op. */
const TEL = process.env.CLINUP_TEL_TESTE ?? "";

describe("Clinup — fluxo de paciente antes do agendamento", () => {
  it("há uma conta Clinup ativa para testar", () => {
    expect(accountId, "nenhuma conta com clinup_config.ativo=true").toBeTruthy();
    console.log(`\n  conta: ${accountId}`);
  });

  it("acha o paciente pelo NOME quando o telefone tem vários cadastros", async () => {
    if (!TEL) return;
    const nome = process.env.CLINUP_NOME_TESTE ?? "";
    if (!nome) {
      console.log("  (defina CLINUP_NOME_TESTE para checar a escolha por nome)");
      return;
    }
    const p = await findClinupPatient(accountId, TEL, nome);
    console.log(`  buscar("${nome}", ${TEL}) → ${p ? `id=${p.id} nome="${p.name}"` : "null"}`);
    expect(p, "não encontrou — o agendamento criaria um cadastro novo").toBeTruthy();
    // O nome do cadastro escolhido tem que bater com o pedido. Este é o teste
    // que pega o bug de 28/07: o telefone tinha 7 cadastros e a busca devolvia
    // o primeiro ("Maria do Carmo") para um lead chamado outra coisa.
    const norm = (s: string) =>
      s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
    expect(
      norm(p!.name).includes(norm(nome).split(" ")[0]!),
      `escolheu "${p!.name}" para um lead chamado "${nome}" — agendaria na pessoa errada`,
    ).toBe(true);
  }, 60_000);

  it("devolve null para um nome que NÃO tem cadastro (→ o fluxo cria)", async () => {
    if (!TEL) return;
    const p = await findClinupPatient(accountId, TEL, "Zoraide Nascimento Improvável");
    console.log(`  buscar("Zoraide…", ${TEL}) → ${p ? `id=${p.id}` : "null (correto: vai criar)"}`);
    expect(
      p,
      "reaproveitou o cadastro de outra pessoa — a consulta iria para a ficha errada",
    ).toBeNull();
  }, 60_000);

  it("sem nome, devolve algum cadastro do telefone (uso informativo)", async () => {
    if (!TEL) return;
    const p = await findClinupPatient(accountId, TEL);
    console.log(`  buscar(sem nome, ${TEL}) → ${p ? `id=${p.id} nome="${p.name}"` : "null"}`);
    expect(p?.id).toBeTruthy();
  }, 60_000);

  it("telefone sem nenhum cadastro devolve null", async () => {
    const p = await findClinupPatient(accountId, "21999999999", "Fulano de Tal");
    console.log(`  buscar(telefone inexistente) → ${p ? `id=${p.id}` : "null (correto)"}`);
    expect(p).toBeNull();
  }, 60_000);
});
