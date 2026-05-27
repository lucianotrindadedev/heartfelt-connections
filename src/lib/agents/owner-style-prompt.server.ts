// Reforço de tom/emojis do system_prompt do proprietário nos sub-agentes.
// O prompt hardcoded de qualifier/scheduler tende a tom formal; sem este bloco
// o modelo costuma ignorar emojis e mensagens-modelo definidas pelo usuário.

export function buildOwnerStylePromptBlock(): string {
  return `# TOM, EMOJIS E ESTILO (prioridade do proprietário)

As "INSTRUÇÕES ADICIONAIS DO PROPRIETÁRIO" (bloco abaixo) definem tom de voz, emojis e mensagens exatas — elas têm prioridade sobre o tom genérico deste módulo.

Se o proprietário pedir uso de emojis (ex.: 😊 🇨🇦 🐻), inclua-os normalmente no campo JSON \`reply\` (Unicode). Não omita emojis por formalidade, por JSON estruturado ou por parecer "robótico".

Quando o prompt do proprietário traz uma mensagem-modelo (ex.: abertura da ETAPA 1), use o texto conforme indicado, inclusive emojis.`;
}
