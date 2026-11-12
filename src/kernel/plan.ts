// 规划（P2-08）：把一个标了“可能要拆”的目标切成任务图。规划是一次不给工具的模型调用，输出是资料：
// 内核和接单程序都用这里的校验，只认列出的字段；三个拆分条件里能确定性核对的都在这里核对。
//   1. 可写范围互不重叠：两两比较，判法和租约一样保守（取第一个通配符之前的字面前缀）。
//   2. 各自有独立的验收标准：每个任务至少一条。
//   3. 彼此只通过明确的产出物依赖：depends_on 只能指向计划里的别的任务，不能成环。
// 合并任务不由规划写：拆开时内核自动加一个（P2-09）。
import { jsonCandidates } from "./receipt.ts";
import { patternsOverlap } from "./scheduler.ts";
import type { CardOption, Plan, PlanTask } from "./types.ts";

export const DEFAULT_MAX_TASKS = 4;   // 一个目标最多拆几个（配置 max_tasks_per_goal，人定 2026-11-12）
const WHY_MAX = 200, OBJECTIVE_MAX = 120, ITEM_MAX = 80, CRITERIA_MAX = 4, WRITE_MAX = 5;

// 拆分计划卡的三个选项（2026-11-12 人定：二期每次拆分都出决策卡）。
export const PLAN_OPTIONS: CardOption[] = [
  { key: "split", label: "按计划拆", recommended: true }, { key: "single", label: "不拆，一个任务做" }, { key: "revise", label: "修改", needs_text: true },
];

export type PlanResult = { ok: true; plan: Plan } | { ok: false; error: string };
export interface PlanLimits { max_tasks: number; checks: string[]; }

export function parsePlan(lastMessage: string, limits: PlanLimits): PlanResult {
  let lastErr = "没有找到 JSON 对象";
  for (const c of jsonCandidates(lastMessage)) {
    let obj: unknown;
    try { obj = JSON.parse(c); } catch { continue; }
    const p = normalizePlan(obj, limits);
    if (p.ok) return p;
    lastErr = p.error;
  }
  return { ok: false, error: lastErr };
}

export function normalizePlan(obj: unknown, limits: PlanLimits): PlanResult {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "输出不是对象" };
  const r = obj as Record<string, unknown>;
  if (typeof r.split !== "boolean") return { ok: false, error: "split 必须是 true 或 false" };
  const str = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");
  const why = str(r.why, WHY_MAX);
  if (!why) return { ok: false, error: "缺 why：一句话说明为什么拆或为什么不拆" };
  if (!r.split) return { ok: true, plan: { split: false, why, tasks: [] } };
  const raw = Array.isArray(r.tasks) ? r.tasks : [];
  const max = Math.max(2, limits.max_tasks);
  if (raw.length < 2) return { ok: false, error: "split=true 时 tasks 至少 2 个；拆不出两个互不重叠的部分就写 split=false" };
  if (raw.length > max) return { ok: false, error: `最多拆 ${max} 个任务` };
  const list = (x: unknown, n: number, m = ITEM_MAX) => (Array.isArray(x) ? x.map((v) => str(v, m)).filter(Boolean).slice(0, n) : []);
  const tasks: PlanTask[] = [];
  for (const [i, t] of raw.entries()) {
    const o = (t ?? {}) as Record<string, unknown>;
    const key = str(o.key, 12) || String.fromCharCode(97 + i);
    if (!/^[A-Za-z0-9_-]+$/.test(key)) return { ok: false, error: `任务 ${key} 的 key 只能用字母、数字、- 和 _` };
    if (tasks.some((x) => x.key === key)) return { ok: false, error: `key 重复：${key}` };
    const objective = str(o.objective, OBJECTIVE_MAX);
    if (!objective) return { ok: false, error: `任务 ${key} 缺 objective` };
    const criteria = list(o.criteria, CRITERIA_MAX);
    if (!criteria.length) return { ok: false, error: `任务 ${key} 至少要有一条自己的验收标准（criteria）` };
    const write = list(o.write, WRITE_MAX, 120).map((w) => w.replace(/^\.\//, ""));
    if (!write.length) return { ok: false, error: `任务 ${key} 要写可写范围（write），例如 "src/billing/**"` };
    for (const w of write) {
      if (w.startsWith("/") || w.includes("..")) return { ok: false, error: `任务 ${key} 的可写范围 ${w} 要写仓库里的相对路径` };
      if (!w.split(/[*?[{]/)[0]) return { ok: false, error: `任务 ${key} 的可写范围 ${w} 太宽：要以具体的目录或文件开头` };
    }
    const checksRaw = list(o.checks, 3, 200);
    const unknown = checksRaw.find((c) => !limits.checks.includes(c));
    if (unknown) return { ok: false, error: `任务 ${key} 的检查命令 ${unknown} 不在目标已批准的检查命令里；只能从里面挑，不能新写` };
    tasks.push({ key, objective, criteria, write, checks: checksRaw, depends_on: list(o.depends_on, max, 12) });
  }
  for (const t of tasks) {
    for (const d of t.depends_on) {
      if (d === t.key) return { ok: false, error: `任务 ${t.key} 不能依赖自己` };
      if (!tasks.some((x) => x.key === d)) return { ok: false, error: `任务 ${t.key} 依赖的 ${d} 不在计划里` };
    }
  }
  if (hasCycle(tasks)) return { ok: false, error: "depends_on 成环了" };
  for (const [i, a] of tasks.entries()) {
    for (const b of tasks.slice(i + 1)) {
      for (const x of a.write) for (const y of b.write) {
        if (patternsOverlap(x, y)) return { ok: false, error: `任务 ${a.key} 和 ${b.key} 的可写范围重叠（${x} 和 ${y}）：拆开的任务不能改同一处；分不开就写 split=false` };
      }
    }
  }
  return { ok: true, plan: { split: true, why, tasks } };
}

function hasCycle(tasks: PlanTask[]): boolean {
  const state = new Map<string, 1 | 2>();
  const visit = (k: string): boolean => {
    if (state.get(k) === 2) return false;
    if (state.get(k) === 1) return true;
    state.set(k, 1);
    if (tasks.find((t) => t.key === k)!.depends_on.some(visit)) return true;
    state.set(k, 2);
    return false;
  };
  return tasks.some((t) => visit(t.key));
}

// 合并任务的说法（P2-09）。
export function mergeObjective(goalTitle: string, parts: string[]): string {
  return `合并 ${parts.join("、")} 的分支，作为目标“${goalTitle}”的最终结果`.slice(0, 200);
}

// 拆分计划卡的正文。各段之间、列表后面都空一行（飞书的 markdown 不空行时，后面的文字会接到列表最后一项上）。
export function planCardBody(plan: Plan, goal: { acceptance: string[]; checks: string[] }, revision: number): string {
  const parts = plan.tasks.map((t) => [
    `**${t.key}** ${t.objective}`,
    [`- 验收：${t.criteria.join("；")}`, `- 可写：${t.write.join("、")}`, `- 依赖：${t.depends_on.length ? t.depends_on.join("、") : "无，立即开工"}`,
      ...(t.checks.length ? [`- 检查命令：${t.checks.map((c) => `\`${c}\``).join("、")}`] : [])].join("\n"),
  ].join("\n"));
  return [
    `**为什么拆**${revision ? `（第 ${revision} 次修改）` : ""} ${plan.why}`,
    ...parts,
    `**合并** 各部分验证通过后，合并任务把分支合到一起，按目标的验收标准整体验收${goal.checks.length ? `（检查命令 ${goal.checks.map((c) => `\`${c}\``).join("、")}）` : ""}，然后出一张目标审核卡。`,
    "按计划拆：没有依赖的同时开工，各在自己的 worktree。不拆：一个任务做完。修改：在文字框写怎么改，再规划一次。",
  ].join("\n\n");
}
