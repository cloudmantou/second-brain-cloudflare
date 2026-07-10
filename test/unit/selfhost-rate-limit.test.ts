import { describe, expect, it } from "vitest";
import { createFixedWindowRateLimiter } from "../../src/selfhost/rate-limit";

describe("fixed-window rate limiter", () => {
  it("allows the configured number of attempts and then returns retry timing", () => {
    const limiter = createFixedWindowRateLimiter({ limit: 2, windowMs: 60_000 });

    expect(limiter.consume("127.0.0.1", 1_000).allowed).toBe(true);
    expect(limiter.consume("127.0.0.1", 2_000).allowed).toBe(true);
    expect(limiter.consume("127.0.0.1", 3_000)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 58,
    });
  });

  it("resets after the window and isolates clients", () => {
    const limiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 1_000 });

    expect(limiter.consume("client-a", 0).allowed).toBe(true);
    expect(limiter.consume("client-a", 500).allowed).toBe(false);
    expect(limiter.consume("client-b", 500).allowed).toBe(true);
    expect(limiter.consume("client-a", 1_000).allowed).toBe(true);
  });
});
