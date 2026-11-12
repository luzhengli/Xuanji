// P1-10 主理人：一句话 → 判断点 → 目标卡 → 确认 / 修改 / 不做；小而明确的直接立项；不是目标的回一句话。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { Kernel } from "../src/kernel/kernel.ts";
import { startApi } from "../src/kernel/api.ts";
import { JUDGMENT_TIMEOUT_MS, GOAL_OPTIONS } from "../src/kernel/reducer.ts";
import { parseDraft, goalCardBody } from "../src/kernel/intake.ts";
import { DEFAULTS } from "../src/shared/config.ts";
import { Worker } from "../src/worker/worker.ts";
import { kernelClient } from "../src/worker/http-client.ts";
import { buildIntakePrompt } from "../src/worker/context-pack.ts";
import type { AgentAdapter, RunRequest } from "../src/worker/adapters/types.ts";
import type { IntakeInput } from "../src/kernel/types.ts";

const T0 = "2026-11-12T10:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
let n = 0;
const sid = () => `s${n++}`;
const A = { worker: "local", instance: "100-a" };

const DRAFT = { kind: "goal", direct: false, title: "math.mjs 新增 div(a, b)", acceptance: ["div(6, 3) 返回 2", "除以 0 抛错"], boundaries: ["只改 math.mjs"], ask_first: [] };

function said(text = "在 math.mjs 加一个 div", k = new Kernel(DEFAULTS, ":memory:")) {
  k.ingest({ source: "feishu", source_id: sid(), type: "human.message", at: T0, payload: { text } });
  return k;
}
function draft(k: Kernel, output: unknown, t = T0, who = A) {
  const j = k.claimJudgment("claude", t, sid(), who)!;
  assert.ok(j, "领到判断点");
  k.ingest({ source: "worker", source_id: sid(), type: "judgment.result", at: t, about: j.about, payload: { judgment_id: j.id, output } });
  return j;
}
const answer = (k: Kernel, card: string, choice?: string, text?: string) =>
  k.ingest({ source: "feishu", source_id: sid(), type: "card.answered", at: T0, about: card, payload: { card_id: card, choice, text } });

test("一句话：先记一个待确认的目标，排一个主理人判断点；不立任务、不能领活", () => {
  const k = said();
  assert.deepEqual(k.goal("G-1")!.status, "proposed");
  assert.equal(k.overview().tasks.length, 0);
  assert.equal(k.claim("claude", T0, sid()), null, "确认之前没有活可领");
  const j = k.claimJudgment("claude", T0, sid(), A)!;
  assert.deepEqual([j.id, j.kind, j.about, j.status, (j.input as IntakeInput).request, j.worker], ["J-1", "intake", "G-1", "running", "在 math.mjs 加一个 div", "local"]);
  assert.equal(k.claimJudgment("claude", T0, sid(), A), null, "同一个判断点不会被领两次");
});

test("目标卡：主理人的草稿写进目标，出一张要推送的目标卡；确认后才立项，验收标准进任务契约", () => {
  const k = said();
  draft(k, DRAFT);
  const g = k.goal("G-1")!;
  assert.deepEqual([g.status, g.title, g.acceptance, g.boundaries], ["proposed", DRAFT.title, DRAFT.acceptance, DRAFT.boundaries]);
  const [card] = k.cards();
  assert.deepEqual([card!.id, card!.kind, card!.form, card!.about, card!.push], ["C-1", "decision", "goal", "G-1", true]);
  assert.equal(card!.title, "目标卡：math.mjs 新增 div(a, b)");
  assert.deepEqual(card!.options, GOAL_OPTIONS);
  assert.equal(card!.body, goalCardBody(g));
  assert.match(card!.body, /\*\*授权\*\* L1 做到可审核为止，可推分支、开 PR · 预算 8 轮或 2 小时 · 先问：不可逆或授权外的对外动作/);

  answer(k, "C-1", "confirm");
  assert.equal(k.goal("G-1")!.status, "active");
  const t = k.task("T-1")!;
  assert.deepEqual([t.state, t.contract.objective, t.contract.acceptance.criteria], ["queued", DRAFT.title, DRAFT.acceptance]);
  assert.equal((k.db.prepare("SELECT COUNT(*) n FROM rulings").get() as { n: number }).n, 0, "目标卡的回答不落成定论");
  const why = k.why("G-1");
  assert.deepEqual(why.map((e) => e.type), ["human.message", "judgment.claimed", "judgment.result", "card.answered"], "xj why G-1 从原话一路查到确认");
  assert.match(why.at(-1)!.note ?? "", /人确认目标卡，立项 T-1/);
  assert.ok(k.why("T-1").some((e) => e.type === "card.answered"), "立任务的那次确认挂在任务上");
});

test("确认时写在输入框里的话不丢：作为补充带进第一轮（实测 G-10 的说明被丢了）", () => {
  const k = said();
  draft(k, DRAFT);
  answer(k, "C-1", "confirm", "验收再加一条：cube(-2) 返回 -8");
  assert.equal(k.task("T-1")!.feedback, "人确认目标卡时补充：验收再加一条：cube(-2) 返回 -8");
  assert.match(k.why("G-1").at(-1)!.note ?? "", /立项 T-1，带着补充/);
});

test("修改：带着上一版和修改意见再排一次主理人；新目标卡替换旧的；改过的版本不再直接立项", () => {
  const k = said();
  draft(k, DRAFT);
  answer(k, "C-1", "revise", "再加一条：小数也要对");
  assert.equal(k.goal("G-1")!.status, "proposed");
  const j = k.claimJudgment("claude", T0, sid(), A)!;
  assert.equal(j.id, "J-2");
  assert.deepEqual([(j.input as IntakeInput).revision, (j.input as IntakeInput).request, (j.input as IntakeInput).feedback, (j.input as IntakeInput).draft?.title], [1, "在 math.mjs 加一个 div", "再加一条：小数也要对", DRAFT.title]);
  const prompt = buildIntakePrompt((j.input as IntakeInput));
  assert.match(prompt, /## 上一版目标卡\n\{"kind":"goal"/);
  assert.match(prompt, /## 人的修改意见（照这个改上一版）\n再加一条：小数也要对/);
  k.ingest({ source: "worker", source_id: sid(), type: "judgment.result", at: T0, payload: { judgment_id: j.id,
    output: { ...DRAFT, direct: true, acceptance: [...DRAFT.acceptance, "div(1, 4) 返回 0.25"] } } });
  assert.equal(k.goal("G-1")!.status, "proposed", "改过的版本即使说 direct 也要人确认");
  const cards = k.cards();
  assert.deepEqual(cards.map((c) => c.id), ["C-2"]);
  assert.match(cards[0]!.body, /div\(1, 4\) 返回 0\.25/);
  answer(k, "C-2", "confirm");
  assert.equal(k.task("T-1")!.contract.acceptance.criteria.length, 3);
});

test("不做：目标放弃，不立任务", () => {
  const k = said();
  draft(k, DRAFT);
  answer(k, "C-1", "drop");
  assert.equal(k.goal("G-1")!.status, "abandoned");
  assert.equal(k.overview().tasks.length, 0);
});

test("小而明确：直接立项，出一张要推送的答复（知会卡）；改了预算的不能直接立项", () => {
  const k = said();
  draft(k, { ...DRAFT, direct: true });
  assert.equal(k.goal("G-1")!.status, "active");
  assert.equal(k.task("T-1")!.state, "queued");
  const [c] = k.cards();
  assert.deepEqual([c!.kind, c!.form, c!.push, c!.title], ["notice", "reply", true, "已立项 G-1 · T-1：math.mjs 新增 div(a, b)"]);
  assert.match(c!.body, /小而明确，没等你确认就开工了。做完会出审核卡；不想做发 \/stop T-1。/);

  const k2 = said("用 4 轮做完 div");
  draft(k2, { ...DRAFT, direct: true, budget: { runs: 4, minutes: 60 } });
  assert.equal(k2.goal("G-1")!.status, "proposed", "改了默认预算要人确认");
  assert.match(k2.cards()[0]!.body, /预算 4 轮或 1 小时/);
  answer(k2, "C-1", "confirm");
  assert.deepEqual(k2.task("T-1")!.contract.budget, { runs: 4, minutes: 60 });
});

test("不是目标：回一句话，目标放弃", () => {
  const k = said("你好");
  draft(k, { kind: "not_goal", reply: "你好，有要做的事直接说。" });
  assert.equal(k.goal("G-1")!.status, "abandoned");
  const [c] = k.cards();
  assert.deepEqual([c!.kind, c!.form, c!.push, c!.title], ["notice", "reply", true, "主理人：你好，有要做的事直接说。"]);
});

test("主理人的输出不合格式：重新排队；连续第 3 次就按原话出目标卡，人仍可确认", () => {
  const k = said("在 math.mjs 加一个 div");
  for (let i = 0; i < 2; i++) {
    const j = k.claimJudgment("claude", T0, sid(), A)!;
    k.ingest({ source: "worker", source_id: sid(), type: "judgment.result", at: T0, payload: { judgment_id: j.id, error: "没有找到 JSON 对象" } });
    assert.equal(k.judgment("J-1")!.status, "queued");
    assert.equal(k.cards().length, 0);
  }
  // 内核也不信任接单程序的校验：输出缺字段同样算失败
  const j = k.claimJudgment("claude", T0, sid(), A)!;
  k.ingest({ source: "worker", source_id: sid(), type: "judgment.result", at: T0, payload: { judgment_id: j.id, output: { kind: "goal", title: "x" } } });
  assert.equal(k.judgment("J-1")!.status, "failed");
  const [c] = k.cards();
  assert.equal(c!.form, "goal");
  assert.equal(c!.title, "目标卡：在 math.mjs 加一个 div");
  assert.match(c!.body, /^主理人连续 3 次没整理出来（acceptance 至少一条），下面按原话列出。/);
  answer(k, c!.id, "confirm");
  assert.equal(k.task("T-1")!.contract.objective, "在 math.mjs 加一个 div");
});

test("判断点超时（看门狗）或接单程序重启：重新排队，迟到的结果只记录", () => {
  const k = said();
  const j = k.claimJudgment("claude", T0, sid(), A)!;
  k.ingest({ source: "timer", source_id: sid(), type: "timer.tick", at: at(JUDGMENT_TIMEOUT_MS), payload: {} });
  assert.equal(k.judgment(j.id)!.status, "running", "5 分钟整还不算");
  k.ingest({ source: "timer", source_id: sid(), type: "timer.tick", at: at(JUDGMENT_TIMEOUT_MS + 1_000), payload: {} });
  assert.deepEqual([k.judgment(j.id)!.status, k.judgment(j.id)!.error], ["queued", "判断点超时"]);
  // 超时之后才到的结果：判断点已经重新排队，不出卡片
  k.ingest({ source: "worker", source_id: sid(), type: "judgment.result", at: at(400_000), payload: { judgment_id: j.id, output: DRAFT } });
  assert.equal(k.cards().length, 0);

  k.claimJudgment("claude", at(400_000), sid(), A);
  k.ingest({ source: "worker", source_id: sid(), type: "worker.started", at: at(410_000), payload: { worker: "local", instance: "200-b" } });
  assert.deepEqual([k.judgment(j.id)!.status, k.judgment(j.id)!.error], ["queued", "接单程序重启"]);
});

test("重建投影：目标、判断点、目标卡和立项与原来一致", () => {
  const k = said();
  draft(k, DRAFT);
  answer(k, "C-1", "revise", "改短一点");
  draft(k, { ...DRAFT, title: "div" });
  answer(k, "C-2", "confirm");
  const snap = () => JSON.stringify([k.overview(), k.judgment("J-1"), k.judgment("J-2"), k.card("C-1"), k.card("C-2")]);
  const before = snap();
  k.rebuild();
  assert.equal(snap(), before);
});

test("草稿解析：围栏里的 JSON 也认；缺字段报错；预算只认合理范围；超长截断", () => {
  const ok = parseDraft("整理好了：\n```json\n" + JSON.stringify(DRAFT) + "\n```");
  assert.ok(ok.ok && ok.draft.title === DRAFT.title);
  assert.deepEqual(parseDraft('{"kind":"goal","title":"x","acceptance":[]}'), { ok: false, error: "acceptance 至少一条" });
  assert.deepEqual(parseDraft('{"kind":"任务"}'), { ok: false, error: 'kind 必须是 "goal"、"not_goal" 或 "amend"' });
  assert.deepEqual(parseDraft("好的"), { ok: false, error: "没有找到 JSON 对象" });
  const wild = parseDraft(JSON.stringify({ ...DRAFT, budget: { runs: 999, minutes: 60 }, level: "L3", acceptance: ["a", "b", "c", "d", "e"], title: "长".repeat(100) }));
  assert.ok(wild.ok);
  assert.equal(wild.draft.budget, undefined, "离谱的预算不认");
  assert.equal(wild.draft.acceptance.length, 4);
  assert.equal(wild.draft.title.length, 60);
  assert.equal((wild.draft as unknown as { level?: string }).level, undefined, "自主级别不由主理人定");
});

// ---- 接单程序层：真的本机接口，假的 Claude Code ----

async function api() {
  const kernel = new Kernel(DEFAULTS, ":memory:");
  const server = startApi(kernel, 0);
  await once(server, "listening");
  const client = kernelClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "worker", { worker: A });
  return { kernel, client, close: () => new Promise<void>((r) => { server.close(() => r()); kernel.close(); }) };
}

test("接单程序领判断点：不给工具、不接会话；格式错了在同一会话里重写一次；结果交回内核出目标卡", async () => {
  const h = await api();
  try {
    await h.client.emit("human.message", { text: "在 math.mjs 加一个 div" });
    const seen: RunRequest[] = [];
    const replies = ["好的，我整理一下。", JSON.stringify(DRAFT)];
    const fake: AgentAdapter = { name: "claude", run: async (req) => {
      seen.push(req);
      return { last_message: replies.shift()!, session_id: "s-j", exit_code: 0, usage: {}, rate_limited: false, stderr: "" };
    } };
    const w = new Worker(h.client, { claude: fake }, tmpdir(), { profiles: { claude: { model: "claude-haiku-5-5" } }, log: () => {} });
    assert.equal(await w.judgeOnce("claude"), true);
    assert.equal(await w.judgeOnce("claude"), false, "没有第二个");
    assert.deepEqual(seen.map((r) => [r.label, r.tools, r.session_id, r.model]), [["J-1", [], undefined, "claude-haiku-5-5"], ["J-1-rewrite", [], "s-j", "claude-haiku-5-5"]]);
    assert.match(seen[0]!.prompt, /## 人的原话\n在 math\.mjs 加一个 div/);
    assert.equal(h.kernel.judgment("J-1")!.status, "finished");
    assert.equal(h.kernel.cards()[0]!.form, "goal");
  } finally { await h.close(); }
});

test("接单程序领判断点：适配器起不来时交错误，判断点重新排队", async () => {
  const h = await api();
  try {
    await h.client.emit("human.message", { text: "x" });
    const broken: AgentAdapter = { name: "claude", run: async () => { throw new Error("spawn claude ENOENT"); } };
    await new Worker(h.client, { claude: broken }, tmpdir(), { log: () => {} }).judgeOnce("claude");
    assert.deepEqual([h.kernel.judgment("J-1")!.status, h.kernel.judgment("J-1")!.error], ["queued", "接单程序出错：spawn claude ENOENT"]);
  } finally { await h.close(); }
});

test("判断点不占执行的并发名额：执行在跑时照样能领判断点", async () => {
  const k = new Kernel({ ...DEFAULTS, agents: { claude: { ...DEFAULTS.agents.claude!, capacity: 1 } } }, ":memory:");
  k.ingest({ source: "cli", source_id: sid(), type: "goal.confirmed", at: T0, payload: { title: "长活" } });
  assert.ok(k.claim("claude", T0, sid()));
  said("再加一个 mul", k);
  assert.ok(k.claimJudgment("claude", T0, sid()), "执行占满了名额，判断点照样领");
});

test("提醒：上卡片、不进契约；带提醒的不直接立项；ask_first 进授权行", () => {
  const k = said("在 math.mjs 加 mul");
  draft(k, { ...DRAFT, direct: true, ask_first: ["删除已有函数"], notes: ["git log 里 9527f52 已经加过 mul", "math.mjs 有未提交的改动"] });
  assert.equal(k.goal("G-1")!.status, "proposed", "有提醒就请人确认");
  const body = k.cards()[0]!.body;
  assert.match(body, /^\*\*提醒\*\*\n- git log 里 9527f52 已经加过 mul\n- math\.mjs 有未提交的改动\n\n\*\*验收\*\*/);
  assert.match(body, /先问：删除已有函数$/);
  answer(k, "C-1", "confirm");
  assert.doesNotMatch(JSON.stringify(k.task("T-1")!.contract), /9527f52/);
  assert.deepEqual(k.task("T-1")!.contract.ask_first, ["删除已有函数"]);
});

// 2026-11-12 真实录下的主理人一轮（claude-haiku-5-5，不给工具，6 秒）：Claude Code 即使不给工具，也把工作目录的
// git 状态放进系统提示词，所以主理人看得到“mul 已经加过”“有未提交改动”，写成了提醒。
test("真实录制：主理人不给工具也看得到 git 状态；输出的草稿能解析，提醒上卡片", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseStream } = await import("../src/worker/adapters/claude-code.ts");
  const out = parseStream(readFileSync(new URL("./fixtures/real-intake-mul.ndjson", import.meta.url), "utf8"));
  assert.match(out.last_message, /^\{"kind":"goal"/);
  const d = parseDraft(out.last_message);
  assert.ok(d.ok);
  assert.equal(d.draft.direct, false);
  assert.equal(d.draft.notes?.length, 2);
  assert.match(d.draft.notes![0]!, /9527f52/);
  assert.deepEqual(d.draft.ask_first, ["覆盖或改写已有的 mul 实现"]);
  assert.equal(out.rate_limit?.seven_day?.utilization, 0.58);
});

// ---- P1-23 补充：主理人判断一句话是对在途目标的补充 ----

test("补充等确认的目标：这句话的目标作废并入，旧目标卡撤回，带着补充重整一张；推一条“已并入”", () => {
  const k = said("在 math.mjs 加 pow");
  draft(k, DRAFT);                                             // G-1 的目标卡 C-1
  k.ingest({ source: "feishu", source_id: sid(), type: "human.message", at: T0, payload: { text: "pow 也要支持小数指数" } });
  const j = k.claimJudgment("claude", T0, sid(), A)!;
  assert.deepEqual((j.input as IntakeInput).pending, [{ goal: "G-1", title: DRAFT.title, status: "proposed" }]);
  assert.match(buildIntakePrompt((j.input as IntakeInput)), /## 在途的目标（人之前说过、还没结束的）\n- G-1（目标卡等人确认）：math\.mjs 新增 div\(a, b\)/);
  k.ingest({ source: "worker", source_id: sid(), type: "judgment.result", at: T0, payload: { judgment_id: j.id, output: { kind: "amend", target: "G-1" } } });
  assert.equal(k.goal("G-2")!.status, "abandoned");
  assert.equal(k.card("C-1")!.status, "withdrawn");
  const re = k.claimJudgment("claude", T0, sid(), A)!;
  assert.deepEqual([re.about, re.input.revision, re.input.feedback], ["G-1", 1, "人补充：pow 也要支持小数指数"]);
  const reply = k.cards().find((c) => c.form === "reply")!;
  assert.deepEqual([reply.title, reply.push], ["已并入 G-1：pow 也要支持小数指数", true]);
});

test("补充正在跑的任务：回执到时有新补充，不出审核卡，带着补充立即开下一轮；这一轮领走的反馈清掉，新补充留下", () => {
  const k = new Kernel(DEFAULTS, ":memory:");
  k.ingest({ source: "cli", source_id: sid(), type: "goal.confirmed", at: T0, payload: { title: "加 pow" } });
  const c1 = k.claim("claude", T0, sid())!;
  k.ingest({ source: "worker", source_id: sid(), type: "run.receipt", at: T0, payload: { run_id: c1.run_id, task_id: "T-1", receipt: { outcome: "done", summary: "好了", handoff: "h" } } });
  k.ingest({ source: "cli", source_id: sid(), type: "card.answered", at: T0, payload: { card_id: "C-1", choice: "return", text: "负数要报错" } });
  const c2 = k.claim("claude", T0, sid())!;
  assert.match(c2.feedback!, /负数要报错/);
  said("pow 再加一条：0 的 0 次方返回 1", k);                 // G-2，跑的过程中说的
  const j = k.claimJudgment("claude", T0, sid(), A)!;
  assert.deepEqual((j.input as IntakeInput).pending, [{ goal: "G-1", title: "加 pow", status: "active", task: "T-1" }]);
  k.ingest({ source: "worker", source_id: sid(), type: "judgment.result", at: T0, payload: { judgment_id: j.id, output: { kind: "amend", target: "G-1" } } });
  assert.match(k.cards().find((c) => c.form === "reply")!.body, /T-1 这一轮跑完后带着它开下一轮/);
  k.ingest({ source: "worker", source_id: sid(), type: "run.receipt", at: T0, payload: { run_id: c2.run_id, task_id: "T-1", receipt: { outcome: "done", summary: "改好了", handoff: "h" } } });
  assert.equal(k.task("T-1")!.state, "queued", "不出审核卡，回队列");
  assert.equal(k.cards().filter((c) => c.kind === "review").length, 0);
  const c3 = k.claim("claude", T0, sid())!;
  assert.equal(c3.feedback, "人的补充（G-2）：pow 再加一条：0 的 0 次方返回 1", "上一轮领走的“负数要报错”已清掉");
});

test("补充等世界的任务：不再等，带着补充回队列；补错了目标（不在在途列表里）算判断点失败", () => {
  const k = new Kernel(DEFAULTS, ":memory:");
  k.ingest({ source: "cli", source_id: sid(), type: "goal.confirmed", at: T0, payload: { title: "等 CI" } });
  const c = k.claim("claude", T0, sid())!;
  k.ingest({ source: "worker", source_id: sid(), type: "run.receipt", at: T0, payload: { run_id: c.run_id, task_id: "T-1", receipt: { outcome: "waiting", summary: "等", later: [{ timeout: "2h", about: "CI" }] } } });
  said("CI 不用等了，直接合", k);
  draft(k, { kind: "amend", target: "G-1" });
  assert.equal(k.task("T-1")!.state, "queued");
  said("再改改", k);
  const j = draft(k, { kind: "amend", target: "G-9" });
  assert.deepEqual([k.judgment(j.id)!.status, k.judgment(j.id)!.error], ["queued", "补充指向的 G-9 不在在途目标里"]);
});

test("补充等人审核的任务：主理人看得到它；并入时撤回审核卡，当作带着补充退回，再做一轮（实测 G-11 本是对审核中 G-10 的补充）", () => {
  const k = new Kernel(DEFAULTS, ":memory:");
  k.ingest({ source: "cli", source_id: sid(), type: "goal.confirmed", at: T0, payload: { title: "加 cube" } });
  const c = k.claim("claude", T0, sid())!;
  k.ingest({ source: "worker", source_id: sid(), type: "run.receipt", at: T0, payload: { run_id: c.run_id, task_id: "T-1", receipt: { outcome: "done", summary: "好了", handoff: "h" } } });
  assert.equal(k.task("T-1")!.state, "awaiting_review");
  said("补充：再加一个解释 cube 的 print 函数", k);
  const j = k.claimJudgment("claude", T0, sid(), A)!;
  assert.deepEqual((j.input as IntakeInput).pending, [{ goal: "G-1", title: "加 cube", status: "active", task: "T-1", reviewing: true }]);
  assert.match(buildIntakePrompt((j.input as IntakeInput)), /- G-1（做完了等人审核，任务 T-1）：加 cube/);
  k.ingest({ source: "worker", source_id: sid(), type: "judgment.result", at: T0, payload: { judgment_id: j.id, output: { kind: "amend", target: "G-1" } } });
  assert.equal(k.card("C-1")!.status, "withdrawn");
  assert.equal(k.task("T-1")!.state, "queued");
  assert.equal(k.task("T-1")!.feedback, "人的补充（G-2）：补充：再加一个解释 cube 的 print 函数");
  assert.match(k.cards().find((x) => x.form === "reply")!.body, /撤回了 T-1 的审核卡，带着补充再做一轮/);
});

test("任务结束（叫停）时，它还开着的待办卡片撤回，知会卡留着（实测 /stop T-10 后 C-30 还在）", () => {
  const k = new Kernel(DEFAULTS, ":memory:");
  k.ingest({ source: "cli", source_id: sid(), type: "goal.confirmed", at: T0, payload: { title: "x" } });
  const c = k.claim("claude", T0, sid())!;
  k.ingest({ source: "worker", source_id: sid(), type: "run.receipt", at: T0, payload: { run_id: c.run_id, task_id: "T-1",
    receipt: { outcome: "ask", summary: "问", ask: [{ question: "哪个？", options: ["a", "b"] }], found: [{ title: "顺便发现" }] } } });
  k.ingest({ source: "cli", source_id: sid(), type: "human.stop", at: T0, payload: { about: "T-1" } });
  assert.deepEqual(k.cards().map((x) => [x.kind, x.title]), [["notice", "发现：顺便发现"]]);
  assert.equal(k.card("C-1")!.status, "withdrawn");
});

test("主理人还在整理时人又补充：先到的整理结果过时了，不出卡片，只出按补充重整的那张", () => {
  const k = said("加 pow");
  const first = k.claimJudgment("claude", T0, sid(), A)!;       // J-1 在跑
  said("pow 要支持负指数", k);                                   // G-2 → J-2
  draft(k, { kind: "amend", target: "G-1" });                    // J-2 判为补充，排 J-3
  k.ingest({ source: "worker", source_id: sid(), type: "judgment.result", at: T0, payload: { judgment_id: first.id, output: DRAFT } });
  assert.equal(k.cards().filter((c) => c.form === "goal").length, 0, "J-1 的结果被取代");
  draft(k, { ...DRAFT, title: "pow 支持负指数" });               // J-3
  assert.deepEqual(k.cards().filter((c) => c.form === "goal").map((c) => c.title), ["目标卡：pow 支持负指数"]);
});
