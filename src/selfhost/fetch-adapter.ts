/**
 * Convert a Fastify request into a Fetch API Request and stream the Response back.
 */

import { Readable } from "node:stream";
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
    if (key.toLowerCase() === "transfer-encoding") return;
    reply.header(key, value);
  });

  if (!response.body) {
    reply.send();
    return;
  }

  // Stream SSE / large bodies instead of buffering the entire response.
  const nodeStream = Readable.fromWeb(response.body as unknown as import("stream/web").ReadableStream);
  reply.send(nodeStream);
}
