// Server functions de mídias do agente.
// Upload, listagem, exclusão. Mídias ficam no Supabase Storage (bucket público
// 'agent_media'). O LLM usa o `slug` para chamar a tool enviar_midia.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSelfhost } from "@/integrations/selfhost/client.server";

const BUCKET = "agent_media";

function storageBaseUrl(): string {
  const base = process.env.SELFHOST_SUPABASE_URL ?? "";
  return base.replace(/\/$/, "") + "/storage/v1";
}
function storageHeaders() {
  const k = process.env.SELFHOST_SUPABASE_SERVICE_ROLE_KEY ?? "";
  return { apikey: k, Authorization: `Bearer ${k}` };
}

function inferMediaType(mime: string): "image" | "video" | "audio" | "document" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

// ── Upload ────────────────────────────────────────────────────────────────

export const uploadAgentMedia = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        agentId: z.string().uuid(),
        filename: z.string().min(1).max(255),
        fileBase64: z.string().min(100),
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        slug: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();

    // 1. Decodifica base64
    const dataUriMatch = data.fileBase64.match(/^data:([^;]+);base64,(.*)$/);
    const mime = dataUriMatch?.[1] ?? "application/octet-stream";
    const base64 = dataUriMatch?.[2] ?? data.fileBase64;
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length < 50) throw new Error("Arquivo muito pequeno.");
    if (buffer.length > 50 * 1024 * 1024) throw new Error("Máximo 50MB por arquivo.");

    // 2. Slug auto se não veio (ou conflitar com existente, adiciona sufixo)
    const requestedSlug = data.slug ?? slugify(data.title);
    let finalSlug = requestedSlug;
    const existing = await sb
      .from("agent_media")
      .select("slug")
      .eq("agent_id", data.agentId)
      .like("slug", `${requestedSlug}%`);
    const existingSlugs = new Set((existing.data ?? []).map((r) => r.slug as string));
    if (existingSlugs.has(finalSlug)) {
      let n = 2;
      while (existingSlugs.has(`${requestedSlug}_${n}`)) n++;
      finalSlug = `${requestedSlug}_${n}`;
    }

    // 3. Upload para Storage
    const ext = (data.filename.split(".").pop() || "bin").toLowerCase().slice(0, 8);
    const storagePath = `${data.agentId}/${Date.now()}_${finalSlug}.${ext}`;
    const upRes = await fetch(
      `${storageBaseUrl()}/object/${BUCKET}/${storagePath}`,
      {
        method: "POST",
        headers: {
          ...storageHeaders(),
          "Content-Type": mime,
          "x-upsert": "true",
        },
        body: buffer,
      },
    );
    if (!upRes.ok) {
      const err = await upRes.text();
      throw new Error(`Falha no upload: ${upRes.status} ${err.slice(0, 200)}`);
    }

    const publicUrl = `${storageBaseUrl()}/object/public/${BUCKET}/${storagePath}`;

    // 4. Cria registro
    const ins = await sb
      .from("agent_media")
      .insert({
        agent_id: data.agentId,
        slug: finalSlug,
        title: data.title,
        description: data.description ?? null,
        file_url: publicUrl,
        storage_path: storagePath,
        mime_type: mime,
        file_size: buffer.length,
        media_type: inferMediaType(mime),
      })
      .select("id, slug, file_url, media_type")
      .single();
    if (ins.error || !ins.data) {
      // tenta limpar o arquivo já uploadado
      await fetch(`${storageBaseUrl()}/object/${BUCKET}/${storagePath}`, {
        method: "DELETE",
        headers: storageHeaders(),
      }).catch(() => {});
      throw new Error(ins.error?.message ?? "Falha ao criar registro.");
    }

    return {
      id: ins.data.id as string,
      slug: ins.data.slug as string,
      file_url: ins.data.file_url as string,
      media_type: ins.data.media_type as string,
    };
  });

// ── List ──────────────────────────────────────────────────────────────────

export const listAgentMedia = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ agentId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const res = await sb
      .from("agent_media")
      .select(
        "id, slug, title, description, file_url, media_type, mime_type, file_size, criado_em",
      )
      .eq("agent_id", data.agentId)
      .order("criado_em", { ascending: false });
    if (res.error) throw new Error(res.error.message);
    return { media: res.data ?? [] };
  });

// ── Update (slug, título, descrição) ──────────────────────────────────────

export const updateAgentMedia = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        slug: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_-]+$/i)
          .optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { id, ...patch } = data;
    const res = await sb.from("agent_media").update(patch).eq("id", id);
    if (res.error) throw new Error(res.error.message);
    return { ok: true };
  });

// ── Delete (registro + arquivo no storage) ────────────────────────────────

export const deleteAgentMedia = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();

    // Pega storage_path
    const row = await sb
      .from("agent_media")
      .select("storage_path")
      .eq("id", data.id)
      .maybeSingle();
    const path = row.data?.storage_path as string | null;

    // Apaga registro
    const del = await sb.from("agent_media").delete().eq("id", data.id);
    if (del.error) throw new Error(del.error.message);

    // Apaga arquivo (best-effort)
    if (path) {
      await fetch(`${storageBaseUrl()}/object/${BUCKET}/${path}`, {
        method: "DELETE",
        headers: storageHeaders(),
      }).catch((e) => console.warn("[media] falha ao deletar do storage:", e));
    }

    return { ok: true };
  });
