import { describe, it, expect } from "vitest";
import { extractHashtags } from "../../src/index";

describe("extractHashtags", () => {
  it("returns empty hashtags and unchanged content when no hashtags present", () => {
    const { cleanContent, hashtags } = extractHashtags("plain text");
    expect(cleanContent).toBe("plain text");
    expect(hashtags).toEqual([]);
  });

  it("extracts a single hashtag and strips it from content", () => {
    const { cleanContent, hashtags } = extractHashtags("note #health");
    expect(cleanContent).toBe("note");
    expect(hashtags).toEqual(["health"]);
  });

  it("extracts multiple hashtags", () => {
    const { cleanContent, hashtags } = extractHashtags("note #health #fitness");
    expect(cleanContent).toBe("note");
    expect(hashtags).toEqual(["health", "fitness"]);
  });

  it("extracts a hashtag mid-sentence and collapses whitespace", () => {
    const { cleanContent, hashtags } = extractHashtags("went #health for a run");
    expect(cleanContent).toBe("went for a run");
    expect(hashtags).toEqual(["health"]);
  });

  it("lowercases hashtags", () => {
    const { cleanContent, hashtags } = extractHashtags("note #Health #FITNESS");
    expect(cleanContent).toBe("note");
    expect(hashtags).toEqual(["health", "fitness"]);
  });

  it("returns empty cleanContent when content is only hashtags", () => {
    const { cleanContent, hashtags } = extractHashtags("#task");
    expect(cleanContent).toBe("");
    expect(hashtags).toEqual(["task"]);
  });

  it("collapses extra whitespace left by removed hashtags", () => {
    const { cleanContent, hashtags } = extractHashtags("a #b c");
    expect(cleanContent).toBe("a c");
    expect(hashtags).toEqual(["b"]);
  });

  it("handles hashtags with underscores and digits", () => {
    const { cleanContent, hashtags } = extractHashtags("note #tag_1 #item2");
    expect(cleanContent).toBe("note");
    expect(hashtags).toEqual(["tag_1", "item2"]);
  });

  it("extracts Chinese hashtags and strips them from content", () => {
    const { cleanContent, hashtags } = extractHashtags(
      "正在优化 #记忆 #黑洞设计 和 #向量检索"
    );
    expect(cleanContent).toBe("正在优化 和");
    expect(hashtags).toEqual(["记忆", "黑洞设计", "向量检索"]);
  });

  it("keeps Unicode letters, digits, underscores, and hyphens in hashtags", () => {
    const { cleanContent, hashtags } = extractHashtags(
      "release #Singularity-自托管_v2"
    );
    expect(cleanContent).toBe("release");
    expect(hashtags).toEqual(["singularity-自托管_v2"]);
  });

  it("does not treat language syntax such as C# or F# as hashtags", () => {
    const input = "阅读 C#中文教程 和 F#函数式编程";
    expect(extractHashtags(input)).toEqual({ cleanContent: input, hashtags: [] });
  });

  it("keeps overlong Unicode hashtags in content instead of creating an invalid D1 pattern", () => {
    const longTag = "记".repeat(16);
    expect(extractHashtags(`内容 #${longTag}`)).toEqual({
      cleanContent: `内容 #${longTag}`,
      hashtags: [],
    });
  });

  it("validates the normalized lowercase tag before removing it from content", () => {
    const expandsWhenLowercased = "İ".repeat(23);
    expect(extractHashtags(`note #${expandsWhenLowercased}`)).toEqual({
      cleanContent: `note #${expandsWhenLowercased}`,
      hashtags: [],
    });
  });
});
