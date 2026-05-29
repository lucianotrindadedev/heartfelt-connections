// Crawler simples de site (mesma origem) para a Base de Conhecimento.
// BFS a partir da URL base: baixa cada página HTML uma vez, coleta o HTML
// (para extração) e descobre links internos para visitar. Limites rígidos
// (maxPages, mesma origem, sem assets) evitam loop e explosão de custo.

import { JSDOM } from "jsdom";

const FETCH_TIMEOUT_MS = 20_000;

export interface CrawledPage {
  url: string;
  html: string;
}

export interface CrawlResult {
  pages: CrawledPage[];
  errors: { url: string; error: string }[];
}

const SKIP_EXT_RE =
  /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|svg|webp|avif|ico|zip|rar|gz|mp4|webm|mp3|wav|css|js|json|xml|woff2?|ttf|eot)(\?|#|$)/i;

/** Normaliza para deduplicação: remove fragmento e barra final (exceto raiz). */
function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    u.hash = "";
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

function shouldSkip(u: string): boolean {
  if (/^(mailto:|tel:|javascript:|data:)/i.test(u)) return true;
  if (SKIP_EXT_RE.test(u)) return true;
  return false;
}

const HEADERS: HeadersInit = {
  "User-Agent":
    "Mozilla/5.0 (compatible; SaraiBot/1.0; +https://sarai.app.br) AppleWebKit/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.5",
};

/**
 * Crawla o site a partir de `baseUrl`, ficando na MESMA origem, até `maxPages`
 * páginas HTML. Cada página é baixada uma única vez.
 */
export async function crawlSite(
  baseUrl: string,
  maxPages: number,
  deadlineMs?: number,
): Promise<CrawlResult> {
  const start = normalizeUrl(baseUrl);
  if (!start) throw new Error("URL inválida.");
  const origin = new URL(start).origin;

  const visited = new Set<string>();
  const queue: string[] = [start];
  const pages: CrawledPage[] = [];
  const errors: { url: string; error: string }[] = [];

  // Teto de fila para não acumular links demais em sites grandes.
  const queueCap = Math.max(maxPages * 5, 50);

  while (queue.length > 0 && pages.length < maxPages) {
    if (deadlineMs && Date.now() > deadlineMs) break;
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    try {
      const res = await fetch(current, {
        headers: HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        errors.push({ url: current, error: `HTTP ${res.status}` });
        continue;
      }
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/html") && !ct.includes("xml")) continue;

      const html = await res.text();
      if (html) pages.push({ url: current, html });

      // Descobre links internos.
      const dom = new JSDOM(html, { url: current });
      const anchors = dom.window.document.querySelectorAll("a[href]");
      for (const a of Array.from(anchors)) {
        if (visited.size + queue.length >= queueCap) break;
        const href = a.getAttribute("href");
        if (!href) continue;
        let abs: string;
        try {
          abs = new URL(href, current).toString();
        } catch {
          continue;
        }
        if (shouldSkip(abs)) continue;
        const norm = normalizeUrl(abs);
        if (!norm) continue;
        if (new URL(norm).origin !== origin) continue; // só mesma origem
        if (!visited.has(norm) && !queue.includes(norm)) queue.push(norm);
      }
    } catch (e) {
      errors.push({
        url: current,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { pages, errors };
}
