// GET /api/public/diag/knowledge?secret=...&agent_id=<uuid>[&q=<pergunta>]
//
// Diagnóstico da base de conhecimento (RAG) de um agente:
// - Lista os documentos com status, nº de chunks, chars e erro de indexação.
// - Conta chunks indexados do agente.
// - Se `q` for passado, roda a busca semântica real e retorna os trechos +
//   similaridade — para confirmar se o RAG recupera algo para uma pergunta.
//
// Útil quando: "subi PDFs na base mas o agente não puxa os dados".

import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { searchKnowledge } from "@/lib/knowledge/retrieval.server";

function validateSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const url = new URL(request.url);
  return (
    request.headers.get("x-cron-secret") === secret ||
    url.searchParams.get("secret") === secret
  );
}

export const Route = createFileRoute("/api/public/diag/knowledge")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!validateSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const url = new URL(request.url);
        const agentId = url.searchParams.get("agent_id")?.trim();
        const q = url.searchParams.get("q")?.trim();

        const sb = getSelfhost();

        // Modo descoberta: sem agent_id, lista quais agentes TÊM documentos na
        // base — para achar onde os PDFs foram realmente parar.
        if (!agentId) {
          const { data: allDocs } = await sb
            .from("knowledge_documents")
            .select("agent_id, status")
            .limit(5000);
          const counts = new Map<string, { docs: number; ready: number }>();
          for (const d of allDocs ?? []) {
            const id = d.agent_id as string;
            const cur = counts.get(id) ?? { docs: 0, ready: 0 };
            cur.docs++;
            if (d.status === "ready") cur.ready++;
            counts.set(id, cur);
          }
          const ids = [...counts.keys()];
          const { data: agents } = ids.length
            ? await sb.from("agents").select("id, nome, account_id").in("id", ids)
            : { data: [] as { id: string; nome: string; account_id: string }[] };
          const nameById = new Map((agents ?? []).map((a) => [a.id as string, a]));
          return Response.json({
            ok: true,
            mode: "discovery",
            agentes_com_base: ids.map((id) => ({
              agent_id: id,
              nome: nameById.get(id)?.nome ?? "(agente não encontrado)",
              account_id: nameById.get(id)?.account_id ?? null,
              docs: counts.get(id)!.docs,
              docs_ready: counts.get(id)!.ready,
            })),
          });
        }

        // 1. Documentos do agente
        const { data: docs, error: docsErr } = await sb
          .from("knowledge_documents")
          .select(
            "id, title, source_type, source_ref, status, review_status, quarantine_until, total_chunks, total_chars, error, criado_em",
          )
          .eq("agent_id", agentId)
          .order("criado_em", { ascending: false })
          .limit(200);
        if (docsErr) {
          return Response.json({ ok: false, error: docsErr.message }, { status: 500 });
        }

        // 2. Total de chunks indexados do agente
        const { count: chunkCount } = await sb
          .from("knowledge_chunks")
          .select("id", { count: "exact", head: true })
          .eq("agent_id", agentId);

        // 3. Resumo por status
        const byStatus: Record<string, number> = {};
        const byReview: Record<string, number> = {};
        for (const d of docs ?? []) {
          const s = (d.status as string) ?? "?";
          const r = (d.review_status as string) ?? "?";
          byStatus[s] = (byStatus[s] ?? 0) + 1;
          byReview[r] = (byReview[r] ?? 0) + 1;
        }

        // 4. Teste de busca real (opcional)
        let search:
          | { query: string; retrieved: number; chunks: { fonte: string | null; similaridade: number; preview: string }[] }
          | null = null;
        if (q) {
          const chunks = await searchKnowledge(agentId, q, 5);
          search = {
            query: q,
            retrieved: chunks.length,
            chunks: chunks.map((c) => ({
              fonte: c.doc_title ?? c.source_ref,
              similaridade: Math.round(c.similarity * 100) / 100,
              preview: c.chunk_text.slice(0, 160),
            })),
          };
        }

        // 5. Diagnóstico textual
        const total = docs?.length ?? 0;
        const ready = byStatus["ready"] ?? 0;
        const failed = byStatus["failed"] ?? 0;
        let verdict: string;
        if (total === 0) verdict = "Nenhum documento na base deste agente (agent_id errado?).";
        else if ((chunkCount ?? 0) === 0)
          verdict = "Documentos existem mas NENHUM chunk foi indexado — extração falhou (ex.: PDF escaneado/sem texto). Veja os docs com status=failed e o campo error.";
        else if (ready === 0)
          verdict = "Nenhum documento com status=ready — todos pendentes ou falharam. RAG não recupera nada.";
        else if (failed > 0)
          verdict = `${ready} doc(s) ok, mas ${failed} falharam na indexação (ver error). Os que falharam não são recuperados.`;
        else verdict = `${ready} doc(s) prontos e ${chunkCount} chunk(s) indexados. Se ainda não puxa, teste com ?q= e veja a similaridade (threshold mínimo 0.25).`;

        return Response.json({
          ok: true,
          agent_id: agentId,
          total_docs: total,
          chunk_count: chunkCount ?? 0,
          by_status: byStatus,
          by_review_status: byReview,
          verdict,
          docs: (docs ?? []).map((d) => ({
            title: d.title,
            source_type: d.source_type,
            status: d.status,
            review_status: d.review_status,
            total_chunks: d.total_chunks,
            total_chars: d.total_chars,
            error: d.error,
          })),
          search,
        });
      },
    },
  },
});
