import { describe, it, expect } from "vitest";
import { tokenizeQuery } from "../../src/index";

describe("tokenizeQuery()", () => {
  it("preserves identifier-shaped tokens like version strings", () => {
    expect(tokenizeQuery("release v1.9")).toEqual(["release", "v1.9"]);
  });

  it("drops stopwords and 1-char tokens but keeps the meaningful ones", () => {
    expect(tokenizeQuery("What is the v1.9 release?")).toEqual(["v1.9", "release"]);
  });

  it("strips SQL LIKE wildcards so a token is always a literal substring", () => {
    expect(tokenizeQuery("foo_bar 100%")).toEqual(["foobar", "100"]);
  });

  it("deduplicates repeated tokens", () => {
    expect(tokenizeQuery("test test")).toEqual(["test"]);
  });

  it("returns an empty array when the query is all stopwords", () => {
    expect(tokenizeQuery("what is the")).toEqual([]);
  });

  it("keeps Chinese search phrases instead of stripping them", () => {
    expect(tokenizeQuery("覆盖安装 黑洞可视化")).toEqual(
      expect.arrayContaining(["覆盖安装", "黑洞可视化"])
    );
  });

  it("adds useful Chinese word segments while preserving the original phrase", () => {
    expect(tokenizeQuery("正在优化向量检索")).toEqual(
      expect.arrayContaining(["正在优化向量检索", "向量", "检索"])
    );
  });

  it("preserves mixed Chinese and developer identifiers", () => {
    expect(tokenizeQuery("修复 ERR_STREAM_PREMATURE_CLOSE 错误")).toEqual(
      expect.arrayContaining(["修复", "errstreamprematureclose", "错误"])
    );
  });

  it("keeps every generated LIKE pattern within D1's 50-byte limit", () => {
    const tokens = tokenizeQuery(`${"记".repeat(17)} 向量检索`);
    expect(tokens).toContain("向量检索");
    expect(tokens.every(token => new TextEncoder().encode(`%${token}%`).byteLength <= 50)).toBe(true);
  });

  it("caps keyword tokens well below D1's 100 binding limit", () => {
    const query = Array.from({ length: 200 }, (_, index) => `token${index}`).join(" ");
    expect(tokenizeQuery(query)).toHaveLength(24);
  });

  it("bounds work before segmenting oversized queries", () => {
    const tokens = tokenizeQuery(`向量检索 ${"汉".repeat(3_000)} tailtoken`);
    expect(tokens).toContain("向量检索");
    expect(tokens).not.toContain("tailtoken");
    expect(tokens.length).toBeLessThanOrEqual(24);
  });
});
