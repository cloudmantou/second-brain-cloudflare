/**
 * Self-host entrypoint — Fastify front door over the existing Worker fetch handler.
 *
 * Usage:
 *   cp .env.example .env   # set AUTH_TOKEN + LLM_* / EMBEDDING_*
 *   npm run server
 *
 * Cloudflare Worker entry remains: src/index.ts via wrangler.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import dotenv from "dotenv";
import worker from "./index";
import {
  createExecutionContext,
  createSelfhostEnv,
} from "./selfhost/env";
import { handleWithWorker } from "./selfhost/fetch-adapter";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
};

async function tryServePublic(
  urlPath: string
): Promise<{ body: Buffer; contentType: string } | null> {
  let rel = decodeURIComponent(urlPath.split("?")[0] || "/");
  if (rel === "/") rel = "/index.html";
  const resolved = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  try {
    const body = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    return { body, contentType: MIME[ext] || "application/octet-stream" };
  } catch {
    return null;
  }
}

async function main() {
  const { env, databasePath } = createSelfhostEnv();

  // Eager schema init (entries table + migrations via /count → initializeDatabase)
  const ctx = createExecutionContext();
  await worker.fetch(
    new Request("http://localhost/count", {
      headers: { Authorization: `Bearer ${env.AUTH_TOKEN}` },
    }),
    env,
    ctx
  );

  const app = Fastify({
    logger: true,
    bodyLimit: 10 * 1024 * 1024,
  });

  // Preserve raw body for OAuth form posts
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    }
  );
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      if (!body || (body as string).length === 0) {
        done(null, null);
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  app.get("/health", async () => ({
    ok: true,
    mode: "selfhost",
    database: databasePath,
    llm: Boolean(env.LLM_BASE_URL && env.LLM_API_KEY),
    embedding: Boolean(env.EMBEDDING_BASE_URL && env.EMBEDDING_API_KEY),
  }));

  app.all("/*", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD") {
      const urlPath = req.url.split("?")[0] || "/";
      const isApi =
        urlPath.startsWith("/mcp") ||
        urlPath.startsWith("/oauth") ||
        urlPath.startsWith("/capture") ||
        urlPath.startsWith("/recall") ||
        urlPath.startsWith("/list") ||
        urlPath.startsWith("/count") ||
        urlPath.startsWith("/stats") ||
        urlPath.startsWith("/chat") ||
        urlPath.startsWith("/digest") ||
        urlPath.startsWith("/append") ||
        urlPath.startsWith("/update") ||
        urlPath.startsWith("/forget") ||
        urlPath.startsWith("/tags") ||
        urlPath.startsWith("/.well-known");

      if (!isApi) {
        const file = await tryServePublic(urlPath);
        if (file) {
          reply.header("content-type", file.contentType);
          if (req.method === "HEAD") return reply.send();
          return reply.send(file.body);
        }
      }
    }
    await handleWithWorker(req, reply, env);
  });

  // Nightly compression — check hourly; runs during 01:00 UTC like wrangler cron
  setInterval(() => {
    if (new Date().getUTCHours() !== 1) return;
    worker
      .scheduled({} as ScheduledEvent, env, createExecutionContext())
      .catch((err) => console.error("[scheduled]", err));
  }, 60 * 60 * 1000);

  await app.listen({ port: PORT, host: HOST });
  const displayHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  console.log(`Second Brain self-host listening on http://${displayHost}:${PORT}`);
  console.log(`  database: ${databasePath}`);
  console.log(`  MCP:      http://${displayHost}:${PORT}/mcp`);
  console.log(
    `  LLM:      ${env.LLM_BASE_URL ? env.LLM_BASE_URL : "(not set — configure LLM_BASE_URL)"}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
