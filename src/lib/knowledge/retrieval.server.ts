// Busca por similaridade na base de conhecimento de um agente.
// Usa pgvector com índice HNSW e operador <=> (cosine distance).

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { embedText, vectorLiteral } from "@/lib/knowledge/embedder.server";

export interface RetrievedChunk {
  chunk_text: string;
  ordem: number;
  doc_title: string | null;
  source_type: string;
  source_ref: string | null;
  similarity: number; // 0..1 (1 = idêntico)
}

const DEFAULT_TOP_K = 5;
const MIN_SIMILARITY = 0.25; // descarta chunks muito distantes

/**
 * Busca os top-K chunks mais similares à `query` na base do agente.
 * Retorna [] se o agente não tem base ou se nada bate o threshold.
 *
 * Trata erros silenciosamente — RAG é "best effort"; se a busca falhar
 * o agente segue sem o contexto extra (não quebra o atendimento).
 */
export async function searchKnowledge(
  agentId: string,
  query: string,
  topK: number = DEFAULT_TOP_K,
): Promise<RetrievedChunk[]> {
  if (!query.trim() || !agentId) return [];

  try {
    const sb = getSelfhost();

    // 1. Verifica se o agente tem chunks indexados (early-out barato)
    const { count } = await sb
      .from("knowledge_chunks")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agentId);
    if (!count || count === 0) return [];

    // 2. Embedding da query
    const qVec = await embedText(query);
    const qLiteral = vectorLiteral(qVec);

    // 3. Busca top-K por cosine distance via RPC ou query SQL
    //    Como o supabase-js não suporta operadores de vector diretamente,
    //    usamos uma RPC ou rpc/sql.
    //    Aqui usamos a função rpc 'search_knowledge_chunks' se existir;
    //    senão fallback para query direta via pg/query.
    const sql = `
      select c.chunk_text, c.ordem, d.title as doc_title, d.source_type, d.source_ref,
             1 - (c.embedding <=> '${qLiteral}'::vector) as similarity
      from public.knowledge_chunks c
      join public.knowledge_documents d on d.id = c.document_id
      where c.agent_id = '${agentId}'
        and d.status = 'ready'
        and (d.review_status = 'approved' or
             (d.review_status = 'quarantine' and d.quarantine_until is not null and d.quarantine_until <= now()))
      order by c.embedding <=> '${qLiteral}'::vector
      limit ${topK};
    `;

    const PG_URL = process.env.SELFHOST_SUPABASE_URL ?? "";
    const KEY = process.env.SELFHOST_SUPABASE_SERVICE_ROLE_KEY ?? "";
    const res = await fetch(`${PG_URL}/pg/query`, {
      method: "POST",
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.warn(`[rag] search failed ${res.status}`);
      return [];
    }

    const rows = (await res.json()) as RetrievedChunk[];
    return rows.filter((r) => r.similarity >= MIN_SIMILARITY);
  } catch (e) {
    console.warn("[rag] searchKnowledge falhou:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** Formata os chunks recuperados como bloco markdown pra injetar no system prompt. */
export function formatChunksAsContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  const lines = ["# 📚 BASE DE CONHECIMENTO (contexto recuperado)\n"];
  lines.push(
    "Trechos da base de conhecimento desta conta que podem ser relevantes para a pergunta do lead. Use APENAS se realmente couber — não force o uso, e não invente nada que não esteja aqui.\n",
  );
  for (const c of chunks) {
    const src = c.doc_title ?? c.source_ref ?? "documento";
    lines.push(`---\n**Fonte:** ${src} (similaridade ${(c.similarity * 100).toFixed(0)}%)\n\n${c.chunk_text}\n`);
  }
  return lines.join("\n");
}
