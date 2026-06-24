// Opt-out / descadastro do lead.
//
// Quando o lead pede para PARAR de receber mensagens — seja digitando "sair"
// (em qualquer caixa: SAIR, Sair, sair…) ou qualquer frase pedindo para não
// receber mais mensagens — ele deve ser:
//   1. Etiquetado como "IA Desligada" no CRM (pausa a IA), e
//   2. Removido de toda e qualquer sequência automática (follow-up / warm-up).
//
// A etiqueta "IA Desligada" JÁ é respeitada por todos os caminhos de envio
// automático (webhook de entrada, follow-up-sequence, warm-up) via
// checkContactBlocked*. Ou seja: aplicar a etiqueta é o que efetivamente tira o
// lead das sequências — este módulo só decide QUANDO disparar isso a partir do
// texto do lead.
//
// A detecção tem dois níveis para evitar falsos positivos:
//   • EXATO  — a mensagem inteira (normalizada) é um comando de saída. Usado
//     para palavras curtas e ambíguas como "sair"/"parar" que, soltas no meio
//     de uma frase ("vou sair de casa"), NÃO são opt-out.
//   • CONTÉM — frases específicas e multi-palavra ("não quero receber mais
//     mensagens", "pare de me enviar"…) que são seguras como substring.

import { normalizeCommandText, parseAgentCommands } from "@/lib/agent-commands.server";

/**
 * Comandos de saída reconhecidos quando a mensagem INTEIRA é igual a eles
 * (após normalização: minúsculas, sem acento, sem pontuação de borda).
 * Palavras curtas só contam aqui — nunca como substring.
 */
const EXACT_OPT_OUT = [
  "sair",
  "saír",
  "parar",
  "pare",
  "para",
  "stop",
  "cancelar",
  "descadastrar",
  "remover",
  "unsubscribe",
  "quero sair",
  "sair da lista",
  "me remova",
  "me remove",
  "me tira",
  "me tire",
  "nao quero",
  "nao quero mais",
] as const;

/**
 * Frases que indicam opt-out quando aparecem em QUALQUER lugar da mensagem.
 * São longas/específicas o bastante para não casar por acidente.
 */
const CONTAINS_OPT_OUT = [
  "nao quero receber",
  "nao quero mais receber",
  "nao quero mais mensagem",
  "nao quero mais essas mensagem",
  "nao quero mais ser",
  "nao receber mais",
  "nao receber mensagem",
  "parar de receber",
  "pare de receber",
  "para de receber",
  "parar de mandar",
  "pare de mandar",
  "para de mandar",
  "parar de enviar",
  "pare de enviar",
  "para de enviar",
  "parar de me",
  "pare de me",
  "para de me",
  "nao me envie",
  "nao me mande",
  "nao me manda",
  "nao manda mais",
  "nao envie mais",
  "nao enviar mais",
  "descadastr",
  "me descadastr",
  "remover da lista",
  "remova da lista",
  "tirar da lista",
  "me tira da lista",
  "me tire da lista",
  "sair da lista",
  "cancelar inscricao",
  "cancelar recebimento",
  "nao quero ser incomodad",
  "para de me incomodar",
  "pare de me incomodar",
  "nao perturbe",
  "nao me perturbe",
] as const;

/**
 * Decide se a mensagem do lead é um pedido de opt-out (sair / parar de receber).
 *
 * `extraCommands` permite que o dono adicione comandos exatos extras via
 * settings.opt_out_command (ex.: "cancela, remove-me"). Não substitui os
 * defaults — apenas amplia.
 */
export function isOptOutMessage(message: string, extraCommands?: string | null): boolean {
  const msg = normalizeCommandText(message);
  if (!msg) return false;

  // Para o match EXATO: remove um "/" inicial ("/sair") e pontuação de borda
  // ("sair.", "sair!", "parar..."), comum quando o lead encerra com pontuação.
  const core = msg
    .replace(/^\//, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "");

  const exact = new Set<string>(EXACT_OPT_OUT as readonly string[]);
  for (const extra of parseAgentCommands(extraCommands)) {
    const n = normalizeCommandText(extra).replace(/^\//, "");
    if (n) exact.add(n);
  }
  if (exact.has(core)) return true;

  return CONTAINS_OPT_OUT.some((phrase) => msg.includes(phrase));
}
