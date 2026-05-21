#!/usr/bin/env node
/**
 * build-vercel.mjs
 *
 * Gera o Vercel Build Output API v3 (.vercel/output/) a partir do bundle
 * produzido pelo `vite build` (com VERCEL=1, sem @cloudflare/vite-plugin).
 *
 * Estrutura gerada:
 *   .vercel/output/
 *     config.json                         ← routing
 *     static/assets/**                    ← JS/CSS do browser (dist/client/assets)
 *     functions/index.func/
 *       .vc-config.json                   ← Node.js 20 runtime
 *       index.mjs                         ← entry wrapper
 *       server-bundle.js                  ← server bundleado (esbuild)
 *       chunks/                           ← code-split chunks do servidor
 *
 * Por que esbuild?
 *   O dist/server/server.js importa h3-v2, @tanstack/router-core, react etc.
 *   como pacotes externos. A Vercel function não tem node_modules — por isso
 *   usamos esbuild para bundlear tudo em arquivos auto-suficientes.
 */

import { execSync, spawnSync } from "child_process";
import { cp, mkdir, rm, writeFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { build as esbuild } from "esbuild";

const ROOT = resolve(process.cwd());
const DIST_CLIENT = join(ROOT, "dist/client");
const DIST_SERVER = join(ROOT, "dist/server");
const VERCEL_OUT = join(ROOT, ".vercel/output");
const FUNC_DIR = join(VERCEL_OUT, "functions/index.func");

// ── 1. Vite build (Cloudflare desabilitado via VERCEL=1) ────────────────────
console.log("🔨  Building TanStack Start (Node.js target)...");
const buildResult = spawnSync("npm", ["run", "build"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, VERCEL: "1" },
  cwd: ROOT,
});
if (buildResult.status !== 0) {
  console.error("❌  vite build falhou");
  process.exit(1);
}

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
await mkdir(FUNC_DIR, { recursive: true });

// ── 3. Static assets (browser JS/CSS) ──────────────────────────────────────
console.log("📦  Copiando assets estáticos do browser...");
await cp(join(DIST_CLIENT, "assets"), join(VERCEL_OUT, "static/assets"), {
  recursive: true,
});

// ── 4. esbuild: bundle server.js + todas as dependências npm ───────────────
// O dist/server/server.js importa h3-v2, @tanstack/router-core, react etc.
// como externos (não bundleados pelo vite). O esbuild os inclui todos no output.
//
// --splitting: divide dynamic imports em chunks separados (mantém code-splitting)
// --platform=node: externaliza automaticamente built-ins node:* e fs, crypto, etc.
// --external:*.node: exclui addons nativos
console.log("⚙️   Bundleando servidor com esbuild (inclui dependências npm)...");
// format=cjs: necessário porque algumas dependências usam require() dinâmico
// (splitting não funciona com cjs, então o bundle é um único arquivo grande)
await esbuild({
  entryPoints: [join(DIST_SERVER, "server.js")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: join(FUNC_DIR, "server-bundle.cjs"),
  external: ["*.node"],
  logLevel: "warning",
  // Ignora sideEffects:false do package.json — o servidor precisa de TODOS os módulos
  ignoreAnnotations: true,
  // Não minifica para manter stack traces legíveis nos logs do Vercel
  minify: false,
});

// ── 5. Entry point da Vercel function ──────────────────────────────────────
// Usa CJS require() porque o bundle é CommonJS (por compatibilidade com
// pacotes que usam require() dinâmico como h3-v2, seroval, etc.)
await writeFile(
  join(FUNC_DIR, "index.js"),
  `// Vercel Serverless Function (Node.js runtime).
// Vercel chama handler(req: IncomingMessage, res: ServerResponse).
// Converte para Web Fetch API Request/Response que TanStack Start usa internamente.
"use strict";
const serverModule = require("./server-bundle.cjs");
const server = serverModule?.default ?? serverModule;

module.exports = async function handler(req, res) {
  // ── Constrói URL completa (Vercel IncomingMessage.url é só o path) ─────
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host  = req.headers["x-forwarded-host"]  || req.headers["host"] || "localhost";
  const url   = \`\${proto}://\${host}\${req.url}\`;

  // ── Lê o body como Buffer ──────────────────────────────────────────────
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : null;

  // ── Converte IncomingMessage → Web Request ─────────────────────────────
  const hasBody = !["GET", "HEAD"].includes(req.method || "GET") && body;
  const webRequest = new Request(url, {
    method:  req.method || "GET",
    headers: new Headers(req.headers),
    body:    hasBody ? body : null,
    ...(hasBody ? { duplex: "half" } : {}),
  });

  // ── Chama o TanStack Start server ──────────────────────────────────────
  let webResponse;
  try {
    webResponse = await server.fetch(webRequest);
  } catch (err) {
    console.error("[vercel-handler] server.fetch error:", err);
    res.statusCode = 500;
    res.end("Internal Server Error");
    return;
  }

  // ── Converte Web Response → Node.js ServerResponse ─────────────────────
  res.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => res.setHeader(key, value));
  const buffer = Buffer.from(await webResponse.arrayBuffer());
  res.end(buffer);
};
`,
);

// ── 6. Vercel function config (.vc-config.json) ────────────────────────────
await writeFile(
  join(FUNC_DIR, ".vc-config.json"),
  JSON.stringify(
    {
      runtime: "nodejs20.x",
      handler: "index.js",
      launcherType: "Nodejs",
      supportsResponseStreaming: false,
    },
    null,
    2,
  ),
);

// ── 7. Routing config ─────────────────────────────────────────────────────
// filesystem → tenta arquivos estáticos primeiro; o resto vai para index.func
await writeFile(
  join(VERCEL_OUT, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { handle: "filesystem" },
        { src: "^/(.*)", dest: "/index.func" },
      ],
    },
    null,
    2,
  ),
);

// ── Resumo ─────────────────────────────────────────────────────────────────
const bundleStat = await stat(join(FUNC_DIR, "server-bundle.cjs")).catch(() => ({ size: 0 }));
console.log(`\n✅  Vercel output pronto!`);
console.log(`   server-bundle.js : ${(bundleStat.size / 1024 / 1024).toFixed(1)} MB`);
console.log(`   static/assets    : ${existsSync(join(VERCEL_OUT, "static/assets")) ? "ok" : "MISSING"}`);
console.log(`   index.func/      : ${existsSync(FUNC_DIR) ? "ok" : "MISSING"}`);
