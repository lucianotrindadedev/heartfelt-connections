// Cliente da Evolution API (instalacao global do SAAS).
//
// Le as credenciais (base_url + api_key) de system_evolution_config (singleton id=1)
// e expoe helpers para:
//  - listar instancias da Evolution
//  - listar grupos de uma instancia
//  - enviar mensagem de texto a partir de uma instancia para um JID
//
// Toda chamada usa fetch nativo + apikey header (padrao Evolution v2).

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";

export interface EvolutionCredentials {
  baseUrl: string;
  apiKey: string;
}

export interface EvolutionInstance {
  /** Nome interno da instancia (usado como path: /message/sendText/{name}). */
  name: string;
  /** Status reportado (ex: "open", "close", "connecting"). */
  status?: string;
  /** Nome amigavel/perfil (quando a Evolution retorna). */
  profileName?: string;
}

export interface EvolutionGroup {
  /** JID do grupo no formato 123456789@g.us — usado como destino em sendText. */
  id: string;
  /** Titulo do grupo (subject). */
  subject: string;
}

export class EvolutionConfigMissingError extends Error {
  constructor() {
    super("Evolution API nao configurada (system_evolution_config vazia)");
    this.name = "EvolutionConfigMissingError";
  }
}

export class EvolutionApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    public endpoint: string,
  ) {
    super(`Evolution API ${status} em ${endpoint}: ${body.slice(0, 200)}`);
    this.name = "EvolutionApiError";
  }
}

/** Carrega credenciais globais. Lanca EvolutionConfigMissingError se incompletas. */
export async function loadSystemEvolution(): Promise<EvolutionCredentials> {
  const sb = getSelfhost();
  const { data } = await sb
    .from("system_evolution_config")
    .select("base_url, api_key_enc")
    .eq("id", 1)
    .single();
  const baseUrl = (data?.base_url as string | null)?.trim();
  const apiKeyEnc = data?.api_key_enc as string | null;
  if (!baseUrl || !apiKeyEnc) throw new EvolutionConfigMissingError();
  const apiKey = await decryptValue(apiKeyEnc);
  if (!apiKey) throw new EvolutionConfigMissingError();
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKey,
  };
}

function buildHeaders(creds: EvolutionCredentials): HeadersInit {
  return {
    apikey: creds.apiKey,
    "Content-Type": "application/json",
  };
}

async function evolutionGet<T>(
  creds: EvolutionCredentials,
  endpoint: string,
): Promise<T> {
  const url = `${creds.baseUrl}${endpoint}`;
  const res = await fetch(url, { method: "GET", headers: buildHeaders(creds) });
  const text = await res.text();
  if (!res.ok) throw new EvolutionApiError(res.status, text, endpoint);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new EvolutionApiError(res.status, text, endpoint);
  }
}

/** Lista instancias cadastradas na Evolution. */
export async function listInstances(
  creds?: EvolutionCredentials,
): Promise<EvolutionInstance[]> {
  const c = creds ?? (await loadSystemEvolution());
  const raw = await evolutionGet<unknown>(c, "/instance/fetchInstances");
  const arr = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const out: EvolutionInstance[] = [];
  for (const item of arr) {
    const inst =
      (item.instance as Record<string, unknown> | undefined) ?? item;
    const name =
      (inst.instanceName as string | undefined) ??
      (inst.name as string | undefined) ??
      (inst.profileName as string | undefined);
    if (!name) continue;
    out.push({
      name,
      status:
        (inst.status as string | undefined) ??
        (inst.connectionStatus as string | undefined),
      profileName: inst.profileName as string | undefined,
    });
  }
  return out;
}

/** Lista grupos de uma instancia. Padrao: getParticipants=false (leve). */
export async function listGroups(
  instance: string,
  creds?: EvolutionCredentials,
): Promise<EvolutionGroup[]> {
  const c = creds ?? (await loadSystemEvolution());
  const raw = await evolutionGet<unknown>(
    c,
    `/group/fetchAllGroups/${encodeURIComponent(instance)}?getParticipants=false`,
  );
  const arr = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  return arr
    .map((g) => {
      const id =
        (g.id as string | undefined) ?? (g.remoteJid as string | undefined);
      const subject =
        (g.subject as string | undefined) ??
        (g.name as string | undefined) ??
        "(sem nome)";
      return id ? { id, subject } : null;
    })
    .filter((x): x is EvolutionGroup => x !== null);
}

/** Envia mensagem de texto via uma instancia para um numero/JID. */
export async function sendText(params: {
  instance: string;
  number: string;
  text: string;
  creds?: EvolutionCredentials;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const c = params.creds ?? (await loadSystemEvolution());
  const url = `${c.baseUrl}/message/sendText/${encodeURIComponent(params.instance)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(c),
    body: JSON.stringify({ number: params.number, text: params.text }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}
