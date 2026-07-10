/**
 * Convert a Fastify request into a Fetch API Request and write the Response back.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../index";
import worker from "../index";
import { createExecutionContext } from "./env";

function buildRequestUrl(req: FastifyRequest): string {
  const host = req.headers.host || "127.0.0.1";
  const protoHeader = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader) || "http";
  return `${proto}://${host}${req.url}`;
}

export async function handleWithWorker(
  req: FastifyRequest,
  reply: FastifyReply,
  env: Env
): Promise<void> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  // Avoid Node content-length mismatches when body is re-serialized.
  headers.delete("content-length");

  let body: BodyInit | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.body == null) {
      body = undefined;
    } else if (Buffer.isBuffer(req.body)) {
      body = new Uint8Array(req.body);
    } else if (typeof req.body === "string") {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
  }

  const request = new Request(buildRequestUrl(req), {
    method: req.method,
    headers,
    body,
  });

  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);

  reply.status(response.status);
  response.headers.forEach((value, key) => {
    // Fastify manages these; hop-by-hop headers are skipped.
    if (key.toLowerCase() === "transfer-encoding") return;
    reply.header(key, value);
  });

  const buf = Buffer.from(await response.arrayBuffer());
  reply.send(buf);
}
