"use strict";
/**
 * Servidor Node persistente para Coolify (substitui serverless Vercel).
 * Serve assets estáticos + TanStack Start via server-bundle.cjs.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STATIC_ROOT = path.join(ROOT, ".vercel/output/static");
const BUNDLE = path.join(ROOT, ".vercel/output/functions/index.func/server-bundle.cjs");

const serverModule = require(BUNDLE);
const app = serverModule?.default ?? serverModule;
if (typeof app.fetch !== "function") {
  throw new Error("server-bundle.cjs não exporta fetch()");
}

const PORT = Number(process.env.PORT || 3000);

function guessContentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

function tryReadStatic(pathname) {
  if (!pathname.startsWith("/assets/")) return null;
  const file = path.join(STATIC_ROOT, pathname.slice(1));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return { body: fs.readFileSync(file), type: guessContentType(file) };
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://local");

    const stat = tryReadStatic(url.pathname);
    if (stat) {
      res.statusCode = 200;
      res.setHeader("Content-Type", stat.type);
      res.end(stat.body);
      return;
    }

    const proto = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    const fullUrl = `${proto}://${host}${req.url || "/"}`;

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : null;
    const hasBody = !["GET", "HEAD"].includes(req.method || "GET") && body;

    const webRequest = new Request(fullUrl, {
      method: req.method || "GET",
      headers: new Headers(req.headers),
      body: hasBody ? body : null,
      ...(hasBody ? { duplex: "half" } : {}),
    });

    const webResponse = await app.fetch(webRequest);
    res.statusCode = webResponse.status;
    webResponse.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await webResponse.arrayBuffer()));
  } catch (err) {
    console.error("[iasarai] request error:", err);
    res.statusCode = 500;
    res.end("Internal Server Error");
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[iasarai] listening on http://0.0.0.0:${PORT}`);

  if (process.env.REDIS_URL && process.env.REDIS_QUEUE_WORKER === "true") {
    setTimeout(() => {
      const secret = process.env.CRON_SECRET;
      const headers = secret ? { "x-cron-secret": secret } : {};
      void fetch(`http://127.0.0.1:${PORT}/api/health`, { headers }).catch((err) => {
        console.warn("[iasarai] warmup redis worker via /api/health:", err?.message ?? err);
      });
    }, 1500);
  }
});
