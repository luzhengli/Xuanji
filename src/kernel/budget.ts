// 预算（P1-13）：每个任务有轮数和时长上限，由内核强制。时长只算 Agent 在跑的时间（领活到回执或中断），
// 等人、等世界期间没有进程在跑，不计。超限即停并出卡片，人可以追加、停掉或接管（2026-11-12 人定）。
import type { Task } from "./types.ts";

// “追加”一次给的量（人定 2026-11-12：追加 4 轮和 1 小时）。
export const BUDGET_EXTEND = { runs: 4, minutes: 60 } as const;

type BudgetView = Pick<Task, "runs_used" | "minutes_used"> & { contract: { budget: { runs: number; minutes: number } } };

// 超了返回一句说明，没超返回 null。
export function overBudget(t: BudgetView): string | null {
  const b = t.contract.budget;
  if (t.runs_used >= b.runs) return `已跑 ${t.runs_used} 轮（预算 ${b.runs} 轮）`;
  if (t.minutes_used >= b.minutes) return `已用 ${Math.round(t.minutes_used)} 分钟（预算 ${b.minutes} 分钟）`;
  return null;
}

// 这一轮最多跑多久：剩余的时长预算，至少 1 分钟。接单程序据此结束进程，看门狗据此判单轮超时。
export function runLimitMinutes(t: BudgetView): number {
  return Math.max(1, t.contract.budget.minutes - t.minutes_used);
}
