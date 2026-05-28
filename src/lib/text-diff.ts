// Diff por linhas usando LCS (longest common subsequence).
// Retorna sequência de operações context/add/remove para visualização lado-a-lado.

export type DiffOp = { type: "context"; text: string } | { type: "add"; text: string } | { type: "remove"; text: string };

/** Diff por linhas baseado em LCS. Não é o algoritmo mais rápido para arquivos
 *  enormes, mas para prompts de ~15k chars roda em <50ms — suficiente. */
export function lineDiff(before: string, after: string): DiffOp[] {
  // Normaliza quebras de linha (CRLF/CR → LF) antes de comparar. Sem isso, um
  // prompt salvo com \r\n vs uma proposta com \n faria TODA linha "diferir"
  // (cada linha do "antes" termina com \r invisível), poluindo o diff com
  // trechos sem relação com a mudança real.
  const a = before.replace(/\r\n?/g, "\n").split("\n");
  const b = after.replace(/\r\n?/g, "\n").split("\n");
  const n = a.length;
  const m = b.length;

  // LCS DP table
  const dp: number[][] = Array(n + 1)
    .fill(0)
    .map(() => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Backtrack para gerar ops
  const ops: DiffOp[] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "context", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "remove", text: a[i] });
      i++;
    } else {
      ops.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "remove", text: a[i++] });
  while (j < m) ops.push({ type: "add", text: b[j++] });
  return ops;
}

/** Resumo numérico do diff. */
export function diffStats(ops: DiffOp[]): {
  added: number;
  removed: number;
  changed_lines: number;
} {
  let added = 0,
    removed = 0;
  for (const op of ops) {
    if (op.type === "add") added++;
    else if (op.type === "remove") removed++;
  }
  return { added, removed, changed_lines: added + removed };
}

/** Devolve apenas os blocos de mudança (linhas removed/added contíguas)
 *  com até `contextLines` linhas de contexto em volta. Útil para preview compacto. */
export function diffChangeBlocks(
  ops: DiffOp[],
  contextLines = 1,
): DiffOp[][] {
  const blocks: DiffOp[][] = [];
  let current: DiffOp[] | null = null;
  let contextBuffer: DiffOp[] = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === "context") {
      if (current) {
        // Já temos um bloco aberto: pega `contextLines` de contexto pós
        current.push(op);
        // Conta quantos contexts seguidos pós-mudança
        let trailing = 1;
        let k = i + 1;
        while (k < ops.length && ops[k].type === "context" && trailing < contextLines) {
          current.push(ops[k]);
          trailing++;
          k++;
        }
        // Se o próximo não-context vier logo, mantém o bloco aberto e segue
        // Senão, fecha
        const next = ops[k];
        if (!next || next.type === "context") {
          blocks.push(current);
          current = null;
          contextBuffer = [];
          i = k - 1;
        } else {
          i = k - 1;
        }
      } else {
        contextBuffer.push(op);
        if (contextBuffer.length > contextLines) contextBuffer.shift();
      }
    } else {
      // add ou remove
      if (!current) {
        current = [...contextBuffer];
        contextBuffer = [];
      }
      current.push(op);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}
