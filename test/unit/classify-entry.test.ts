import { describe, it, expect, vi } from "vitest";
import { classifyEntry, getClassificationSample } from "../../src/index";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/index";

function makeSseStream(response: string) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

function makeClassifyAI(response: string | null = null, shouldThrow = false) {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5")
        return { data: [new Array(384).fill(0.1)] };
      if (shouldThrow) throw new Error("AI failure");
      return makeSseStream(response ?? "");
    }),
  } as unknown as Ai;
}

describe("classifyEntry()", () => {
  it('parses {"importance":5,"canonical":true,"kind":"semantic"} correctly', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":5,"confidence":0.92,"canonical":true,"kind":"semantic"}'),
    });
    const result = await classifyEntry("I decided to quit my job and start a company", env);
    expect(result).toEqual({ importance: 5, confidence: 0.92, canonical: true, kind: "semantic" });
  });

  it('parses {"importance":2,"canonical":false,"kind":"episodic"} correctly', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":2,"confidence":0.5,"canonical":false,"kind":"episodic"}'),
    });
    const result = await classifyEntry("Had coffee this morning", env);
    expect(result).toEqual({ importance: 2, confidence: 0.5, canonical: false, kind: "episodic" });
  });

  it("rejects JSON that is missing the required kind field", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":3,"confidence":0.5,"canonical":false}'),
    });
    await expect(classifyEntry("Some memory", env)).rejects.toThrow("invalid_response");
  });

  it("rejects JSON with an unknown kind", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":3,"confidence":0.5,"canonical":false,"kind":"bogus"}'),
    });
    await expect(classifyEntry("Some memory", env)).rejects.toThrow("invalid_response");
  });

  it("rejects an out-of-range confidence instead of clamping it", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":3,"confidence":92,"canonical":false,"kind":"semantic"}'),
    });
    await expect(classifyEntry("Some memory", env)).rejects.toThrow("invalid_response");
  });

  it("does not parse numeric prefixes from malformed tolerant output", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('"importance":50, "confidence":1.5, "canonical":false, "kind":"semantic"'),
    });
    await expect(classifyEntry("Some memory", env)).rejects.toThrow("invalid_response");
  });

  it("does not accept a valid kind as the prefix of an unknown kind", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('"importance":3, "confidence":0.8, "canonical":false, "kind":"semantic-bogus"'),
    });
    await expect(classifyEntry("Some memory", env)).rejects.toThrow("invalid_response");
  });

  it("rejects an unparseable classifier response so it can be retried", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI("sorry I cannot help with that"),
    });
    await expect(classifyEntry("Some memory", env)).rejects.toThrow("invalid_response");
  });

  it("rejects provider failures so the entry can be marked failed and retried", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI(null, true),
    });
    await expect(classifyEntry("Some memory", env)).rejects.toThrow("provider_error");
  });

  // normalizeKind synonym/case/substring mapping tests
  it('maps kind:"event" → "episodic"', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":2,"confidence":0.5,"canonical":false,"kind":"event"}'),
    });
    const result = await classifyEntry("Attended a conference today", env);
    expect(result).toEqual({ importance: 2, confidence: 0.5, canonical: false, kind: "episodic" });
  });

  it('maps kind:"milestone" → "episodic"', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":2,"confidence":0.5,"canonical":false,"kind":"milestone"}'),
    });
    const result = await classifyEntry("Shipped the first release", env);
    expect(result).toEqual({ importance: 2, confidence: 0.5, canonical: false, kind: "episodic" });
  });

  it('maps kind:"fact" → "semantic"', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":3,"confidence":0.5,"canonical":false,"kind":"fact"}'),
    });
    const result = await classifyEntry("The office is in downtown", env);
    expect(result).toEqual({ importance: 3, confidence: 0.5, canonical: false, kind: "semantic" });
  });

  it('maps kind:"preference" → "semantic"', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":3,"confidence":0.5,"canonical":false,"kind":"preference"}'),
    });
    const result = await classifyEntry("I prefer dark mode", env);
    expect(result).toEqual({ importance: 3, confidence: 0.5, canonical: false, kind: "semantic" });
  });

  it('maps kind:"Episodic" (mixed case) → "episodic"', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":3,"confidence":0.5,"canonical":false,"kind":"Episodic"}'),
    });
    const result = await classifyEntry("Went for a run this morning", env);
    expect(result).toEqual({ importance: 3, confidence: 0.5, canonical: false, kind: "episodic" });
  });

  it('maps kind:"episodic event" (substring) → "episodic"', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":3,"confidence":0.5,"canonical":false,"kind":"episodic event"}'),
    });
    const result = await classifyEntry("Had a team meeting", env);
    expect(result).toEqual({ importance: 3, confidence: 0.5, canonical: false, kind: "episodic" });
  });

  it('rejects kind:"banana" as an invalid response', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":3,"confidence":0.5,"canonical":false,"kind":"banana"}'),
    });
    await expect(classifyEntry("Some memory", env)).rejects.toThrow("invalid_response");
  });

  // ── Malformed JSON / tolerant parsing ─────────────────────────────────────

  it('salvages kind from real regression payload: {"importance": 3, "canonical":, "kind": "episodic"}', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance": 3, "confidence": 0.5, "canonical": false, "kind": "episodic"'),
    });
    const result = await classifyEntry("Some memory", env);
    expect(result).toEqual({ importance: 3, confidence: 0.5, canonical: false, kind: "episodic" });
  });

  it('salvages canonical and kind when importance is malformed: {"importance":, "canonical": true, "kind": "semantic"}', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('"importance": 3, "confidence": 0.5, "canonical": true, "kind": "semantic"'),
    });
    const result = await classifyEntry("Some memory", env);
    expect(result).toEqual({ importance: 3, confidence: 0.5, canonical: true, kind: "semantic" });
  });

  it("recovers all required fields from garbage-surrounding text", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('blah "importance":3, "confidence":0.5, "canonical":false, "kind":"episodic" blah'),
    });
    const result = await classifyEntry("Some memory", env);
    expect(result).toEqual({ importance: 3, confidence: 0.5, canonical: false, kind: "episodic" });
  });

  it("rejects when no classification fields can be recovered", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI("not json at all"),
    });
    await expect(classifyEntry("Some memory", env)).rejects.toThrow("invalid_response");
  });

  it('maps kind:"procedure" to "procedural"', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":4,"confidence":0.88,"canonical":false,"kind":"procedure"}'),
    });
    await expect(classifyEntry("先运行测试，再构建镜像", env)).resolves.toEqual({
      importance: 4,
      confidence: 0.88,
      canonical: false,
      kind: "procedural",
    });
  });

  it("classifies a bounded sample that includes content beyond the first 500 characters", async () => {
    const ai = makeClassifyAI('{"importance":4,"confidence":0.9,"canonical":false,"kind":"semantic"}') as any;
    const env = makeTestEnv(makeTestDb(), { AI: ai });
    const tailMarker = "TAIL_CLASSIFICATION_MARKER";
    await classifyEntry(`${"开头".repeat(2000)}${tailMarker}`, env);
    const classifierPrompt = ai.run.mock.calls.find((call: unknown[]) => call[0] !== "@cf/baai/bge-small-en-v1.5")[1].messages[0].content;
    expect(classifierPrompt).toContain(tailMarker);
    expect(classifierPrompt.length).toBeLessThan(8_000);
  });

  it("keeps head, middle, and tail evidence in oversized classification samples", () => {
    const content = `HEAD_MARKER${"a".repeat(4_000)}MIDDLE_MARKER${"b".repeat(4_000)}TAIL_MARKER`;
    const sample = getClassificationSample(content);
    expect(sample).toContain("HEAD_MARKER");
    expect(sample).toContain("MIDDLE_MARKER");
    expect(sample).toContain("TAIL_MARKER");
    expect(sample.length).toBeLessThan(6_100);
  });
});
