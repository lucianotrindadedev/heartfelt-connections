#!/usr/bin/env node
/**
 * build-vercel.mjs
 *
 * Gera o Vercel Build Output API v3 (.vercel/output/) a partir do bundle
 * produzido pelo `vite build` (com VERCEL=1, sem @cloudflare/vite-plugin).
 *
 * Estrutura gerada:
 *   .vercel/output/
 *     config.json                           ← routing
 *     static/assets/**                      ← JS/CSS do browser (dist/client/assets)
 *     functions/index.func/
 *       .vc-config.json                     ← Node.js 20 runtime
 *       server.js                           ← bundle TanStack Start (dist/server/server.js)
 *       assets/**                           ← code-split chunks do servidor
 *       index.mjs                           ← entry da Vercel function (Web fetch handler)
 */

import { execSync } from "child_process";
import { cp, mkdir, rm, writeFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(process.cwd());
const DIST_CLIENT = join(ROOT, "dist/client");
const DIST_SERVER = join(ROOT, "dist/server");
const VERCEL_OUT = join(ROOT, ".vercel/output");

// ── 1. Vite build (Cloudflare desabilitado via VERCEL=1) ────────────────────
console.log("🔨  Building TanStack Start (Node.js target)...");
execSync("npm run build", {
  stdio: "inherit",
  env: { ...process.env, VERCEL: "1" },
});

// Verifica se o build produziu os arquivos esperados
for (const p of [
  join(DIST_CLIENT, "assets"),
  join(DIST_SERVER, "server.js"),
  join(DIST_SERVER, "assets"),
]) {
  if (!existsSync(p)) {
    console.error(`❌  Arquivo esperado não encontrado após build: ${p}`);
    process.exit(1);
  }
}

// ── 2. Limpa e recria .vercel/output ───────────────────────────────────────
console.log("📁  Criando estrutura .vercel/output...");
if (existsSync(VERCEL_OUT)) {
  await rm(VERCEL_OUT, { recursive: true });
}
await mkdir(join(VERCEL_OUT, "static/assets"), { recursive: true });
await mkdir(join(VERCEL_OUT, "functions/index.func/assets"), { recursive: true });

// ── 3. Static assets (browser JS/CSS) ──────────────────────────────────────
console.log("📦  Copiando assets estáticos...");
await cp(
  join(DIST_CLIENT, "assets"),
  join(VERCEL_OUT, "static/assets"),
  { recursive: true },
);

// ── 4. Server bundle (serverless function) ─────────────────────────────────
console.log("⚙️   Copiando bundle do servidor...");
await cp(join(DIST_SERVER, "server.js"), join(VERCEL_OUT, "functions/index.func/server.js"));
await cp(
  join(DIST_SERVER, "assets"),
  join(VERCEL_OUT, "functions/index.func/assets"),
  { recursive: true },
);

// ── 5. Entry point da Vercel function ──────────────────────────────────────
await writeFile(
  join(VERCEL_OUT, "functions/index.func/index.mjs"),
  `// Vercel serverless function entry — wraps TanStack Start's fetch handler
import serverModule from "./server.js";

// server.js exports: { default: server, T, a, c, createServerEntry, g }
// "server" has a .fetch(Request) -> Promise<Response> method
const server = serverModule.default ?? serverModule;

export default async function handler(request) {
  return server.fetch(request);
}
`,
);

// ── 6. Vercel function config (.vc-config.json) ────────────────────────────
await writeFile(
  join(VERCEL_OUT, "functions/index.func/.vc-config.json"),
  JSON.stringify(
    {
      runtime: "nodejs20.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      supportsResponseStreaming: false,
    },
    null,
    2,
  ),
);

// ── 7. Routing config (.vercel/output/config.json) ─────────────────────────
// Ordem: filesystem (assets estáticos) → index.func (tudo mais)
await writeFile(
  join(VERCEL_OUT, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        // 1. Tenta servir arquivos estáticos (assets JS/CSS)
        { handle: "filesystem" },
        // 2. Tudo que não for estático vai para a function
        { src: "^/(.*)", dest: "/index.func" },
      ],
    },
    null,
    2,
  ),
);

// ── Resumo ─────────────────────────────────────────────────────────────────
const funcStat = await stat(join(VERCEL_OUT, "functions/index.func/server.js"));
console.log(`\n✅  Vercel output pronto!`);
console.log(`   server.js   : ${(funcStat.size / 1024).toFixed(0)} KB`);
console.log(`   static/assets: ${existsSync(join(VERCEL_OUT, "static/assets")) ? "ok" : "MISSING"}`);
console.log(`   index.func  : ${existsSync(join(VERCEL_OUT, "functions/index.func/index.mjs")) ? "ok" : "MISSING"}`);
