// 回执解析。回执写在 Agent 最后一条消息里，可以裸 JSON，也可以包在 ```json 围栏里。
// 格式错了不重做业务，只让 Agent 在原会话里重写最后一条消息（见 worker）。
import type { Receipt, Outcome } from "./types.ts";

const OUTCOMES: Outcome[] = ["done", "waiting", "ask", "blocked", "failed", "nothing"];

export type ParseResult = { ok: true; receipt: Receipt } | { ok: false; error: string };

// 最后一条消息里可能是 JSON 的片段：围栏里的、整条、第一个 { 到最后一个 }。回执和判断点的输出共用。
export function jsonCandidates(lastMessage: string): string[] {
  const text = lastMessage.trim();
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  for (let m = fence.exec(text); m; m = fence.exec(text)) candidates.push(m[1]!.trim());
  candidates.push(text);
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  return candidates;
}

export function parseReceipt(lastMessage: string): ParseResult {
  let lastErr = "没有找到 JSON 对象";
  for (const c of jsonCandidates(lastMessage)) {
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
- effects: 要系统代为执行的对外动作（见下）

## 对外动作由系统代为执行
不要自己 git push、gh pr create（这些命令已被禁用）。要推分支或开 PR，就在本地提交好，把请求写进回执的 effects，
系统先记账、再执行、做过的不会重复，结果会写在审核卡上：
- {"kind": "push-branch", "branch": "<分支名>"}
- {"kind": "open-pr", "branch": "<分支名>", "base": "main", "title": "<标题>", "body": "<描述>"}（先推分支再开 PR，两个都要写）
分支名必须带任务编号（例如 xj/T-12-pow），不能是 main 或 master；只能请求“允许的对外动作”里列出的种类。
“允许的对外动作”里的种类已经授权，不用再出 ask 问人；请求了 effects、活也做完了，outcome 就写 done，不要写 waiting。
授权是上限，不是要做的事：目标和验收里没要求推送或开 PR，就不要请求；只要求推分支的，不要顺手开 PR。

## 子 Agent
可以用子 Agent 分头做，但同时最多 3 个；小任务自己做，不必分。
`;
