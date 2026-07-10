import { describe, expect, it } from "vitest";
import { planRecallRequest } from "../../src/query-intent";

const NOW = new Date("2026-07-10T12:00:00.000Z").getTime();
const DAY = 86_400_000;

describe("planRecallRequest", () => {
  it.each([
    "我在忙什么？",
    "最近在忙什么",
    "我最近都做了什么",
    "最近有什么进展",
    "what have I been working on recently?",
  ])("recognizes recent activity summaries: %s", (query) => {
    const plan = planRecallRequest(query, NOW);

    expect(plan.mode).toBe("recent_activity");
    expect(plan.limit).toBe(30);
    expect(plan.after).toBe(NOW - 30 * DAY);
    expect(plan.before).toBe(NOW);
  });

  it("uses the current week for 本周 activity questions", () => {
    const plan = planRecallRequest("本周我在忙什么", NOW);

    expect(plan.mode).toBe("recent_activity");
    expect(plan.after).toBe(new Date(2026, 6, 6).getTime());
    expect(plan.before).toBe(NOW);
  });

  it.each(["上周", "本月", "last week"])(
    "treats time-only dashboard summaries as recent activity: %s",
    (query) => {
      expect(planRecallRequest(query, NOW).mode).toBe("recent_activity");
    }
  );

  it("honors an explicit 最近 14 天 window", () => {
    const plan = planRecallRequest("最近 14 天我在忙什么", NOW);
    expect(plan.after).toBe(NOW - 14 * DAY);
    expect(plan.before).toBe(NOW);
  });

  it("keeps ordinary factual questions on semantic recall", () => {
    expect(planRecallRequest("我的服务器域名是什么", NOW)).toEqual({
      mode: "semantic",
      limit: 5,
    });
  });
});
