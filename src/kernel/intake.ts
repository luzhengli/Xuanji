// 主理人（P1-10）：把人的一句话整理成目标卡。模型的输出是资料，内核在归并时再清洗一遍，
// 不信任里面的任何权限字段：自主级别固定 L1，预算只认合理范围内的数，其余按默认。
import { jsonCandidates } from "./receipt.ts";
import type { Draft, Goal, Grant } from "./types.ts";

export const TITLE_MAX = 60;
const ITEM_MAX = 80;
const LIMITS = { acceptance: 4, boundaries: 3, ask_first: 3, notes: 2 } as const;

export type DraftResult = { ok: true; draft: Draft } | { ok: false; error: string };

// 接单程序用：从主理人的最后一条消息里取草稿。格式错了只请它重写一次。
export function parseDraft(lastMessage: string): DraftResult {
  let lastErr = "没有找到 JSON 对象";
  for (const c of jsonCandidates(lastMessage)) {
    let obj: unknown;
    try { obj = JSON.parse(c); } catch { continue; }
    const d = normalizeDraft(obj);
    if (d.ok) return d;
    lastErr = d.error;
  }
  return { ok: false, error: lastErr };
}

// 内核和接单程序共用的校验与清洗。
export function normalizeDraft(obj: unknown): DraftResult {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "输出不是对象" };
  const r = obj as Record<string, unknown>;
  const kind = r.kind === "not_goal" ? "not_goal" : r.kind === "goal" ? "goal" : r.kind === "amend" ? "amend" : null;
  if (!kind) return { ok: false, error: 'kind 必须是 "goal"、"not_goal" 或 "amend"' };
  const str = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");
  if (kind === "amend") {
    const target = str(r.target, 20);
    if (!/^G-\d+$/.test(target)) return { ok: false, error: "kind=amend 时 target 要是在途目标的编号，例如 G-9" };
    return { ok: true, draft: { kind, target, direct: false, title: "", acceptance: [], boundaries: [], ask_first: [] } };
  }
  const list = (x: unknown, n: number) => (Array.isArray(x) ? x.map((v) => str(v, ITEM_MAX)).filter(Boolean).slice(0, n) : []);
  if (kind === "not_goal") {
    const reply = str(r.reply, 200);
    if (!reply) return { ok: false, error: "kind=not_goal 时要有 reply" };
    return { ok: true, draft: { kind, direct: false, title: "", acceptance: [], boundaries: [], ask_first: [], reply } };
  }
  const title = str(r.title, TITLE_MAX);
  if (!title) return { ok: false, error: "缺 title" };
  const acceptance = list(r.acceptance, LIMITS.acceptance);
  if (!acceptance.length) return { ok: false, error: "acceptance 至少一条" };
  const draft: Draft = { kind, direct: r.direct === true, title, acceptance,
    boundaries: list(r.boundaries, LIMITS.boundaries), ask_first: list(r.ask_first, LIMITS.ask_first) };
  const notes = list(r.notes, LIMITS.notes);
  if (notes.length) draft.notes = notes;
  const b = r.budget as { runs?: unknown; minutes?: unknown } | undefined;
  if (b && Number.isInteger(b.runs) && Number.isInteger(b.minutes)) {
    const runs = b.runs as number, minutes = b.minutes as number;
    if (runs >= 1 && runs <= 50 && minutes >= 5 && minutes <= 1440) draft.budget = { runs, minutes };
  }
  return { ok: true, draft };
}

// 目标卡的正文：提醒（有才列）、验收、边界、授权。目标本身在卡片标题里。
// 各段之间空一行：飞书的 markdown 不空行时，下一段的标题会接到上一段列表最后一项的末尾（2026-11-12 真实一轮看到）。
export function goalCardBody(g: Pick<Goal, "acceptance" | "boundaries" | "grant">, notes: string[] = []): string {
  const bullets = (xs: string[], none: string) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : `- ${none}`);
  return [
    ...(notes.length ? [`**提醒**\n${bullets(notes, "")}`] : []),
    `**验收**\n${bullets(g.acceptance, "（未整理，按目标本身验收）")}`,
    `**边界**\n${bullets(g.boundaries, "（无）")}`,
    `**授权** ${grantLine(g.grant)}`,
  ].join("\n\n");
}

export function grantLine(g: Grant): string {
  const level = { L0: "L0 只提方案", L1: "L1 做到可审核为止", L2: "L2 可逆的自动收尾", L3: "L3 规则内全自动" }[g.level];
  const ask = g.ask_first.length ? g.ask_first.join("、") : "不可逆或授权外的对外动作";
  const fx = g.effects.map((k) => ({ "push-branch": "推分支", "open-pr": "开 PR" }[k] ?? k)).join("、");
  return `${level}${fx ? `，可${fx}` : ""} · 预算 ${g.budget.runs} 轮或 ${minutesText(g.budget.minutes)} · 先问：${ask}`;
}

export function minutesText(m: number): string {
  return m % 60 === 0 ? `${m / 60} 小时` : `${m} 分钟`;
}
