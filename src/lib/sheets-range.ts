// Conversão entre o intervalo A1 guardado em google_sheets_config.planilhas[].aba
// ("Tabela!A1:F500") e os dois campos do painel: aba (dropdown) + intervalo.
//
// Vive fora do *.server.ts porque é usado no componente do painel — importar o
// módulo do servidor no cliente arrastaria token/Supabase para o bundle.

/** Quebra "Tabela!A1:F500" em { tab: "Tabela", range: "A1:F500" }. */
export function splitAba(aba: string): { tab: string; range: string } {
  const raw = (aba ?? "").trim();
  if (!raw) return { tab: "", range: "" };
  const i = raw.lastIndexOf("!");
  if (i < 0) return { tab: unquoteTab(raw), range: "" };
  return { tab: unquoteTab(raw.slice(0, i)), range: raw.slice(i + 1) };
}

/** Monta o intervalo A1. Sem aba, devolve "" (o agente lê a primeira aba). */
export function joinAba(tab: string, range: string): string {
  const t = (tab ?? "").trim();
  const r = (range ?? "").trim();
  if (!t) return "";
  return r ? `${quoteTab(t)}!${r}` : quoteTab(t);
}

/** Aba com espaço, acento ou pontuação precisa de aspas simples na notação A1;
 *  aspa dentro do nome é escapada dobrando. */
function quoteTab(tab: string): string {
  return /^[A-Za-z0-9_]+$/.test(tab) ? tab : `'${tab.replace(/'/g, "''")}'`;
}

function unquoteTab(tab: string): string {
  const t = tab.trim();
  const inner = t.startsWith("'") && t.endsWith("'") && t.length >= 2 ? t.slice(1, -1) : t;
  return inner.replace(/''/g, "'");
}
