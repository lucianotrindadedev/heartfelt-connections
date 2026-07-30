// Extração de identificadores do payload do webhook de etiquetas da Helena.
//
// O evento registrado no CRM é "Contato etiqueta alterada". O envelope desse
// evento varia e NÃO é o mesmo das mensagens — a versão anterior procurava as
// chaves de forma RASA e com uma assimetria: o ramo `changeMetadata` aceitava
// `id`, mas o ramo `content` não. Se a Helena manda
// `{ content: { id: "<contactId>", ... } }` — formato natural de "contato
// alterado" — nada era encontrado, o webhook respondia 200 `no-identifier` e a
// automação MORRIA em silêncio (0 execuções em 5 clínicas, nenhuma desde 06/07).
//
// Aqui a busca é PROFUNDA e agnóstica ao envelope: varre o objeto inteiro
// procurando as chaves conhecidas, em qualquer nível.
//
// PURO: sem I/O, para poder testar cada formato de envelope.

/** Nomes de chave que carregam o id do contato, em qualquer nível do payload. */
const CONTACT_ID_KEYS = [
  "contactid",
  "contact_id",
  "contactidentifier",
  "entityid",
  "entity_id",
];

/** Chaves de sessão/atendimento. */
const SESSION_ID_KEYS = ["sessionid", "session_id", "ticketid", "ticket_id"];

/** Chaves de telefone. */
const PHONE_KEYS = ["phonenumber", "phone_number", "phone", "telefone", "from", "to"];

/** Objetos cujo `id` É, com certeza, o id do contato. */
const CONTACT_CONTAINER_KEYS = ["contact", "contato", "changemetadata", "entity"];

/**
 * Containers AMBÍGUOS: `content.id` é o id da MENSAGEM no webhook de mensagens,
 * mas no evento de etiqueta o `content` pode ser o próprio contato. Só é usado
 * como ÚLTIMO recurso, depois de esgotar os identificadores inequívocos.
 *
 * Um palpite errado aqui é inofensivo: resolveContact tenta contactId →
 * sessionId → telefone, e um id que não resolve simplesmente cai para o
 * próximo. Melhor tentar do que devolver "no-identifier" e morrer calado.
 */
const AMBIGUOUS_CONTAINER_KEYS = ["content", "data", "payload"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asId(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Varre o payload em profundidade procurando a primeira chave da lista.
 * `containerKeys`: nomes de objeto cujo `id` interno também vale como resposta
 * (ex.: `content.contact.id` → id do contato).
 */
function deepFind(
  root: unknown,
  keys: string[],
  containerKeys: string[] = [],
  maxDepth = 6,
): string | null {
  const wanted = new Set(keys);
  const containers = new Set(containerKeys);
  const queue: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];

  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;
    if (depth > maxDepth) continue;

    if (Array.isArray(node)) {
      for (const item of node) queue.push({ node: item, depth: depth + 1 });
      continue;
    }
    if (!isPlainObject(node)) continue;

    // 1) chave direta (contactId, phoneNumber…)
    for (const [k, v] of Object.entries(node)) {
      if (wanted.has(k.toLowerCase())) {
        const id = asId(v);
        if (id) return id;
      }
    }
    // 2) container cujo `id` é o que queremos (contact.id, changeMetadata.id…)
    for (const [k, v] of Object.entries(node)) {
      if (containers.has(k.toLowerCase()) && isPlainObject(v)) {
        const id = asId(v.id ?? v.Id ?? v.ID);
        if (id) return id;
      }
    }
    for (const v of Object.values(node)) {
      if (isPlainObject(v) || Array.isArray(v)) queue.push({ node: v, depth: depth + 1 });
    }
  }
  return null;
}

export interface ExtractedIds {
  contactId: string | null;
  sessionId: string | null;
  phone: string | null;
}

/**
 * Identificadores do contato a partir de QUALQUER envelope da Helena.
 * Ordem de preferência: contactId → sessionId → telefone.
 */
export function extractTagEventIds(body: unknown): ExtractedIds {
  const contactId =
    // 1º: chaves/containers inequívocos (contactId, contact.id, entityId…)
    deepFind(body, CONTACT_ID_KEYS, CONTACT_CONTAINER_KEYS) ??
    // 2º: só então os ambíguos (content.id pode ser id de mensagem)
    deepFind(body, [], AMBIGUOUS_CONTAINER_KEYS);
  const sessionId = deepFind(body, SESSION_ID_KEYS);
  const phone = deepFind(body, PHONE_KEYS);
  return { contactId, sessionId, phone };
}

/**
 * Esqueleto do payload (só as CHAVES e os tipos, sem os valores) para log de
 * diagnóstico. Permite descobrir o formato real do evento sem despejar dado
 * pessoal do lead (telefone, nome) no log.
 */
export function payloadShape(value: unknown, depth = 0): unknown {
  if (depth > 4) return "…";
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [payloadShape(value[0], depth + 1), `…(${value.length})`];
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = payloadShape(v, depth + 1);
    return out;
  }
  if (value === null) return "null";
  return typeof value;
}
