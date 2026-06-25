// Helper centralizado para a API key do Groq (transcrição de áudio).
//
// Ordem de resolução:
//   1. `GROQ_API_KEY` na env do servidor (recomendado em produção / Coolify).
//   2. Chave salva por conta em `account_secrets.groq_api_key_enc` (legado —
//      mantida por retrocompat, mas a UI não pede mais).
//
// Decisão de produto: a transcrição de áudio é um custo central da plataforma,
// então a chave fica no servidor e atende todas as contas. O usuário não
// precisa mais cadastrar Groq individualmente.

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";

export async function getGroqApiKey(accountId?: string): Promise<string | null> {
  // 1. Env var do servidor — caminho preferido.
  const envKey = process.env.GROQ_API_KEY;
  if (envKey && envKey.length > 10) return envKey;

  // 2. Fallback: chave por conta (suporte ao modelo antigo).
  if (!accountId) return null;
  const sb = getSelfhost();
  const { data } = await sb
    .from("account_secrets")
    .select("groq_api_key_enc")
    .eq("account_id", accountId)
    .maybeSingle();
  const enc = data?.groq_api_key_enc as unknown as string | null;
  if (!enc) return null;

  try {
    return await decryptValue(enc);
  } catch {
    return null;
  }
}

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";

export interface TranscribeResult {
  ok: boolean;
  text: string;
  error?: string;
}

/** Extensão de arquivo reconhecida pelo Whisper a partir do mime. */
function extForMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  return "webm";
}

/**
 * Transcreve um áudio já em memória (bytes) via Groq Whisper. Usado pela UI
 * (gravação no navegador via MediaRecorder → base64 → server fn), enquanto
 * {@link transcribeAudioFromUrl} cobre o webhook (áudio do WhatsApp por URL).
 */
export async function transcribeAudioBytes(
  bytes: Uint8Array,
  mime: string,
  apiKey: string,
  opts: { language?: string } = {},
): Promise<TranscribeResult> {
  try {
    if (!bytes || bytes.byteLength === 0) {
      return { ok: false, text: "", error: "áudio vazio" };
    }
    const blob = new Blob([bytes], { type: mime || "audio/webm" });
    const form = new FormData();
    form.append("file", blob, `audio.${extForMime(mime)}`);
    form.append("model", GROQ_WHISPER_MODEL);
    form.append("temperature", "0");
    form.append("response_format", "json");
    if (opts.language) form.append("language", opts.language);

    const res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, text: "", error: `groq ${res.status}: ${body.slice(0, 200)}` };
    }
    const json = (await res.json()) as { text?: string };
    return { ok: true, text: (json.text ?? "").trim() };
  } catch (e) {
    return {
      ok: false,
      text: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Baixa um áudio de uma URL pública e transcreve via Groq Whisper.
 * Espelha o fluxo n8n: download → multipart POST → whisper-large-v3-turbo.
 *
 * Retorna { ok:false } com erro em vez de lançar — transcrição é best-effort,
 * o webhook segue com a melhor info disponível.
 */
export async function transcribeAudioFromUrl(
  audioUrl: string,
  apiKey: string,
  opts: { language?: string } = {},
): Promise<TranscribeResult> {
  try {
    // 1. Baixa o áudio
    const audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(30_000) });
    if (!audioRes.ok) {
      return { ok: false, text: "", error: `download ${audioRes.status}` };
    }
    const audioBlob = await audioRes.blob();
    if (audioBlob.size === 0) {
      return { ok: false, text: "", error: "áudio vazio" };
    }

    // 2. Monta multipart e envia ao Groq
    const form = new FormData();
    // Nome do arquivo precisa ter extensão reconhecida pelo Whisper
    const ext = audioBlob.type.includes("ogg")
      ? "ogg"
      : audioBlob.type.includes("mp4") || audioBlob.type.includes("m4a")
        ? "m4a"
        : audioBlob.type.includes("wav")
          ? "wav"
          : "mp3";
    form.append("file", audioBlob, `audio.${ext}`);
    form.append("model", GROQ_WHISPER_MODEL);
    form.append("temperature", "0");
    form.append("response_format", "json");
    if (opts.language) form.append("language", opts.language);

    const res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, text: "", error: `groq ${res.status}: ${body.slice(0, 200)}` };
    }
    const json = (await res.json()) as { text?: string };
    return { ok: true, text: (json.text ?? "").trim() };
  } catch (e) {
    return {
      ok: false,
      text: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
