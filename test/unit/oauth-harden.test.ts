import { describe, it, expect } from "vitest";
import { hardenOAuthResponse, oauthMethodProbe } from "../../src/oauth/harden";

describe("oauth harden", () => {
  it("makes registration_client_uri absolute", async () => {
    const req = new Request("https://agent.mtzs.cloud/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://chatgpt.com" },
      body: "{}",
    });
    const upstream = new Response(
      JSON.stringify({
        client_id: "abc",
        client_secret: "sec",
        registration_client_uri: "/oauth/register/abc",
      }),
      { status: 201, headers: { "content-type": "application/json" } }
    );
    const out = await hardenOAuthResponse(req, upstream, {
      PUBLIC_URL: "https://agent.mtzs.cloud",
    });
    const data = (await out.json()) as Record<string, string>;
    expect(data.registration_client_uri).toBe(
      "https://agent.mtzs.cloud/oauth/register/abc"
    );
    expect(out.headers.get("access-control-allow-origin")).toBe(
      "https://chatgpt.com"
    );
  });

  it("GET /oauth/register probe is 200", () => {
    const res = oauthMethodProbe(
      new Request("https://x/oauth/register"),
      "/oauth/register"
    );
    expect(res?.status).toBe(200);
  });

  it("GET /oauth/token probe is 200", () => {
    const res = oauthMethodProbe(
      new Request("https://x/oauth/token"),
      "/oauth/token"
    );
    expect(res?.status).toBe(200);
  });
});
