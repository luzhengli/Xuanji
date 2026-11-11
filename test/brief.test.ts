// P1-17 每日简报（兼作心跳）、P1-22 知会卡随简报收起、P1-20 xj why 折叠心跳。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Kernel } from "../src/kernel/kernel.ts";
import { briefDue, localDate, ticksFor } from "../src/sources/timer.ts";
import { foldHeartbeats } from "../src/channels/format.ts";
import { DEFAULTS } from "../src/shared/config.ts";
import type { Event, Receipt } from "../src/kernel/types.ts";

const T0 = "2026-11-12T10:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
let n = 0;
const sid = () => `br${n++}`;

function goal(k: Kernel, title: string, t = T0) { k.ingest({ source: "cli", source_id: sid(), type: "goal.confirmed", at: t, payload: { title } }); }
function round(k: Kernel, t: string, receipt: Receipt) {
  const c = k.claim("claude", t, sid())!;
  k.ingest({ source: "worker", source_id: sid(), type: "run.receipt", at: t, payload: { run_id: c.run_id, task_id: c.task.id, receipt } });
}
const brief = (k: Kernel, t: string, date = t.slice(0, 10)) => k.ingest({ source: "timer", source_id: `brief-${date}`, type: "brief.due", at: t, payload: { date } });
const answer = (k: Kernel, card: string, choice: string, t = T0) => k.ingest({ source: "cli", source_id: sid(), type: "card.answered", at: t, payload: { card_id: card, choice } });

test("简报：要你处理的卡片、完成的任务、在做的事、知会、额度；简报推送，汇总过的知会卡收起", () => {
  const k = new Kernel(DEFAULTS, ":memory:");
  goal(k, "加 div");
  round(k, T0, { outcome: "done", summary: "div 好了", handoff: "h", found: [{ title: "没有测试" }] });   // C-1 审核、C-2 知会
  answer(k, "C-1", "accept");
  goal(k, "加 mul");
  round(k, T0, { outcome: "ask", summary: "要问", ask: [{ question: "整数还是小数", options: ["整数", "小数"] }] });   // C-3 决策
  goal(k, "加 pow");
  k.ingest({ source: "worker", source_id: sid(), type: "quota.observed", at: T0, payload: { agent: "claude", seven_day: { utilization: 0.55, resetsAt: 1 } } });

  brief(k, at(3_600_000));
  const cards = k.cards();
  const b = cards.find((c) => c.form === "brief")!;
  assert.deepEqual([b.kind, b.push, b.title, b.about], ["notice", true, "简报 2026-11-12", "简报"]);
  assert.equal(b.body, [
    "**需要你**：决策 1 张（发 /card 取）",
    "· C-3 整数还是小数",
    "**完成** 1 件",
    "· T-1 加 div",
    "**在做**：等 Agent 1 · 等人 1",
    "**知会** 1 条（已收起）",
    "· C-2 发现：没有测试",
    "**额度** claude 周用量 55%",
  ].join("\n"));
  assert.equal(k.card("C-2")!.status, "folded", "汇总过的知会卡收起");
  assert.deepEqual(cards.map((c) => c.id), ["C-3", b.id], "收起后 /card、/status 不再列它");
  assert.ok(k.why("C-2").some((e) => e.type === "brief.due" && e.note === `随简报 ${b.id} 收起`));
});

test("第二天的简报：只列上次简报以来完成的；上一份简报也收起；同一天的到点事件只认一次", () => {
  const k = new Kernel(DEFAULTS, ":memory:");
  goal(k, "加 div");
  round(k, T0, { outcome: "done", summary: "好了", handoff: "h" });
  answer(k, "C-1", "accept");
  brief(k, at(60_000));                                          // C-2：完成 1 件
  brief(k, at(120_000));                                         // 同一天重复：内核去重
  assert.equal(k.cards().filter((c) => c.form === "brief").length, 1);

  const day2 = "2026-11-13T01:00:00.000Z";
  brief(k, day2);
  const open = k.cards();
  assert.deepEqual(open.map((c) => [c.form, c.title]), [["brief", "简报 2026-11-13"]], "上一份简报收起，只剩今天这份");
  assert.equal(open[0]!.body, "**需要你**：没有\n**在做**：没有", "什么事都没有也照发，兼作心跳");
  assert.equal(k.card("C-2")!.status, "folded");
});

test("重建投影：简报和收起状态与原来一致", () => {
  const k = new Kernel(DEFAULTS, ":memory:");
  goal(k, "x");
  round(k, T0, { outcome: "done", summary: "好了", handoff: "h", found: [{ title: "a" }, { title: "b" }] });
  brief(k, at(60_000));
  const snap = () => JSON.stringify(k.db.prepare("SELECT * FROM cards ORDER BY id").all());
  const before = snap();
  k.rebuild();
  assert.equal(snap(), before);
});

test("定时器来源：本机时间过了简报时刻才发，来源编号是当天日期；过点后每次 tick 都带，靠内核去重", () => {
  const before = new Date(2026, 10, 13, 8, 59);
  const onTime = new Date(2026, 10, 13, 9, 0);
  const late = new Date(2026, 10, 13, 23, 30);
  assert.equal(briefDue(before, "09:00"), null);
  const e = briefDue(onTime, "09:00")!;
  assert.deepEqual([e.type, e.source, e.source_id, e.payload], ["brief.due", "timer", "brief-2026-11-13", { date: "2026-11-13" }]);
  assert.equal(briefDue(late, "09:00")!.source_id, "brief-2026-11-13", "睡过了点，醒来补发同一天的");
  assert.equal(briefDue(onTime, "9点"), null, "认不出的时刻不发");
  assert.equal(localDate(new Date(2026, 0, 5)), "2026-01-05");
  // 普通 tick 不受影响
  assert.deepEqual(ticksFor(null, T0, 60_000).map((x) => x.type), ["timer.tick"]);
});

test("xj why 默认视图：连续的心跳折成一行“心跳 N 次”，带注的心跳和其他事件原样保留", () => {
  let seq = 0;
  const ev = (type: string, payload: Record<string, unknown> = {}, note?: string): Event =>
    ({ seq: ++seq, source: "worker", source_id: String(seq), type, at: at(seq * 30_000), payload, ...(note ? { note } : {}) });
  const events = [
    ev("run.claimed", { task_id: "T-1" }),
    ...Array.from({ length: 5 }, () => ev("run.heartbeat", { run_id: "RN-1" })),
    ev("kernel.restarted", {}, "RN-1 执行中，内核重启后等它恢复心跳"),
    ev("run.heartbeat", { run_id: "RN-1" }),
    ev("run.receipt", { run_id: "RN-1" }),
  ];
  const folded = foldHeartbeats(events);
  assert.deepEqual(folded.map((x) => (x.kind === "beats" ? `beats×${x.count} ${x.runs.join()} #${x.first.seq}-#${x.last.seq}` : x.event.type)),
    ["run.claimed", "beats×5 RN-1 #2-#6", "kernel.restarted", "run.heartbeat", "run.receipt"]);
});

test("简报每条（连编号）只留前 40 个字", () => {
  const k = new Kernel(DEFAULTS, ":memory:");
  goal(k, "长".repeat(60));
  round(k, T0, { outcome: "done", summary: "好了", handoff: "h" });
  answer(k, "C-1", "accept");
  brief(k, at(60_000));
  assert.match(k.cards()[0]!.body, new RegExp(`· T-1 ${"长".repeat(36)}…\n`));
});
