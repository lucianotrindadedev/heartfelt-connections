// Read-only: compara a category_description configurada com as categorias REAIS do Clinicorp.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-87-cat.txt");
const R: string[] = [];
const log = (l = "") => { R.push(l); fs.writeFileSync(OUT, `${R.join("\n")}\n`, "utf8"); };
function loadEnv() {
  const txt = fs.readFileSync(path.resolve(process.cwd(), ".env.production"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("="); const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
loadEnv();
const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const { listClinicorpCategories } = await import("@/lib/tools/clinicorp.server");
const sb = getSelfhost();

describe("categoria", () => {
  it("compara", async () => {
    const { data: acc } = await sb.from("accounts").select("id, nome").ilike("nome", "%Odonto Sorrisos%");
    for (const a of (acc ?? []) as { id: string; nome: string }[]) {
      log(`=== conta ${a.nome} (${a.id})`);
      const { data: cfg, error } = await sb.from("clinicorp_config")
        .select("subscriber_id, business_id, agenda_id, dentist_person_id, duracao_consulta, category_description, category_color, ativo, atualizado_em")
        .eq("account_id", a.id).maybeSingle();
      log(`cfg=${JSON.stringify(cfg)} erro=${JSON.stringify(error)}`);
      try {
        const cats = await listClinicorpCategories(a.id);
        log(`categorias REAIS no Clinicorp (${cats.length}):`);
        for (const c of cats) log(`   id=${c.id} description=${JSON.stringify(c.description)} color=${c.color}`);
        const cfgDesc = (cfg as Record<string, unknown> | null)?.category_description as string | null;
        const hit = cats.find((c) => c.description === cfgDesc);
        log(`\nconfigurada=${JSON.stringify(cfgDesc)} -> ${hit ? "EXISTE" : "*** NAO EXISTE na lista ***"}`);
        const ci = cats.find((c) => c.description?.toLowerCase().trim() === (cfgDesc ?? "").toLowerCase().trim());
        log(`match ignorando caixa/espaco: ${ci ? JSON.stringify(ci.description) : "nenhum"}`);
      } catch (e) {
        log(`falha ao listar categorias: ${String(e)}`);
      }
    }
    expect(true).toBe(true);
  }, 300_000);
});
