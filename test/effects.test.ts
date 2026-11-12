// P1-21 对外动作先落账后执行、带幂等键重试：Agent 写进回执，内核与回执同事务落账，接单程序执行前先查远端。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Kernel } from "../src/kernel/kernel.ts";
import { startApi } from "../src/kernel/api.ts";
import { EFFECT_TIMEOUT_MS } from "../src/kernel/reducer.ts";
import { DEFAULTS } from "../src/shared/config.ts";
import { runEffect, type Exec } from "../src/worker/effects.ts";
import { Worker, EXECUTION_DISALLOWED } from "../src/worker/worker.ts";
import { kernelClient } from "../src/worker/http-client.ts";
import { buildArgs } from "../src/worker/adapters/claude-code.ts";
import type { Effect, Receipt, ReceiptEffect } from "../src/kernel/types.ts";

const T0 = "2026-11-12T10:00:00.000Z";
const MIN = 60_000;
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
let n = 0;
const sid = () => `fx${n++}`;
const PUSH: ReceiptEffect = { kind: "push-branch", branch: "xj/T-1-pow" };
const PR: ReceiptEffect = { kind: "open-pr", branch: "xj/T-1-pow", base: "main", title: "加 pow", body: "实现 pow" };

function done(k: Kernel, effects: ReceiptEffect[], t = T0, outcome: Receipt["outcome"] = "done") {
  const c = k.claim("claude", t, sid())!;
  const receipt: Receipt = outcome === "waiting" ? { outcome, summary: "推了等 CI", later: [{ timeout: "1h", about: "CI" }], effects }
    : { outcome, summary: "pow 好了", handoff: "见 math.mjs", effects };
  k.ingest({ source: "worker", source_id: sid(), type: "run.receipt", at: t, payload: { run_id: c.run_id, task_id: c.task.id, receipt } });
  return c;
}
function kernel() {
  const k = new Kernel(DEFAULTS, ":memory:");
  k.ingest({ source: "cli", source_id: sid(), type: "goal.confirmed", at: T0, payload: { title: "pow" } });
  return k;
}
const result = (k: Kernel, id: string, ok: boolean, extra: Record<string, unknown> = {}, t = T0) =>
  k.ingest({ source: "worker", source_id: sid(), type: "effect.result", at: t, payload: { effect_id: id, ok, ...extra } });
const effects = (k: Kernel) => (k.db.prepare("SELECT id, kind, status, attempts, error FROM effects ORDER BY rowid").all() as Record<string, unknown>[]).map((r) => ({ ...r }));

test("先落账：回执里的对外动作与回执同事务记下；先推分支再开 PR，一个一个来；都做完才出审核卡，卡上带结果", () => {
  const k = kernel();
  done(k, [PUSH, PR, PUSH]);
  assert.equal(k.task("T-1")!.state, "verifying", "等对外动作");
  assert.deepEqual(effects(k).map((x) => [x.id, x.kind, x.status]), [["X-1", "push-branch", "queued"], ["X-2", "open-pr", "queued"]], "重复的请求只记一次");
  assert.equal(k.cards().length, 0, "还没出审核卡");

  const a = k.claimEffect(T0, sid())!;
  assert.equal(a.effect.id, "X-1");
  assert.equal(k.claimEffect(T0, sid()), null, "推分支没结束，开 PR 不派");
  result(k, "X-1", true, { ref: "origin/xj/T-1-pow@abc1234" });
  assert.equal(k.claimEffect(T0, sid())!.effect.id, "X-2");
  result(k, "X-2", true, { ref: "https://github.com/me/repo/pull/7" });

  const [card] = k.cards();
  assert.equal(k.task("T-1")!.state, "awaiting_review");
  assert.match(card!.body, /^\*\*结果\*\*\n- 推分支 origin\/xj\/T-1-pow：origin\/xj\/T-1-pow@abc1234\n- 开 PR xj\/T-1-pow → main：https:\/\/github\.com\/me\/repo\/pull\/7\n\n\*\*执行者说明\*\*\n见 math\.mjs/);
  assert.deepEqual(k.why("X-1").map((e) => e.type), ["run.receipt", "effect.claimed", "effect.result"]);
});

test("不合规矩的请求不执行，记为 rejected，审核卡上照实列出：分支名不带任务编号、不支持的种类、推主干", () => {
  const k = kernel();
  done(k, [{ kind: "push-branch", branch: "feature/pow" }, { kind: "send-email" }, { kind: "push-branch", branch: "main" }]);
  assert.deepEqual(effects(k).map((x) => x.status), ["rejected", "rejected", "rejected"]);
  assert.equal(k.claimEffect(T0, sid()), null);
  assert.equal(k.task("T-1")!.state, "awaiting_review", "没有要等的，直接出审核卡");
  assert.match(k.cards()[0]!.body, /- 推分支 origin\/feature\/pow：没执行（分支名要带任务编号 T-1（出身标记））\n- send-email：没执行（一期只支持 push-branch、open-pr）\n- 推分支 origin\/main：没执行/);
});

test("不在授权内的种类不执行", () => {
  const k = new Kernel(DEFAULTS, ":memory:");
  k.ingest({ source: "cli", source_id: sid(), type: "goal.confirmed", at: T0, payload: { title: "x", grant: { effects: ["push-branch"] } } });
  done(k, [PUSH, PR]);
  assert.deepEqual(effects(k).map((x) => [x.status, x.error]), [["queued", null], ["rejected", "不在这个目标的授权内"]]);
});

test("可重试的失败：退避 1 分钟、5 分钟；第 3 次还不行判失败，后面的作废，任务受阻出卡片；选重试再来，成功后出审核卡", () => {
  const k = kernel();
  done(k, [PUSH, PR]);
  k.claimEffect(T0, sid());
  result(k, "X-1", false, { detail: "Could not resolve host", retryable: true });
  assert.equal(k.claimEffect(at(30_000), sid()), null, "退避中");
  assert.equal(k.claimEffect(at(MIN), sid())!.effect.attempts, 2);
  result(k, "X-1", false, { detail: "Could not resolve host", retryable: true }, at(MIN));
  assert.equal(k.claimEffect(at(5 * MIN), sid()), null);
  k.claimEffect(at(6 * MIN), sid());
  result(k, "X-1", false, { detail: "Could not resolve host", retryable: true }, at(6 * MIN));
  assert.deepEqual(effects(k).map((x) => x.status), ["failed", "cancelled"]);
  assert.equal(k.task("T-1")!.state, "blocked");
  const card = k.cards()[0]!;
  assert.deepEqual([card.form, card.title, card.push], ["effect", "对外动作失败：推分支 origin/xj/T-1-pow", true]);

  k.ingest({ source: "cli", source_id: sid(), type: "card.answered", at: at(10 * MIN), payload: { card_id: card.id, choice: "retry" } });
  assert.equal(k.task("T-1")!.state, "verifying");
  assert.deepEqual(effects(k).map((x) => [x.status, x.attempts]), [["queued", 0], ["queued", 0]]);
  k.claimEffect(at(10 * MIN), sid()); result(k, "X-1", true, { ref: "r1" });
  k.claimEffect(at(10 * MIN), sid()); result(k, "X-2", true, { ref: "r2" });
  assert.equal(k.task("T-1")!.state, "awaiting_review");
});

test("不可重试的失败（远端拒绝）立即问人；选跳过直接出审核卡，卡上写明没做成", () => {
  const k = kernel();
  done(k, [PUSH, PR]);
  k.claimEffect(T0, sid());
  result(k, "X-1", false, { detail: "推送失败：! [rejected] (non-fast-forward)", retryable: false });
  const card = k.cards()[0]!;
  k.ingest({ source: "cli", source_id: sid(), type: "card.answered", at: T0, payload: { card_id: card.id, choice: "skip" } });
  assert.equal(k.task("T-1")!.state, "awaiting_review");
  assert.match(k.cards()[0]!.body, /- 推分支 origin\/xj\/T-1-pow：失败（推送失败：! \[rejected\] \(non-fast-forward\)）\n- 开 PR xj\/T-1-pow → main：作废/);
});

test("执行超时或接单程序重启：按可重试的失败重排（重做前查远端，不会做两遍）", () => {
  const k = kernel();
  done(k, [PUSH]);
  k.claimEffect(T0, sid(), { worker: "local", instance: "a" });
  k.ingest({ source: "timer", source_id: sid(), type: "timer.tick", at: at(EFFECT_TIMEOUT_MS + 1_000), payload: {} });
  assert.deepEqual(effects(k).map((x) => [x.status, x.error]), [["queued", "执行超时"]]);
  k.claimEffect(at(20 * MIN), sid(), { worker: "local", instance: "a" });
  k.ingest({ source: "worker", source_id: sid(), type: "worker.started", at: at(21 * MIN), payload: { worker: "local", instance: "b" } });
  assert.deepEqual(effects(k).map((x) => [x.status, x.error]), [["queued", "接单程序重启"]]);
  // 迟到的结果：已经重排了，只记录
  result(k, "X-1", true, { ref: "late" });
  assert.equal(effects(k)[0]!.status, "queued");
});

test("叫停：还没执行的对外动作作废；回执是 waiting（写了 later）时照样执行，做完不干等，带着结果叫 Agent 回来", () => {
  const k = kernel();
  done(k, [PUSH], T0, "waiting");
  assert.equal(k.task("T-1")!.state, "awaiting_world");
  k.claimEffect(T0, sid()); result(k, "X-1", true, { ref: "origin/xj/T-1-pow@abc1234" });
  assert.equal(k.cards().length, 0);
  assert.equal(k.task("T-1")!.state, "queued");
  assert.match(k.task("T-1")!.feedback ?? "", /系统已执行你请求的对外动作：推分支 origin\/xj\/T-1-pow：origin\/xj\/T-1-pow@abc1234/);
  const c = k.claim("claude", T0, sid())!;
  k.ingest({ source: "worker", source_id: sid(), type: "run.receipt", at: T0, payload: { run_id: c.run_id, task_id: "T-1", receipt: { outcome: "done", summary: "推好了", handoff: "远端已是 abc1234" } } });
  assert.match(k.cards()[0]!.body, /^\*\*结果\*\*\n- 推分支 origin\/xj\/T-1-pow：origin\/xj\/T-1-pow@abc1234\n/, "前一轮请求的动作也上审核卡");
  assert.equal((k.db.prepare("SELECT COUNT(*) n FROM timers WHERE about = 'T-1' AND fired = 0").get() as { n: number }).n, 0, "兜底定时器撤掉");
  const k2 = kernel();
  done(k2, [PUSH, PR]);
  k2.ingest({ source: "cli", source_id: sid(), type: "human.stop", at: T0, payload: { about: "T-1" } });
  assert.deepEqual(effects(k2).map((x) => x.status), ["cancelled", "cancelled"]);
});

test("waiting 但没写 later、只在等自己请求的对外动作：按 done 处理，动作做完出审核卡（实测 T-9 卡在等世界）", () => {
  const k = kernel();
  const c = k.claim("claude", T0, sid())!;
  k.ingest({ source: "worker", source_id: sid(), type: "run.receipt", at: T0,
    payload: { run_id: c.run_id, task_id: c.task.id, receipt: { outcome: "waiting", summary: "推送请求已提交，等结果", effects: [PUSH] } } });
  assert.equal(k.task("T-1")!.state, "verifying");
  k.claimEffect(T0, sid()); result(k, "X-1", true, { ref: "origin/xj/T-1-pow@abc1234" });
  assert.equal(k.task("T-1")!.state, "awaiting_review");
  assert.match(k.cards()[0]!.body, /^\*\*结果\*\*\n- 推分支/);
});

test("waiting 的任务，对外动作失败：撤掉等待，任务受阻，出对外动作卡", () => {
  const k = kernel();
  done(k, [PUSH], T0, "waiting");
  k.claimEffect(T0, sid()); result(k, "X-1", false, { detail: "rejected", retryable: false });
  assert.equal(k.task("T-1")!.state, "blocked");
  assert.equal(k.cards()[0]!.form, "effect");
  assert.equal((k.db.prepare("SELECT COUNT(*) n FROM timers WHERE about = 'T-1' AND fired = 0").get() as { n: number }).n, 0);
});

test("重建投影：对外动作的状态、审核卡与原来一致", () => {
  const k = kernel();
  done(k, [PUSH, PR]);
  k.claimEffect(T0, sid()); result(k, "X-1", true, { ref: "r1" });
  k.claimEffect(T0, sid()); result(k, "X-2", false, { detail: "gh: not logged in", retryable: false });
  const snap = () => JSON.stringify([k.db.prepare("SELECT * FROM effects ORDER BY id").all(), k.db.prepare("SELECT * FROM cards ORDER BY id").all(), k.task("T-1")]);
  const before = snap();
  k.rebuild();
  assert.equal(snap(), before);
});

// ---- 执行器：真的 git，本地 bare 仓库当远端 ----

function repos() {
  const dir = mkdtempSync(join(tmpdir(), "xj-fx-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "--bare", join(dir, "remote.git")]);
  const work = join(dir, "work");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(work, "config", "user.email", "t@example.com"); git(work, "config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "1"); git(work, "add", "."); git(work, "commit", "-qm", "init");
  git(work, "checkout", "-qb", "xj/T-1-pow");
  writeFileSync(join(work, "a.txt"), "2"); git(work, "commit", "-qam", "pow");
  return { dir, work, git };
}
const fx = (kind: string, branch: string, extra: Partial<Effect["params"]> = {}): Effect => ({
  id: "X-1", task_id: "T-1", run_id: "RN-1", kind, params: { branch, remote: "origin", ...extra }, key: "k", status: "running",
  attempts: 1, not_before: null, result: null, error: null, worker: null, instance: null, started_at: null, finished_at: null, created_at: T0,
});

test("推分支：没有远端判失败不重试；推一次成功；再推一次查到远端已是这个提交，不再推", async () => {
  const { dir, work, git } = repos();
  assert.deepEqual(await runEffect(fx("push-branch", "xj/T-1-pow"), work, "G-1"), { ok: false, detail: "仓库没有远端 origin", retryable: false });
  git(work, "remote", "add", "origin", join(dir, "remote.git"));
  const sha = git(work, "rev-parse", "HEAD").slice(0, 7);
  const first = await runEffect(fx("push-branch", "xj/T-1-pow"), work, "G-1");
  assert.deepEqual([first.ok, first.ref], [true, `origin/xj/T-1-pow@${sha}`]);
  assert.equal(git(join(dir, "remote.git"), "rev-parse", "xj/T-1-pow").slice(0, 7), sha);
  const again = await runEffect(fx("push-branch", "xj/T-1-pow"), work, "G-1");
  assert.deepEqual([again.ok, again.detail], [true, "远端已经是这个提交（之前推过）"]);
  assert.deepEqual(await runEffect(fx("push-branch", "xj/T-1-nope"), work, "G-1"), { ok: false, detail: "本地没有分支 xj/T-1-nope", retryable: false });
});

test("推分支：远端已经分叉（non-fast-forward）不强推，判失败不重试", async () => {
  const { dir, work, git } = repos();
  git(work, "remote", "add", "origin", join(dir, "remote.git"));
  await runEffect(fx("push-branch", "xj/T-1-pow"), work, "G-1");
  git(work, "reset", "-q", "--hard", "HEAD~1");
  writeFileSync(join(work, "a.txt"), "3"); git(work, "commit", "-qam", "另一条路");
  const r = await runEffect(fx("push-branch", "xj/T-1-pow"), work, "G-1");
  assert.equal(r.ok, false);
  assert.equal(r.retryable, false);
  assert.match(r.detail, /推送失败：[\s\S]*rejected/);
});

test("开 PR：已有就直接算完成；没有就开，描述末尾带出身标记", async () => {
  const calls: string[][] = [];
  const fake = (prs: string): Exec => async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[1] === "list") return { code: 0, stdout: prs, stderr: "" };
    return { code: 0, stdout: "https://github.com/me/repo/pull/9\n", stderr: "" };
  };
  const pr = fx("open-pr", "xj/T-1-pow", { base: "main", title: "加 pow", body: "实现 pow" });
  assert.deepEqual(await runEffect(pr, "/tmp", "G-1", fake('[{"url":"https://github.com/me/repo/pull/3"}]')),
    { ok: true, ref: "https://github.com/me/repo/pull/3", detail: "这个分支已经有 PR（之前开过）" });
  const r = await runEffect(pr, "/tmp", "G-1", fake("[]"));
  assert.deepEqual([r.ok, r.ref], [true, "https://github.com/me/repo/pull/9"]);
  const create = calls.at(-1)!;
  assert.deepEqual(create.slice(0, 9), ["gh", "pr", "create", "--head", "xj/T-1-pow", "--base", "main", "--title", "加 pow"]);
  assert.equal(create.at(-1), "实现 pow\n\n---\n璇玑任务 T-1（目标 G-1，轮次 RN-1）");
});

test("执行的 Agent 禁用推送和改 PR 的命令；判断点和回执重写不受影响", () => {
  const args = buildArgs({ prompt: "p", cwd: "/tmp", timeout_ms: 1, disallowed_tools: EXECUTION_DISALLOWED });
  const i = args.indexOf("--disallowedTools");
  assert.deepEqual(args.slice(i + 1, i + 3), ["Bash(git push:*)", "Bash(gh pr create:*)"]);
  assert.equal(args.at(-2), "--", "提示词前有 --，不会被吞成工具名");
  assert.ok(!buildArgs({ prompt: "p", cwd: "/tmp", timeout_ms: 1, tools: [] }).includes("--disallowedTools"));
});

test("接单程序：经本机接口领对外动作、执行、报结果，审核卡随之出来", async () => {
  const k = kernel();
  const server = startApi(k, 0);
  await once(server, "listening");
  try {
    done(k, [PUSH]);
    const ran: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      ran.push([cmd, ...args]);
      if (args[0] === "rev-parse") return { code: 0, stdout: "abcdef1234567\n", stderr: "" };
      if (args[0] === "remote") return { code: 0, stdout: "/tmp/remote.git\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const w = new Worker(kernelClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "worker"), {}, tmpdir(), { exec, log: () => {} });
    assert.equal(await w.effectOnce(), true);
    assert.equal(await w.effectOnce(), false);
    assert.deepEqual(ran.at(-1), ["git", "push", "origin", "refs/heads/xj/T-1-pow:refs/heads/xj/T-1-pow"]);
    assert.equal(k.task("T-1")!.state, "awaiting_review");
    assert.match(k.cards()[0]!.body, /^\*\*结果\*\*\n- 推分支 origin\/xj\/T-1-pow：origin\/xj\/T-1-pow@abcdef1/);
  } finally { server.close(); k.close(); }
});

test("系统起的 Claude Code 进程和人的个人配置隔开；执行轮用允许清单，禁掉绕开内核的命令；判断点什么工具都没有", async () => {
  const { ISOLATION_ARGS } = await import("../src/worker/adapters/claude-code.ts");
  const { EXECUTION_TOOLS, EXECUTION_PERMISSION_MODE } = await import("../src/worker/worker.ts");
  const exec = buildArgs({ prompt: "p", cwd: "/tmp", timeout_ms: 1, tools: EXECUTION_TOOLS, disallowed_tools: EXECUTION_DISALLOWED, permission_mode: EXECUTION_PERMISSION_MODE });
  const judge = buildArgs({ prompt: "p", cwd: "/tmp", timeout_ms: 1, tools: [] });
  for (const a of [exec, judge]) {
    assert.deepEqual(a.slice(a.indexOf("--setting-sources"), a.indexOf("--setting-sources") + 3), ISOLATION_ARGS);
  }
  const tools = exec[exec.indexOf("--tools") + 1]!.split(",");
  assert.ok(tools.includes("Task") && tools.includes("Bash"));
  for (const t of ["CronCreate", "ScheduleWakeup", "RemoteTrigger", "Monitor", "SendMessage", "ListAgents", "EnterWorktree", "Skill"]) assert.ok(!tools.includes(t), t);
  for (const c of ["lark-cli", "claude", "codex", "crontab", "launchctl", "osascript"]) assert.ok(EXECUTION_DISALLOWED.includes(`Bash(${c}:*)`), c);
  assert.equal(exec[exec.indexOf("--permission-mode") + 1], "auto");
  assert.equal(judge[judge.indexOf("--tools") + 1], "");
});
