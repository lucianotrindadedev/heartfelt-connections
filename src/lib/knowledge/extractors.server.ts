// Extração de texto de fontes diversas (PDF, URL).
// Cada extractor retorna { title, text } — title é usado para mostrar na UI.

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const EXTRACTOR_TIMEOUT_MS = 60_000;
const MAX_TEXT_CHARS = 800_000; // ~200k tokens — limite generoso para PDFs/sites grandes

export interface ExtractedDoc {
  title: string;
  text: string;
}

// ── PDF ────────────────────────────────────────────────────────────────────

export async function extractFromPdf(buffer: Buffer): Promise<ExtractedDoc> {
  // pdf-parse: ESM moderno exporta tudo direto; fallback para default em CJS.
  const mod = (await import("pdf-parse")) as unknown as {
    default?: (b: Buffer) => Promise<{ text: string; info?: { Title?: string } }>;
    pdf?: (b: Buffer) => Promise<{ text: string; info?: { Title?: string } }>;
  };
  const pdfParse =
    mod.default ?? mod.pdf ?? (mod as unknown as (b: Buffer) => Promise<{ text: string; info?: { Title?: string } }>);

  const result = await pdfParse(buffer);
  const text = (result.text ?? "")
    .replace(/[\t ]+/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n[ ]+/g, "\n")
    .trim();

  if (!text) throw new Error("PDF não contém texto extraível (talvez seja só imagens — usaria OCR).");

  return {
    title: result.info?.Title?.trim() || "Documento PDF",
    text: text.slice(0, MAX_TEXT_CHARS),
  };
}

// ── URL ────────────────────────────────────────────────────────────────────

export async function extractFromUrl(url: string): Promise<ExtractedDoc> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL inválida.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Apenas URLs http/https são suportadas.");
  }

  const res = await fetch(url, {
    headers: {
      // User-Agent realista evita bloqueios de bots em muitos sites
      "User-Agent":
        "Mozilla/5.0 (compatible; SaraiBot/1.0; +https://sarai.app.br) AppleWebKit/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.5",
    },
    signal: AbortSignal.timeout(EXTRACTOR_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar ${url}`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("xml")) {
    throw new Error(`Tipo de conteúdo não suportado: ${contentType.slice(0, 50)}`);
  }

  const html = await res.text();
  if (!html) throw new Error("Resposta vazia.");

  // Usa Mozilla Readability para extrair conteúdo principal
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  let title = article?.title?.trim() || dom.window.document.title || parsed.hostname;
  title = title.slice(0, 300);

  let text = "";
  if (article?.textContent) {
    text = article.textContent;
  } else {
    // Fallback: pega body inteiro
    text = dom.window.document.body?.textContent ?? "";
  }

  text = text
    .replace(/[\t ]+/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n[ ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text.length < 100) {
    throw new Error("Conteúdo extraído muito curto — talvez a página exija JavaScript.");
  }

  return {
    title,
    text: text.slice(0, MAX_TEXT_CHARS),
  };
}
