// `/api/health` respondeu `commit:"unknown"` desde o primeiro deploy até
// 21/09/2026. Não era uma fonte faltando — eram as CINCO impossíveis ao mesmo
// tempo: a Coolify passa SOURCE_COMMIT como build arg e o Dockerfile não o
// declarava com ARG (build arg não declarado não existe dentro do build), e o
// fallback `git rev-parse` não tinha como rodar porque `.git` está no
// `.dockerignore` e a imagem slim não traz o binário do git.
//
// Custo: confirmar o PR #49 virou uma sonda contra a API do Clinicorp, porque
// não havia como perguntar ao sistema qual versão estava servindo.
//
// O que estes testes travam é a parte que mais enganou: um "unknown" que CHEGA
// como valor (gravado pelo build quando ele próprio desistiu) não pode passar
// por resposta — senão a falha volta a ser muda.

import { describe, expect, it } from "vitest";

import { resolveDeployCommit } from "./build-commit";

describe("resolveDeployCommit", () => {
  it("usa a primeira fonte com valor e diz qual foi", () => {
    expect(
      resolveDeployCommit([
        ["build", "a3f830f377c0"],
        ["SOURCE_COMMIT", "outro"],
      ]),
    ).toEqual({ commit: "a3f830f377c0", source: "build" });
  });

  it("cai para a próxima quando a primeira está ausente ou vazia", () => {
    expect(
      resolveDeployCommit([
        ["build", undefined],
        ["SOURCE_COMMIT", "   "],
        ["GIT_SHA", "bfe4dfd"],
      ]),
    ).toEqual({ commit: "bfe4dfd", source: "GIT_SHA" });
  });

  it('REGRESSÃO: "unknown" gravado pelo build NÃO conta como resposta', () => {
    // build-vercel.mjs grava "unknown" no bundle quando não resolve. Aceitar
    // isso como valor esconderia de novo a falha que custou o dia 21/09.
    expect(
      resolveDeployCommit([
        ["build", "unknown"],
        ["SOURCE_COMMIT", "a3f830f377c0"],
      ]),
    ).toEqual({ commit: "a3f830f377c0", source: "SOURCE_COMMIT" });

    expect(resolveDeployCommit([["build", "UNKNOWN"]])).toEqual({
      commit: "unknown",
      source: "nenhuma",
    });
  });

  it("sem nenhuma fonte, diz explicitamente que nenhuma respondeu", () => {
    expect(resolveDeployCommit([])).toEqual({ commit: "unknown", source: "nenhuma" });
    expect(
      resolveDeployCommit([
        ["build", undefined],
        ["SOURCE_COMMIT", null],
        ["GIT_SHA", ""],
      ]),
    ).toEqual({ commit: "unknown", source: "nenhuma" });
  });

  it("apara espaço em volta do valor", () => {
    expect(resolveDeployCommit([["SOURCE_COMMIT", "  a3f830f \n"]])).toEqual({
      commit: "a3f830f",
      source: "SOURCE_COMMIT",
    });
  });
});
