// 注意力队列：所有卡片进同一个队列，由内核决定何时打扰人。
import type { DB } from "./store.ts";
import type { Card } from "./types.ts";

export function openCards(db: DB): Card[] {
  const rows = db.prepare(`SELECT * FROM cards WHERE status = 'open' ORDER BY created_at, rowid`).all() as Record<string, unknown>[];
  return rows.map(rowToCard).sort(rank);
}

// 读出卡片时由内核算好要不要推送，通道只照做：何时打扰人由内核决定，不由通道或 Agent 决定。
export function rowToCard(r: Record<string, unknown>): Card {
  const card = { ...(r as unknown as Card), form: (r.form as Card["form"]) ?? null,
    options: JSON.parse(r.options as string), answer: r.answer ? JSON.parse(r.answer as string) : null };
  return { ...card, push: card.status === "open" && shouldPush(card) };
}

// 排序：按挡住了多少在途工作和紧急程度排，不按到达时间。一期先按类型：决策 > 审核 > 知会。
function rank(a: Card, b: Card): number {
  const w = { decision: 0, review: 1, notice: 2 } as const;
  return w[a.kind] - w[b.kind] || a.created_at.localeCompare(b.created_at);
}

// 背压（P2-06，2026-11-12 人定）：只计待处理的决策卡和审核卡，知会卡和简报不计；主理人不受限（判断点另走一条路）。
// 软上限：不开新任务的第一轮。硬上限：只放行带人回答的任务和验证轮。规则是确定的，不猜哪个任务会出卡。
export type Backpressure = "none" | "soft" | "hard";
export interface BackpressureLimits { soft: number; hard: number; }

export function pendingCardCount(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM cards WHERE status = 'open' AND kind IN ('decision','review')`).get() as { n: number }).n;
}

export function backpressureLevel(open: number, l: BackpressureLimits): Backpressure {
  return open >= l.hard ? "hard" : open >= l.soft ? "soft" : "none";
}

// 领活顺序：带人回答的 > 验证 > 在做的 > 新任务。数越小越先。
export type Lane = "answered" | "verify" | "ongoing" | "new";
export const LANE_ORDER: Record<Lane, number> = { answered: 0, verify: 1, ongoing: 2, new: 3 };

// 这一档背压下，这条道上的活放不放行。
export function lanePasses(level: Backpressure, lane: Lane): boolean {
  if (level === "hard") return lane === "answered" || lane === "verify";
  if (level === "soft") return lane !== "new";
  return true;
}

// 推送与静默：只有阻塞性的决策卡（含目标卡、超预算卡、受阻卡）会推送；审核卡和知会卡留在队列里随简报汇总。
// 异常（备份失败等）也推。两种知会卡例外：简报本身（它兼作心跳，到点没收到就说明系统停了），以及主理人对人刚说的那句话的答复
// （直接立项了、或不像目标），它是对话里的回话，不是打扰。
export function shouldPush(card: Pick<Card, "kind" | "form">): boolean {
  return card.kind === "decision" || card.form === "brief" || card.form === "reply" || card.form === "alert";
}

// 一件排队的任务在哪条道上。验证轮（第二批）不经排队的任务，直接是 verify 道。
// 带人回答的：已经跑过、反馈里有人的话（回答卡片、退回、补充、追加预算时说的）。系统自己写的反馈不算。
export const SYSTEM_FEEDBACK_PREFIX = "系统已执行";
export function laneOf(t: { runs_used: number; feedback: string | null }): Lane {
  if (t.runs_used === 0) return "new";
  const human = (t.feedback ?? "").split("\n").some((l) => l.trim() && !l.startsWith(SYSTEM_FEEDBACK_PREFIX));
  return human ? "answered" : "ongoing";
}

// 背压的现状：待处理卡几张、在哪一档、多少件排队的活被它挡着（新活单独数）。简报、/status 用。
export interface BackpressureView { open: number; level: Backpressure; soft: number; hard: number; held: number; held_new: number; }
export function backpressureView(db: DB, l: BackpressureLimits): BackpressureView {
  const open = pendingCardCount(db);
  const level = backpressureLevel(open, l);
  const queued = db.prepare(`SELECT runs_used, feedback FROM tasks WHERE state = 'queued'`).all() as { runs_used: number; feedback: string | null }[];
  const held = queued.map(laneOf).filter((lane) => !lanePasses(level, lane));
  return { open, level, soft: l.soft, hard: l.hard, held: held.length, held_new: held.filter((x) => x === "new").length };
}

// 一行给人看的说明；没触发背压时为 null。
export function backpressureLine(v: BackpressureView): string | null {
  if (v.level === "none") return null;
  const why = v.level === "hard" ? `待处理卡 ${v.open} 张，到了硬上限 ${v.hard}，只放行带你回答的任务` : `待处理卡 ${v.open} 张，到了软上限 ${v.soft}，不开新活`;
  const waiting = v.held_new ? `${v.held_new} 件新活在排队` : "没有新活在排队";
  const more = v.held > v.held_new ? `，另有 ${v.held - v.held_new} 件在做的暂停` : "";
  return `队列满了，${waiting}${more}（${why}）`;
}
