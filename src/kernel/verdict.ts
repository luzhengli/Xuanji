// 验证（P2-05）：检查命令的清洗、验证者结论的解析、不通过时带给下一轮的意见。内核和接单程序共用。
// 验证者的输出是资料：只认这里列的字段，长度都有上限。
import { jsonCandidates } from "./receipt.ts";
import type { CheckResult, Verdict, VerdictIssue } from "./types.ts";

export const MAX_CHECKS = 3;
const CHECK_MAX = 200;
const ISSUES_MAX = 6, RISKS_MAX = 5, ITEM_MAX = 300;
// 验证三轮还不通过就出卡问人（2026-11-12 人定）。
export const MAX_VERIFY_ROUNDS = 3;
// 带给下一轮的验证意见以这个开头。背压按“在做的”排，不算带人回答（attention.ts laneOf）。
export const VERIFY_FEEDBACK_PREFIX = "系统验证没通过";

// 检查命令：一行一条，不带换行，最多 3 条。命令本身是否放行由接单程序按 Bash 禁用规则再查一遍。
export function normalizeChecks(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  const out = x.map((v) => (typeof v === "string" ? v.trim() : "")).filter((v) => v && v.length <= CHECK_MAX && !/[\r\n]/.test(v));
  return [...new Set(out)].slice(0, MAX_CHECKS);
}

export type VerdictResult = { ok: true; verdict: Verdict } | { ok: false; error: string };

export function parseVerdict(lastMessage: string): VerdictResult {
  let lastErr = "没有找到 JSON 对象";
  for (const c of jsonCandidates(lastMessage)) {
    let obj: unknown;
    try { obj = JSON.parse(c); } catch { continue; }
    const v = normalizeVerdict(obj);
    if (v.ok) return v;
    lastErr = v.error;
  }
  return { ok: false, error: lastErr };
}

export function normalizeVerdict(obj: unknown): VerdictResult {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "输出不是对象" };
  const r = obj as Record<string, unknown>;
  if (r.verdict !== "pass" && r.verdict !== "fail") return { ok: false, error: 'verdict 必须是 "pass" 或 "fail"' };
  const str = (x: unknown, max = ITEM_MAX) => (typeof x === "string" ? x.trim().slice(0, max) : "");
  const issues: VerdictIssue[] = (Array.isArray(r.issues) ? r.issues : []).map((i) => {
    if (typeof i === "string") return { problem: str(i) };
    const o = (i ?? {}) as Record<string, unknown>;
    const issue: VerdictIssue = { problem: str(o.problem) };
    if (str(o.criterion)) issue.criterion = str(o.criterion);
    if (str(o.where, 120)) issue.where = str(o.where, 120);
    return issue;
  }).filter((i) => i.problem).slice(0, ISSUES_MAX);
  const risks = (Array.isArray(r.risks) ? r.risks : []).map((x) => str(x)).filter(Boolean).slice(0, RISKS_MAX);
  const pass = r.verdict === "pass";
  if (!pass && !issues.length) return { ok: false, error: "verdict=fail 时 issues 不能为空，写明违反了哪条验收标准" };
  if (pass && issues.length) return { ok: false, error: "verdict=pass 时 issues 要为空；有问题就写 fail" };
  if (!risks.length) return { ok: false, error: "risks 至少一条：列出你没核实到、可能出问题的地方" };
  return { ok: true, verdict: { pass, summary: str(r.summary, 200) || (pass ? "验证通过" : "验证没通过"), issues, risks } };
}

// 检查命令没过：不必请验证者，直接按没通过处理（便宜的先跑）。
export function checksVerdict(checks: CheckResult[]): Verdict | null {
  const failed = checks.filter((c) => !c.ok && !c.skipped);
  if (!failed.length) return null;
  return { pass: false, summary: `检查命令没过：${failed.map((c) => c.command).join("、")}`,
    issues: failed.map((c) => ({ problem: `\`${c.command}\` ${c.exit_code == null ? "没跑成" : `退出码 ${c.exit_code}`}：${tail(c.output, 200)}`, criterion: "检查命令" })),
    risks: ["检查命令没过，没有请验证者审查，其余验收标准未核对"], checks };
}

// 没跑的检查命令写进残余风险，验证者的风险后面。
export function skippedRisks(checks: CheckResult[]): string[] {
  return checks.filter((c) => c.skipped).map((c) => `检查命令 \`${c.command}\` 没跑：${c.skipped}`);
}

function tail(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? `…${t.slice(-n)}` : t || "（没有输出）";
}

export function issueLine(i: VerdictIssue): string {
  return `${i.criterion ? `［${i.criterion}］` : ""}${i.problem}${i.where ? `（${i.where}）` : ""}`;
}

// 不通过时带给下一轮的意见：一行（反馈按行区分人和系统，见 laneOf）。
export function verifyFeedback(runId: string, round: number, v: Verdict): string {
  const text = `${VERIFY_FEEDBACK_PREFIX}（${runId}，第 ${round} 轮）：${v.summary}。要改的问题：${v.issues.map(issueLine).join("；")}。改完照常交 done，系统会再验证。`;
  return text.replace(/[\r\n]+/g, " ");
}
