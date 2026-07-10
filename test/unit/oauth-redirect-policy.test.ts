import { describe, expect, it } from "vitest";
import {
  checkOAuthRedirectOrigin,
  oauthFormActionSources,
} from "../../src/oauth/redirect-policy";

describe("OAuth redirect origin policy", () => {
  it("uses a closed personal default when no allowlist is configured", () => {
    expect(checkOAuthRedirectOrigin("https://chatgpt.com/aip/callback", undefined).allowed).toBe(true);
    expect(checkOAuthRedirectOrigin("http://localhost:43123/callback", undefined).allowed).toBe(true);
    expect(checkOAuthRedirectOrigin("https://client.example/callback", undefined).allowed).toBe(false);
  });

  it("requires an explicit wildcard to allow arbitrary registered origins", () => {
    expect(checkOAuthRedirectOrigin("https://client.example/callback", "*").allowed).toBe(true);
  });

  it("allows exact HTTPS origins and loopback ports", () => {
    const allowed = "https://chatgpt.com,http://127.0.0.1,http://localhost";
    expect(checkOAuthRedirectOrigin("https://chatgpt.com/aip/callback", allowed).allowed).toBe(true);
    expect(checkOAuthRedirectOrigin("http://127.0.0.1:43123/callback", allowed).allowed).toBe(true);
    expect(checkOAuthRedirectOrigin("http://localhost:9876/callback", allowed).allowed).toBe(true);
  });

  it("rejects unlisted origins and malformed redirects", () => {
    const allowed = "https://chatgpt.com,http://127.0.0.1";
    expect(checkOAuthRedirectOrigin("https://evil.example/callback", allowed).allowed).toBe(false);
    expect(checkOAuthRedirectOrigin("https://chatgpt.com:444/aip/callback", allowed).allowed).toBe(false);
    expect(checkOAuthRedirectOrigin("not-a-url", allowed).allowed).toBe(false);
  });
});

describe("oauthFormActionSources", () => {
  it("includes self, ChatGPT, and any-port loopback on default allowlist", () => {
    const sources = oauthFormActionSources(undefined);
    expect(sources).toContain("'self'");
    expect(sources).toContain("https://chatgpt.com");
    expect(sources).toContain("http://127.0.0.1:*");
    expect(sources).toContain("http://localhost:*");
  });

  it("mirrors a custom allowlist for CSP form-action", () => {
    const sources = oauthFormActionSources(
      "https://chatgpt.com,https://client.example,http://127.0.0.1:9000"
    );
    expect(sources).toContain("'self'");
    expect(sources).toContain("https://chatgpt.com");
    expect(sources).toContain("https://client.example");
    expect(sources).toContain("http://127.0.0.1:9000");
    expect(sources).not.toContain("http://localhost");
  });

  it("uses wildcard form-action only when redirect allowlist is *", () => {
    expect(oauthFormActionSources("*")).toBe("*");
  });
});
