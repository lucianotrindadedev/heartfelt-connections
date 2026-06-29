// Núcleo das automações de etiqueta (tag → ação).
// Server-only — não importar do client.
//
// Fluxo: o webhook dedicado resolve um contato (id/sessão/telefone), chama
// runTagAutomationsForContact, que RECARREGA as tags atuais do contato no CRM
// e executa as regras cujo gatilho (trigger_tag) está presente. Cada regra só
// dispara uma vez por contato (dedupe em tag_automation_runs).

import { getSelfhost } from "@/integrations/selfhost/client.server";
import {
  addContactToSequence,
  loadHelenaAccount,
  loadHelenaContactById,
  loadHelenaSession,
  removeContactFromSequence,
  resolveHelenaContactId,
  type HelenaAccount,
  type HelenaContact,
} from "@/lib/helena.server";

/** Normaliza tag para comparação: sem acento, sem espaços nas pontas, minúsculo. */
function normalizeTag(s: string): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

export interface TagAutomationRow {
  id: string;
  agent_id: string;
  enabled: boolean;
  trigger_tag: string;
  action_type: "add_to_sequence" | "remove_from_sequence";
  sequence_id: string | null;
  sequence_name: string | null;
}

export interface RunResult {
  resolvedContactId: string | null;
  evaluated: number;
  matched: number;
  executed: number;
  skipped: number;
  details: Array<{ automationId: string; tag: string; action: string; status: string; note?: string }>;
}

/**
 * Resolve o agente da conta. O webhook é por accountId; cada conta tem 1 agente
 * (mesma premissa do webhook principal da Helena).
 */
async function resolveAgentId(accountId: string): Promise<string | null> {
  const sb = getSelfhost();
  const { data } = await sb
    .from("agents")
    .select("id")
    .eq("account_id", accountId)
    .maybeSingle();
  return (data?.id as string | null) ?? null;
}

/**
 * Resolve o contato a partir de qualquer identificador presente no payload do
 * webhook (contactId direto, sessionId Helena, ou telefone).
 */
async function resolveContact(
  account: HelenaAccount,
  ids: { contactId?: string | null; sessionId?: string | null; phone?: string | null },
): Promise<HelenaContact | null> {
  // 1) contactId direto
  if (ids.contactId) {
    const c = await loadHelenaContactById(account, String(ids.contactId));
    if (c) return c;
  }
  // 2) sessão → contactId
  if (ids.sessionId) {
    const sess = await loadHelenaSession(account, String(ids.sessionId));
    if (sess?.contactId) {
      const c = await loadHelenaContactById(account, sess.contactId);
      if (c) return c;
    }
  }
  // 3) telefone (resolveHelenaContactId varre variações BR/E164)
  const cid = await resolveHelenaContactId(account, {
    phone: ids.phone ?? undefined,
  });
  if (cid) return loadHelenaContactById(account, cid);
  return null;
}

/**
 * Executa as automações de etiqueta para um contato.
 * Best-effort: nunca lança — devolve um resumo para o webhook responder 200.
 */
export async function runTagAutomationsForContact(
  accountId: string,
  ids: { contactId?: string | null; sessionId?: string | null; phone?: string | null },
): Promise<RunResult> {
  const empty: RunResult = {
    resolvedContactId: null,
    evaluated: 0,
    matched: 0,
    executed: 0,
    skipped: 0,
    details: [],
  };

  const sb = getSelfhost();

  const agentId = await resolveAgentId(accountId);
  if (!agentId) return empty;

  const { data: rules } = await sb
    .from("agent_tag_automations")
    .select("id, agent_id, enabled, trigger_tag, action_type, sequence_id, sequence_name")
    .eq("agent_id", agentId)
    .eq("enabled", true);

  const automations = (rules ?? []) as TagAutomationRow[];
  if (automations.length === 0) return empty;

  const account = await loadHelenaAccount(accountId).catch(() => null);
  if (!account) return empty;

  const contact = await resolveContact(account, ids);
  if (!contact) return empty;

  const contactTags = new Set(contact.tagNames.map(normalizeTag));
  const result: RunResult = { ...empty, resolvedContactId: contact.id, details: [] };

  for (const rule of automations) {
    result.evaluated++;
    if (!contactTags.has(normalizeTag(rule.trigger_tag))) continue;
    result.matched++;

    if (!rule.sequence_id) {
      result.skipped++;
      result.details.push({
        automationId: rule.id,
        tag: rule.trigger_tag,
        action: rule.action_type,
        status: "skipped",
        note: "sem sequência configurada",
      });
      continue;
    }

    // Dedupe: a regra já rodou para este contato?
    const { data: prev } = await sb
      .from("tag_automation_runs")
      .select("id")
      .eq("automation_id", rule.id)
      .eq("contact_id", contact.id)
      .eq("status", "done")
      .maybeSingle();
    if (prev) {
      result.skipped++;
      result.details.push({
        automationId: rule.id,
        tag: rule.trigger_tag,
        action: rule.action_type,
        status: "skipped",
        note: "já executada para este contato",
      });
      continue;
    }

    const who = { contactId: contact.id, phoneNumber: contact.phoneNumber || null };
    const res =
      rule.action_type === "remove_from_sequence"
        ? await removeContactFromSequence(account, rule.sequence_id, who)
        : await addContactToSequence(account, rule.sequence_id, who);

    await sb.from("tag_automation_runs").insert({
      automation_id: rule.id,
      agent_id: agentId,
      contact_id: contact.id,
      trigger_tag: rule.trigger_tag,
      status: res.ok ? "done" : "failed",
      error: res.ok ? null : `${res.status} ${res.body.slice(0, 300)}`,
    });

    if (res.ok) result.executed++;
    else result.skipped++;
    result.details.push({
      automationId: rule.id,
      tag: rule.trigger_tag,
      action: rule.action_type,
      status: res.ok ? "executed" : "failed",
      note: res.ok ? rule.sequence_name ?? rule.sequence_id : `${res.status}`,
    });
  }

  return result;
}
