import { DEFAULT_PERSONAL_OAUTH_REDIRECT_ORIGINS } from "./constants";

export interface OAuthRedirectPolicyResult {
  allowed: boolean;
  redirectOrigin?: string;
  reason?: string;
}

function configuredOrigins(raw: string): URL[] {
  return raw
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        return [new URL(value)];
      } catch {
        return [];
      }
    });
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/**
 * CSP form-action sources for the OAuth login page.
 *
 * Chrome/Safari apply form-action to the entire form navigation chain, including
 * the 302 back to the client after successful authorization. Listing only 'self'
 * therefore blocks redirect_uri hosts (e.g. https://chatgpt.com) even though the
 * form POSTs to the same origin. The console often still reports the form action
 * URL rather than the redirect target.
 *
 * Sources mirror OAUTH_ALLOWED_REDIRECT_ORIGINS / checkOAuthRedirectOrigin.
 */
export function oauthFormActionSources(allowlist: string | undefined): string {
  if (allowlist?.trim() === "*") {
    // Explicit open allowlist: any registered client redirect is permitted.
    return "*";
  }

  const effectiveAllowlist = allowlist?.trim()
    ? allowlist
    : DEFAULT_PERSONAL_OAUTH_REDIRECT_ORIGINS;
  const sources = new Set<string>(["'self'"]);

  for (const candidate of configuredOrigins(effectiveAllowlist)) {
    if (isLoopbackHostname(candidate.hostname) && !candidate.port) {
      // Match any loopback port, same rule as checkOAuthRedirectOrigin.
      sources.add(`${candidate.protocol}//${candidate.hostname}:*`);
    } else {
      sources.add(candidate.origin);
    }
  }

  return Array.from(sources).join(" ");
}

export function checkOAuthRedirectOrigin(
  redirectUri: string,
  allowlist: string | undefined
): OAuthRedirectPolicyResult {
  let target: URL;
  try {
    target = new URL(redirectUri);
  } catch {
    return { allowed: false, reason: "invalid_redirect_uri" };
  }

  if (allowlist?.trim() === "*") {
    return { allowed: true, redirectOrigin: target.origin };
  }

  const effectiveAllowlist = allowlist?.trim()
    ? allowlist
    : DEFAULT_PERSONAL_OAUTH_REDIRECT_ORIGINS;
  const allowed = configuredOrigins(effectiveAllowlist).some((candidate) => {
    if (candidate.protocol !== target.protocol || candidate.hostname !== target.hostname) {
      return false;
    }
    if (isLoopbackHostname(candidate.hostname) && !candidate.port) return true;
    return candidate.port === target.port;
  });

  return {
    allowed,
    redirectOrigin: target.origin,
    reason: allowed ? undefined : "redirect_origin_not_allowed",
  };
}
