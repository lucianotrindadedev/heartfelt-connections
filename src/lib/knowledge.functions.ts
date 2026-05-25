// Server functions da Base de Conhecimento (RAG).
//
// Endpoints:
//   - addUrlDocument:   indexa uma URL (síncrono — para PDFs pequenos/sites OK)
//   - addPdfDocument:   recebe arquivo em base64 e indexa
//   - listKnowledgeDocuments: lista documentos do agente
//   - deleteKnowledgeDocument: apaga doc + chunks (cascade)
//   - reindexDocument:  refaz o indexing de um doc existente

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { chunkText } from "@/lib/knowledge/chunker";
import { extractFromUrl, extractFromPdf } from "@/lib/knowledge/extractors.server";
import { embedTexts, vectorLiteral } from "@/lib/knowledge/embedder.server";

const PG_URL = () => process.env.SELFHOST_SUPABASE_URL ?? "";
const PG_KEY = () => process.env.SELFHOST_SUPABASE_SERVICE_ROLE_KEY ?? "";

// ── Index pipeline (chamado internamente) ─────────────────────────────────

interface IndexInput {
  documentId: string;
  agentId: string;
  text: string;
}

async function indexDocument({ documentId, agentId, text }: IndexInput): Promise<{
  chunks: number;
  preview: string;
}> {
  const sb = getSelfhost();

  // Marca como indexing
  await sb
    .from("knowledge_documents")
    .update({ status: "indexing", total_chars: text.length })
    .eq("id", documentId);

  // 1. Chunking
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    throw new Error("Texto resultou em 0 chunks (muito curto).");
  }

  // 2. Embeddings em batch
  const embeddings = await embedTexts(chunks.map((c) => c.text));
  if (embeddings.length !== chunks.length) {
    throw new Error(`Mismatch chunks (${chunks.length}) vs embeddings (${embeddings.length}).`);
  }

  // 3. Inserir chunks (via pg/query para usar pgvector)
  // Usamos um INSERT em batch construído como SQL para passar os vetores como literal.
  const valueRows = chunks
    .map((c, i) => {
      const safeText = c.text.replace(/'/g, "''");
      const vec = vectorLiteral(embeddings[i]);
      return `('${documentId}'::uuid, '${agentId}'::uuid, ${c.ordem}, '${safeText}', ${c.estimatedTokens}, '${vec}'::vector)`;
    })
    .join(",\n");

  const sql = `
    insert into public.knowledge_chunks (document_id, agent_id, ordem, chunk_text, token_count, embedding)
    values ${valueRows};
  `;

  const res = await fetch(`${PG_URL()}/pg/query`, {
    method: "POST",
    headers: {
      apikey: PG_KEY(),
      Authorization: `Bearer ${PG_KEY()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Falha ao inserir chunks: ${res.status} ${err.slice(0, 200)}`);
  }

  // 4. Atualiza doc
  const preview = text.slice(0, 500);
  await sb
    .from("knowledge_documents")
    .update({
      status: "ready",
      total_chunks: chunks.length,
      content_preview: preview,
      error: null,
    })
    .eq("id", documentId);

  return { chunks: chunks.length, preview };
}

// ── Adicionar URL ──────────────────────────────────────────────────────────

export const addUrlDocument = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        agentId: z.string().uuid(),
        url: z.string().url(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();

    // 1. Cria registro pending
    const ins = await sb
      .from("knowledge_documents")
      .insert({
        agent_id: data.agentId,
        source_type: "url",
        source_ref: data.url,
        title: data.url,
        status: "pending",
      })
      .select("id")
      .single();
    if (ins.error || !ins.data) throw new Error(ins.error?.message ?? "Falha ao criar doc.");
    const docId = ins.data.id as string;

    try {
      // 2. Extrai
      const { title, text } = await extractFromUrl(data.url);
      await sb.from("knowledge_documents").update({ title }).eq("id", docId);

      // 3. Indexa
      const result = await indexDocument({ documentId: docId, agentId: data.agentId, text });
      return { ok: true, document_id: docId, chunks: result.chunks };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sb
        .from("knowledge_documents")
        .update({ status: "failed", error: msg.slice(0, 500) })
        .eq("id", docId);
      throw new Error(msg);
    }
  });

// ── Adicionar PDF ──────────────────────────────────────────────────────────

export const addPdfDocument = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        agentId: z.string().uuid(),
        filename: z.string().min(1).max(255),
        fileBase64: z.string().min(100, "Arquivo muito pequeno"),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();

    // 1. Decodifica base64 → Buffer
    const base64 = data.fileBase64.replace(/^data:application\/pdf;base64,/, "");
    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64, "base64");
    } catch {
      throw new Error("Base64 inválido.");
    }
    if (buffer.length < 100) throw new Error("Arquivo muito pequeno.");
    if (buffer.length > 25 * 1024 * 1024) throw new Error("Arquivo maior que 25MB.");

    // 2. Cria registro pending
    const ins = await sb
      .from("knowledge_documents")
      .insert({
        agent_id: data.agentId,
        source_type: "pdf",
        source_ref: data.filename,
        title: data.filename,
        status: "pending",
      })
      .select("id")
      .single();
    if (ins.error || !ins.data) throw new Error(ins.error?.message ?? "Falha ao criar doc.");
    const docId = ins.data.id as string;

    try {
      const { title, text } = await extractFromPdf(buffer);
      await sb
        .from("knowledge_documents")
        .update({ title: title || data.filename })
        .eq("id", docId);

      const result = await indexDocument({ documentId: docId, agentId: data.agentId, text });
      return { ok: true, document_id: docId, chunks: result.chunks };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sb
        .from("knowledge_documents")
        .update({ status: "failed", error: msg.slice(0, 500) })
        .eq("id", docId);
      throw new Error(msg);
    }
  });

// ── Listar documentos ──────────────────────────────────────────────────────

export const listKnowledgeDocuments = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ agentId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const res = await sb
      .from("knowledge_documents")
      .select(
        "id, source_type, source_ref, title, status, content_preview, total_chars, total_chunks, error, criado_em",
      )
      .eq("agent_id", data.agentId)
      .order("criado_em", { ascending: false });
    if (res.error) throw new Error(res.error.message);
    return { documents: res.data ?? [] };
  });

// ── Apagar documento (cascade nos chunks) ──────────────────────────────────

export const deleteKnowledgeDocument = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        documentId: z.string().uuid(),
        agentId: z.string().uuid(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { error } = await sb
      .from("knowledge_documents")
      .delete()
      .eq("id", data.documentId)
      .eq("agent_id", data.agentId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
