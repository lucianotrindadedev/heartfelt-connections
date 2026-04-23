// @lovable.dev/vite-tanstack-config já inclui:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ alias, React/TanStack dedupe,
//     error logger plugins, sandbox detection.
//
// Para deploy no Coolify (Docker + Nginx) precisamos desabilitar o target Cloudflare
// e gerar um build SPA estático servível por Nginx com fallback para index.html.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const isCoolifyBuild = process.env.BUILD_TARGET === "static";

export default defineConfig(
  isCoolifyBuild
    ? {
        tanstackStart: {
          target: "static",
          spa: { enabled: true },
        },
      }
    : {},
);
