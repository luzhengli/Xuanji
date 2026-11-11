// 调度：谁来做。硬条件筛选（类型、权限、空位、租约不重叠），再按静态路由表排序。
import type { DB } from "./store.ts";
import type { Config } from "../shared/config.ts";
import { underBackpressure } from "./attention.ts";
import { getTask } from "./reducer.ts";
import type { Task } from "./types.ts";

export interface Assignment { task: Task; agent: string; purpose: "execute"; }

// 由接单程序来领活时调用：返回一件可以派的任务，或 null。
export function pickNext(db: DB, cfg: Config, agent: string): Assignment | null {
  const profile = cfg.agents[agent];
  if (!profile) return null;
  const running = (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE agent = ? AND status = 'running'`).get(agent) as { n: number }).n;
  if (running >= profile.capacity) return null;
  if (underBackpressure(db, cfg.limits.backpressure_cards)) return null; // TODO P2：只暂停会产生新卡片的任务，优先推进能收尾的
  if (quotaExhausted(db, cfg, agent)) return null;                        // TODO P1-12 / P3：60% 规则按来源分级

  const rows = db.prepare(`SELECT id FROM tasks WHERE state = 'queued' ORDER BY created_at`).all() as { id: string }[];
  for (const { id } of rows) {
    const task = getTask(db, id)!;
    if (!profile.kinds.includes(task.contract.agent.kind)) continue;
    if (task.runs_used >= task.contract.budget.runs) continue;            // TODO P1-13：超限即停并出卡片，而不是悄悄跳过
    if (!depsSatisfied(db, task)) continue;
    if (leaseConflict(db, task)) continue;
    return { task, agent, purpose: "execute" };
  }
  return null;
}

function depsSatisfied(db: DB, task: Task): boolean {
  for (const dep of task.contract.depends_on) {
    const t = getTask(db, dep);
    if (!t || t.state !== "done") return false;
  }
  return true;
}

// TODO P2：可写范围租约。一期每个目标只有一个任务，不会重叠。
function leaseConflict(_db: DB, _task: Task): boolean { return false; }

function quotaExhausted(db: DB, cfg: Config, agent: string): boolean {
  const q = db.prepare(`SELECT seven_day_utilization AS u FROM quota WHERE agent = ?`).get(agent) as { u: number | null } | undefined;
  return (q?.u ?? 0) >= cfg.limits.weekly_quota_ratio;
}
