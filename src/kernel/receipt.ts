// 回执解析。回执写在 Agent 最后一条消息里，可以裸 JSON，也可以包在 ```json 围栏里。
// 格式错了不重做业务，只让 Agent 在原会话里重写最后一条消息（见 worker）。
import type { Receipt, Outcome } from "./types.ts";

const OUTCOMES: Outcome[] = ["done", "waiting", "ask", "blocked", "failed", "nothing"];

export type ParseResult = { ok: true; receipt: Receipt } | { ok: false; error: string };

export function parseReceipt(lastMessage: string): ParseResult {
  const text = lastMessage.trim();
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  for (let m = fence.exec(text); m; m = fence.exec(text)) candidates.push(m[1]!.trim());
  candidates.push(text);
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  let lastErr = "没有找到 JSON 对象";
  for (const c of candidates) {
    let obj: unknown;
    try { obj = JSON.parse(c); } catch { continue; }
    const v = validate(obj);
    if (v.ok) return v;
    lastErr = v.error;
  }
  return { ok: false, error: lastErr };
}

function validate(obj: unknown): ParseResult {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "回执不是对象" };
  const r = obj as Record<string, unknown>;
  if (!OUTCOMES.includes(r.outcome as Outcome)) return { ok: false, error: `outcome 必须是 ${OUTCOMES.join("/")}` };
  if (typeof r.summary !== "string" || !r.summary) return { ok: false, error: "缺 summary" };
  const outcome = r.outcome as Outcome;
  const asks = Array.isArray(r.ask) ? r.ask : [];
  if (outcome === "ask" && asks.length === 0) return { ok: false, error: "outcome=ask 时 ask 不能为空" };
  if (outcome === "waiting" && !(Array.isArray(r.later) && r.later.length)) return { ok: false, error: "outcome=waiting 时 later 不能为空" };
  if (outcome === "done" && !r.handoff) return { ok: false, error: "outcome=done 时必须有 handoff（交接说明）" };
  return { ok: true, receipt: r as unknown as Receipt };
}

// 写给 Agent 的回执约定，派发时附在提示词末尾。
export const RECEIPT_INSTRUCTIONS = `
## 回执（必交）
你的最后一条消息必须是、且只能是一个 JSON 对象，字段：
- outcome: "done" | "waiting" | "ask" | "blocked" | "failed" | "nothing"
- summary: 一句话
- evidence: [{check, result} | {artifact, ref}]
- handoff: 做了什么、停在哪、还剩什么、踩过什么坑（done 时必填；下一轮据此接手）
- ask: [{question, why, options, recommended}]（要问人时；一张卡片只问一个问题）
- later: [{on, timeout, about}]（在等外部事件时）
- found: [{title, why}]（发现的范围外事项，不要自己去做）
`;
