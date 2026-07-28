// Config do DIAGNÓSTICO contra produção (somente leitura).
// Separada da vitest.config.ts de propósito: os arquivos *.diag.ts ficam fora
// de src/ e nunca entram no `npm test`.
//
//   npx vitest run --config scripts/diag/vitest.diag.config.ts
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "..", "..", "src") },
  },
  test: {
    environment: "node",
    include: ["scripts/diag/**/*.diag.ts"],
    globals: false,
    passWithNoTests: true,
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
