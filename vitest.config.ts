// Config dedicada do vitest — evita carregar plugins de runtime do vite (TanStack
// Start, Cloudflare, etc), que tentam resolver tipos/manifests pesados durante
// os testes unitarios. Aqui rodamos apenas funcoes puras de src/lib.

import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
    passWithNoTests: true,
  },
});
