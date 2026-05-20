import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { attachSelfhostAuth } from "@/integrations/selfhost/auth-attacher";
import { requireSuperAdmin } from "@/integrations/selfhost/auth-middleware";
import { getSelfhost } from "@/integrations/selfhost/client.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IntegrationType = "clinicorp" | "google_calendar" | "clinup" | null;

const INTEGRATION_TYPES = ["clinicorp", "google_calendar", "clinup", ""] as const;

const templateShape = z.object({
  nome: z.string().min(1).max(200),
  descricao: z.string().max(1000).default(""),
  cover_url: z.string().max(500).default(""),
  system_prompt: z.string().max(50000).default(""),
  integration_type: z.enum(INTEGRATION_TYPES).default(""),
  categoria: z.string().max(100).default("geral"),
  ordem: z.number().int().min(0).default(0),
  ativo: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Public — no auth (embed uses these)
// ---------------------------------------------------------------------------

export const listTemplates = createServerFn({ method: "GET" }).handler(async () => {
  const sb = getSelfhost();
  const { data, error } = await sb
    .from("prompt_templates")
    .select("id, nome, descricao, cover_url, system_prompt, integration_type, categoria, ordem")
    .eq("ativo", true)
    .order("ordem", { ascending: true })
    .order("criado_em", { ascending: true });
  if (error) throw new Error(error.message);
  return { templates: data ?? [] };
});

// ---------------------------------------------------------------------------
// Superadmin — CRUD
// ---------------------------------------------------------------------------

export const listAllTemplates = createServerFn({ method: "GET" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .handler(async () => {
    const sb = getSelfhost();
    const { data, error } = await sb
      .from("prompt_templates")
      .select("*")
      .order("ordem", { ascending: true })
      .order("criado_em", { ascending: false });
    if (error) throw new Error(error.message);
    return { templates: data ?? [] };
  });

export const createTemplate = createServerFn({ method: "POST" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .inputValidator((d) => templateShape.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: row, error } = await sb
      .from("prompt_templates")
      .insert({
        nome: data.nome,
        descricao: data.descricao,
        cover_url: data.cover_url || null,
        system_prompt: data.system_prompt,
        integration_type: data.integration_type || null,
        categoria: data.categoria,
        ordem: data.ordem,
        ativo: data.ativo,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id };
  });

export const updateTemplate = createServerFn({ method: "POST" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .inputValidator((d) =>
    z
      .object({ id: z.string().uuid() })
      .merge(templateShape)
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { error } = await sb
      .from("prompt_templates")
      .update({
        nome: data.nome,
        descricao: data.descricao,
        cover_url: data.cover_url || null,
        system_prompt: data.system_prompt,
        integration_type: data.integration_type || null,
        categoria: data.categoria,
        ordem: data.ordem,
        ativo: data.ativo,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteTemplate = createServerFn({ method: "POST" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { error } = await sb.from("prompt_templates").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
