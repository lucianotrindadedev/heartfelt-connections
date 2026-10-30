// Transferência de atendimento para outra loja/unidade (agente "central").
//
// Uma central atende o lead e, quando o atendimento precisa seguir com uma loja
// específica, TRANSFERE: a IA para de responder esse contato, a loja recebe um
// alerta no WhatsApp dela com o resumo do atendimento, o grupo de alertas também,
// e o Leads360 registra a transferência com a loja de destino. Era o workflow
// n8n "06. Transferir Atendimento" (Game Point).
//
// Diferença proposital em relação ao n8n: lá a IA DIGITAVA o telefone da loja a
// partir do prompt (um dígito errado e o alerta ia para outra pessoa). Aqui a IA
// só escolhe o NOME da loja, entre as cadastradas no painel; o WhatsApp sai do
// cadastro.
//
// Cadastro: agents.settings.transfer_units_json = JSON de
//   [{ "nome": "Madureira Shopping", "whatsapp": "21970672747", "observacao": "Zona Norte" }]

export interface TransferUnit {
  name: string;
  /** Só dígitos, com 55 (formato do número para a Evolution). */
  phone: string;
  /** Quando usar esta loja (bairros, regiões, serviços) — vai para o prompt. */
  hint: string;
}

/** Etiqueta aplicada no contato transferido (além de "IA Desligada"). */
export const TRANSFER_TAG = "Transferido";

/** Chave em agents.settings. */
export const TRANSFER_UNITS_SETTING = "transfer_units_json";

/** WhatsApp em dígitos com DDI 55; null se não parecer telefone BR. */
export function normalizeUnitPhone(raw: unknown): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) return d;
  return null;
}

/** Lê o cadastro; ignora linhas sem nome ou com WhatsApp inválido. */
export function parseTransferUnits(raw: string | null | undefined): TransferUnit[] {
  if (!raw?.trim()) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: TransferUnit[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const name = String(o.nome ?? o.name ?? "").trim();
    const phone = normalizeUnitPhone(o.whatsapp ?? o.phone);
    if (!name || !phone) continue;
    out.push({ name, phone, hint: String(o.observacao ?? o.hint ?? "").trim() });
  }
  return out;
}

/** Serializa para agents.settings (formato do painel). */
export function serializeTransferUnits(units: { name: string; phone: string; hint?: string }[]): string {
  return JSON.stringify(
    units.map((u) => ({ nome: u.name.trim(), whatsapp: u.phone.trim(), observacao: (u.hint ?? "").trim() })),
  );
}

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * A loja que a IA pediu. Nome exato (sem acento/caixa) primeiro; senão, uma
 * única loja cujo nome contenha o pedido (ou vice-versa). Ambíguo ou inexistente
 * → null: melhor cair na escalada comum do que alertar a loja errada.
 */
export function resolveTransferUnit(
  units: TransferUnit[],
  requested: string | null | undefined,
): TransferUnit | null {
  const r = norm(requested ?? "");
  if (!r || units.length === 0) return null;
  const exact = units.filter((u) => norm(u.name) === r);
  if (exact.length === 1) return exact[0]!;
  const partial = units.filter((u) => {
    const n = norm(u.name);
    return n.includes(r) || r.includes(n);
  });
  return partial.length === 1 ? partial[0]! : null;
}

/** Bloco do prompt com as lojas e como transferir. Vazio sem lojas cadastradas. */
export function buildTransferUnitsPromptBlock(units: TransferUnit[]): string {
  if (units.length === 0) return "";
  const lista = units.map((u) => `- ${u.name}${u.hint ? ` — ${u.hint}` : ""}`).join("\n");
  return `# TRANSFERÊNCIA PARA OUTRA LOJA

Este atendimento é de uma CENTRAL. Quando o atendimento precisar seguir com uma loja específica (siga as regras do prompt do proprietário sobre quando e para qual loja transferir), TRANSFIRA:
- next_stage="ESCALATED";
- lead_data_patch.transfer_unit = o nome EXATO de uma das lojas abaixo;
- lead_data_patch.escalation_reason = resumo curto para a loja (o que o lead quer, datas, quantidade, dados já coletados).
No reply, avise o lead que a equipe da loja vai continuar o atendimento por aqui. Depois de transferir, a IA não responde mais este contato.

Lojas disponíveis:
${lista}

Nunca transfira para uma loja fora desta lista.`;
}
