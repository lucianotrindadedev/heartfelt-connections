/**
 * Comandos configuráveis de pausar/reativar a IA (agent.settings).
 * Aceita qualquer texto definido no painel; suporta vários comandos separados por vírgula.
 */

const COMMAND_SEPARATORS = /[,;|\n]+/;

/** Normaliza mensagem ou comando (remove prefixo *Atendente:*, acentos, espaços extras). */
export function normalizeCommandText(text: string): string {
  return text
    .trim()
    .replace(/^\*[^*]+:\*\s*/s, "")
    .replace(/^\*[^*]+\*\s*/s, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Converte o valor salvo em settings em lista de comandos (sem aplicar default). */
export function parseAgentCommands(raw: string | undefined | null): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(COMMAND_SEPARATORS)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Lista final: o que o usuário configurou, ou defaults se vazio. */
export function resolveAgentCommands(
  raw: string | undefined | null,
  defaults: string[],
): string[] {
  const parsed = parseAgentCommands(raw);
  return parsed.length > 0 ? parsed : defaults;
}

function matchesSingleCommand(normalizedMessage: string, rawCommand: string): boolean {
  const cmd = normalizeCommandText(rawCommand);
  if (!normalizedMessage || !cmd) return false;
  if (normalizedMessage === cmd) return true;
  const msgCore = normalizedMessage.replace(/^\//, "");
  const cmdCore = cmd.replace(/^\//, "");
  return msgCore === cmdCore;
}

/** Verifica se a mensagem do lead corresponde a algum comando configurado. */
export function messageMatchesAgentCommand(
  message: string,
  configured: string | undefined | null,
  defaults: string[],
): boolean {
  const commands = resolveAgentCommands(configured, defaults);
  const msg = normalizeCommandText(message);
  return commands.some((cmd) => matchesSingleCommand(msg, cmd));
}
