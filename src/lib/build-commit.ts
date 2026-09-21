/**
 * Qual commit está REALMENTE no ar — e de onde essa informação veio.
 *
 * Contexto (21/09/2026): `/api/health` respondia `commit:"unknown"` desde
 * sempre, porque as cinco fontes que ele consultava eram impossíveis ao mesmo
 * tempo neste deploy. A Coolify passa `SOURCE_COMMIT` como build arg, mas o
 * Dockerfile não o declarava com `ARG` — e um build arg não declarado não
 * existe dentro do build. O fallback `git rev-parse` do build-vercel.mjs também
 * não tinha como rodar: `.git` está no `.dockerignore` e a imagem slim não traz
 * o binário do git.
 *
 * Custo real: confirmar a correção do PR #49 teve que ser feito sondando o
 * comportamento contra a API do Clinicorp, porque não havia como perguntar ao
 * sistema que versão estava servindo.
 *
 * Por isso esta função devolve a FONTE junto com o valor: um "unknown" mudo não
 * diz se a variável falta, se está vazia ou se chegou literalmente "unknown".
 */
export interface DeployCommit {
  commit: string;
  /** Nome da fonte que respondeu, ou "nenhuma" quando nada respondeu. */
  source: string;
}

/**
 * Primeira fonte com valor útil vence. Descarta vazio, espaço em branco e o
 * literal "unknown" — esse último é o que o build grava quando ele próprio não
 * conseguiu resolver, e tratá-lo como resposta mascararia a falha.
 */
export function resolveDeployCommit(
  fontes: readonly (readonly [string, string | undefined | null])[],
): DeployCommit {
  for (const [nome, valor] of fontes) {
    if (typeof valor !== "string") continue;
    const v = valor.trim();
    if (v === "" || v.toLowerCase() === "unknown") continue;
    return { commit: v, source: nome };
  }
  return { commit: "unknown", source: "nenhuma" };
}
