// 跟进的几条确定性规则：waiting 的相对时长、failed 的退避与转受阻、限流、定时器到点。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Kernel } from "../src/kernel/kernel.ts";
import { DEFAULTS } from "../src/shared/config.ts";
import { parseDuration, dueAt } from "../src/shared/duration.ts";
import type { Receipt } from "../src/kernel/types.ts";

const T0 = "2026-11-11T12:00:00.000Z";
const plus = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
let n = 0;

function started() {
  const k = new Kernel(DEFAULTS, ":memory:");
  k.ingest({ source: "cli", source_id: "g", type: "goal.confirmed", at: T0, payload: { title: "x" } });
  return k;
}
function round(k: Kernel, at: string, receipt: Receipt) {
  const c = k.claim("claude", at, `c${n++}`);
  assert.ok(c, "领到活");
  k.ingest({ source: "worker", source_id: `r${n++}`, type: "run.receipt", at, about: c.task.id, payload: { run_id: c.run_id, task_id: c.task.id, receipt } });
  return c;
}
const tick = (k: Kernel, at: string) => k.ingest({ source: "timer", source_id: at, type: "timer.tick", at, payload: {} });
const state = (k: Kernel) => k.task("T-1")!.state;
const timers = (k: Kernel) => (k.db.prepare("SELECT due_at, fired FROM timers ORDER BY id").all() as { due_at: string; fired: number }[]).map((t) => ({ ...t }));

test("相对时长换算：从事件的 at 起算，不读时钟", () => {
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("30m"), 1_800_000);
  assert.equal(parseDuration("1.5h"), 5_400_000);
  assert.equal(parseDuration("PT2H30M"), 9_000_000);
  assert.equal(parseDuration("明天"), null);
  assert.equal(dueAt(T0, "2h", 1), "2026-11-11T14:00:00.000Z");
  assert.equal(dueAt(T0, "2026-11-12T08:00:00Z", 1), "2026-11-12T08:00:00.000Z");
  assert.equal(dueAt(T0, "等 CI", 3_600_000), "2026-11-11T13:00:00.000Z", "认不出的用兜底");
});

test("waiting：later.timeout=2h 换算成 due_at；到点前不动，到点后回队列", () => {
  const k = started();
  round(k, T0, { outcome: "waiting", summary: "等 CI", later: [{ on: "github:acme/shop#318 ci.completed", timeout: "2h", about: "CI 出结果后核对" }] });
  assert.equal(state(k), "awaiting_world");
  assert.deepEqual(timers(k), [{ due_at: "2026-11-11T14:00:00.000Z", fired: 0 }]);
  tick(k, plus(3_600_000));
  assert.equal(state(k), "awaiting_world", "一小时时还没到");
  tick(k, plus(7_200_000));
  assert.equal(state(k), "queued", "两小时到点回队列");
  assert.equal(timers(k)[0]!.fired, 1);
  assert.ok(k.why("T-1").some((e) => e.type === "timer.tick"), "叫醒任务的那次 tick 挂在任务上");
  assert.equal((k.db.prepare("SELECT COUNT(*) n FROM subscriptions").get() as { n: number }).n, 0, "离开等世界后订阅作废");
});

test("failed：第 1、2 次退避 1 分钟、5 分钟后重派；连续第 3 次转受阻并出决策卡", () => {
  const k = started();
  round(k, T0, { outcome: "failed", summary: "网络断了" });
  assert.equal(state(k), "awaiting_world");
  assert.equal(k.claim("claude", T0, "early"), null, "退避期间不派");
  assert.equal(timers(k).at(-1)!.due_at, plus(60_000));
  tick(k, plus(60_000));
  assert.equal(state(k), "queued");

  round(k, plus(60_000), { outcome: "failed", summary: "网络断了" });
  assert.equal(timers(k).at(-1)!.due_at, plus(60_000 + 300_000));
  tick(k, plus(360_000));

  round(k, plus(360_000), { outcome: "failed", summary: "网络断了" });
  assert.equal(state(k), "blocked");
  const card = k.cards().find((c) => c.kind === "decision")!;
  assert.match(card.title, /连续失败 3 次/);

  k.ingest({ source: "cli", source_id: "a", type: "card.answered", at: plus(400_000), payload: { card_id: card.id, choice: "unblocked" } });
  assert.equal(state(k), "queued");
  assert.equal(k.task("T-1")!.failures, 0, "人解除后计数清零");
});

test("一次成功就把连续失败计数清零", () => {
  const k = started();
  round(k, T0, { outcome: "failed", summary: "x" });
  tick(k, plus(60_000));
  round(k, plus(60_000), { outcome: "ask", summary: "要问", ask: [{ question: "q" }] });
  assert.equal(k.task("T-1")!.failures, 0);
});

test("审核退回：意见作为下一轮的反馈，领活时一起返回；回执到了就清空", () => {
  const k = started();
  round(k, T0, { outcome: "done", summary: "好了", handoff: "h" });
  const card = k.cards()[0]!;
  k.ingest({ source: "cli", source_id: "ret", type: "card.answered", at: T0, payload: { card_id: card.id, choice: "return", text: "缺测试" } });
  const c = k.claim("claude", T0, "again")!;
  assert.match(c.feedback!, /审核退回（C-1）：缺测试/);
  assert.equal(c.previous?.handoff, "h", "上一轮回执一起带上");
  k.ingest({ source: "worker", source_id: "r-again", type: "run.receipt", at: T0, payload: { run_id: c.run_id, task_id: "T-1", receipt: { outcome: "nothing", summary: "s" } } });
  assert.equal(k.task("T-1")!.feedback, null);
});

test("限流：任务转等世界，定时器设在额度重置时间", () => {
  const k = started();
  const c = k.claim("claude", T0, "c")!;
  k.ingest({ source: "worker", source_id: "rl", type: "run.rate_limited", at: T0, payload: { run_id: c.run_id, task_id: "T-1", resets_at: 1794524400 } });
  assert.equal(state(k), "awaiting_world");
  assert.equal(timers(k)[0]!.due_at, new Date(1794524400 * 1000).toISOString());
});

test("领活重复投递（同一来源编号）不会派第二轮", () => {
  const k = started();
  assert.ok(k.claim("claude", T0, "same"));
  k.ingest({ source: "worker", source_id: "r", type: "run.receipt", at: T0, payload: { run_id: "RN-1", task_id: "T-1", receipt: { outcome: "failed", summary: "x" } } });
  tick(k, plus(60_000));
  assert.equal(k.claim("claude", plus(60_000), "same"), null);
  assert.equal(state(k), "queued");
});
