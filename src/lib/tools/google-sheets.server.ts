// Integração Google Sheets: OAuth (mesmas credenciais do app usado no Google
// Calendar — GOOGLE_CLIENT_ID/SECRET), leitura de intervalos e busca de linhas.
//
// Uso: planilha como fonte de consulta do agente (tabela de preços,
// procedimentos, convênios). SOMENTE LEITURA — o escopo pedido é
// spreadsheets.readonly e não existe nenhuma escrita neste arquivo.
//
// Por que tokens próprios (tabela google_sheets_config) e não os do Calendar:
// ver o cabeçalho de migrations/0052_google_sheets.sql.

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue, encryptValue } from "@/lib/crypto.server";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Escopos do consentimento de planilha. Leitura apenas. */
export const SHEETS_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

/** Uma planilha configurada pela conta. `label` vira enum na tool do agente. */
export interface SheetSource {
  label: string;
  spreadsheetId: string;
  /** Intervalo A1 (ex.: "Tabela!A1:F500"). Vazio = primeira aba inteira. */
  aba?: string;
  /** Explica ao agente quando usar esta planilha. */
  descricao?: string;
}

interface SheetsToken {
  accessToken: string;
  refreshToken: string;
  email: string | null;
  expiresAt: Date | null;
}

// ── Tokens ────────────────────────────────────────────────────────────────

async function loadTokens(accountId: string): Promise<SheetsToken | null> {
  const sb = getSelfhost();
  const { data } = await sb
    .from("google_sheets_config")
    .select("access_token_enc, refresh_token_enc, email, expires_at, ativo")
    .eq("account_id", accountId)
    .maybeSingle();

  if (!data || !data.ativo) return null;

  const accessToken = await decryptValue(data.access_token_enc as unknown as string);
  const refreshToken = await decryptValue(data.refresh_token_enc as unknown as string);
  if (!accessToken || !refreshToken) return null;

  return {
    accessToken,
    refreshToken,
    email: (data.email as string | null) ?? null,
    expiresAt: data.expires_at ? new Date(data.expires_at as string) : null,
  };
}

async function refreshTokenIfNeeded(accountId: string, token: SheetsToken): Promise<string> {
  const needsRefresh = !token.expiresAt || token.expiresAt.getTime() - Date.now() < 5 * 60 * 1000;

  if (!needsRefresh) return token.accessToken;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: token.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  const newAccessToken = json.access_token;
  if (!newAccessToken) throw new Error("Refresh token response missing access_token");

  const expiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000);
  const sb = getSelfhost();
  await sb
    .from("google_sheets_config")
    .update({
      access_token_enc: await encryptValue(newAccessToken),
      expires_at: expiresAt.toISOString(),
      atualizado_em: new Date().toISOString(),
    })
    .eq("account_id", accountId);

  return newAccessToken;
}

async function accessTokenFor(accountId: string): Promise<string | null> {
  const token = await loadTokens(accountId);
  if (!token) return null;
  return refreshTokenIfNeeded(accountId, token);
}

// ── Config das planilhas ──────────────────────────────────────────────────

function parsePlanilhas(raw: unknown): SheetSource[] {
  if (!Array.isArray(raw)) return [];
  const out: SheetSource[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    const label = String(item?.label ?? "").trim();
    const spreadsheetId = String(item?.spreadsheet_id ?? "").trim();
    if (!label || !spreadsheetId) continue;
    out.push({
      label,
      spreadsheetId,
      aba: typeof item.aba === "string" && item.aba.trim() ? item.aba.trim() : undefined,
      descricao:
        typeof item.descricao === "string" && item.descricao.trim()
          ? item.descricao.trim()
          : undefined,
    });
  }
  return out;
}

export async function listAccountSheets(accountId: string): Promise<SheetSource[]> {
  const sb = getSelfhost();
  try {
    const { data, error } = await sb
      .from("google_sheets_config")
      .select("planilhas")
      .eq("account_id", accountId)
      .maybeSingle();
    if (error) return [];
    return parsePlanilhas(data?.planilhas);
  } catch {
    return [];
  }
}

/**
 * Persiste a lista de planilhas da conta. Normaliza para o formato canônico
 * ({label, spreadsheet_id, aba, descricao}) e remove labels duplicados
 * (case-insensitive, mantendo o primeiro) — o label é a chave que o agente usa.
 */
export async function saveAccountSheets(
  accountId: string,
  planilhas: SheetSource[],
): Promise<void> {
  const seen = new Set<string>();
  const normalized: {
    label: string;
    spreadsheet_id: string;
    aba?: string;
    descricao?: string;
  }[] = [];

  for (const p of planilhas) {
    const label = (p.label ?? "").trim();
    const spreadsheetId = extractSpreadsheetId(p.spreadsheetId ?? "");
    if (!label || !spreadsheetId) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const aba = (p.aba ?? "").trim();
    const descricao = (p.descricao ?? "").trim();
    normalized.push({
      label,
      spreadsheet_id: spreadsheetId,
      ...(aba ? { aba } : {}),
      ...(descricao ? { descricao } : {}),
    });
  }

  const sb = getSelfhost();
  await sb
    .from("google_sheets_config")
    .update({ planilhas: normalized, atualizado_em: new Date().toISOString() })
    .eq("account_id", accountId);

  // Config mudou → o cache de conteúdo da conta não vale mais.
  invalidateSheetCache(accountId);
}

/** Aceita o ID puro ou uma URL colada do navegador (.../spreadsheets/d/<ID>/edit). */
export function extractSpreadsheetId(input: string): string {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return (m ? m[1] : raw).trim();
}

export async function getGoogleSheetsStatus(accountId: string): Promise<{
  connected: boolean;
  email: string | null;
  planilhas: SheetSource[];
}> {
  const sb = getSelfhost();
  const { data } = await sb
    .from("google_sheets_config")
    .select("email, planilhas, ativo")
    .eq("account_id", accountId)
    .maybeSingle();

  if (!data || !data.ativo) return { connected: false, email: null, planilhas: [] };

  return {
    connected: true,
    email: (data.email as string | null) ?? null,
    planilhas: parsePlanilhas(data.planilhas),
  };
}

// ── Leitura ───────────────────────────────────────────────────────────────

/** Cache de conteúdo por (conta, planilha, intervalo). Tabela de preço muda
 *  raramente e o agente consulta a cada turno — sem isso, cada pergunta de
 *  valor vira uma ida à API do Google no meio da resposta ao lead. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const sheetCache = new Map<string, { rows: string[][]; at: number }>();

export function invalidateSheetCache(accountId?: string): void {
  if (!accountId) {
    sheetCache.clear();
    return;
  }
  for (const key of sheetCache.keys()) {
    if (key.startsWith(`${accountId}::`)) sheetCache.delete(key);
  }
}

/** Lista os nomes das abas de uma planilha (validação na UI). */
export async function listSheetTabs(
  accountId: string,
  spreadsheetId: string,
): Promise<{ title: string; tabs: string[] }> {
  const token = await accessTokenFor(accountId);
  if (!token) throw new Error("Google Sheets não conectado nesta conta.");

  const id = extractSpreadsheetId(spreadsheetId);
  const res = await fetch(
    `${SHEETS_BASE}/${encodeURIComponent(id)}?fields=properties.title,sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(await describeSheetsError(res));

  const json = (await res.json()) as {
    properties?: { title?: string };
    sheets?: { properties?: { title?: string } }[];
  };
  return {
    title: json.properties?.title ?? "",
    tabs: (json.sheets ?? []).map((s) => s.properties?.title ?? "").filter(Boolean),
  };
}

/** Mensagem de erro legível — 403 de escopo é o caso mais provável e o mais
 *  confuso ("PERMISSION_DENIED" não diz o que fazer). */
async function describeSheetsError(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string; status?: string } };
    detail = body.error?.message ?? "";
  } catch {
    // resposta sem JSON — segue só com o status
  }
  if (res.status === 401 || res.status === 403) {
    if (/scope|insufficient|permission/i.test(detail)) {
      return `Sem permissão de leitura (${res.status}). Reconecte o Google Sheets e confirme o acesso às planilhas. Detalhe: ${detail.slice(0, 160)}`;
    }
    return `Acesso negado (${res.status}). Verifique se a planilha está compartilhada com a conta Google conectada. Detalhe: ${detail.slice(0, 160)}`;
  }
  if (res.status === 404) {
    return "Planilha não encontrada — confira o ID/URL e se a conta Google conectada tem acesso a ela.";
  }
  return `Falha na API do Google Sheets (${res.status}). ${detail.slice(0, 160)}`;
}

/** Lê um intervalo e devolve as linhas cruas (com header, se houver). */
async function readRange(
  accountId: string,
  spreadsheetId: string,
  aba?: string,
): Promise<string[][]> {
  const id = extractSpreadsheetId(spreadsheetId);
  const cacheKey = `${accountId}::${id}::${aba ?? ""}`;
  const hit = sheetCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;

  const token = await accessTokenFor(accountId);
  if (!token) throw new Error("Google Sheets não conectado nesta conta.");

  // Sem aba configurada: a API exige um range, então usamos a primeira aba da
  // planilha (o metadata já traz os títulos na ordem em que aparecem).
  let range = aba;
  if (!range) {
    const meta = await listSheetTabs(accountId, id);
    range = meta.tabs[0] ?? "A1:Z1000";
  }

  const url =
    `${SHEETS_BASE}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}` +
    `?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(await describeSheetsError(res));

  const json = (await res.json()) as { values?: unknown[][] };
  const rows = (json.values ?? []).map((r) => r.map((c) => String(c ?? "").trim()));

  sheetCache.set(cacheKey, { rows, at: Date.now() });
  return rows;
}

function normalize(s: string): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export interface SheetQueryResult {
  ok: boolean;
  planilha?: string;
  colunas?: string[];
  linhas?: Record<string, string>[];
  total_encontrado?: number;
  truncado?: boolean;
  aviso?: string;
  error?: string;
}

const MAX_ROWS_RETURNED = 25;
const MAX_RESULT_CHARS = 6000;

/**
 * Consulta a planilha: 1ª linha vira cabeçalho, as demais viram objetos
 * {coluna: valor}. Com `busca`, filtra as linhas que contenham TODAS as
 * palavras do termo em qualquer célula (sem acento, case-insensitive).
 *
 * Devolve sempre um objeto serializável — quem chama manda direto pro LLM.
 */
export async function querySheet(
  accountId: string,
  planilhas: SheetSource[],
  opts: { label?: string; busca?: string },
): Promise<SheetQueryResult> {
  if (planilhas.length === 0) {
    return { ok: false, error: "Nenhuma planilha configurada nesta conta." };
  }

  let source: SheetSource | undefined;
  if (opts.label && opts.label.trim()) {
    const wanted = normalize(opts.label.trim());
    source = planilhas.find((p) => normalize(p.label) === wanted);
    if (!source) {
      return {
        ok: false,
        error: `Planilha "${opts.label}" não existe. Use exatamente um destes rótulos: ${planilhas
          .map((p) => p.label)
          .join(", ")}.`,
      };
    }
  } else if (planilhas.length === 1) {
    source = planilhas[0];
  } else {
    return {
      ok: false,
      error: `Esta conta tem várias planilhas. Informe o parâmetro "planilha" com um destes valores: ${planilhas
        .map((p) => p.label)
        .join(", ")}.`,
    };
  }

  let rows: string[][];
  try {
    rows = await readRange(accountId, source.spreadsheetId, source.aba);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, planilha: source.label, error: msg.slice(0, 220) };
  }

  if (rows.length === 0) {
    return { ok: true, planilha: source.label, colunas: [], linhas: [], total_encontrado: 0 };
  }

  const header = rows[0].map((h, i) => h || `coluna_${i + 1}`);
  const body = rows.slice(1).filter((r) => r.some((c) => c !== ""));

  const termos = normalize(opts.busca ?? "")
    .split(/\s+/)
    .filter((t) => t.length >= 2);

  const matched = termos.length
    ? body.filter((r) => {
        const hay = normalize(r.join(" | "));
        return termos.every((t) => hay.includes(t));
      })
    : body;

  const toObj = (r: string[]): Record<string, string> => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      const v = r[i] ?? "";
      if (v !== "") obj[h] = v;
    });
    return obj;
  };

  let linhas = matched.slice(0, MAX_ROWS_RETURNED).map(toObj);
  let truncado = matched.length > linhas.length;

  // Guarda de tamanho: planilha larga (muitas colunas) estoura o contexto mesmo
  // dentro do limite de linhas — corta até caber.
  while (linhas.length > 1 && JSON.stringify(linhas).length > MAX_RESULT_CHARS) {
    linhas = linhas.slice(0, linhas.length - 1);
    truncado = true;
  }

  return {
    ok: true,
    planilha: source.label,
    colunas: header,
    linhas,
    total_encontrado: matched.length,
    ...(truncado ? { truncado: true } : {}),
    ...(termos.length && matched.length === 0
      ? {
          aviso:
            "Nenhuma linha bate com a busca. NÃO invente o dado: diga que vai confirmar com a equipe ou pergunte de outro jeito. Você pode chamar a tool de novo sem o parâmetro 'busca' para ver a tabela inteira.",
        }
      : {}),
  };
}
