// P1-14 重启恢复与 P1-19 看门狗。内核层用确定的时间点驱动；接单程序层起真的本机接口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "../src/kernel/kernel.ts";
import { startApi } from "../src/kernel/api.ts";
import { HEARTBEAT_TIMEOUT_MS, RUN_GRACE_MS } from "../src/kernel/reducer.ts";
import { ticksFor } from "../src/sources/timer.ts";
import { DEFAULTS } from "../src/shared/config.ts";
import { Worker } from "../src/worker/worker.ts";
import { kernelClient } from "../src/worker/http-client.ts";
import { parseStream, reapOrphans, buildArgs } from "../src/worker/adapters/claude-code.ts";
import type { AgentAdapter, RunRequest, RunResult } from "../src/worker/adapters/types.ts";

const T0 = "2026-11-12T08:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const MIN = 60_000;
const A = { worker: "local", instance: "100-a" };
const B = { worker: "local", instance: "200-b" };
let n = 0;
const sid = () => `s${n++}`;

function withGoal(k = new Kernel(DEFAULTS, ":memory:")) {
  k.ingest({ source: "cli", source_id: sid(), type: "goal.confirmed", at: T0, payload: { title: "x" } });
  return k;
}
const tick = (k: Kernel, t: string) => k.ingest({ source: "timer", source_id: t, type: "timer.tick", at: t, payload: {} });
const beat = (k: Kernel, runId: string, t: string, session?: string) =>
  k.ingest({ source: "worker", source_id: sid(), type: "run.heartbeat", at: t, about: "T-1", payload: { run_id: runId, task_id: "T-1", session_id: session } });

test("看门狗：心跳超时的轮次标为 lost，任务带恢复说明回队列，领活时拿到说明", () => {
  const k = withGoal();
  const c = k.claim("claude", T0, sid(), A)!;
  tick(k, at(2 * MIN));
  assert.equal(k.run(c.run_id)!.status, "running", "两分钟没心跳还不算超时");
  beat(k, c.run_id, at(2 * MIN), "sess-1");
  tick(k, at(2 * MIN + HEARTBEAT_TIMEOUT_MS));
  assert.equal(k.run(c.run_id)!.status, "running", "恰好到阈值不算");
  tick(k, at(2 * MIN + HEARTBEAT_TIMEOUT_MS + 1_000));
  const run = k.run(c.run_id)!;
  assert.equal(run.status, "lost");
  assert.match(run.lost_reason!, /心跳超时/);
  const task = k.task("T-1")!;
  assert.equal(task.state, "queued");
  assert.equal(task.session_id, "sess-1", "心跳报过的会话编号留给恢复的那一轮接上");
  assert.match(task.recovery!, /RN-1 没有交回执就中断了.*先检查工作目录、git 历史和远端状态/);

  const again = k.claim("claude", at(6 * MIN), sid(), A)!;
  assert.equal(again.run_id, "RN-2");
  assert.equal(again.recovery, task.recovery);
  // 中断的那一轮的回执迟到了：只记录，不推动任务
  k.ingest({ source: "worker", source_id: sid(), type: "run.receipt", at: at(7 * MIN), payload: { run_id: "RN-1", task_id: "T-1", receipt: { outcome: "done", summary: "迟到", handoff: "h" } } });
  assert.equal(k.task("T-1")!.state, "running");
  assert.equal(k.cards().length, 0);
  // 新一轮的回执到了，恢复说明用掉
  k.ingest({ source: "worker", source_id: sid(), type: "run.receipt", at: at(8 * MIN), payload: { run_id: "RN-2", task_id: "T-1", receipt: { outcome: "done", summary: "好了", handoff: "h" } } });
  assert.equal(k.task("T-1")!.recovery, null);
  assert.equal(k.task("T-1")!.failures, 0);

  const why = k.why("T-1");
  const lostTick = why.find((e) => e.type === "timer.tick")!;
  assert.match(lostTick.note!, /RN-1 中断：心跳超时.*带恢复说明回队列/, "xj why 能看到看门狗做了什么");
  assert.match(k.why("RN-1").find((e) => e.type === "timer.tick")!.note!, /中断：心跳超时/);
});

test("看门狗：一直有心跳但超过预算时长加宽限，判单轮超时", () => {
  const k = withGoal();
  const c = k.claim("claude", T0, sid())!;
  const budget = k.task("T-1")!.contract.budget.minutes * MIN;
  for (let t = MIN; t <= budget + RUN_GRACE_MS; t += MIN) { beat(k, c.run_id, at(t)); tick(k, at(t)); }
  assert.equal(k.run(c.run_id)!.status, "running");
  beat(k, c.run_id, at(budget + RUN_GRACE_MS + 1_000));
  tick(k, at(budget + RUN_GRACE_MS + 1_000));
  assert.equal(k.run(c.run_id)!.status, "lost");
  assert.match(k.run(c.run_id)!.lost_reason!, /单轮超时（预算 120 分钟）/);
});

test("内核重启：从账本重建，执行中的轮次不立即判中断，给一个心跳超时的宽限", () => {
  const dir = mkdtempSync(join(tmpdir(), "xj-restart-"));
  const db = join(dir, "xuanji.db");
  const k1 = withGoal(new Kernel(DEFAULTS, db));
  const c = k1.claim("claude", T0, sid(), A)!;
  beat(k1, c.run_id, at(MIN), "sess-r");
  k1.close();

  // 停机 20 分钟后重启：先重建投影，再记一条 kernel.restarted
  const k2 = new Kernel(DEFAULTS, db);
  k2.rebuild();
  assert.equal(k2.run(c.run_id)!.status, "running", "重建后轮次仍是执行中");
  k2.ingest({ source: "kernel", source_id: "restarted-1", type: "kernel.restarted", at: at(21 * MIN), payload: {} });
  tick(k2, at(22 * MIN));
  assert.equal(k2.run(c.run_id)!.status, "running", "接单程序可能还活着，宽限期内不判");
  beat(k2, c.run_id, at(22 * MIN));                 // 它果然还活着，心跳恢复
  tick(k2, at(24 * MIN));
  assert.equal(k2.run(c.run_id)!.status, "running");
  tick(k2, at(22 * MIN + HEARTBEAT_TIMEOUT_MS + 1_000));
  assert.equal(k2.run(c.run_id)!.status, "lost", "之后心跳又断了，照常判超时");
  assert.ok(k2.why("T-1").some((e) => e.type === "kernel.restarted" && /内核重启后等它恢复心跳/.test(e.note ?? "")));

  // 重建是确定的：再重建一次，投影和 why 都不变
  const before = JSON.stringify([k2.overview(), k2.why("T-1")]);
  k2.rebuild();
  assert.equal(JSON.stringify([k2.overview(), k2.why("T-1")]), before);
  k2.close();
});

test("接单程序重启报到：同名旧实例领的轮次立即判中断；别的接单程序的轮次不动", () => {
  const k = withGoal();
  k.ingest({ source: "cli", source_id: sid(), type: "goal.confirmed", at: T0, payload: { title: "y" } });
  const mine = k.claim("claude", T0, sid(), A)!;
  const other = k.claim("claude", T0, sid(), { worker: "remote", instance: "9" })!;
  k.ingest({ source: "worker", source_id: sid(), type: "worker.started", at: at(MIN), payload: A });
  assert.equal(k.run(mine.run_id)!.status, "running", "同一个实例重复报到不算重启");
  k.ingest({ source: "worker", source_id: sid(), type: "worker.started", at: at(2 * MIN), payload: B });
  assert.equal(k.run(mine.run_id)!.status, "lost");
  assert.equal(k.run(mine.run_id)!.lost_reason, "接单程序重启");
  assert.equal(k.run(other.run_id)!.status, "running");
  assert.equal(k.task(mine.task.id)!.state, "queued");
});

test("连续第 3 次失败或中断就不再自动重派，转受阻出卡片", () => {
  const k = withGoal();
  for (let i = 0; i < 3; i++) {
    k.claim("claude", at(i * 10 * MIN), sid(), A);
    tick(k, at(i * 10 * MIN + HEARTBEAT_TIMEOUT_MS + 1_000));
  }
  assert.equal(k.task("T-1")!.state, "blocked");
  const card = k.cards().find((c) => c.kind === "decision")!;
  assert.match(card.title, /连续 3 次失败或中断：心跳超时/);
  assert.equal(k.claim("claude", at(60 * MIN), sid(), A), null);
});

// ---- 接单程序层 ----

async function api(kernel: Kernel, port = 0) {
  const server = startApi(kernel, port);
  await once(server, "listening");
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("接单程序崩了再起：新实例报到，旧轮次判中断；新一轮接上旧会话并带恢复说明；旧进程被叫停", async () => {
  const kernel = new Kernel(DEFAULTS, ":memory:");
  const { server, base } = await api(kernel);
  try {
    await kernelClient(base, "cli").emit("goal.confirmed", { title: "在 math.mjs 加 sub" });
    // 旧实例：Agent 一起来就报会话编号，然后一直跑，直到被结束
    let oldAborted = false;
    const hanging: AgentAdapter = { name: "claude", run: (req, signal) => new Promise<RunResult>((resolve) => {
      req.onSession?.("sess-old");
      signal!.addEventListener("abort", () => { oldAborted = true; resolve({ last_message: "", session_id: "sess-old", exit_code: 143, usage: {}, rate_limited: false, stderr: "", stopped: true }); });
    }) };
    const oldWorker = new Worker(kernelClient(base, "worker", { worker: A }), { claude: hanging }, tmpdir(), { identity: A, heartbeatMs: 15, log: () => {} });
    await oldWorker.start();
    const oldRun = oldWorker.once("claude");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(kernel.run("RN-1")!.session_id, "sess-old", "会话编号随心跳入账");

    // 新实例（同名）起来：报到 → RN-1 判中断 → 领到 RN-2，接上 sess-old，提示词里有恢复说明
    const seen: RunRequest[] = [];
    const replay: AgentAdapter = { name: "claude", run: async (req) => {
      seen.push(req);
      return { ...parseStream(readFileSync(new URL("./fixtures/real-t1-done.ndjson", import.meta.url), "utf8")), exit_code: 0, stderr: "" };
    } };
    const newWorker = new Worker(kernelClient(base, "worker", { worker: B }), { claude: replay }, tmpdir(), { identity: B, log: () => {} });
    await newWorker.start();
    assert.equal(kernel.run("RN-1")!.status, "lost");
    await newWorker.once("claude");
    assert.equal(seen[0]!.label, "RN-2");
    assert.equal(seen[0]!.session_id, "sess-old");
    assert.match(seen[0]!.prompt, /## 恢复说明\n上一轮 RN-1 没有交回执就中断了（接单程序重启）/);
    assert.equal(kernel.task("T-1")!.state, "awaiting_review");

    // 旧实例的心跳发现 RN-1 已不是执行中，结束 Agent，不交回执
    await oldRun;
    assert.ok(oldAborted);
    assert.equal(kernel.run("RN-1")!.receipt, null);
    assert.equal(kernel.run("RN-1")!.status, "lost");
  } finally { server.close(); kernel.close(); }
});

test("内核短暂停机时，回执用同一个来源编号重试，内核起来后只落账一次", async () => {
  const port = await freePort();
  const kernel = new Kernel(DEFAULTS, ":memory:");
  const client = kernelClient(`http://127.0.0.1:${port}`, "worker", { retryDelaysMs: [50, 50, 50, 50, 50, 50] });
  const pending = client.emit("goal.confirmed", { title: "停机期间提的" });
  await new Promise((r) => setTimeout(r, 120));         // 前几次都连不上
  const { server } = await api(kernel, port);
  try {
    await pending;
    assert.equal(kernel.overview().goals.length, 1);
    assert.equal(kernel.why("G-1").length, 1);
  } finally { server.close(); kernel.close(); }
});

test("接单程序启动时清理上个实例留下的 Agent 进程组（只清命令行对得上的）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xj-pids-"));
  const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  orphan.unref();
  writeFileSync(join(dir, "RN-7.pid"), String(orphan.pid));
  writeFileSync(join(dir, "RN-8.pid"), String(process.pid));   // 命令行不是 sleep：不能误杀
  writeFileSync(join(dir, "RN-9.pid"), "999999");              // 早就不在了
  const exited = once(orphan, "exit");
  assert.deepEqual(reapOrphans(dir, "sleep"), ["RN-7"]);
  await exited;
  assert.ok(!existsSync(join(dir, "RN-7.pid")) && !existsSync(join(dir, "RN-8.pid")) && !existsSync(join(dir, "RN-9.pid")), "pid 文件都清掉");
});

test("中途被结束、没有 result 行时，也能从 system/init 取到会话编号", () => {
  const firstLine = readFileSync(new URL("./fixtures/real-t1-done.ndjson", import.meta.url), "utf8").split("\n")[0]!;
  const r = parseStream(firstLine + "\n");
  assert.equal(r.session_id, "80265ba6-614b-4d5e-9502-32eb52acd9b9");
  assert.equal(r.last_message, "");
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
  });
}

// ---- 2026-11-12 真实演练里发现的问题 ----

test("提示词前有 --：--tools 能接多个值，不隔开会把提示词吞掉", () => {
  const args = buildArgs({ prompt: "重写回执", cwd: "/tmp", session_id: "s", tools: [], timeout_ms: 1 });
  assert.deepEqual(args.slice(-4), ["--tools", "", "--", "重写回执"]);
});

test("result 行只写出一半时，用最后一条 assistant 文本作回执（录制件截掉最后一行的后半截）", () => {
  const lines = readFileSync(new URL("./fixtures/real-t1-done.ndjson", import.meta.url), "utf8").trimEnd().split("\n");
  const cut = [...lines.slice(0, -1), lines.at(-1)!.slice(0, 200)].join("\n");
  const r = parseStream(cut);
  assert.match(r.last_message, /^\{"outcome":"done"/);
  assert.equal(r.session_id, "80265ba6-614b-4d5e-9502-32eb52acd9b9");
});

test("回执重写的真实输出：不给工具、同一会话，交回合法回执", async () => {
  const kernel = new Kernel(DEFAULTS, ":memory:");
  const { server, base } = await api(kernel);
  try {
    const client = kernelClient(base, "worker");
    const seen: RunRequest[] = [];
    const outputs = [
      { last_message: "做完了，提交了 dfbabe1。", session_id: "758bb8e1-556e-44c4-a8dc-3c28404f28c3", exit_code: 0, usage: {}, rate_limited: false, stderr: "" },
      { ...parseStream(readFileSync(new URL("./fixtures/real-rewrite.ndjson", import.meta.url), "utf8")), exit_code: 0, stderr: "" },
    ];
    const adapter: AgentAdapter = { name: "claude", run: async (req) => { seen.push(req); return outputs.shift()!; } };
    await client.emit("goal.confirmed", { title: "sq" });
    await new Worker(client, { claude: adapter }, tmpdir(), { log: () => {} }).once("claude");
    assert.deepEqual(buildArgs(seen[1]!).slice(-4, -1), ["--tools", "", "--"]);
    assert.equal(kernel.task("T-1")!.state, "awaiting_review");
    assert.equal(kernel.run("RN-1")!.session_id, "758bb8e1-556e-44c4-a8dc-3c28404f28c3");
  } finally { server.close(); kernel.close(); }
});

test("Agent 结束时本轮已被判中断（接单程序被冻住过）：不重写、不交回执", async () => {
  const kernel = new Kernel(DEFAULTS, ":memory:");
  const { server, base } = await api(kernel);
  try {
    const client = kernelClient(base, "worker", { worker: A });
    let calls = 0;
    const adapter: AgentAdapter = { name: "claude", run: async () => {
      calls++;
      // 模拟冻住期间：同名新实例报到，内核判本轮中断
      kernel.ingest({ source: "worker", source_id: sid(), type: "worker.started", at: new Date().toISOString(), payload: B });
      return { last_message: "（回执被截断）", session_id: "s", exit_code: 0, usage: {}, rate_limited: false, stderr: "" };
    } };
    await client.emit("goal.confirmed", { title: "x" });
    await new Worker(client, { claude: adapter }, tmpdir(), { identity: A, heartbeatMs: 60_000, log: () => {} }).once("claude");
    assert.equal(calls, 1, "没有为已作废的轮次再起一次进程重写回执");
    assert.equal(kernel.run("RN-1")!.receipt, null);
    assert.equal(kernel.task("T-1")!.state, "queued");
  } finally { server.close(); kernel.close(); }
});

test("一拿到会话编号就报心跳，不等心跳间隔", async () => {
  const kernel = new Kernel(DEFAULTS, ":memory:");
  const { server, base } = await api(kernel);
  try {
    const client = kernelClient(base, "worker");
    let seenByKernel: string | null = null;
    const adapter: AgentAdapter = { name: "claude", run: async (req) => {
      req.onSession?.("sess-early");
      await new Promise((r) => setTimeout(r, 80));
      seenByKernel = kernel.run("RN-1")!.session_id;
      return { last_message: '{"outcome":"nothing","summary":"s"}', session_id: "sess-early", exit_code: 0, usage: {}, rate_limited: false, stderr: "" };
    } };
    await client.emit("goal.confirmed", { title: "x" });
    await new Worker(client, { claude: adapter }, tmpdir(), { heartbeatMs: 60_000, log: () => {} }).once("claude");
    assert.equal(seenByKernel, "sess-early");
  } finally { server.close(); kernel.close(); }
});

test("机器睡眠后醒来：定时器来源先补 timer.resumed，看门狗不把还活着的轮次误判中断", () => {
  assert.deepEqual(ticksFor(at(0), at(MIN), MIN).map((e) => e.type), ["timer.tick"], "正常间隔只发 tick");
  const woke = ticksFor(at(0), at(40 * MIN), MIN);
  assert.deepEqual(woke.map((e) => e.type), ["timer.resumed", "timer.tick"]);

  const k = withGoal();
  const c = k.claim("claude", T0, sid(), A)!;
  for (const e of woke) k.ingest(e);
  assert.equal(k.run(c.run_id)!.status, "running", "醒来的第一次 tick 不判");
  tick(k, at(40 * MIN + HEARTBEAT_TIMEOUT_MS + 1_000));
  assert.equal(k.run(c.run_id)!.status, "lost", "宽限过后仍没心跳才判");
});
