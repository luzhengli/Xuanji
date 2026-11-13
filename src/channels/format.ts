// 入口共用的文字格式：xj 和飞书通道用同一套写法说状态和卡片。
import type { Card, Event } from "../kernel/types.ts";
import { backpressureLine, type BackpressureView } from "../kernel/attention.ts";

export const WAITING = { human: "等人", agent: "等 Agent", world: "等世界", none: "不再等" } as const;
export const CARD_KIND = { decision: "决策", review: "审核", notice: "知会" } as const;

export type Overview = {
  goals: { id: string; title: string; status: string }[];
  tasks: { id: string; goal_id: string; state: string; runs_used: number; waiting_on: keyof typeof WAITING; session_id: string | null }[];
  cards: Card[];
  quota: { agent: string; seven_day_utilization: number | null; five_hour_utilization: number | null }[];
  accounts?: { use: string; agents: string[]; seven_day: number | null; seven_day_resets_at: number | null; five_hour: number | null; five_hour_resets_at: number | null }[] | undefined;
  backpressure?: BackpressureView | undefined;
  slots?: { agent: string; capacity: number; running: number; subagents: boolean; human_only: boolean; utilization: number | null;
    verifying?: number; verify_capacity?: number; planning?: number; executes?: boolean }[] | undefined;
  backup?: { snapshot_ok_at: string | null; snapshot_failed_at: string | null; drill_ok_at: string | null; drill_failed_at: string | null } | undefined;
};

// 多久以前。入口是客户端，可以读时钟；内核里同样的说法只拿事件时间相减。
export function since(at: string, now: Date): string {
  const m = Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 60_000));
  return m < 60 ? `${m} 分钟前` : m < 2880 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
}

// 备份一行（P1-15）：最近一次成功的快照、最近一次演练；最近一次是失败的照实说。
export function showBackup(b: NonNullable<Overview["backup"]>, now: Date): string | null {
  if (!b.snapshot_ok_at && !b.snapshot_failed_at) return null;
  const failedLast = b.snapshot_failed_at && (!b.snapshot_ok_at || b.snapshot_failed_at > b.snapshot_ok_at);
  const snap = b.snapshot_ok_at ? `最近成功 ${since(b.snapshot_ok_at, now)}` : "还没有成功过";
  const drillFailedLast = b.drill_failed_at && (!b.drill_ok_at || b.drill_failed_at > b.drill_ok_at);
  const drill = drillFailedLast ? `恢复演练 ${since(b.drill_failed_at!, now)}没通过` : b.drill_ok_at ? `恢复演练 ${since(b.drill_ok_at, now)}通过` : "还没演练";
  return `备份：${snap}${failedLast ? `（${since(b.snapshot_failed_at!, now)}失败过一次）` : ""}；${drill}`;
}

export function showCard(c: Card): string {
  const opts = c.options.map((o) => `${o.key}${o.recommended ? "（推荐）" : ""}`).join(" / ");
  return [`${c.id} [${CARD_KIND[c.kind]}] ${c.about}  ${c.title}`,
    ...(c.body ? c.body.split("\n").map((l) => `    ${l}`) : []), ...(opts ? [`    选项：${opts}`] : [])].join("\n");
}

// 只要“需要你”的卡片（决策、审核）；知会卡不需要动作，只报个数。
export function splitCards(cards: Card[]): { need: Card[]; fyi: Card[] } {
  return { need: cards.filter((c) => c.kind !== "notice"), fyi: cards.filter((c) => c.kind === "notice") };
}

// 看全局（2026-11-13 人看了飞书上的 /status 觉得不好读后改成分段）：需要你、在做、最近结束、名额、额度、备份。
// 飞书渲染成一张卡片，每段一个元素；xj 渲染成纯文字。状态用中文说“在等谁”，结束的目标一行一个，不列任务。
export const TASK_STATE: Record<string, string> = {
  queued: "排队", running: "在跑", verifying: "验证中", awaiting_answer: "等你回答", awaiting_review: "等你审核", blocked: "受阻，等你",
  awaiting_world: "等外部", awaiting_deps: "等依赖", done: "完成", abandoned: "放弃", stopped: "叫停",
};
export const GOAL_STATUS: Record<string, string> = { proposed: "待确认", active: "在做", paused: "暂停", done: "完成", abandoned: "放弃", stopped: "叫停" };
const clipTitle = (x: string, n = 32) => (x.length > n ? `${x.slice(0, n)}…` : x);

export interface StatusSection { title: string; lines: string[]; }
export interface StatusOptions { cardsHint: string; doneLimit?: number | undefined; now?: Date | undefined; }

// 重置时间：本机时间“13 日 07:00”。入口是客户端，可以读时钟和时区。
export function resetAt(epochSec: number | null | undefined, now: Date): string {
  if (!epochSec) return "";
  const d = new Date(epochSec * 1000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString() ? `今天 ${hm}` : `${d.getDate()} 日 ${hm}`;
}

export function statusSections(o: Overview, opts: StatusOptions = { cardsHint: "xj cards" }): StatusSection[] {
  const now = opts.now ?? new Date();
  const out: StatusSection[] = [];
  const { need, fyi } = splitCards(o.cards);
  const count = (k: Card["kind"]) => need.filter((c) => c.kind === k).length;
  const needLines = need.length
    ? [`${need.length} 张：${[count("decision") && `决策 ${count("decision")}`, count("review") && `审核 ${count("review")}`].filter(Boolean).join("、")}（${opts.cardsHint}）`,
      ...need.slice(0, 5).map((c) => `${c.id} ${clipTitle(c.title, 36)}`)]
    : ["没有"];
  if (fyi.length) needLines.push(`知会 ${fyi.length} 张，不用动作`);
  const bp = o.backpressure && backpressureLine(o.backpressure);
  if (bp) needLines.push(bp);
  out.push({ title: "需要你", lines: needLines });

  const finished = (st: string) => st === "done" || st === "abandoned" || st === "stopped";
  const tasksOf = (g: string) => o.tasks.filter((t) => t.goal_id === g);
  const active = o.goals.filter((g) => !finished(g.status));
  out.push({ title: "在做", lines: active.length ? active.map((g) => {
    const ts = tasksOf(g.id);
    const what = g.status === "proposed" ? "主理人整理中，或目标卡等你确认"
      : !ts.length ? "规划拆分中，或拆分计划等你确认"
      : ts.map((t) => `${t.id} ${TASK_STATE[t.state] ?? t.state}${t.runs_used && !finished(t.state) ? `（第 ${t.runs_used} 轮）` : ""}`).join("、");
    return `${g.id} ${clipTitle(g.title)}：${what}`;
  }) : ["没有"] });

  const done = o.goals.filter((g) => finished(g.status));
  const limit = opts.doneLimit ?? done.length;
  const shown = done.slice(-limit).reverse();
  if (shown.length) {
    out.push({ title: "最近结束", lines: [...shown.map((g) => {
      const n = tasksOf(g.id).length;
      return `${g.id} ${GOAL_STATUS[g.status] ?? g.status}：${clipTitle(g.title)}${n > 1 ? `（${n} 个任务）` : ""}`;
    }), ...(done.length > shown.length ? [`另有 ${done.length - shown.length} 个，xj status --all 看全部`] : [])] });
  }

  const slots: string[] = [];
  for (const sl of o.slots ?? []) {
    const why = sl.human_only ? "，周用量过上限，只跑你亲自提的目标" : !sl.subagents ? "，周用量过降档线" : "";
    if (sl.verifying !== undefined) slots.push(`验证 ${sl.agent} ${sl.verifying}/${sl.verify_capacity ?? 1}${sl.human_only ? "，周用量过上限，只验证你亲自提的目标" : ""}`);
    if (sl.planning !== undefined) slots.push(`规划 ${sl.agent} ${sl.planning}/${sl.capacity}${why}`);
    if (sl.executes ?? (sl.verifying === undefined && sl.planning === undefined)) slots.push(`执行 ${sl.agent} ${sl.running}/${sl.capacity}${why}${!sl.subagents && !sl.human_only ? "，降档且不起子 Agent" : ""}`);
  }
  if (slots.length) out.push({ title: "名额（在跑/上限）", lines: slots });

  const pct = (x: number | null) => (x == null ? "?" : `${Math.round(x * 100)}%`);
  const quota = o.accounts?.length
    ? o.accounts.filter((a) => a.seven_day != null || a.five_hour != null).map((a) => {
      const name = { claude: "Claude", codex: "Codex", dsh: "DeepSeek" }[a.use] ?? a.use;
      const r7 = resetAt(a.seven_day_resets_at, now);
      return `${name}${a.agents.length > 1 ? `（${a.agents.join("、")}）` : ""}：周 ${pct(a.seven_day)}${r7 ? `，${r7} 重置` : ""}${a.five_hour != null ? `；5 小时 ${pct(a.five_hour)}` : ""}`;
    })
    : o.quota.map((q) => `${q.agent}：周 ${pct(q.seven_day_utilization)}，5 小时 ${pct(q.five_hour_utilization)}`);
  if (quota.length) out.push({ title: "额度", lines: quota });

  const b = o.backup && showBackup(o.backup, now);
  if (b) out.push({ title: "备份", lines: [b.replace(/^备份：/, "")] });
  return out;
}

// xj status：纯文字，一段一个标题，下面缩进列出。
export function showStatus(o: Overview, opts: StatusOptions = { cardsHint: "xj cards" }): string {
  return statusSections(o, opts).map((x) => `${x.title}\n${x.lines.map((l) => `  ${l}`).join("\n")}`).join("\n\n");
}

// 飞书：markdown 一段一个，标题加粗、每行一个列表项。列表后的分段由卡片渲染时拆成独立元素（bodyElements）。
export function statusMarkdown(o: Overview, opts: StatusOptions): string {
  return statusSections(o, opts).map((x) => `**${x.title}**\n${x.lines.map((l) => `- ${l}`).join("\n")}`).join("\n\n");
}

// xj why 的默认视图（P1-20）：长任务每 30 秒一条心跳，连续的心跳折成一行“心跳 N 次”，别的事件原样保留。
export type WhyItem = { kind: "event"; event: Event } | { kind: "beats"; first: Event; last: Event; count: number; runs: string[] };

export function foldHeartbeats(events: Event[]): WhyItem[] {
  const out: WhyItem[] = [];
  for (const e of events) {
    const prev = out.at(-1);
    if (e.type === "run.heartbeat" && !e.note) {
      const run = String((e.payload as { run_id?: unknown }).run_id ?? "");
      if (prev?.kind === "beats") {
        prev.last = e; prev.count++;
        if (run && !prev.runs.includes(run)) prev.runs.push(run);
        continue;
      }
      out.push({ kind: "beats", first: e, last: e, count: 1, runs: run ? [run] : [] });
      continue;
    }
    out.push({ kind: "event", event: e });
  }
  // 单独一次心跳不必折
  return out.map((x) => (x.kind === "beats" && x.count === 1 ? { kind: "event", event: x.first } : x));
}
