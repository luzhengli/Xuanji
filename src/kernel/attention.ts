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

// 背压：待处理的决策卡和审核卡合计达到上限时，暂停启动会产生新卡片的任务。
export function underBackpressure(db: DB, limit: number): boolean {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM cards WHERE status = 'open' AND kind IN ('decision','review')`).get() as { n: number };
  return n >= limit;
}

// 推送与静默：只有阻塞性的决策卡（含目标卡、超预算卡、受阻卡）会推送；审核卡和知会卡留在队列里随简报汇总。
// 两种知会卡例外：简报本身（它兼作心跳，到点没收到就说明系统停了），以及主理人对人刚说的那句话的答复
// （直接立项了、或不像目标），它是对话里的回话，不是打扰。
export function shouldPush(card: Pick<Card, "kind" | "form">): boolean {
  return card.kind === "decision" || card.form === "brief" || card.form === "reply";
}
