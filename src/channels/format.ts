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
  backpressure?: BackpressureView | undefined;
  slots?: { agent: string; capacity: number; running: number; subagents: boolean; human_only: boolean; utilization: number | null;
    verifying?: number; verify_capacity?: number; executes?: boolean }[] | undefined;
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

// 看全局：默认只回答“现在有什么需要我”，再按目标列任务在等谁。done 的目标只留最近几个，健康的状态不占地方。
export function showStatus(o: Overview, opts: { cardsHint: string; doneLimit?: number; now?: Date } = { cardsHint: "xj cards" }): string {
  const out: string[] = [];
  const { need, fyi } = splitCards(o.cards);
  out.push(`需要你：${need.length ? `${need.length} 张卡片（${opts.cardsHint}）` : "没有"}${fyi.length ? `；另有 ${fyi.length} 张知会卡` : ""}`);
  const bp = o.backpressure && backpressureLine(o.backpressure);
  if (bp) out.push(bp);
  const finished = (s: string) => s === "done" || s === "abandoned" || s === "stopped";
  const active = o.goals.filter((g) => !finished(g.status));
  const done = o.goals.filter((g) => finished(g.status));
  const shownDone = opts.doneLimit === undefined ? done : done.slice(-opts.doneLimit);
  for (const g of [...shownDone, ...active]) {
    out.push(`${g.id} [${g.status}] ${g.title}${g.status === "proposed" ? "（主理人整理中，或目标卡等你确认）" : ""}`);
    for (const t of o.tasks.filter((x) => x.goal_id === g.id)) out.push(`  ${t.id} [${t.state}] ${WAITING[t.waiting_on]} · 已跑 ${t.runs_used} 轮`);
  }
  if (shownDone.length < done.length) out.push(`（另有 ${done.length - shownDone.length} 个已结束的目标未列出）`);
  for (const s of o.slots ?? []) {
    const why = s.human_only ? "，周用量过上限，只跑你亲自提的目标" : !s.subagents ? "，周用量过降档线，降档且不起子 Agent" : "";
    if (s.verifying !== undefined) out.push(`验证 ${s.agent}：${s.verifying}/${s.verify_capacity ?? 1} 在跑${s.human_only ? "，周用量过上限，只验证你亲自提的目标" : ""}`);
    if (s.verifying === undefined || s.executes) out.push(`执行 ${s.agent}：${s.running}/${s.capacity} 在跑${why}`);
  }
  for (const q of o.quota) {
    const pct = (x: number | null) => (x == null ? "?" : `${Math.round(x * 100)}%`);
    out.push(`额度 ${q.agent}：周 ${pct(q.seven_day_utilization)}，5 小时 ${pct(q.five_hour_utilization)}`);
  }
  const b = o.backup && showBackup(o.backup, opts.now ?? new Date());
  if (b) out.push(b);
  return out.join("\n");
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
