export type RecallMode = "semantic" | "recent_activity";

export interface RecallRequestPlan {
  mode: RecallMode;
  limit: number;
  after?: number;
  before?: number;
}

const DAY = 86_400_000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function startOfWeek(date: Date): number {
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + mondayOffset
  ).getTime();
}

function isRecentActivityQuestion(query: string): boolean {
  const q = query.trim().toLowerCase();
  return [
    /^(?:上周|本周|这周|本月|这个月|上个月|上月|last\s+week|this\s+week|last\s+month|this\s+month)[？?!.。]*$/i,
    /(?:我|咱们)?(?:最近|目前|现在)?在忙(?:什么|啥)/,
    /最近.{0,8}(?:忙|做|干|进展|项目|任务|工作)/,
    /(?:忙|做|干|进展).{0,8}最近/,
    /(?:本周|这周|上周|本月|这个月|上个月|近期).{0,10}(?:忙|做|干|进展|项目|任务|工作)/,
    /(?:近况|近期进展|最近动态)/,
    /what (?:have|had) i been (?:working|busy) (?:on|with)/i,
    /what am i (?:working on|busy with)(?: recently)?/i,
    /(?:summari[sz]e|show) my recent (?:work|activity|progress|projects)/i,
  ].some((pattern) => pattern.test(q));
}

function activityWindow(query: string, now: number): Pick<RecallRequestPlan, "after" | "before"> {
  const q = query.trim().toLowerCase();
  const current = new Date(now);

  const recentDays = q.match(/(?:最近|近)\s*(\d{1,3})\s*天|last\s+(\d{1,3})\s+days?/i);
  if (recentDays) {
    const days = Math.min(Math.max(Number(recentDays[1] || recentDays[2]), 1), 365);
    return { after: now - days * DAY, before: now };
  }

  if (/(?:今天|today)/i.test(q)) {
    return { after: startOfDay(current), before: now };
  }
  if (/(?:昨天|yesterday)/i.test(q)) {
    const before = startOfDay(current);
    return { after: before - DAY, before };
  }
  if (/(?:本周|这周|this\s+week)/i.test(q)) {
    return { after: startOfWeek(current), before: now };
  }
  if (/(?:上周|last\s+week)/i.test(q)) {
    const before = startOfWeek(current);
    return { after: before - 7 * DAY, before };
  }
  if (/(?:本月|这个月|this\s+month)/i.test(q)) {
    return {
      after: new Date(current.getFullYear(), current.getMonth(), 1).getTime(),
      before: now,
    };
  }
  if (/(?:上个月|上月|last\s+month)/i.test(q)) {
    return {
      after: new Date(current.getFullYear(), current.getMonth() - 1, 1).getTime(),
      before: new Date(current.getFullYear(), current.getMonth(), 1).getTime(),
    };
  }

  return { after: now - 30 * DAY, before: now };
}

export function planRecallRequest(query: string, now = Date.now()): RecallRequestPlan {
  if (!isRecentActivityQuestion(query)) {
    return { mode: "semantic", limit: 5 };
  }

  return {
    mode: "recent_activity",
    limit: 30,
    ...activityWindow(query, now),
  };
}
