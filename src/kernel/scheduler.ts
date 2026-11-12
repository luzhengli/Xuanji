// 调度：谁来做。硬条件筛选（类型、权限、空位、额度、背压、每目标并发、租约），再按领活顺序排。
// 上限都来自配置（P2-01、P2-06，2026-11-12 人定，暂定）：只影响调度，不影响账本重放。
import type { DB } from "./store.ts";
import type { Config } from "../shared/config.ts";
import { backpressureLevel, pendingCardCount, laneOf, lanePasses, LANE_ORDER } from "./attention.ts";
import { getTask } from "./reducer.ts";
import type { Task, TaskContract } from "./types.ts";

// subagents：这一轮能不能起子 Agent。周用量过降档线时为 false，接单程序据此从允许清单去掉起子 Agent 的工具。
export interface Assignment { task: Task; agent: string; purpose: "execute"; subagents: boolean; }

// 人亲自提的目标：立项的那条事件来自人（飞书、xj、人直接说）。环境触发的（三期）不算。
const HUMAN_SOURCES = ["human", "feishu", "cli"];

// 这个档案现在的名额：周用量过降档线执行降为 1 个、禁用子 Agent；过上限只跑人亲自提的目标。
export interface Throttle { capacity: number; running: number; subagents: boolean; human_only: boolean; utilization: number | null; }
export function throttle(db: DB, cfg: Config, agent: string): Throttle | null {
  const profile = cfg.agents[agent];
  if (!profile) return null;
  const u = weeklyUtilization(db, agent);
  const down = u != null && u >= cfg.limits.downgrade_quota_ratio;
  const running = (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE agent = ? AND status = 'running' AND purpose = 'execute'`).get(agent) as { n: number }).n;
  return { capacity: down ? Math.min(1, profile.capacity) : profile.capacity, running, subagents: !down,
    human_only: u != null && u >= cfg.limits.weekly_quota_ratio, utilization: u };
}

// 由接单程序来领活时调用：返回一件可以派的任务，或 null。
export function pickNext(db: DB, cfg: Config, agent: string): Assignment | null {
  const profile = cfg.agents[agent];
  const th = throttle(db, cfg, agent);
  if (!profile || !th || th.running >= th.capacity) return null;
  const level = backpressureLevel(pendingCardCount(db), { soft: cfg.limits.backpressure_cards, hard: cfg.limits.backpressure_hard });

  const rows = db.prepare(`SELECT id FROM tasks WHERE state = 'queued' ORDER BY created_at, rowid`).all() as { id: string }[];
  const candidates = rows.map(({ id }) => getTask(db, id)!).map((task) => ({ task, lane: laneOf(task) }))
    .filter(({ lane }) => lanePasses(level, lane))
    .sort((a, b) => LANE_ORDER[a.lane] - LANE_ORDER[b.lane]);   // 稳定排序：同一条道上按排队先后
  for (const { task } of candidates) {
    if (!profile.kinds.includes(task.contract.agent.kind)) continue;
    if (task.runs_used >= task.contract.budget.runs) continue;   // 超预算的在回队列时就转受阻了，这里只是兜底
    if (!depsSatisfied(db, task)) continue;
    if (th.human_only && !goalFromHuman(db, task.goal_id)) continue;
    if (goalRunning(db, task.goal_id) >= cfg.limits.per_goal_concurrency) continue;
    if (leaseConflict(db, task)) continue;
    return { task, agent, purpose: "execute", subagents: th.subagents };
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

function goalRunning(db: DB, goalId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.goal_id = ? AND r.status = 'running' AND r.purpose = 'execute'`)
    .get(goalId) as { n: number }).n;
}

function goalFromHuman(db: DB, goalId: string): boolean {
  const r = db.prepare(`SELECT e.source FROM goals g JOIN events e ON e.seq = g.origin_event WHERE g.id = ?`).get(goalId) as { source: string } | undefined;
  return !!r && HUMAN_SOURCES.includes(r.source);
}

// ---- 租约（P2-03）----
// 租约在领活时登记（归并 run.claimed），这一轮结束即释放。两种：
// - 可写范围：只在同一目标的任务之间比。不同目标各在自己的 worktree 和分支上，不直接冲突，冲突只在合并时出现
//   （2026-11-12 人定），所以默认的 ** 不挡跨目标并行。同一目标里拆出来的任务（第三批）各给具体范围。
// - 独占资源（预发环境、数据库迁移、发布通道）：具名，跨目标也只给一个任务，登记成 res:<名字>。
export const RESOURCE_PREFIX = "res:";
export function leasePatterns(c: TaskContract): string[] {
  return [...new Set([...c.scope.write, ...(c.scope.exclusive ?? []).map((r) => `${RESOURCE_PREFIX}${r}`)])];
}

// 返回冲突的那个任务编号和范围，没有冲突返回 null。
export function leaseConflict(db: DB, task: Task): string | null {
  const mine = leasePatterns(task.contract);
  const held = db.prepare(`SELECT l.task_id, l.pattern, t.goal_id FROM leases l JOIN tasks t ON t.id = l.task_id WHERE l.task_id != ?`)
    .all(task.id) as { task_id: string; pattern: string; goal_id: string }[];
  for (const h of held) {
    for (const p of mine) {
      const res = p.startsWith(RESOURCE_PREFIX);
      if (res !== h.pattern.startsWith(RESOURCE_PREFIX)) continue;
      if (res ? p === h.pattern : h.goal_id === task.goal_id && patternsOverlap(p, h.pattern)) return `${h.task_id} ${h.pattern}`;
    }
  }
  return null;
}

// 两个路径范围会不会碰到同一个文件。保守判断：取各自第一个通配符之前的字面前缀，一个是另一个的前缀就算重叠。
// 会多判（src/*.ts 和 src/a.md 算重叠），不会漏判；多判的代价只是晚一点执行。
export function patternsOverlap(a: string, b: string): boolean {
  const lit = (p: string) => p.replace(/^\.\//, "").split(/[*?[{]/)[0]!;
  const x = lit(a), y = lit(b);
  return x.startsWith(y) || y.startsWith(x);
}

function weeklyUtilization(db: DB, agent: string): number | null {
  const q = db.prepare(`SELECT seven_day_utilization AS u FROM quota WHERE agent = ?`).get(agent) as { u: number | null } | undefined;
  return q?.u ?? null;
}
