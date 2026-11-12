// 一期闭环的端到端用例：真的起内核的本机接口、真的跑 xj 子进程、真的跑接单程序，
// 只有 Claude Code 换成回放适配器，喂 2026-11-11 真实一轮录下的 stream-json（test/fixtures/real-*.ndjson）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Kernel } from "../src/kernel/kernel.ts";
import { startApi } from "../src/kernel/api.ts";
import { DEFAULTS } from "../src/shared/config.ts";
import { Worker } from "../src/worker/worker.ts";
import { kernelClient } from "../src/worker/http-client.ts";
import { parseStream, buildArgs } from "../src/worker/adapters/claude-code.ts";
import type { AgentAdapter, RunRequest, RunResult } from "../src/worker/adapters/types.ts";
import type { Card, Event } from "../src/kernel/types.ts";

const execFileP = promisify(execFile);
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const XJ = new URL("../src/channels/cli/xj.ts", import.meta.url).pathname;

// 回放适配器：按顺序吐录制的输出，并记下每次收到的请求。
class Replay implements AgentAdapter {
  readonly name = "claude";
  readonly requests: RunRequest[] = [];
  private readonly queue: string[];
  constructor(files: string[]) { this.queue = files.map(fixture); }
  async run(req: RunRequest): Promise<RunResult> {
    this.requests.push(req);
    const out = this.queue.shift();
    if (out === undefined) throw new Error("回放用完了");
    return { ...parseStream(out), exit_code: 0, stderr: "" };
  }
}

async function harness(files: string[]) {
  const kernel = new Kernel(DEFAULTS, ":memory:");
  const server = startApi(kernel, 0);
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "xj-test-"));
  const cfgPath = join(dir, "xuanji.config.json");
  writeFileSync(cfgPath, JSON.stringify({ port }));
  const adapter = new Replay(files);
  const logs: string[] = [];
  const worker = new Worker(kernelClient(`http://127.0.0.1:${port}`, "worker"), { claude: adapter }, dir,
    { profiles: { claude: { model: "claude-haiku-5-5" } }, log: (l) => logs.push(l) });
  // xj 是独立进程，和人敲的一样；必须异步执行，否则会卡住同进程里的接口。
  const xj = async (...args: string[]) => (await execFileP(process.execPath, [XJ, ...args], { env: { ...process.env, XJ_CONFIG: cfgPath } })).stdout;
  const xjJson = async <T>(...args: string[]) => JSON.parse(await xj(...args, "--json")) as T;
  const close = () => new Promise<void>((r) => { server.close(() => r()); kernel.close(); });
  return { kernel, adapter, worker, xj, xjJson, logs, close, base: `http://127.0.0.1:${port}`, dir };
}

type Overview = { goals: { id: string; status: string }[]; tasks: { id: string; state: string; session_id: string | null }[];
  runs: { id: string; task_id: string; session_id: string | null }[] };

test("验收 1：xj goal → 接单程序跑一轮 → 回执入账 → 审核卡 → xj answer C-1 accept → 任务和目标都是 done", async () => {
  const h = await harness(["real-t1-done.ndjson"]);
  try {
    await h.xj("goal", "--direct", "在 math.mjs 里新增并导出函数 sub(a, b)");
    assert.equal(await h.worker.once("claude"), true, "接单程序领到活");
    assert.equal(await h.worker.once("claude"), false, "没有第二件");
    assert.equal(h.adapter.requests[0]!.label, "RN-1", "轮次编号由内核签发，不再是 TODO");
    assert.equal(h.adapter.requests[0]!.model, "claude-haiku-5-5");
    assert.equal(h.adapter.requests[0]!.session_id, undefined);
    assert.match(h.adapter.requests[0]!.prompt, /任务 T-1（目标 G-1：在 math\.mjs/, "从 GET /goals/:id 取到了目标");

    const run = h.kernel.run("RN-1")!;
    assert.equal(run.status, "finished"); assert.equal(run.receipt?.outcome, "done");

    const cards = await h.xjJson<Card[]>("cards");
    const review = cards.find((c) => c.kind === "review")!;
    assert.equal(review.id, "C-1"); assert.equal(review.about, "T-1");
    assert.match(await h.xj("cards"), /C-1 \[审核\] T-1/);

    assert.match(await h.xj("answer", "C-1", "accept"), /已回答 C-1 → accept/);
    const o = await h.xjJson<Overview>("status");
    assert.equal(o.tasks[0]!.state, "done");
    assert.equal(o.goals[0]!.status, "done");
    assert.match(await h.xj("status"), /G-1 \[done\][\s\S]*T-1 \[done\]/);
  } finally { await h.close(); }
});

test("验收 2：问人路径：ask 回执出决策卡；xj answer 后下一轮 --resume 接上原会话，两轮 session_id 相同", async () => {
  const h = await harness(["real-t2-ask.ndjson", "real-t2-resume-done.ndjson"]);
  try {
    await h.xj("goal", "--direct", "在 math.mjs 新增 greet(name)，语言先问我");
    await h.worker.once("claude");
    const decision = (await h.xjJson<Card[]>("cards")).find((c) => c.kind === "decision")!;
    assert.ok(decision, "得到决策卡");
    assert.deepEqual(decision.options.map((x) => x.key), ["中文", "英文"]);
    assert.equal((await h.xjJson<Overview>("status")).tasks[0]!.state, "awaiting_answer");

    await h.xj("answer", decision.id, "中文", "用“你好，<name>！”这种格式");
    await h.worker.once("claude");

    const [first, second] = h.adapter.requests;
    assert.equal(first!.session_id, undefined);
    assert.equal(second!.session_id, "9b5d5284-9463-4bd1-a1f6-eb19f3d11ab4", "第二轮带着第一轮的会话编号");
    const a2 = buildArgs(second!);
    assert.equal(a2[a2.indexOf("--resume") + 1], "9b5d5284-9463-4bd1-a1f6-eb19f3d11ab4");
    assert.match(second!.prompt, /的回答：中文；说明：用“你好，<name>！”这种格式/, "回答作为反馈带进下一轮");

    const o = await h.xjJson<Overview>("status");
    const runs = o.runs.filter((r) => r.task_id === "T-1");
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.session_id, runs[1]!.session_id, "账本里前后两轮的 session_id 相同");

    const review = (await h.xjJson<Card[]>("cards")).find((c) => c.kind === "review")!;
    await h.xj("answer", review.id, "accept");
    const done = await h.xjJson<Overview>("status");
    assert.equal(done.tasks[0]!.state, "done"); assert.equal(done.goals[0]!.status, "done");
  } finally { await h.close(); }
});

test("验收 3：xj why T-1 列出从立项到验收的全部事件（P1-18 关联表）", async () => {
  const h = await harness(["real-t1-done.ndjson"]);
  try {
    await h.xj("goal", "--direct", "在 math.mjs 里新增并导出函数 sub(a, b)");
    await h.worker.once("claude");
    await h.xj("answer", "C-1", "accept");
    const ev = await h.xjJson<Event[]>("why", "T-1");
    assert.deepEqual(ev.map((e) => e.type), ["goal.confirmed", "run.claimed", "run.receipt", "card.answered"]);
    // 立项事件的 about 为空、payload 里也没有 T-1，只能靠归并时回写的关联表找到它。
    assert.equal(ev[0]!.about, undefined);
    const text = await h.xj("why", "T-1");
    assert.match(text, /goal\.confirmed[\s\S]*run\.claimed[\s\S]*run\.receipt[\s\S]*RN-1 done[\s\S]*card\.answered\s+C-1 → accept/);
    // 从任一编号都能找回：目标、轮次、卡片
    assert.equal((await h.xjJson<Event[]>("why", "G-1")).length, 4);
    assert.deepEqual((await h.xjJson<Event[]>("why", "RN-1")).map((e) => e.type), ["run.claimed", "run.receipt"]);
    assert.deepEqual((await h.xjJson<Event[]>("why", "C-1")).map((e) => e.type), ["run.receipt", "card.answered"]);
    // 重建投影后关联表一致
    h.kernel.rebuild();
    assert.equal(h.kernel.why("T-1").length, 4);
  } finally { await h.close(); }
});

test("接单程序：人说停，心跳发现本轮已取消就结束进程，不交回执", async () => {
  const kernel = new Kernel(DEFAULTS, ":memory:");
  const server = startApi(kernel, 0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = kernelClient(base, "worker");
    let aborted = false;
    const hanging: AgentAdapter = {
      name: "claude",
      run: (_req, signal) => new Promise((resolve) => signal!.addEventListener("abort", () => {
        aborted = true;
        resolve({ last_message: "", session_id: "s-stop", exit_code: 143, usage: {}, rate_limited: false, stderr: "", stopped: true });
      })),
    };
    const worker = new Worker(client, { claude: hanging }, tmpdir(), { heartbeatMs: 20, log: () => {} });
    await client.emit("goal.confirmed", { title: "跑很久的活" });
    const p = worker.once("claude");
    await new Promise((r) => setTimeout(r, 50));
    await client.emit("human.stop", { about: "T-1" }, "T-1");
    await p;
    assert.ok(aborted, "进程被结束");
    assert.equal(kernel.task("T-1")!.state, "stopped");
    assert.equal(kernel.run("RN-1")!.status, "cancelled");
    assert.ok(kernel.why("T-1").some((e) => e.type === "run.heartbeat"), "心跳入账");
    assert.ok(!kernel.why("T-1").some((e) => e.type === "run.receipt"), "被叫停的轮次不交回执");
  } finally { server.close(); kernel.close(); }
});

test("接单程序：适配器起不来时交 failed 回执，任务不卡在执行中", async () => {
  const kernel = new Kernel(DEFAULTS, ":memory:");
  const server = startApi(kernel, 0);
  await once(server, "listening");
  try {
    const client = kernelClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "worker");
    const broken: AgentAdapter = { name: "claude", run: async () => { throw new Error("spawn claude ENOENT"); } };
    await client.emit("goal.confirmed", { title: "x" });
    await new Worker(client, { claude: broken }, tmpdir(), { log: () => {} }).once("claude");
    assert.equal(kernel.task("T-1")!.state, "awaiting_world", "退避等待中");
    assert.match(kernel.run("RN-1")!.receipt!.summary, /ENOENT/);
  } finally { server.close(); kernel.close(); }
});

test("接单程序：回执格式错了不重做业务，只在原会话里请 Agent 重写最后一条消息", async () => {
  const kernel = new Kernel(DEFAULTS, ":memory:");
  const server = startApi(kernel, 0);
  await once(server, "listening");
  try {
    const client = kernelClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "worker");
    const seen: RunRequest[] = [];
    const replies = ["做完了，改了 a.ts。", '{"outcome":"done","summary":"改好了","handoff":"见 a.ts"}'];
    const sloppy: AgentAdapter = { name: "claude", run: async (req) => {
      seen.push(req);
      return { last_message: replies.shift()!, session_id: "s-1", exit_code: 0, usage: {}, rate_limited: false, stderr: "" };
    } };
    await client.emit("goal.confirmed", { title: "x" });
    await new Worker(client, { claude: sloppy }, tmpdir(), { log: () => {} }).once("claude");
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.session_id, "s-1", "在原会话里重写");
    assert.deepEqual(seen[1]!.tools, [], "重写时不给工具，不重做业务");
    assert.match(seen[1]!.prompt, /回执格式错误/);
    assert.equal(kernel.task("T-1")!.state, "awaiting_review");
  } finally { server.close(); kernel.close(); }
});

test("验收 4：xj goal 经主理人出目标卡 → xj answer confirm → 跑一轮；xj why 折叠心跳；xj brief 出简报并收起知会卡", async () => {
  const h = await harness(["real-t1-done.ndjson"]);
  try {
    assert.match(await h.xj("goal", "在 math.mjs 里新增并导出函数 sub(a, b)"), /^收到 G-1（事件 #1）。主理人整理好目标卡后用 xj cards 查看/);
    assert.equal(await h.worker.once("claude"), false, "确认之前没有活");
    const draft = { kind: "goal", direct: false, title: "math.mjs 新增并导出 sub(a, b)", acceptance: ["sub(5, 3) 返回 2"], boundaries: [], ask_first: [] };
    const principal: AgentAdapter = { name: "claude", run: async () => ({ last_message: JSON.stringify(draft), session_id: "s-j", exit_code: 0, usage: {}, rate_limited: false, stderr: "" }) };
    await new Worker(kernelClient(h.base, "worker"), { claude: principal }, h.dir, { log: () => {} }).judgeOnce("claude");
    assert.match(await h.xj("cards"), /C-1 \[决策\] G-1  目标卡：math\.mjs 新增并导出 sub\(a, b\)[\s\S]*选项：confirm（推荐） \/ revise \/ drop/);
    await h.xj("answer", "C-1", "confirm");
    assert.equal(await h.worker.once("claude"), true);
    assert.match(h.adapter.requests[0]!.prompt, /验收：- sub\(5, 3\) 返回 2/, "目标卡上的验收标准进了提示词");

    for (let i = 0; i < 4; i++) {
      h.kernel.ingest({ source: "worker", source_id: `hb${i}`, type: "run.heartbeat", at: `2026-11-12T10:0${i}:00.000Z`, about: "T-1", payload: { run_id: "RN-1", task_id: "T-1" } });
    }
    const folded = await h.xj("why", "T-1");
    assert.match(folded, /心跳 4 次（RN-1）/);
    assert.doesNotMatch(folded, /run\.heartbeat/);
    assert.equal((await h.xj("why", "T-1", "--all")).match(/run\.heartbeat/g)!.length, 4, "--all 全部列出");
    assert.match(await h.xj("why", "G-1"), /human\.message\s+“在 math\.mjs 里新增并导出函数 sub\(a, b\)”[\s\S]*judgment\.result\s+J-1 目标卡：math\.mjs 新增并导出 sub/);

    const brief = await h.xj("brief");
    assert.match(brief, /^C-\d+ \[知会\] 简报  简报 \d{4}-\d{2}-\d{2}\n    \*\*需要你\*\*：审核 1 张/);
  } finally { await h.close(); }
});
