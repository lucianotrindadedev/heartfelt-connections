// Auto-distillation de FAQs: lê conversas recentes, agrupa perguntas
// frequentes, gera FAQ canônica via LLM cheap (Gemini Flash), checa
// duplicatas via embedding, detecta PII e insere em knowledge_documents
// com review_status apropriado.
//
// Não rodar direto — usar via /api/public/cron/knowledge-distiller.

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { callLlm } from "@/lib/agents/llm.server";
import { decryptValue } from "@/lib/crypto.server";
import { embedText, vectorLiteral, embedTexts } from "@/lib/knowledge/embedder.server";
import { chunkText } from "@/lib/knowledge/chunker";

// ──────────────────────────────────────────────────────────────────
// PII detection — regex simples (sem ML). Bloqueia FAQs com dados
// pessoais antes de virarem chunks.
// ──────────────────────────────────────────────────────────────────

const PII_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // CPF (xxx.xxx.xxx-xx ou só dígitos)
  { name: "cpf", re: /\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/ },
  // CNPJ
  { name: "cnpj", re: /\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2}\b/ },
  // Telefone BR
  { name: "phone", re: /\b\(?(?:\+55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/ },
  // Email
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  // Data de nascimento (dd/mm/aaaa)
  { name: "birthdate", re: /\b\d{2}\/\d{2}\/(?:19|20)\d{2}\b/ },
];

export function detectPii(text: string): string[] {
  const hits: string[] = [];
  for (const p of PII_PATTERNS) {
    if (p.re.test(text)) hits.push(p.name);
  }
  return hits;
}

// ──────────────────────────────────────────────────────────────────
// Tipos
// ──────────────────────────────────────────────────────────────────

interface QAPair {
  question: string;        // user msg
  answer: string;          // assistant reply
  conversationId: string;
  questionAt: string;      // ISO
}

interface ExtractedFAQ {
  question_canonical: string;
  answer_canonical: string;
  frequency: number;
  confidence: number;       // 0..1 — quão certo o LLM está
  source_conversation_ids: string[];
}

export interface DistillerConfig {
  min_frequency: number;
  min_confidence: number;
  quarantine_hours: number;
  max_auto_approve_per_run: number;
}

export interface DistillerResult {
  conversations_scanned: number;
  q_and_a_pairs: number;
  clusters_found: number;
  faqs_extracted: number;
  faqs_auto_approved: number;
  faqs_pending: number;
  faqs_duplicates: number;
  faqs_pii_blocked: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
}

// ──────────────────────────────────────────────────────────────────
// Extração de pares Q&A das conversas
// ──────────────────────────────────────────────────────────────────

async function extractQAPairs(
  agentId: string,
  sinceISO: string,
): Promise<{ pairs: QAPair[]; conversationIds: string[] }> {
  const sb = getSelfhost();

  // Conversas do agente que receberam msg do user no período
  const convs = await sb
    .from("conversations")
    .select("id")
    .eq("agent_id", agentId)
    .gte("atualizado_em", sinceISO)
    .limit(500);
  if (!convs.data?.length) return { pairs: [], conversationIds: [] };

  const conversationIds = convs.data.map((c) => c.id as string);

  const msgs = await sb
    .from("messages")
    .select("conversation_id, role, content, criado_em, meta")
    .in("conversation_id", conversationIds)
    .gte("criado_em", sinceISO)
    .order("criado_em", { ascending: true });
  if (!msgs.data?.length) return { pairs: [], conversationIds };

  // Para cada conversa, junta msgs em ordem; cada user msg seguida por
  // assistant msg vira um par. Pula fallbacks e msgs do follow-up.
  const byConv = new Map<string, typeof msgs.data>();
  for (const m of msgs.data) {
    const k = m.conversation_id as string;
    const arr = byConv.get(k) ?? [];
    arr.push(m);
    byConv.set(k, arr);
  }

  const pairs: QAPair[] = [];
  for (const [convId, msgsConv] of byConv) {
    for (let i = 0; i < msgsConv.length - 1; i++) {
      const cur = msgsConv[i];
      const nxt = msgsConv[i + 1];
      if (cur.role !== "user" || nxt.role !== "assistant") continue;
      const meta = (nxt.meta as Record<string, unknown> | null) ?? {};
      if (meta.fallback === true) continue;
      if (meta.origem === "followup") continue;
      const q = String(cur.content ?? "").trim();
      const a = String(nxt.content ?? "").trim();
      if (q.length < 5 || a.length < 10) continue;
      // ignora saudações / confirmações curtas
      if (/^(oi|olá|ola|ok|certo|sim|não|nao|valeu|obrigad[oa])[.!?\s]*$/i.test(q)) continue;
      pairs.push({
        question: q,
        answer: a,
        conversationId: convId,
        questionAt: String(cur.criado_em),
      });
    }
  }

  return { pairs, conversationIds };
}

// ──────────────────────────────────────────────────────────────────
// Clusterização + extração de FAQs via LLM
// ──────────────────────────────────────────────────────────────────

async function clusterAndExtract(
  orKey: string,
  model: string,
  pairs: QAPair[],
  minFrequency: number,
): Promise<{ faqs: ExtractedFAQ[]; tokensIn: number; tokensOut: number; costUsd: number }> {
  if (pairs.length < minFrequency) {
    return { faqs: [], tokensIn: 0, tokensOut: 0, costUsd: 0 };
  }

  // Limita pares pra não estourar contexto (top 200 mais recentes)
  const sample = pairs.slice(-200);

  const numbered = sample
    .map((p, i) => `[${i}] Q: ${p.question.slice(0, 300)}\n   A: ${p.answer.slice(0, 500)}`)
    .join("\n\n");

  const systemPrompt = `Você é um analista que identifica PERGUNTAS FREQUENTES em conversas de atendimento.

Recebe uma lista de pares (Q, A) numerados. Identifica clusters de perguntas que se repetem (semanticamente similares) ${minFrequency}+ vezes e gera uma FAQ canônica para cada cluster.

Critérios obrigatórios:
- Frequência mínima por cluster: ${minFrequency}
- Confiança da resposta: avalia se as respostas dadas no cluster são CONSISTENTES entre si. Se sim, confidence alto (0.9+). Se há discrepâncias, confidence baixo.
- NÃO inclua FAQs que contenham dados pessoais (nome próprio, telefone, CPF, email, data nascimento).
- A "resposta canônica" deve ser uma síntese clara das melhores respostas do cluster — concisa, em PT-BR, em 2-4 frases.

Responda APENAS com JSON neste formato:
{
  "faqs": [
    {
      "question_canonical": "string clara em PT-BR",
      "answer_canonical": "string em 2-4 frases",
      "frequency": int (quantos pares do cluster),
      "confidence": float (0..1),
      "source_ids": [int, int, ...]  // índices dos pares na lista de entrada
    }
  ]
}

Se não encontrar nenhum cluster com >= ${minFrequency} ocorrências, devolve {"faqs": []}.`;

  const res = await callLlm(orKey, {
    model,
    systemDynamic: systemPrompt,
    messages: [
      {
        role: "user",
        content: `## Pares Q&A da última semana\n\n${numbered}\n\nIdentifique os clusters de FAQs.`,
      },
    ],
    jsonMode: true,
    maxTokens: 3000,
    temperature: 0.1,
    timeoutMs: 60_000,
  });

  if (!res.content) {
    return { faqs: [], tokensIn: res.tokensIn, tokensOut: res.tokensOut, costUsd: res.costUsd };
  }

  let parsed: { faqs?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(res.content);
  } catch {
    console.warn("[distiller] JSON parse falhou:", res.content.slice(0, 200));
    return { faqs: [], tokensIn: res.tokensIn, tokensOut: res.tokensOut, costUsd: res.costUsd };
  }

  const faqs: ExtractedFAQ[] = [];
  for (const raw of parsed.faqs ?? []) {
    const q = String(raw.question_canonical ?? "").trim();
    const a = String(raw.answer_canonical ?? "").trim();
    if (!q || !a || a.length < 20) continue;
    const sourceIds = Array.isArray(raw.source_ids) ? (raw.source_ids as number[]) : [];
    const sourceConvIds = sourceIds
      .map((i) => sample[i]?.conversationId)
      .filter((x): x is string => !!x);
    const uniqueConvs = Array.from(new Set(sourceConvIds));
    faqs.push({
      question_canonical: q,
      answer_canonical: a,
      frequency: Number(raw.frequency ?? sourceIds.length),
      confidence: Number(raw.confidence ?? 0),
      source_conversation_ids: uniqueConvs,
    });
  }

  return {
    faqs,
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
    costUsd: res.costUsd,
  };
}

// ──────────────────────────────────────────────────────────────────
// Dedupe por similaridade de embedding com FAQs já aprovadas
// ──────────────────────────────────────────────────────────────────

async function isDuplicateOfApproved(
  agentId: string,
  faqEmbedding: number[],
  threshold = 0.85,
): Promise<boolean> {
  const sb = getSelfhost();
  const qLiteral = vectorLiteral(faqEmbedding);
  const sql = `
    select 1 - (c.embedding <=> '${qLiteral}'::vector) as similarity
    from public.knowledge_chunks c
    join public.knowledge_documents d on d.id = c.document_id
    where c.agent_id = '${agentId}'
      and d.status = 'ready'
      and d.review_status in ('approved','auto_pending','quarantine')
    order by c.embedding <=> '${qLiteral}'::vector
    limit 1;
  `;
  try {
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
    });
    if (!res.ok) return false;
    const rows = (await res.json()) as { similarity: number }[];
    return rows.length > 0 && rows[0].similarity >= threshold;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────
// Insere FAQ como knowledge_document + chunks
// ──────────────────────────────────────────────────────────────────

async function insertFaq(
  agentId: string,
  faq: ExtractedFAQ,
  embedding: number[],
  reviewStatus: "approved" | "auto_pending" | "quarantine",
  quarantineHours: number,
  piiDetected: boolean,
): Promise<void> {
  const sb = getSelfhost();
  const text = `**P:** ${faq.question_canonical}\n\n**R:** ${faq.answer_canonical}`;

  const quarantineUntil =
    reviewStatus === "quarantine"
      ? new Date(Date.now() + quarantineHours * 60 * 60 * 1000).toISOString()
      : null;

  const doc = await sb
    .from("knowledge_documents")
    .insert({
      agent_id: agentId,
      source_type: "auto_distilled",
      title: faq.question_canonical.slice(0, 120),
      status: "ready",
      review_status: reviewStatus,
      confidence: faq.confidence,
      frequency: faq.frequency,
      pii_detected: piiDetected,
      quarantine_until: quarantineUntil,
      distilled_question: faq.question_canonical,
      content_preview: text.slice(0, 500),
      total_chars: text.length,
      total_chunks: 1,
    })
    .select("id")
    .single();
  if (doc.error || !doc.data) throw new Error(doc.error?.message ?? "insert doc failed");

  const docId = doc.data.id as string;
  await sb.from("knowledge_chunks").insert({
    document_id: docId,
    agent_id: agentId,
    ordem: 0,
    chunk_text: text,
    token_count: Math.ceil(text.length / 4),
    embedding: vectorLiteral(embedding),
  });
}

// ──────────────────────────────────────────────────────────────────
// Função principal: roda o distillation para um agente
// ──────────────────────────────────────────────────────────────────

export async function runDistillationForAgent(args: {
  accountId: string;
  agentId: string;
  orKey: string;
  model: string;          // modelo barato (Gemini Flash)
  config: DistillerConfig;
  sinceISO: string;       // janela de tempo (ex: 7 dias atrás)
}): Promise<DistillerResult> {
  const result: DistillerResult = {
    conversations_scanned: 0,
    q_and_a_pairs: 0,
    clusters_found: 0,
    faqs_extracted: 0,
    faqs_auto_approved: 0,
    faqs_pending: 0,
    faqs_duplicates: 0,
    faqs_pii_blocked: 0,
    cost_usd: 0,
    tokens_in: 0,
    tokens_out: 0,
  };

  // 1. Pares Q&A
  const { pairs, conversationIds } = await extractQAPairs(args.agentId, args.sinceISO);
  result.conversations_scanned = conversationIds.length;
  result.q_and_a_pairs = pairs.length;
  if (pairs.length < args.config.min_frequency) {
    return result;
  }

  // 2. LLM cluster + extract
  const clustered = await clusterAndExtract(
    args.orKey,
    args.model,
    pairs,
    args.config.min_frequency,
  );
  result.tokens_in = clustered.tokensIn;
  result.tokens_out = clustered.tokensOut;
  result.cost_usd = clustered.costUsd;
  result.faqs_extracted = clustered.faqs.length;
  result.clusters_found = clustered.faqs.length;

  if (clustered.faqs.length === 0) return result;

  // 3. Embeda todas as FAQs em batch
  const texts = clustered.faqs.map(
    (f) => `${f.question_canonical}\n${f.answer_canonical}`,
  );
  const embeddings = await embedTexts(texts);

  // 4. Para cada FAQ: PII → duplicate → review_status → insert
  let autoApprovedCount = 0;
  for (let i = 0; i < clustered.faqs.length; i++) {
    const faq = clustered.faqs[i];
    const emb = embeddings[i];

    const piiHits = detectPii(faq.answer_canonical + " " + faq.question_canonical);
    const hasPii = piiHits.length > 0;

    const isDup = await isDuplicateOfApproved(args.agentId, emb, 0.85);
    if (isDup) {
      result.faqs_duplicates++;
      continue;
    }

    // Decide review_status
    let reviewStatus: "approved" | "auto_pending" | "quarantine";
    if (hasPii) {
      reviewStatus = "auto_pending";
      result.faqs_pii_blocked++;
    } else if (
      faq.confidence >= args.config.min_confidence &&
      faq.frequency >= args.config.min_frequency &&
      autoApprovedCount < args.config.max_auto_approve_per_run
    ) {
      reviewStatus = "quarantine";
      autoApprovedCount++;
    } else {
      reviewStatus = "auto_pending";
    }

    try {
      await insertFaq(
        args.agentId,
        faq,
        emb,
        reviewStatus,
        args.config.quarantine_hours,
        hasPii,
      );
      if (reviewStatus === "quarantine") result.faqs_auto_approved++;
      else result.faqs_pending++;
    } catch (e) {
      console.error("[distiller] insertFaq falhou:", e);
    }
  }

  // 5. Marca conversas como distilled
  if (conversationIds.length > 0) {
    const sb = getSelfhost();
    await sb
      .from("conversations")
      .update({ distilled_until: new Date().toISOString() })
      .in("id", conversationIds);
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────
// Helper: carrega chave OpenRouter da conta
// ──────────────────────────────────────────────────────────────────

export async function loadOrKey(accountId: string): Promise<string | null> {
  const sb = getSelfhost();
  const secrets = await sb
    .from("account_secrets")
    .select("openrouter_api_key_enc")
    .eq("account_id", accountId)
    .single();
  if (!secrets.data?.openrouter_api_key_enc) return null;
  return decryptValue(secrets.data.openrouter_api_key_enc as unknown as string);
}

// chunkText imported pra evitar dead import warning
void chunkText;
