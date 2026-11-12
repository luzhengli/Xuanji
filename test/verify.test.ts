// 二期第二批：验证。Codex 适配器（P2-04）、验证在人之前（P2-05）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "../src/kernel/kernel.ts";
import { DEFAULTS, type Config } from "../src/shared/config.ts";
import { chooseVerifier } from "../src/kernel/scheduler.ts";
import { laneOf } from "../src/kernel/attention.ts";
import { normalizeDraft, goalCardBody } from "../src/kernel/intake.ts";
import { parseVerdict, normalizeVerdict, checksVerdict, verifyFeedback, VERIFY_FEEDBACK_PREFIX } from "../src/kernel/verdict.ts";
import { VERIFY_OPTIONS, VERIFY_ERROR_OPTIONS } from "../src/kernel/reducer.ts";
import { buildCodexArgs, parseCodexStream, parseRateLimits, findSessionFile, CodexAdapter, sandboxOf } from "../src/worker/adapters/codex.ts";
import { Worker, blockedBy, type KernelClient } from "../src/worker/worker.ts";
import { buildPrompt, buildVerifyPrompt } from "../src/worker/context-pack.ts";
import type { AgentAdapter, RunRequest, RunResult } from "../src/worker/adapters/types.ts";
import type { Card, EventInput } from "../src/kernel/types.ts";

const FIX = join(import.meta.dirname, "fixtures");
const T0 = "2026-11-13T08:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
let n = 0;
const sid = () => `v${n++}`;
const CODEX = { use: "codex" as const, kinds: ["review" as const], tier: "strong" as const, billing: "subscription" as const, capacity: 1, model: "gpt-6.1-sol", effort: "max" };
const cfg = (agents: Config["agents"] = { claude: DEFAULTS.agents.claude!, codex: CODEX }): Config => ({ ...DEFAULTS, agents });
const ev = (k: Kernel, type: string, payload: Record<string, unknown>, source: EventInput["source"] = "cli", t = T0) =>
  k.ingest({ source, source_id: sid(), type, at: t, payload });
const done = (k: Kernel, run: string, task: string, extra: Record<string, unknown> = {}) =>
  ev(k, "run.receipt", { run_id: run, task_id: task, receipt: { outcome: "done", summary: `${task} 好了`, handoff: "改了 math.mjs", ...extra } }, "worker");
const RISKS = ["没有测负数"];
const verdict = (k: Kernel, run: string, task: string, pass: boolean, t = T0, extra: Record<string, unknown> = {}) =>
  ev(k, "run.verdict", { run_id: run, task_id: task, reviewer: "codex",
    verdict: pass ? { verdict: "pass", summary: "满足验收", issues: [], risks: RISKS }
      : { verdict: "fail", summary: "half 算错了", issues: [{ criterion: "half(3) 返回 1.5", problem: "返回 1", where: "math.mjs:2" }], risks: RISKS },
    ...extra }, "worker", t);
const cardsOf = (k: Kernel, task: string): Card[] => k.cards().filter((c) => c.about === task);

// ---- P2-04 Codex 适配器 ----

test("P2-04：参数——不加载人的配置，审批 never，不联网，关掉桌面和插件；模型、强度显式传；提示词前有 --", () => {
  const fresh = buildCodexArgs({ prompt: "-看看", cwd: "/w/T-1", model: "gpt-6.1-sol", effort: "max", sandbox: "read-only", timeout_ms: 1 }, "/tmp/o.md");
  assert.deepEqual(fresh.slice(0, 4), ["exec", "--json", "-o", "/tmp/o.md"]);
  for (const a of ["--ignore-user-config", 'approval_policy="never"', 'web_search="disabled"', "notify=[]", "computer_use", "multi_agent"]) assert.ok(fresh.includes(a), a);
  assert.deepEqual(fresh.slice(fresh.indexOf("-m"), fresh.indexOf("-m") + 2), ["-m", "gpt-6.1-sol"]);
  assert.ok(fresh.includes('model_reasoning_effort="max"'));
  assert.deepEqual(fresh.slice(fresh.indexOf("-s"), fresh.indexOf("-s") + 4), ["-s", "read-only", "-C", "/w/T-1"]);
  assert.deepEqual(fresh.slice(-2), ["--", "-看看"]);

  // 续接：resume 不认 -C 和 -s（实测），沙箱走 -c，会话编号在 -- 之前。
  const resume = buildCodexArgs({ prompt: "重写", cwd: "/w", session_id: "S1", tools: [], timeout_ms: 1 }, "/tmp/o.md");
  assert.deepEqual(resume.slice(0, 2), ["exec", "resume"]);
  assert.ok(!resume.includes("-C") && !resume.includes("-s"));
  assert.ok(resume.includes('sandbox_mode="read-only"'));
  assert.deepEqual(resume.slice(-3), ["S1", "--", "重写"]);
  // 沙箱：显式给的为准；不给工具只读；其余可写。
  assert.equal(sandboxOf({ prompt: "", cwd: "", timeout_ms: 1, tools: [] }), "read-only");
  assert.equal(sandboxOf({ prompt: "", cwd: "", timeout_ms: 1 }), "workspace-write");
});

test("P2-04：录制件——会话编号、最后一条消息、用量；人的过时设置报的 error 项忽略；续接会话编号不变", () => {
  const c1 = parseCodexStream(readFileSync(join(FIX, "codex-c1.jsonl"), "utf8"));
  assert.equal(c1.session_id, "01a1d002-f67e-7191-9420-eedc9e9ea726");
  assert.deepEqual(JSON.parse(c1.last_message), { outcome: "done", summary: "add(2,3) returns 5.", handoff: "Read math.mjs and confirmed add uses a + b; no files were modified." });
  assert.equal(c1.rate_limited, false);
  assert.equal((c1.usage.usage as { output_tokens: number }).output_tokens, 104);
  assert.equal(c1.usage.commands, 1);
  const c2 = parseCodexStream(readFileSync(join(FIX, "codex-c2.jsonl"), "utf8"));
  assert.equal(c2.session_id, c1.session_id);
  // 只读沙箱里写文件被拦（c3）：事件流照常，回执照常取。
  const c3 = parseCodexStream(readFileSync(join(FIX, "codex-c3.jsonl"), "utf8"));
  assert.match(c3.last_message, /operation not permitted/);
});

test("P2-04：周用量从会话文件读，换成和 Claude Code 一样的读数；触顶标记；按会话编号找文件", () => {
  const rl = parseRateLimits(readFileSync(join(FIX, "codex-rollout-token-count.jsonl"), "utf8"))!;
  assert.deepEqual(rl.rate_limit.seven_day, { utilization: 0.29, resetsAt: 1795010426, status: "allowed" });
  assert.equal(rl.rate_limit.five_hour, undefined);
  assert.equal(rl.reached, false);
  const hit = parseRateLimits(JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 100, window_minutes: 10080, resets_at: 9 }, rate_limit_reached_type: "primary" } } }))!;
  assert.equal(hit.reached, true);
  assert.equal(hit.rate_limit.seven_day!.status, "rejected");
  assert.equal(parseRateLimits("{}\n"), null);

  const root = mkdtempSync(join(tmpdir(), "xj-sessions-"));
  mkdirSync(join(root, "2026", "11", "11"), { recursive: true });
  mkdirSync(join(root, "2026", "11", "12"), { recursive: true });
  writeFileSync(join(root, "2026", "11", "11", "rollout-2026-11-11T01-00-00-AAA.jsonl"), "");
  writeFileSync(join(root, "2026", "11", "12", "rollout-2026-11-12T01-00-00-BBB.jsonl"), "");
  assert.equal(findSessionFile(root, "AAA"), join(root, "2026", "11", "11", "rollout-2026-11-11T01-00-00-AAA.jsonl"));
  assert.equal(findSessionFile(root, "CCC"), null);
});

test("P2-04：真跑一个假 codex——最后一条消息取 -o 写出的文件，会话编号一拿到就回调，用量从会话文件报", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xj-fake-codex-"));
  const sessions = join(dir, "sessions", "2026", "11", "12");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-2026-11-12T13-48-00-01a1d002-f67e-7191-9420-eedc9e9ea726.jsonl"), readFileSync(join(FIX, "codex-rollout-token-count.jsonl")));
  const bin = join(dir, "codex");
  // 假的 codex：找到 -o 后面的文件写回执，再把录制件吐到 stdout；顺便把参数和 cwd 记下来。
  writeFileSync(bin, `#!/bin/sh
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
printf '%s' '{"outcome":"done","summary":"从文件来","handoff":"h"}' > "$out"
pwd > "${dir}/cwd"
cat "${join(FIX, "codex-c1.jsonl")}"
`);
  chmodSync(bin, 0o755);
  const work = mkdtempSync(join(tmpdir(), "xj-fake-work-"));
  const seen: string[] = [];
  const r = await new CodexAdapter({ bin, sessionsDir: join(dir, "sessions") }).run({ prompt: "p", cwd: work, timeout_ms: 10_000, onSession: (s) => seen.push(s) });
  assert.equal(JSON.parse(r.last_message).summary, "从文件来");
  assert.deepEqual(seen, ["01a1d002-f67e-7191-9420-eedc9e9ea726"]);
  assert.equal(r.rate_limit!.seven_day!.utilization, 0.29);
  assert.equal(r.exit_code, 0);
  assert.equal(readFileSync(join(dir, "cwd"), "utf8").trim().endsWith(work.split("/").at(-1)!), true, "进程 cwd 是工作目录（resume 不认 -C）");
});

// ---- P2-05 验证结论 ----

test("P2-05：验证结论的格式——fail 要有问题，pass 不能有问题，残余风险至少一条；字符串问题也认", () => {
  assert.equal(parseVerdict('```json\n{"verdict":"pass","summary":"好","issues":[],"risks":["没测负数"]}\n```').ok, true);
  assert.match((normalizeVerdict({ verdict: "pass", issues: [], risks: [] }) as { error: string }).error, /risks/);
  assert.match((normalizeVerdict({ verdict: "fail", issues: [], risks: ["x"] }) as { error: string }).error, /issues/);
  assert.match((normalizeVerdict({ verdict: "pass", issues: ["y"], risks: ["x"] }) as { error: string }).error, /fail/);
  assert.match((normalizeVerdict({ verdict: "ok" }) as { error: string }).error, /pass/);
  const v = normalizeVerdict({ verdict: "fail", issues: ["返回值不对"], risks: ["x"] });
  assert.ok(v.ok && v.verdict.issues[0]!.problem === "返回值不对" && v.verdict.summary === "验证没通过");
  // 检查命令没过就不请验证者；没跑的（禁用规则拦下）不算没过。
  assert.equal(checksVerdict([{ command: "npm test", ok: true, exit_code: 0, output: "" }]), null);
  assert.equal(checksVerdict([{ command: "git push", ok: false, exit_code: null, output: "", skipped: "命中禁用规则" }]), null);
  const cv = checksVerdict([{ command: "npm test", ok: false, exit_code: 1, output: "1 failing" }])!;
  assert.equal(cv.pass, false);
  assert.match(cv.issues[0]!.problem, /退出码 1.*1 failing/);
  // 带给下一轮的意见是一行，开头是系统前缀：背压按“在做的”排，不算带人回答。
  const fb = verifyFeedback("RN-2", 1, { pass: false, summary: "错\n了", issues: [{ problem: "a\nb" }], risks: [] });
  assert.ok(fb.startsWith(VERIFY_FEEDBACK_PREFIX) && !fb.includes("\n"));
  assert.equal(laneOf({ runs_used: 1, feedback: fb }), "ongoing");
  assert.equal(laneOf({ runs_used: 1, feedback: `${fb}\n人的补充（G-3）：也要支持负数` }), "answered");
});

test("P2-05：检查命令照用 Bash 禁用规则，命令里任何一段命中都不跑", () => {
  assert.equal(blockedBy("npm test"), null);
  assert.equal(blockedBy("node --test test/a.test.js && npm run typecheck"), null);
  assert.equal(blockedBy("git push origin x"), "git push");
  assert.equal(blockedBy("npm test && git push"), "git push");
  assert.equal(blockedBy("FOO=1 gh pr create -t x"), "gh pr create");
  assert.equal(blockedBy("echo $(claude -p hi)"), "claude");
  assert.equal(blockedBy("npm test | lark-cli im send"), "lark-cli");
  assert.equal(blockedBy("git pushx"), null, "按词匹配，不按字符前缀");
});

// ---- P2-05 内核：验证在人之前 ----

test("P2-05：选验证者——kinds 有 review、不是同一个 Agent、档位不低于执行者；没有就不验证", () => {
  assert.equal(chooseVerifier(cfg(), "claude"), "codex");
  assert.equal(chooseVerifier(cfg(), "codex"), null, "执行者自己不能验证");
  assert.equal(chooseVerifier(cfg({ claude: DEFAULTS.agents.claude!, codex: { ...CODEX, tier: "light" } }), "claude"), null, "档位低于执行者");
  assert.equal(chooseVerifier(cfg({ claude: DEFAULTS.agents.claude!, claude2: { ...DEFAULTS.agents.claude!, kinds: ["review"] } }), "claude"), null, "同一个 Agent 的另一个档案也不行");
  assert.equal(chooseVerifier(DEFAULTS, "claude"), null);
});

test("P2-05：done → 等验证（内核按配置写验证者，接单程序带来的不算）→ codex 领验证 → 通过出审核卡，残余风险原样展示", () => {
  const k = new Kernel(cfg(), ":memory:");
  ev(k, "goal.confirmed", { title: "math.mjs 加 half(a)", acceptance: ["half(3) 返回 1.5"], checks: ["npm test"] });
  const c = k.claim("claude", T0, sid())!;
  assert.deepEqual(c.task.contract.acceptance.checks, ["npm test"], "人自己写的检查命令进契约");
  ev(k, "run.receipt", { run_id: c.run_id, task_id: "T-1", verifier: "claude", receipt: { outcome: "done", summary: "好了", handoff: "h" } }, "worker");
  const t = k.task("T-1")!;
  assert.equal(t.state, "verifying");
  assert.equal(t.verify_due, "codex", "验证者由内核按配置定");
  assert.equal(k.claim("claude", T0, sid()), null, "执行者领不到验证");
  assert.equal(cardsOf(k, "T-1").length, 0, "验证之前不出审核卡");

  const v = k.claim("codex", T0, sid())!;
  assert.equal(v.purpose, "verify");
  assert.equal(v.verify!.round, 1);
  assert.equal(v.verify!.subject, c.run_id);
  assert.equal(v.previous!.summary, "好了", "带着要验证的那一轮回执");
  assert.equal(k.claim("codex", T0, sid()), null, "同一个任务不同时验证两次");
  assert.equal(k.task("T-1")!.state, "verifying");
  assert.equal(k.task("T-1")!.runs_used, 1, "验证轮不占轮数预算");

  verdict(k, v.run_id, "T-1", true, at(120), { checks: [{ command: "npm test", ok: true, exit_code: 0, output: "ok" }] });
  assert.equal(k.task("T-1")!.state, "awaiting_review");
  assert.equal(k.task("T-1")!.minutes_used, 0, "验证轮不占时长预算");
  const [card] = cardsOf(k, "T-1");
  assert.equal(card!.kind, "review");
  assert.match(card!.body, /\*\*验证\*\* 通过（RN-2，codex）/);
  assert.match(card!.body, /`npm test` 通过/);
  assert.match(card!.body, /\*\*残余风险\*\*\n- 没有测负数/);
  assert.equal(k.run(v.run_id)!.verdict!.pass, true);
});

test("P2-05：没通过带着意见开下一轮（接上原会话，按在做的排）；第 2 轮验证带上次意见；三轮不过出决策卡", () => {
  const k = new Kernel(cfg(), ":memory:");
  ev(k, "goal.confirmed", { title: "half", acceptance: ["half(3) 返回 1.5"] });
  let t = 0;
  for (let round = 1; round <= 3; round++) {
    const c = k.claim("claude", at(t++), sid())!;
    if (round > 1) {
      assert.match(c.feedback!, new RegExp(`^${VERIFY_FEEDBACK_PREFIX}（RN-\\d+，第 ${round - 1} 轮）.*返回 1（math.mjs:2）`));
      assert.equal(laneOf(k.task("T-1")!), "ongoing");
    }
    ev(k, "run.receipt", { run_id: c.run_id, task_id: "T-1", session_id: "S", receipt: { outcome: "done", summary: "好了", handoff: "h" } }, "worker", at(t++));
    const v = k.claim("codex", at(t++), sid())!;
    assert.equal(v.verify!.round, round);
    if (round > 1) assert.equal(v.verify!.prior!.verdict.issues[0]!.problem, "返回 1");
    else assert.equal(v.verify!.prior, null);
    verdict(k, v.run_id, "T-1", false, at(t++));
    if (round < 3) assert.equal(k.task("T-1")!.state, "queued");
  }
  const task = k.task("T-1")!;
  assert.equal(task.state, "blocked");
  assert.equal(task.session_id, "S");
  const [card] = cardsOf(k, "T-1");
  assert.equal(card!.form, "verify");
  assert.match(card!.title, /验证 3 轮没通过/);
  assert.deepEqual(card!.options, VERIFY_OPTIONS);
  assert.equal(card!.options.find((o) => o.recommended)!.key, "review", "推荐按现状审核（人定）");
  assert.match(card!.body, /返回 1/);
  assert.match(card!.body, /没有测负数/);

  // 按现状审核：出审核卡，卡上写没通过和问题。
  const k2 = new Kernel(cfg(), ":memory:");
  for (const e of k.db.prepare(`SELECT * FROM events ORDER BY seq`).all() as Record<string, string>[]) {
    k2.ingest({ source: e.source as EventInput["source"], source_id: e.source_id!, type: e.type!, at: e.at!, payload: JSON.parse(e.payload!) });
  }
  ev(k2, "card.answered", { card_id: card!.id, choice: "review" });
  assert.equal(k2.task("T-1")!.state, "awaiting_review");
  const review = cardsOf(k2, "T-1")[0]!;
  assert.match(review.body, /\*\*验证\*\* 没通过/);
  assert.match(review.body, /问题：\n- ［half\(3\) 返回 1.5］返回 1/);
  assert.equal(k2.task("T-1")!.verify_due, null);

  // 再给 3 轮：轮数重新算，带着最后一次意见回队列。
  ev(k, "card.answered", { card_id: card!.id, choice: "more", text: "注意小数" });
  const again = k.task("T-1")!;
  assert.equal(again.state, "queued");
  assert.equal(again.verify_failures, 0);
  assert.match(again.feedback!, new RegExp(`^${VERIFY_FEEDBACK_PREFIX}`));
  assert.match(again.feedback!, /人对验证卡的说明（C-\d+）：注意小数/);
});

test("P2-05：有对外动作先等它们做完再验证；验证通过后审核卡上同时有推送结果和验证结论", () => {
  const k = new Kernel(cfg(), ":memory:");
  ev(k, "goal.confirmed", { title: "推一下" });
  const c = k.claim("claude", T0, sid())!;
  done(k, c.run_id, "T-1", { effects: [{ kind: "push-branch", branch: "xj/T-1-x" }] });
  assert.equal(k.claim("codex", T0, sid()), null, "推送还没做完");
  const x = k.claimEffect(T0, sid())!;
  ev(k, "effect.result", { effect_id: x.effect.id, ok: true, ref: "origin/xj/T-1-x" }, "worker");
  assert.equal(k.task("T-1")!.state, "verifying", "推送做完了，还要等验证");
  assert.equal(cardsOf(k, "T-1").length, 0);
  const v = k.claim("codex", T0, sid())!;
  verdict(k, v.run_id, "T-1", true);
  const body = cardsOf(k, "T-1")[0]!.body;
  assert.match(body, /验证\*\* 通过/);
  assert.match(body, /推分支 origin\/xj\/T-1-x：origin\/xj\/T-1-x/);
});

test("P2-05：没有验证者的配置（和 P2-05 之前的回执）照旧直接出审核卡", () => {
  const k = new Kernel(DEFAULTS, ":memory:");
  ev(k, "goal.confirmed", { title: "x" });
  const c = k.claim("claude", T0, sid())!;
  done(k, c.run_id, "T-1");
  assert.equal(k.task("T-1")!.state, "awaiting_review");
  assert.doesNotMatch(cardsOf(k, "T-1")[0]!.body, /验证/);
});

test("P2-05：验证者没跑成（出错、中断）任务留在验证中重新派；连续 3 次出卡，可选重新验证", () => {
  const k = new Kernel(cfg(), ":memory:");
  ev(k, "goal.confirmed", { title: "x" });
  const c = k.claim("claude", T0, sid())!;
  done(k, c.run_id, "T-1");
  const v1 = k.claim("codex", at(1), sid())!;
  ev(k, "run.verdict", { run_id: v1.run_id, task_id: "T-1", error: "验证结论无法解析" }, "worker", at(2));
  assert.equal(k.task("T-1")!.state, "verifying");
  assert.equal(k.task("T-1")!.verify_failures, 0, "没跑成不算验证没通过");
  const v2 = k.claim("codex", at(3), sid())!;
  ev(k, "timer.tick", {}, "timer", at(3 + 200));   // 心跳超时
  assert.equal(k.run(v2.run_id)!.status, "lost");
  assert.equal(k.task("T-1")!.state, "verifying", "验证中断不回执行队列");
  const v3 = k.claim("codex", at(300), sid())!;
  ev(k, "run.verdict", { run_id: v3.run_id, task_id: "T-1", error: "接单程序出错：spawn codex ENOENT" }, "worker", at(301));
  assert.equal(k.task("T-1")!.state, "blocked");
  const card = cardsOf(k, "T-1")[0]!;
  assert.match(card.title, /验证者连续 3 次没跑成/);
  assert.deepEqual(card.options, VERIFY_ERROR_OPTIONS);
  ev(k, "card.answered", { card_id: card.id, choice: "retry" });
  assert.equal(k.task("T-1")!.state, "verifying");
  assert.equal(k.claim("codex", at(400), sid())!.purpose, "verify");
  // 迟到的结论（这一轮已判中断）只记录。
  verdict(k, v2.run_id, "T-1", true, at(401));
  assert.equal(k.task("T-1")!.state, "verifying");
});

test("P2-05：验证者限流——任务留在验证中，到重置时间再派验证，不回执行队列", () => {
  const k = new Kernel(cfg(), ":memory:");
  ev(k, "goal.confirmed", { title: "x" });
  const c = k.claim("claude", T0, sid())!;
  done(k, c.run_id, "T-1");
  const v = k.claim("codex", T0, sid())!;
  const reset = Date.parse(at(3600)) / 1000;
  ev(k, "run.rate_limited", { run_id: v.run_id, task_id: "T-1", resets_at: reset }, "worker", at(5));
  assert.equal(k.task("T-1")!.state, "verifying");
  assert.equal(k.claim("codex", at(60), sid()), null, "还没到重置时间");
  assert.equal(k.claim("claude", at(60), sid()), null);
  assert.equal(k.claim("codex", at(3601), sid())!.purpose, "verify");
});

test("P2-05：验证期间人补充了话，通过了也不出审核卡，带着补充开下一轮", () => {
  const k = new Kernel(cfg(), ":memory:");
  ev(k, "goal.confirmed", { title: "x" });
  const c = k.claim("claude", T0, sid())!;
  done(k, c.run_id, "T-1");
  const v = k.claim("codex", T0, sid())!;
  k.db.prepare(`UPDATE tasks SET feedback = '人的补充（G-2）：也要 pow' WHERE id = 'T-1'`).run();   // 主理人并入补充（P1-23）的效果
  verdict(k, v.run_id, "T-1", true);
  assert.equal(k.task("T-1")!.state, "queued");
  assert.equal(cardsOf(k, "T-1").length, 0);
});

test("P2-05：审核卡退回后验证轮数重新算；从账本重建，卡片、轮次、结论都一样", () => {
  const k = new Kernel(cfg(), ":memory:");
  ev(k, "goal.confirmed", { title: "x" });
  const c = k.claim("claude", T0, sid())!;
  done(k, c.run_id, "T-1");
  const v = k.claim("codex", T0, sid())!;
  verdict(k, v.run_id, "T-1", false);
  const c2 = k.claim("claude", at(10), sid())!;
  done(k, c2.run_id, "T-1");
  const v2 = k.claim("codex", at(20), sid())!;
  verdict(k, v2.run_id, "T-1", true, at(30));
  assert.equal(k.task("T-1")!.verify_failures, 0);
  const card = cardsOf(k, "T-1")[0]!;
  ev(k, "card.answered", { card_id: card.id, choice: "return", text: "再加注释" });
  assert.equal(k.task("T-1")!.state, "queued");
  const snap = () => JSON.stringify({ tasks: k.db.prepare(`SELECT * FROM tasks`).all(), runs: k.db.prepare(`SELECT * FROM runs`).all(),
    cards: k.db.prepare(`SELECT * FROM cards`).all(), refs: k.db.prepare(`SELECT * FROM event_refs ORDER BY ref, seq`).all() });
  const before = snap();
  k.rebuild();
  assert.equal(snap(), before);
});

// ---- P2-05 检查命令从哪来：主理人提议、目标卡上写明，人确认才跑；直接立项的不带 ----

test("P2-05：主理人提议的检查命令上目标卡，人确认后进契约；直接立项的不带", () => {
  const d = normalizeDraft({ kind: "goal", title: "half", acceptance: ["a"], checks: ["npm test", "  ", "npm test", "x\ny", "a".repeat(201), "node --test", "c", "d"] });
  assert.ok(d.ok);
  assert.deepEqual(d.draft.checks, ["npm test", "node --test", "c"], "去重、去空、去多行和过长的，最多 3 条");
  assert.match(goalCardBody({ acceptance: ["a"], boundaries: [], grant: { level: "L1", effects: [], budget: { runs: 8, minutes: 120 }, ask_first: [] }, checks: ["npm test"] }),
    /\*\*检查命令\*\*（确认即同意在任务的 worktree 里跑）\n- `npm test`/);

  const k = new Kernel(cfg(), ":memory:");
  ev(k, "human.message", { text: "math.mjs 加 half" }, "feishu");
  const j = k.claimJudgment("claude", T0, sid())!;
  ev(k, "judgment.result", { judgment_id: j.id, output: { kind: "goal", direct: false, title: "加 half", acceptance: ["half(3) 返回 1.5"], checks: ["npm test"] } }, "worker");
  const card = k.cards().find((c) => c.form === "goal")!;
  assert.match(card.body, /`npm test`/);
  ev(k, "card.answered", { card_id: card.id, choice: "confirm" }, "feishu");
  assert.deepEqual(k.task("T-1")!.contract.acceptance.checks, ["npm test"]);

  ev(k, "human.message", { text: "加 double" }, "feishu");
  const j2 = k.claimJudgment("claude", T0, sid())!;
  ev(k, "judgment.result", { judgment_id: j2.id, output: { kind: "goal", direct: true, title: "加 double", acceptance: ["double(2) 是 4"], checks: ["npm test"] } }, "worker");
  assert.deepEqual(k.task("T-2")!.contract.acceptance.checks, [], "直接立项的人没看过命令，不跑");
});

test("P2-05：执行的提示词说明会被验证、列出检查命令；验证者的提示词带验收、边界、改动范围、上次意见、检查结果", () => {
  const k = new Kernel(cfg(), ":memory:");
  ev(k, "goal.confirmed", { title: "half", acceptance: ["half(3) 返回 1.5"], boundaries: ["不改 add"], checks: ["npm test"] });
  const task = { ...k.task("T-1")!, base_commit: "abcdef1234567890" };
  const goal = k.goal("G-1")!;
  const exec = buildPrompt({ task, goal, rulings: [] });
  assert.match(exec, /检查命令（做完后系统在工作区里跑，必须通过）：\n- `npm test`/);
  assert.match(exec, /独立的验证者/);
  const p = buildVerifyPrompt({ task, goal, receipt: { outcome: "done", summary: "好了", handoff: "改了 math.mjs" }, round: 2,
    checks: [{ command: "npm test", ok: true, exit_code: 0, output: "1 passing" }],
    prior: { run_id: "RN-2", verdict: { pass: false, summary: "错", issues: [{ problem: "返回 1", where: "math.mjs:2" }], risks: ["r"] } },
    workspace: { path: "/w/T-1", branch: "xj/T-1-half", base_commit: task.base_commit } });
  for (const s of ["half(3) 返回 1.5", "不改 add", "git diff abcdef123456..HEAD", "改了 math.mjs", "`npm test`：通过", "返回 1（math.mjs:2）", "第 2 轮", "只读", "\"risks\""]) assert.ok(p.includes(s), s);
});

// ---- P2-05 接单程序：先跑检查命令，再请只读的验证者 ----

function local(k: Kernel): KernelClient {
  let i = 100;
  const now = () => at(i++);
  return {
    claim: async (agent) => k.claim(agent, now(), sid(), { worker: "w", instance: "1" }) ?? { task: null },
    claimJudgment: async (agent) => ({ judgment: k.claimJudgment(agent, now(), sid()) }),
    claimEffect: async () => k.claimEffect(now(), sid()) ?? { effect: null },
    emit: async (type, payload, about) => { k.ingest({ source: "worker", source_id: sid(), type, at: now(), about, payload }); },
    goal: async (id) => k.goal(id)!,
    runStatus: async (id) => k.run(id)!.status,
  };
}

class FakeCodex implements AgentAdapter {
  readonly name = "codex";
  readonly requests: RunRequest[] = [];
  private readonly replies: string[];
  constructor(replies: string[]) { this.replies = replies; }
  async run(req: RunRequest): Promise<RunResult> {
    this.requests.push(req);
    return { last_message: this.replies.shift() ?? "", session_id: "CS", exit_code: 0, usage: {}, rate_limited: false, stderr: "",
      rate_limit: { seven_day: { utilization: 0.3, resetsAt: 1, status: "allowed" } } };
  }
}

function verifyingTask(checks: string[] = []) {
  const k = new Kernel(cfg(), ":memory:");
  ev(k, "goal.confirmed", { title: "half", acceptance: ["half(3) 返回 1.5"], checks });
  const c = k.claim("claude", T0, sid())!;
  done(k, c.run_id, "T-1");
  return k;
}

test("P2-05：接单程序——检查命令过了才请验证者；验证者只读、模型和强度照档案；格式错了在它自己的会话里重写一次", async () => {
  const k = verifyingTask(["npm test", "git push"]);
  const ran: string[] = [];
  const codex = new FakeCodex(["看过了，没问题", JSON.stringify({ verdict: "pass", summary: "满足", issues: [], risks: ["没测负数"] })]);
  const w = new Worker(local(k), { codex }, "/tmp", { profiles: { codex: CODEX }, heartbeatMs: 60_000, log: () => {},
    checkRunner: async (cmd) => { ran.push(cmd); return { code: 0, output: "ok" }; } });
  assert.equal(await w.once("codex"), true);
  assert.deepEqual(ran, ["npm test"], "git push 命中禁用规则，不跑");
  assert.equal(codex.requests.length, 2);
  const [first, rewrite] = codex.requests;
  assert.equal(first!.sandbox, "read-only");
  assert.equal(first!.model, "gpt-6.1-sol");
  assert.equal(first!.effort, "max");
  assert.match(first!.prompt, /验证任务 T-1/);
  assert.equal(rewrite!.session_id, "CS");
  assert.equal(k.task("T-1")!.state, "awaiting_review");
  const body = cardsOf(k, "T-1")[0]!.body;
  assert.match(body, /`npm test` 通过；`git push` 没跑/);
  assert.match(body, /- 没测负数\n- 检查命令 `git push` 没跑：命中禁用规则 git push/);
  assert.equal(k.overview().quota.find((q) => (q as { agent: string }).agent === "codex") !== undefined, true, "Codex 的用量也记账");
});

test("P2-05：接单程序——检查命令没过就不请验证者，直接按没通过交结论", async () => {
  const k = verifyingTask(["npm test"]);
  const codex = new FakeCodex([]);
  const w = new Worker(local(k), { codex }, "/tmp", { profiles: { codex: CODEX }, heartbeatMs: 60_000, log: () => {},
    checkRunner: async () => ({ code: 1, output: "AssertionError: 1 !== 1.5" }) });
  await w.once("codex");
  assert.equal(codex.requests.length, 0);
  const t = k.task("T-1")!;
  assert.equal(t.state, "queued");
  assert.match(t.feedback!, /`npm test` 退出码 1：AssertionError: 1 !== 1.5/);
});

test("P2-05：接单程序——验证者起不来，交带错误的结论，任务留在验证中", async () => {
  const k = verifyingTask();
  const broken: AgentAdapter = { name: "codex", run: async () => { throw new Error("spawn codex ENOENT"); } };
  const w = new Worker(local(k), { codex: broken }, "/tmp", { profiles: { codex: CODEX }, heartbeatMs: 60_000, log: () => {} });
  await w.once("codex");
  assert.equal(k.task("T-1")!.state, "verifying");
  assert.match(k.run("RN-2")!.lost_reason!, /spawn codex ENOENT/);
});
