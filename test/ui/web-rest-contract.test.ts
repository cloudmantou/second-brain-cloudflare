import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(path.join(process.cwd(), "public/index.html"), "utf8");

describe("web memory mutation API contract", () => {
  it("uses REST for append and forget instead of routing the UI through MCP", () => {
    expect(html).not.toContain("async function apiMcp");
    expect(html).toMatch(/async function apiAppend[\s\S]*?\/append/);
    expect(html).toMatch(/async function apiForget[\s\S]*?\/forget/);
    expect(html).toContain("await apiAppend(pendingAppendId, addition)");
    expect(html).toContain("await apiForget(idToForget)");
  });

  it("validates capture, append, and forget REST responses", () => {
    expect((html.match(/parseApiJsonResponse\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("imports backups sequentially in D1-safe batches", () => {
    expect(html).toContain("await importEntriesInBatches(entries");
  });
});
