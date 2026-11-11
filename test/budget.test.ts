// P1-13 预算：轮数和时长上限由内核强制，超限即停出卡片（追加 / 停掉 / 接管）。时长只算 Agent 在跑的时间。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Kernel } from "../src/kernel/kernel.ts";
import { BUDGET_OPTIONS, HEARTBEAT_TIMEOUT_MS } from "../src/kernel/reducer.ts";
import { overBudget, runLimitMinutes } from "../src/kernel/budget.ts";
import { DEFAULTS } from "../src/shared/config.ts";
import type { Receipt } from "../src/kernel/types.ts";

const T0 = "2026-11-12T10:00:00.000Z";
const MIN = 60_000;
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
let n = 0;
const sid = () => `b${n++}`;

function goal(budget = { runs: 2, minutes: 120 }) {
  const k = new Kernel(DEFAULTS, ":memory:");
  k.ingest({ source: "cli", source_id: sid(), type: "goal.confirmed", at: T0, payload: { title: "x", grant: { budget } } });
  return k;
}
// 一轮：start 领活，end 交回执。
function round(k: Kernel, start: number, end: number, receipt: Receipt) {
  const c = k.claim("claude", at(start), sid())!;
  assert.ok(c, "领到活");
  k.ingest({ source: "worker", source_id: sid(), type: "run.receipt", at: at(end), payload: { run_id: c.run_id, task_id: c.task.id, session_id: "s", receipt } });
  return c;
}
const ask: Receipt = { outcome: "ask", summary: "要问", ask: [{ question: "用哪个", options: ["甲", "乙"] }] };
const answer = (k: Kernel, card: string, choice: string, text?: string) =>
  k.ingest({ source: "cli", source_id: sid(), type: "card.answered", at: T0, payload: { card_id: card, choice, text } });
const tick = (k: Kernel, ms: number) => k.ingest({ source: "timer", source_id: sid(), type: "timer.tick", at: at(ms), payload: {} });

test("时长只算在跑的时间：两轮各 10 分钟，中间等人一天，用掉 20 分钟", () => {
  const k = goal({ runs: 8, minutes: 120 });
  round(k, 0, 10 * MIN, ask);
  answer(k, "C-1", "甲");
  round(k, 24 * 60 * MIN, 24 * 60 * MIN + 10 * MIN, { outcome: "done", summary: "好了", handoff: "h" });
  assert.equal(k.task("T-1")!.minutes_used, 20);
});

test("轮数用完：回答问题后不回队列，转受阻出超预算卡（推送）；回答先记成反馈，追加后带进下一轮", () => {
  const k = goal({ runs: 2, minutes: 120 });
  round(k, 0, MIN, ask);
  answer(k, "C-1", "甲");
  round(k, 2 * MIN, 3 * MIN, { ...ask, ask: [{ question: "再问一个", options: ["丙", "丁"] }] });
  answer(k, "C-2", "丙");
  assert.equal(k.task("T-1")!.state, "blocked");
  const card = k.cards()[0]!;
  assert.deepEqual([card.id, card.kind, card.form, card.push, card.title], ["C-3", "decision", "budget", true, "超出预算：已跑 2 轮（预算 2 轮）"]);
  assert.deepEqual(card.options, BUDGET_OPTIONS);
  assert.deepEqual(card.options.map((o) => [o.label, o.recommended ?? false]), [["追加 4 轮和 1 小时", false], ["停掉", true], ["接管", false]]);
  assert.match(card.body, /最近一轮：要问/);
  assert.equal(k.claim("claude", at(4 * MIN), sid()), null, "超预算的任务不派");

  answer(k, "C-3", "extend", "抓紧");
  const t = k.task("T-1")!;
  assert.deepEqual([t.state, t.contract.budget.runs, t.contract.budget.minutes], ["queued", 6, 180]);
  const c = k.claim("claude", at(5 * MIN), sid())!;
  assert.equal(c.feedback, "人对“再问一个”（C-2）的回答：丙\n人追加预算时说（C-3）：抓紧", "回答没丢，追加的话也带上");
  assert.ok(k.why("T-1").some((e) => /人追加预算到 6 轮、180 分钟/.test(e.note ?? "")));
});

test("时长用完：failed 不再退避重试，直接出超预算卡；停掉 → stopped", () => {
  const k = goal({ runs: 8, minutes: 30 });
  round(k, 0, 31 * MIN, { outcome: "failed", summary: "单轮超时" });
  assert.equal(k.task("T-1")!.state, "blocked");
  assert.equal(k.cards()[0]!.title, "超出预算：已用 31 分钟（预算 30 分钟）");
  assert.equal((k.db.prepare("SELECT COUNT(*) n FROM timers").get() as { n: number }).n, 0, "没有退避定时器");
  answer(k, "C-1", "stop");
  assert.equal(k.task("T-1")!.state, "stopped");
});

test("接管 → stopped；回答记在时间线上", () => {
  const k = goal({ runs: 1, minutes: 120 });
  round(k, 0, MIN, ask);
  answer(k, "C-1", "甲");
  answer(k, "C-2", "takeover");
  assert.equal(k.task("T-1")!.state, "stopped");
  assert.ok(k.why("T-1").some((e) => e.note === "超出预算，人接管"));
});

test("等世界的任务到点回队列前也查预算", () => {
  const k = goal({ runs: 1, minutes: 120 });
  round(k, 0, MIN, { outcome: "waiting", summary: "等 CI", later: [{ timeout: "10m", about: "看 CI" }] });
  tick(k, 12 * MIN);
  assert.equal(k.task("T-1")!.state, "blocked");
  assert.equal(k.cards()[0]!.form, "budget");
});

test("轮次中断时预算已用完：不带恢复说明回队列，出超预算卡；恢复说明留着，追加后带进下一轮", () => {
  const k = goal({ runs: 1, minutes: 120 });
  const c = k.claim("claude", T0, sid())!;
  tick(k, HEARTBEAT_TIMEOUT_MS + 1_000);
  assert.equal(k.run(c.run_id)!.status, "lost");
  assert.equal(k.task("T-1")!.state, "blocked");
  answer(k, "C-1", "extend");
  assert.match(k.claim("claude", at(10 * MIN), sid())!.recovery!, /上一轮 RN-1 没有交回执就中断了/);
});

test("单轮限时取剩下的时长预算：已用 100 分钟、预算 120 分钟，这一轮 20 分钟后判单轮超时", () => {
  const k = goal({ runs: 8, minutes: 120 });
  round(k, 0, 100 * MIN, ask);
  answer(k, "C-1", "甲");
  const c = k.claim("claude", at(200 * MIN), sid())!;
  assert.equal(runLimitMinutes(c.task), 20);
  for (let t = 201; t <= 226; t++) {   // 限时 20 分钟加 5 分钟宽限，第 226 分钟判
    k.ingest({ source: "worker", source_id: sid(), type: "run.heartbeat", at: at(t * MIN), payload: { run_id: c.run_id, task_id: "T-1" } });
    tick(k, t * MIN);
  }
  assert.equal(k.run(c.run_id)!.status, "lost");
  assert.match(k.run(c.run_id)!.lost_reason!, /单轮超时（本轮限时 20 分钟）/);
});

test("叫停、限流也记时长", () => {
  const k = goal({ runs: 8, minutes: 120 });
  const c = k.claim("claude", T0, sid())!;
  k.ingest({ source: "worker", source_id: sid(), type: "run.rate_limited", at: at(7 * MIN), payload: { run_id: c.run_id, task_id: "T-1" } });
  assert.equal(k.task("T-1")!.minutes_used, 7);
  tick(k, 30 * MIN);
  k.claim("claude", at(30 * MIN), sid());
  k.ingest({ source: "cli", source_id: sid(), type: "human.stop", at: at(35 * MIN), payload: { about: "T-1" } });
  assert.equal(k.task("T-1")!.minutes_used, 12);
});

test("overBudget：轮数优先，时长其次；没超返回 null", () => {
  const t = (runs_used: number, minutes_used: number) => ({ runs_used, minutes_used, contract: { budget: { runs: 8, minutes: 120 } } });
  assert.equal(overBudget(t(7, 119.9)), null);
  assert.equal(overBudget(t(8, 200)), "已跑 8 轮（预算 8 轮）");
  assert.equal(overBudget(t(3, 120)), "已用 120 分钟（预算 120 分钟）");
  assert.equal(runLimitMinutes(t(0, 119.5)), 1, "至少给 1 分钟");
});

test("重建投影：超预算卡、追加后的契约、已用时长与原来一致", () => {
  const k = goal({ runs: 1, minutes: 120 });
  round(k, 0, 9 * MIN, ask);
  answer(k, "C-1", "甲");
  answer(k, "C-2", "extend");
  const snap = () => JSON.stringify([k.task("T-1"), k.card("C-2"), k.overview().cards]);
  const before = snap();
  k.rebuild();
  assert.equal(snap(), before);
});
