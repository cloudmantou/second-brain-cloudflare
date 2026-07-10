/**
 * Post-process OAuthProvider responses so ChatGPT / MCP clients get absolute URLs
 * and consistent CORS on the OAuth surface.
 */

import { resolvePublicOrigin } from "./public-origin";

export function isOAuthEndpointPath(pathname: string): boolean {
  return (
    pathname === "/oauth/register" ||
    pathname.startsWith("/oauth/register/") ||
    pathname === "/oauth/token" ||
    pathname === "/oauth/authorize" ||
    pathname.startsWith("/oauth/authorize")
  );
}

/**
 * Rewrite relative registration_client_uri to absolute public URL.
 * workers-oauth-provider currently returns "/oauth/register/{id}".
 */
export async function hardenOAuthResponse(
  request: Request,
  response: Response,
  env: { PUBLIC_URL?: string; PUBLIC_BASE_URL?: string }
): Promise<Response> {
  const url = new URL(request.url);
  if (!isOAuthEndpointPath(url.pathname)) return response;

  const origin = resolvePublicOrigin(request, env);
  let next = response;

  // Absolute registration_client_uri on DCR success
  if (
    url.pathname === "/oauth/register" &&
    request.method === "POST" &&
    response.ok
  ) {
    try {
      const data = (await response.clone().json()) as Record<string, unknown>;
      const uri = data.registration_client_uri;
      if (typeof uri === "string" && uri.startsWith("/")) {
        data.registration_client_uri = `${origin}${uri}`;
        next = new Response(JSON.stringify(data), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
    } catch {
      /* leave as-is */
    }
  }

  // Ensure CORS on OAuth endpoints for browser-based ChatGPT connector UI
  const originHeader = request.headers.get("Origin");
  if (originHeader) {
    const headers = new Headers(next.headers);
    if (!headers.has("Access-Control-Allow-Origin")) {
      headers.set("Access-Control-Allow-Origin", originHeader);
      headers.set("Access-Control-Allow-Methods", "*");
      headers.set(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, *"
      );
      headers.set("Access-Control-Max-Age", "86400");
    }
    next = new Response(next.body, {
      status: next.status,
      statusText: next.statusText,
      headers,
    });
  }

  return next;
}

/** Friendly probe responses for GET/HEAD on token & register (ChatGPT diagnostics). */
export function oauthMethodProbe(
  request: Request,
  pathname: string
): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  if (pathname === "/oauth/register") {
    const body = JSON.stringify({
      ok: true,
      endpoint: "oauth_register",
      methods: ["POST"],
      description:
        "RFC 7591 dynamic client registration. POST JSON with redirect_uris.",
    });
    return new Response(request.method === "HEAD" ? null : body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        Allow: "POST, OPTIONS",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (pathname === "/oauth/token") {
    const body = JSON.stringify({
      ok: true,
      endpoint: "oauth_token",
      methods: ["POST"],
      description:
        "OAuth token endpoint. POST application/x-www-form-urlencoded.",
    });
    return new Response(request.method === "HEAD" ? null : body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        Allow: "POST, OPTIONS",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return null;
}
