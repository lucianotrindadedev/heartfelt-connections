// @lovable.dev/vite-tanstack-config já inclui:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ alias, React/TanStack dedupe,
//     error logger plugins, sandbox detection.
//
// Targets:
//   - Padrão (sem env var)         → Cloudflare Workers (wrangler deploy)
//   - BUILD_TARGET=static          → SPA estática (Coolify/Nginx)
//   - VERCEL=1 (set pelo Vercel)   → Node.js server (Vercel Serverless Functions)
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const isStaticBuild = process.env.BUILD_TARGET === "static";
const isVercel = !!process.env.VERCEL;

export default defineConfig(
  isVercel
    ? {
        // Desabilita Cloudflare plugin para gerar bundle Node.js compatível com Vercel.
        // client.base "/" mantém caminhos de assets idênticos ao build CF (sem /_build prefix).
        cloudflare: false,
        tanstackStart: {
          client: { base: "/" },
        },
      }
    : isStaticBuild
      ? {
          cloudflare: false,
          tanstackStart: {
            target: "static",
            spa: { enabled: true },
          },
        }
      : {},
);
