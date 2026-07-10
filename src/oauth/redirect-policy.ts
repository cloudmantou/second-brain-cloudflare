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
    const loopback =
      candidate.hostname === "localhost" ||
      candidate.hostname === "127.0.0.1" ||
      candidate.hostname === "[::1]";
    if (loopback && !candidate.port) return true;
    return candidate.port === target.port;
  });

  return {
    allowed,
    redirectOrigin: target.origin,
    reason: allowed ? undefined : "redirect_origin_not_allowed",
  };
}
