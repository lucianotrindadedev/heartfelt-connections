// As respostas FIXAS dos guards são enviadas a TODOS os agentes da plataforma —
// odontologia, estética, escola, casa de festas, mentoria. Qualquer vocabulário
// de um ramo específico vaza para os outros.
//
// Caso real (Odonto Sorrisos, 87 99116-9430, 04/08): o fallback do guard
// anti-duplicata perguntava "você quer agendar uma visita ou tirar alguma dúvida
// (valores, TURMAS, etc.)?" numa clínica odontológica. O "turmas" tinha vindo de
// um caso da Maple Bear (escola) e vazou para todo mundo: 170 mensagens em 16
// contas, das quais só 2 eram escolas.
//
// Este teste varre o CÓDIGO-FONTE em vez de chamar as funções porque os textos
// são literais inline dentro da cadeia de guards do orquestrador — não há função
// pura para exercitar. É um teste de higiene, não de comportamento.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ORQUESTRADOR = "src/lib/agents/orchestrator.server.ts";

/** Termos que só fazem sentido em UM ramo. Se aparecerem num texto enviado ao
 *  lead, algum outro ramo vai receber a mensagem errada. */
const VOCABULARIO_DE_RAMO = [
  "turma",
  "turmas",
  "matrícula",
  "matricula",
  "mensalidade",
  "aluno",
  "alunos",
  "aniversariante",
  "convidados",
  "dentista",
  "odontológic",
  "implante",
  "sorriso",
];

/**
 * Extrai os literais atribuídos a `reply` — as frases que de fato chegam ao
 * lead. Ignora comentários (onde citar "turmas" ao explicar o caso é legítimo).
 */
function textosEnviadosAoLead(fonte: string): string[] {
  const semComentarios = fonte
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  const textos: string[] = [];
  // reply = "..."  |  reply = `...`  (inclusive quebrado em várias linhas)
  const re = /\breply\s*=\s*(?:\r?\n\s*)?(["'`])([\s\S]*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(semComentarios)) !== null) {
    textos.push(m[2]!);
  }
  return textos;
}

describe("respostas fixas dos guards não podem ter vocabulário de um ramo só", () => {
  const fonte = readFileSync(ORQUESTRADOR, "utf8");
  const textos = textosEnviadosAoLead(fonte);

  it("encontra os textos de resposta no orquestrador", () => {
    // Se a extração parar de achar nada, o teste vira vacuoso sem avisar.
    expect(textos.length).toBeGreaterThan(3);
  });

  for (const termo of VOCABULARIO_DE_RAMO) {
    it(`nenhuma resposta menciona "${termo}"`, () => {
      const infratores = textos.filter((t) =>
        new RegExp(`\\b${termo}\\b`, "i").test(t),
      );
      expect(infratores, `resposta com vocabulário de ramo: ${infratores[0]}`).toEqual([]);
    });
  }
});
