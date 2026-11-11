import { test } from "node:test";
import assert from "node:assert/strict";
import { Kernel } from "../src/kernel/kernel.ts";
import { DEFAULTS } from "../src/shared/config.ts";
import { waitingOn } from "../src/kernel/state.ts";

const mk = () => new Kernel(DEFAULTS, ":memory:");
const at = "2026-11-11T12:00:00Z";

test("事件去重：同一来源同一编号只记一次", () => {
  const k = mk();
  const a = k.ingest({ source: "cli", source_id: "1", type: "noop", at, payload: {} });
  const b = k.ingest({ source: "cli", source_id: "1", type: "noop", at, payload: {} });
  assert.equal(a?.seq, 1); assert.equal(b, null);
});

test("一件事走完：立项 → 领活 → 回执 done → 审核卡 → 接受 → 完成", () => {
  const k = mk();
  k.ingest({ source: "cli", source_id: "g", type: "goal.confirmed", at, payload: { title: "结算页支持优惠码" } });
  const t = k.overview().tasks[0]!;
  assert.equal(t.state, "queued"); assert.equal(waitingOn("queued"), "agent");

  const a = k.claim("claude", at, "c"); assert.equal(a?.task.id, t.id);
  assert.equal(a?.run_id, "RN-1", "轮次编号由内核在领活时签发");
  assert.equal(a?.task.state, "running");
  assert.equal(k.claim("claude", at, "c2"), null, "没有第二件可领的活");

  k.ingest({ source: "worker", source_id: "r", type: "run.receipt", at, about: t.id,
    payload: { run_id: "RN-1", task_id: t.id, session_id: "sess-1", receipt: { outcome: "done", summary: "好了", handoff: "见 coupon.ts" } } });
  const cards = k.cards();
  assert.equal(cards.length, 1); assert.equal(cards[0]!.kind, "review");

  // 迟到或重复的回执：任务已不在执行中，只记录，不改状态，不出第二张卡
  k.ingest({ source: "worker", source_id: "r2", type: "run.receipt", at, about: t.id,
    payload: { run_id: "RN-1", task_id: t.id, receipt: { outcome: "done", summary: "好了", handoff: "x" } } });
  assert.equal(k.cards().length, 1);

  k.ingest({ source: "feishu", source_id: "click", type: "card.answered", at, about: cards[0]!.id, payload: { card_id: cards[0]!.id, choice: "accept" } });
  const o = k.overview();
  assert.equal((o.tasks[0] as { state: string }).state, "done");
  assert.equal((o.goals[0] as { status: string }).status, "done");
  assert.equal(k.cards().length, 0);
});

test("要问人就结束这一轮；回答落成定论；任务带会话编号回队列", () => {
  const k = mk();
  k.ingest({ source: "cli", source_id: "g", type: "goal.confirmed", at, payload: { title: "x" } });
  k.ingest({ source: "worker", source_id: "c", type: "run.claimed", at, payload: { task_id: "T-1", agent: "claude", purpose: "execute" } });
  k.ingest({ source: "worker", source_id: "r", type: "run.receipt", at, about: "T-1",
    payload: { run_id: "RN-1", task_id: "T-1", session_id: "s9", receipt: { outcome: "ask", summary: "要定", ask: [{ question: "过期按哪个时区", options: ["服务器", "用户"], recommended: "服务器" }] } } });
  const card = k.cards()[0]!;
  assert.equal(card.kind, "decision"); assert.equal(card.options.find((o) => o.recommended)?.key, "服务器");
  k.ingest({ source: "cli", source_id: "a", type: "card.answered", at, about: card.id, payload: { card_id: card.id, choice: "服务器", scope: "project" } });
  const task = k.db.prepare("SELECT state, session_id FROM tasks WHERE id='T-1'").get() as { state: string; session_id: string };
  assert.equal(task.state, "queued"); assert.equal(task.session_id, "s9");
  assert.equal((k.db.prepare("SELECT COUNT(*) n FROM rulings").get() as { n: number }).n, 1);
});

test("投影可以从事件日志重建", () => {
  const k = mk();
  k.ingest({ source: "cli", source_id: "g", type: "goal.confirmed", at, payload: { title: "x" } });
  k.ingest({ source: "worker", source_id: "c", type: "run.claimed", at, payload: { task_id: "T-1", agent: "claude", purpose: "execute" } });
  const before = JSON.stringify(k.overview());
  assert.equal(k.rebuild(), 2);
  assert.equal(JSON.stringify(k.overview()), before);
});

test("背压：待处理决策卡+审核卡达到上限时不再派活", () => {
  const k = new Kernel({ ...DEFAULTS, limits: { ...DEFAULTS.limits, backpressure_cards: 1 } }, ":memory:");
  k.ingest({ source: "cli", source_id: "g1", type: "goal.confirmed", at, payload: { title: "a" } });
  k.ingest({ source: "cli", source_id: "g2", type: "goal.confirmed", at, payload: { title: "b" } });
  k.ingest({ source: "worker", source_id: "c", type: "run.claimed", at, payload: { task_id: "T-1", agent: "claude", purpose: "execute" } });
  k.ingest({ source: "worker", source_id: "r", type: "run.receipt", at, payload: { run_id: "RN-1", task_id: "T-1", receipt: { outcome: "done", summary: "s", handoff: "h" } } });
  assert.equal(k.claim("claude", at, "c2"), null);
});
