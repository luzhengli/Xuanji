// 二期第三批：定论与拆分。定论簿（P2-07）、规划与任务图（P2-08）、合并任务（P2-09）、目标验收（P2-10）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "../src/kernel/kernel.ts";
import { DEFAULTS, type Config } from "../src/shared/config.ts";
import { normalizePlan, parsePlan, PLAN_OPTIONS } from "../src/kernel/plan.ts";
import { normalizeDraft, goalCardBody } from "../src/kernel/intake.ts";
import { RULING_OPTIONS, PLAN_TIMEOUT_MS, rulingsFor } from "../src/kernel/reducer.ts";
import { buildPrompt, buildVerifyPrompt, buildPlanPrompt, buildIntakePrompt } from "../src/worker/context-pack.ts";
import { Worker, type KernelClient } from "../src/worker/worker.ts";
import { showStatus, type Overview } from "../src/channels/format.ts";
import { execReal, type Exec } from "../src/worker/effects.ts";
import type { AgentAdapter, RunRequest, RunResult } from "../src/worker/adapters/types.ts";
import type { Card, EventInput, PlanInput } from "../src/kernel/types.ts";

const T0 = "2026-11-13T08:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
let n = 0;
const sid = () => `s${n++}`;
const CLAUDE = { use: "claude" as const, kinds: ["code" as const, "write" as const, "judge" as const], tier: "strong" as const, billing: "subscription" as const, capacity: 2 };
const PLANNER = { use: "claude" as const, kinds: ["plan" as const], tier: "strong" as const, billing: "subscription" as const, capacity: 1, model: "claude-opus-5-5" };
const CODEX = { use: "codex" as const, kinds: ["review" as const], tier: "strong" as const, billing: "subscription" as const, capacity: 1 };
const cfg = (agents: Config["agents"] = { claude: CLAUDE, planner: PLANNER, codex: CODEX }, limits: Partial<Config["limits"]> = {}): Config =>
  ({ ...DEFAULTS, limits: { ...DEFAULTS.limits, ...limits }, agents });
const ev = (k: Kernel, type: string, payload: Record<string, unknown>, source: EventInput["source"] = "cli", t = T0) =>
  k.ingest({ source, source_id: sid(), type, at: t, payload });
const receipt = (k: Kernel, run: string, task: string, outcome: string, extra: Record<string, unknown> = {}) =>
  ev(k, "run.receipt", { run_id: run, task_id: task, receipt: { outcome, summary: `${task} ${outcome}`, handoff: `${task} 交接`, ...extra } }, "worker");
const pass = (k: Kernel, run: string, task: string, risks = [`${task} 没测负数`]) =>
  ev(k, "run.verdict", { run_id: run, task_id: task, reviewer: "codex", verdict: { verdict: "pass", summary: "满足验收", issues: [], risks } }, "worker");
const answer = (k: Kernel, card: string, choice?: string, extra: Record<string, unknown> = {}) => ev(k, "card.answered", { card_id: card, ...(choice ? { choice } : {}), ...extra }, "feishu");
const cardOf = (k: Kernel, pred: (c: Card) => boolean) => k.cards().find(pred);
const states = (k: Kernel) => Object.fromEntries(k.overview().tasks.map((t) => [t.id, t.state]));
// 飞书的 markdown：列表项后面紧跟的非列表文字会接到最后一项末尾，所以列表后面要空一行。
function assertFeishuLists(body: string) {
  const lines = body.split("\n");
  lines.forEach((l, i) => {
    const next = lines[i + 1];
    if (l.startsWith("- ") && next !== undefined && next !== "" && !next.startsWith("- ")) assert.fail(`列表后没空行：${JSON.stringify(l)} → ${JSON.stringify(next)}`);
  });
}

const PLAN = {
  split: true, why: "接口和页面互不相干",
  tasks: [
    { key: "a", objective: "math.mjs 加 half", criteria: ["half(3) 返回 1.5"], write: ["math.mjs"], checks: ["node --check math.mjs"], depends_on: [] },
    { key: "b", objective: "README 写用法", criteria: ["README 有 half 的用法"], write: ["README.md"], checks: [], depends_on: [] },
  ],
};
const LIMITS = { max_tasks: 4, checks: ["node --check math.mjs", "npm test"] };

// 立一个要拆的目标并让规划交计划，返回计划卡。
function planned(k: Kernel, plan: unknown = PLAN) {
  ev(k, "goal.confirmed", { title: "half 和文档", acceptance: ["half(3) 返回 1.5", "README 有用法"], checks: ["node --check math.mjs", "npm test"], split: true });
  const j = k.claimJudgment("planner", T0, sid())!;
  ev(k, "judgment.result", { judgment_id: j.id, output: plan }, "worker");
  return { j, card: cardOf(k, (c) => c.form === "plan") };
}

// ---- P2-08 规划：校验 ----

test("P2-08：计划的校验——可写范围不能重叠、不能太宽，依赖要在计划里且不成环，检查命令只能从已批准的里挑，最多 4 个", () => {
  assert.equal(normalizePlan(PLAN, LIMITS).ok, true);
  const bad = (tasks: unknown[], why: RegExp, limits = LIMITS) => {
    const r = normalizePlan({ split: true, why: "x", tasks }, limits);
    assert.ok(!r.ok && why.test(r.error), r.ok ? "应当不合格" : r.error);
  };
  const t = (key: string, write: string[], extra: Record<string, unknown> = {}) => ({ key, objective: `做 ${key}`, criteria: [`${key} 好了`], write, ...extra });
  bad([t("a", ["src/**"]), t("b", ["src/api/x.ts"])], /a 和 b 的可写范围重叠（src\/\*\* 和 src\/api\/x\.ts）/);
  bad([t("a", ["**"]), t("b", ["docs/**"])], /太宽/);
  bad([t("a", ["/etc/x"]), t("b", ["docs/**"])], /相对路径/);
  bad([t("a", ["a/**"], { depends_on: ["c"] }), t("b", ["b/**"])], /依赖的 c 不在计划里/);
  bad([t("a", ["a/**"], { depends_on: ["b"] }), t("b", ["b/**"], { depends_on: ["a"] })], /成环/);
  bad([t("a", ["a/**"], { checks: ["rm -rf /"] }), t("b", ["b/**"])], /不在目标已批准的检查命令里/);
  bad([t("a", ["a/**"])], /至少 2 个/);
  bad(["a", "b", "c", "d", "e"].map((k) => t(k, [`${k}/**`])), /最多拆 4 个/);
  bad([{ key: "a", objective: "x", write: ["a/**"] }, t("b", ["b/**"])], /a 至少要有一条自己的验收标准/);
  const no = normalizePlan({ split: false, why: "都在一个文件里" }, LIMITS);
  assert.deepEqual(no, { ok: true, plan: { split: false, why: "都在一个文件里", tasks: [] } });
  assert.equal(normalizePlan({ split: false }, LIMITS).ok, false, "不拆也要说为什么");
  // 接单程序从最后一条消息里取（可以包在围栏里）。
  assert.equal(parsePlan("好的：\n```json\n" + JSON.stringify(PLAN) + "\n```", LIMITS).ok, true);
});

// ---- P2-08 主理人标“可能要拆” ----

test("P2-08：主理人标了可能要拆——不直接立项，目标卡写明；确认后先排规划，不建任务", () => {
  const d = normalizeDraft({ kind: "goal", direct: true, title: "加接口和页面", acceptance: ["都能用"], split: true });
  assert.ok(d.ok && d.draft.split === true && d.draft.direct === false, "要拆的不算小而明确");
  const body = goalCardBody({ acceptance: ["都能用"], boundaries: [], grant: { level: "L1", effects: [], budget: { runs: 8, minutes: 120 }, ask_first: [] }, split: true });
  assert.match(body, /\*\*可能要拆\*\* 确认后先由规划切成几个/);
  assertFeishuLists(body);
  assert.match(buildIntakePrompt({ request: "x", revision: 0 }), /- split：这件事明显由两块以上互不相干的部分组成/);

  const k = new Kernel(cfg(), ":memory:");
  ev(k, "human.message", { text: "加接口和页面" }, "feishu");
  const j = k.claimJudgment("claude", T0, sid())!;
  ev(k, "judgment.result", { judgment_id: j.id, output: { kind: "goal", direct: true, title: "加接口和页面", acceptance: ["都能用"], split: true } }, "worker");
  const goalCard = cardOf(k, (c) => c.form === "goal")!;
  assert.match(goalCard.body, /可能要拆/);
  answer(k, goalCard.id, "confirm", { text: "页面用中文" });
  assert.equal(k.overview().tasks.length, 0, "先规划，不建任务");
  assert.equal(k.goal("G-1")!.status, "active");
  assert.equal(k.claimJudgment("claude", T0, sid()), null, "规划只给 kinds 有 plan 的档案");
  const p = k.claimJudgment("planner", T0, sid())!;
  assert.equal(p.kind, "plan");
  assert.equal(p.max_tasks, 4, "拆分上限随领判断点给");
  const input = p.input as PlanInput;
  assert.deepEqual([input.goal.id, input.goal.title, input.revision, input.note], ["G-1", "加接口和页面", 0, "人确认目标卡时补充：页面用中文"]);
});

// ---- P2-08 规划结果 → 计划卡 → 任务图 ----

test("P2-08：拆分计划出决策卡（按计划拆 / 不拆 / 修改），列出各任务的验收、可写范围、依赖；上限在落账时写进事件", () => {
  const k = new Kernel(cfg(), ":memory:");
  const { j, card } = planned(k);
  assert.ok(card, "出了计划卡");
  assert.equal(card.kind, "decision");
  assert.equal(card.push, true, "决策卡推送");
  assert.deepEqual(card.options, PLAN_OPTIONS);
  assert.equal(card.title, "拆分计划：half 和文档");
  assert.match(card.body, /\*\*为什么拆\*\* 接口和页面互不相干/);
  assert.match(card.body, /\*\*a\*\* math\.mjs 加 half\n- 验收：half\(3\) 返回 1\.5\n- 可写：math\.mjs\n- 依赖：无，立即开工\n- 检查命令：`node --check math\.mjs`/);
  assert.match(card.body, /\*\*合并\*\* 各部分验证通过后.*按目标的验收标准整体验收（检查命令 `node --check math\.mjs`、`npm test`）/);
  assertFeishuLists(card.body);
  assert.equal(k.why(j.id).find((e) => e.type === "judgment.result")!.payload.max_tasks, 4);
  assert.equal(k.overview().tasks.length, 0, "人确认前不开工");
});

test("P2-08、P2-09、P2-10：按计划拆——两个子任务同时开工（各自的范围、不做对外动作），验证通过即完成不出卡；都完成后合并任务开工；合并验证就是目标验收，出一张目标审核卡；接受后目标完成", () => {
  const k = new Kernel(cfg(), ":memory:");
  const { card } = planned(k);
  answer(k, card!.id, "split", { text: "先写 a" });
  assert.deepEqual(states(k), { "T-1": "queued", "T-2": "queued", "T-3": "awaiting_deps" });
  const a = k.task("T-1")!, b = k.task("T-2")!, m = k.task("T-3")!;
  assert.deepEqual([a.contract.role, a.contract.scope, a.contract.acceptance], ["part", { write: ["math.mjs"], effects: [] }, { checks: ["node --check math.mjs"], criteria: ["half(3) 返回 1.5"] }]);
  assert.equal(b.contract.acceptance.checks.length, 0);
  assert.deepEqual([m.contract.role, m.contract.depends_on, m.contract.scope.write, m.contract.scope.effects], ["merge", ["T-1", "T-2"], ["**"], ["push-branch", "open-pr"]]);
  assert.deepEqual(m.contract.acceptance, { checks: ["node --check math.mjs", "npm test"], criteria: ["half(3) 返回 1.5", "README 有用法"] }, "合并任务按目标的验收标准验收");
  assert.match(m.contract.objective, /合并 T-1、T-2 的分支/);
  assert.equal(a.feedback, "人确认拆分计划时补充：先写 a");

  // 每目标同时 2 个（2026-11-13 人定）：两个子任务同时在跑，可写范围不重叠，租约不挡。
  const ca = k.claim("claude", T0, sid())!, cb = k.claim("claude", T0, sid())!;
  assert.deepEqual([ca.task.id, cb.task.id], ["T-1", "T-2"]);
  assert.equal(k.claim("claude", T0, sid()), null, "合并任务等依赖");
  receipt(k, ca.run_id, "T-1", "done");
  receipt(k, cb.run_id, "T-2", "done");
  assert.deepEqual([k.task("T-1")!.verify_due, k.task("T-2")!.verify_due], ["codex", "codex"], "子任务照常验证");
  const va = k.claim("codex", at(10), sid())!;
  pass(k, va.run_id, "T-1");
  assert.equal(states(k)["T-1"], "done", "验证通过即完成");
  assert.equal(k.cards().filter((c) => c.kind === "review").length, 0, "子任务不出审核卡");
  assert.equal(states(k)["T-3"], "awaiting_deps", "还差 T-2");
  const vb = k.claim("codex", at(20), sid())!;
  pass(k, vb.run_id, "T-2");
  assert.equal(states(k)["T-3"], "queued", "依赖都完成了，合并任务开工");
  assert.match(k.why("T-3").at(-1)!.note ?? "", /依赖的 T-1、T-2 都完成了，开工/);
  assert.equal(k.goal("G-1")!.status, "active");

  // 合并任务领活时带上游的产出（交接说明、分支）；子任务的工作区落账后能找到分支。
  ev(k, "workspace.prepared", { task_id: "T-1", path: "/w/T-1", branch: "xj/T-1-half", base: "main", base_commit: "aaaaaaa1" }, "worker");
  const cm = k.claim("claude", at(30), sid())!;
  assert.equal(cm.task.id, "T-3");
  assert.deepEqual(cm.deps.map((d) => [d.task_id, d.branch, d.base_commit, d.handoff]), [["T-1", "xj/T-1-half", "aaaaaaa1", "T-1 交接"], ["T-2", null, null, "T-2 交接"]]);
  receipt(k, cm.run_id, "T-3", "done", { summary: "合并好了" });
  const vm = k.claim("codex", at(40), sid())!;
  pass(k, vm.run_id, "T-3", ["合并后没跑 npm test 的覆盖率"]);
  const review = cardOf(k, (c) => c.kind === "review")!;
  assert.equal(review.about, "T-3");
  assert.equal(review.title, "目标审核：half 和文档");
  assert.match(review.body, /^\*\*目标验收\*\* 通过（RN-6，codex）：满足验收/);
  assert.match(review.body, /\*\*子任务\*\*\n- T-1 math\.mjs 加 half：验证通过（RN-3）\n- T-2 README 写用法：验证通过（RN-4）/);
  assert.match(review.body, /\*\*子任务的残余风险\*\*\n- T-1：T-1 没测负数\n- T-2：T-2 没测负数/);
  assert.match(review.body, /\*\*残余风险\*\*\n- 合并后没跑 npm test 的覆盖率/);
  assertFeishuLists(review.body);
  assert.equal(k.cards().filter((c) => c.kind === "review").length, 1, "整个目标只有一张审核卡");
  answer(k, review.id, "accept");
  assert.equal(k.goal("G-1")!.status, "done");

  // 从账本重建：任务、卡片、轮次都一样。
  const snap = () => JSON.stringify([k.db.prepare(`SELECT * FROM tasks ORDER BY id`).all(), k.db.prepare(`SELECT * FROM cards ORDER BY id`).all(),
    k.db.prepare(`SELECT * FROM runs ORDER BY id`).all(), k.db.prepare(`SELECT * FROM judgments ORDER BY id`).all()]);
  const before = snap();
  k.rebuild();
  assert.equal(snap(), before);
});

test("P2-08：有依赖的子任务等前一个；前一个被放弃，后面的和合并任务都不再做，目标结束", () => {
  const k = new Kernel(cfg(), ":memory:");
  const chain = { ...PLAN, tasks: [PLAN.tasks[0], { ...PLAN.tasks[1], depends_on: ["a"] }] };
  const { card } = planned(k, chain);
  assert.match(card!.body, /- 依赖：a/);
  answer(k, card!.id, "split");
  assert.deepEqual(states(k), { "T-1": "queued", "T-2": "awaiting_deps", "T-3": "awaiting_deps" });
  assert.deepEqual(k.task("T-2")!.contract.depends_on, ["T-1"]);
  const c = k.claim("claude", T0, sid())!;
  assert.equal(k.claim("claude", T0, sid()), null);
  receipt(k, c.run_id, "T-1", "ask", { ask: [{ question: "half 要不要支持字符串" }] });
  answer(k, cardOf(k, (x) => x.about === "T-1")!.id, "abandon");
  assert.deepEqual(states(k), { "T-1": "abandoned", "T-2": "abandoned", "T-3": "abandoned" });
  assert.match(k.why("T-2").at(-1)!.note ?? "", /依赖的 T-1 没做完（abandoned），不再做/);
  assert.equal(k.goal("G-1")!.status, "abandoned");
});

test("P2-08：不拆 / 修改 / 规划判断不拆 / 规划连续没成", () => {
  // 人选不拆：一个任务，照旧（审核卡在任务上）。
  const k = new Kernel(cfg(), ":memory:");
  const { card } = planned(k);
  answer(k, card!.id, "single");
  assert.deepEqual(states(k), { "T-1": "queued" });
  assert.equal(k.task("T-1")!.contract.role, undefined);
  assert.equal(k.task("T-1")!.contract.objective, "half 和文档");

  // 修改：带上一版和修改意见再规划一次，计划卡是新的一张。
  const k2 = new Kernel(cfg(), ":memory:");
  const first = planned(k2);
  answer(k2, first.card!.id, undefined, { text: "README 不用改，拆成 math 和 test" });
  const j2 = k2.claimJudgment("planner", T0, sid())!;
  const input = j2.input as PlanInput;
  assert.deepEqual([input.revision, input.feedback, input.previous?.why], [1, "README 不用改，拆成 math 和 test", "接口和页面互不相干"]);
  assert.match(buildPlanPrompt(input, 4, ["math.mjs", "README.md"]), /## 上一版计划\n\{"split":true[\s\S]*## 人的修改意见（照这个改上一版）\nREADME 不用改/);
  ev(k2, "judgment.result", { judgment_id: j2.id, output: { ...PLAN, why: "改过了" } }, "worker");
  const second = cardOf(k2, (c) => c.form === "plan")!;
  assert.notEqual(second.id, first.card!.id);
  assert.match(second.body, /\*\*为什么拆\*\*（第 1 次修改） 改过了/);

  // 规划判断不拆：不出决策卡，一个任务，知会一声。
  const k3 = new Kernel(cfg(), ":memory:");
  planned(k3, { split: false, why: "都在 math.mjs 里" });
  assert.deepEqual(states(k3), { "T-1": "queued" });
  assert.match(cardOf(k3, (c) => c.kind === "notice")!.title, /规划：G-1 不拆，一个任务做（T-1）/);

  // 规划连续 3 次没成（输出不合格、超时）：不拆，一个任务做。
  const k4 = new Kernel(cfg(), ":memory:");
  ev(k4, "goal.confirmed", { title: "x", split: true });
  for (let i = 0; i < 2; i++) {
    const j = k4.claimJudgment("planner", T0, sid())!;
    ev(k4, "judgment.result", { judgment_id: j.id, output: { split: true, why: "x", tasks: [] } }, "worker");
  }
  k4.claimJudgment("planner", T0, sid());
  ev(k4, "timer.tick", {}, "timer", new Date(Date.parse(T0) + PLAN_TIMEOUT_MS + 1000).toISOString());
  assert.deepEqual(states(k4), { "T-1": "queued" });
  assert.match(cardOf(k4, (c) => c.kind === "notice")!.title, /规划没成，G-1 不拆：T-1/);
});

test("P2-08：规划档案受 Claude 周用量管——读数按账号算（同一个 Agent 的档案共用）；过 80% 只规划人亲自提的目标", () => {
  const k = new Kernel(cfg(), ":memory:");
  ev(k, "quota.observed", { agent: "claude", seven_day: { utilization: 0.85, resetsAt: 1 } }, "worker");
  ev(k, "goal.confirmed", { title: "环境起的", split: true }, "kernel");
  assert.equal(k.claimJudgment("planner", T0, sid()), null, "不是人提的，不规划");
  ev(k, "goal.confirmed", { title: "人提的", split: true }, "feishu");
  assert.equal(k.claimJudgment("planner", T0, sid())!.about, "G-2");
  assert.equal(k.claimJudgment("planner", T0, sid()), null, "同时只规划一个");
  const s = k.overview().slots.find((x) => x.agent === "planner")!;
  assert.deepEqual([s.utilization, s.human_only, s.capacity], [0.85, true, 1]);
  const text = showStatus(k.overview() as unknown as Overview);
  assert.match(text, /在做\n  G-1 环境起的：规划拆分中，或拆分计划等你确认\n  G-2 人提的：规划拆分中，或拆分计划等你确认/);
  assert.match(text, /规划 planner 1\/1，周用量过上限，只跑你亲自提的目标/);
  // 额度按账号合并：claude、planner 是同一份订阅。
  assert.match(text, /额度\n  Claude（claude、planner）：周 85%/);
  assert.doesNotMatch(text, /执行 planner/);
});

// ---- P2-07 定论 ----

test("P2-07：定论按范围注入——任务、目标、项目、全局；作废的不再注入；提示词说明不适用要出卡", () => {
  const k = new Kernel(cfg(), ":memory:");
  // 四个目标各问一个问题（先都问完再回答，免得回答后被领走的是同一个任务）。
  const ask = (title: string, q: string) => {
    ev(k, "goal.confirmed", { title });
    const c = k.claim("claude", T0, sid())!;
    receipt(k, c.run_id, c.task.id, "ask", { ask: [{ question: q }] });
    return cardOf(k, (x) => x.about === c.task.id && x.status === "open")!.id;
  };
  const cards = [ask("加 mod", "负数取模按哪种"), ask("加 abs", "abs(-0)"), ask("加 sign", "注释用什么语言"), ask("加 pow", "pow 的指数")];
  answer(k, cards[0]!, "数学", { scope: "goal" });                          // R-1：G-1
  answer(k, cards[1]!, "0", { text: "一律返回 0", scope: "task" });         // R-2：只管 T-2
  answer(k, cards[2]!, "中文", { scope: "global" });                        // R-3
  answer(k, cards[3]!, "整数", { scope: "project" });                       // R-4
  assert.deepEqual(k.rulings().map((r) => [r.id, r.scope, r.scope_ref]), [["R-1", "goal", "T-1"], ["R-2", "task", "T-2"], ["R-3", "global", "T-3"], ["R-4", "project", "T-4"]]);
  assert.deepEqual(rulingIds(k, "T-1"), ["R-1", "R-3", "R-4"]);
  assert.deepEqual(rulingIds(k, "T-2"), ["R-2", "R-3", "R-4"]);
  ev(k, "ruling.revoked", { ruling_id: "R-3" }, "feishu");
  assert.deepEqual(rulingIds(k, "T-2"), ["R-2", "R-4"]);

  const c = k.claim("claude", T0, sid())!;
  const prompt = buildPrompt({ task: c.task, goal: k.goal(c.task.goal_id)!, rulings: c.rulings });
  assert.match(prompt, /## 已定的事（人定的，照做，不要再问）\n- R-\d（[^）]+，2026-11-13）：/);
  assert.match(prompt, /某条这次确实不适用时，不要自己绕过：交 ask 回执，ask 里写 "ruling": "R-x"/);
  const vp = buildVerifyPrompt({ task: c.task, goal: k.goal(c.task.goal_id)!, receipt: null, checks: [], round: 1, workspace: { path: "/w" }, rulings: c.rulings });
  assert.match(vp, /## 已定的事（人定的，执行者必须照做）[\s\S]*违反其中任何一条也算问题/);
});
// 某个任务现在领活会带哪些定论（直接按内核的匹配算，不真的领）。
function rulingIds(k: Kernel, task: string): string[] {
  const t = k.task(task)!;
  return rulingsFor(k.db, { goal_id: t.goal_id, task_id: t.id }).map((r) => r.id);
}

test("P2-07：Agent 认为某条定论不适用——出专门的卡（照定论做 / 这次例外 / 作废），不得自行绕过；人的回答带进下一轮", () => {
  const k = new Kernel(cfg(), ":memory:");
  ev(k, "goal.confirmed", { title: "加 mod" });
  const c1 = k.claim("claude", T0, sid())!;
  receipt(k, c1.run_id, "T-1", "ask", { ask: [{ question: "负数取模按哪种" }] });
  answer(k, cardOf(k, (x) => x.about === "T-1")!.id, "数学", { scope: "global" });
  const c2 = k.claim("claude", T0, sid())!;
  assert.deepEqual(c2.rulings.map((r) => r.id), ["R-1"]);
  receipt(k, c2.run_id, "T-1", "ask", { ask: [{ question: "这里要和 Python 一致", why: "调用方是 Python 移植过来的", ruling: "R-1" }] });
  const card = cardOf(k, (x) => x.form === "ruling")!;
  assert.equal(card.title, "定论 R-1 这次不适用？这里要和 Python 一致");
  assert.deepEqual(card.options, RULING_OPTIONS);
  assert.match(card.body, /\*\*定论 R-1\*\*（以后都这样，2026-11-13，出处 C-1）：负数取模按哪种 → 数学\n\n\*\*Agent 认为不适用的理由\*\* 调用方是 Python/);
  answer(k, card.id, "revoke", { text: "按 Python" });
  assert.equal(k.rulings().length, 0, "作废了");
  assert.equal(states(k)["T-1"], "queued");
  assert.match(k.task("T-1")!.feedback!, /定论 R-1 不适用”（C-2）的回答：作废这条定论，不用再照它做；说明：按 Python/);

  // 编号对不上（没有这条或已作废）：当普通问题出卡。
  const c3 = k.claim("claude", T0, sid())!;
  receipt(k, c3.run_id, "T-1", "ask", { ask: [{ question: "还是不适用", ruling: "R-1" }] });
  assert.equal(cardOf(k, (x) => x.status === "open")!.form, null);
});

// ---- 接单程序：规划、上游分支、合并 ----

function local(k: Kernel): KernelClient {
  let i = 0;
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

class Scripted implements AgentAdapter {
  readonly name = "claude";
  readonly requests: RunRequest[] = [];
  private readonly replies: ((req: RunRequest) => string)[];
  constructor(replies: ((req: RunRequest) => string)[]) { this.replies = replies; }
  async run(req: RunRequest): Promise<RunResult> {
    this.requests.push(req);
    const reply = this.replies.shift() ?? (() => "{}");
    return { last_message: reply(req), session_id: `s-${this.requests.length}`, exit_code: 0, usage: {}, rate_limited: false, stderr: "" };
  }
}

test("P2-08：接单程序规划——不给工具、用规划档案的模型、给文件清单；计划不合格在同一会话重写一次", async () => {
  const k = new Kernel(cfg(), ":memory:");
  ev(k, "goal.confirmed", { title: "half 和文档", acceptance: ["好了"], checks: ["node --check math.mjs"], split: true });
  const overlapping = { ...PLAN, tasks: [PLAN.tasks[0], { ...PLAN.tasks[1], write: ["math.mjs"] }] };
  const agent = new Scripted([() => JSON.stringify(overlapping), () => JSON.stringify(PLAN)]);
  const exec: Exec = async (cmd, args) => (cmd === "git" && args[0] === "ls-files" ? { code: 0, stdout: "math.mjs\nREADME.md\n", stderr: "" } : { code: 1, stdout: "", stderr: "" });
  const w = new Worker(local(k), { planner: agent }, "/repo", { profiles: { planner: PLANNER }, exec, log: () => {} });
  assert.equal(await w.judgeOnce("planner"), true);
  const [first, rewrite] = agent.requests;
  assert.deepEqual([first!.tools, first!.model, first!.cwd], [[], "claude-opus-5-5", "/repo"]);
  assert.match(first!.prompt, /你是璇玑的规划者/);
  assert.match(first!.prompt, /## 仓库里的文件（git ls-files，最多 2 个）\nmath\.mjs\nREADME\.md/);
  assert.match(first!.prompt, /最多拆 4 个，至少 2 个/);
  assert.match(rewrite!.prompt, /计划不合格：任务 a 和 b 的可写范围重叠（math\.mjs 和 math\.mjs）/);
  assert.equal(rewrite!.session_id, "s-1");
  assert.ok(cardOf(k, (c) => c.form === "plan"), "第二次合格，出计划卡");
});

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "xj-split-")));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const work = join(dir, "work");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(work, "config", "user.email", "t@example.com"); git(work, "config", "user.name", "t");
  writeFileSync(join(work, "math.mjs"), "export const one = 1;\n"); git(work, "add", "."); git(work, "commit", "-qm", "init");
  return { dir, work, git, main1: git(work, "rev-parse", "HEAD"), root: join(dir, "wt") };
}

test("出口（离线）：两个子任务各在自己的 worktree 从 main 拉；合并任务从第一个子任务的分支拉、提示词让它合其余分支；验证看整个目标的改动", async () => {
  const r = repo();
  const k = new Kernel(cfg(), ":memory:");
  const { card } = planned(k);
  answer(k, card!.id, "split");
  // 假 Agent：子任务各提交自己的文件；合并任务照提示词 git merge 其余分支。
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), file); execFileSync("git", ["add", file], { cwd });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", file], { cwd });
  };
  const done = (s: string) => JSON.stringify({ outcome: "done", summary: s, handoff: `${s}，已提交` });
  const agent = new Scripted([
    (q) => { commit(q.cwd, "half.txt"); return done("a 好了"); },
    (q) => { commit(q.cwd, "readme.txt"); return done("b 好了"); },
    (q) => { const m = /`git merge --no-edit (\S+)`/.exec(q.prompt)!; execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "merge", "-q", "--no-edit", m[1]!], { cwd: q.cwd }); return done("合并好了"); },
  ]);
  const exec: Exec = (cmd, args, cwd) => (cmd === "lsof" ? Promise.resolve({ code: 0, stdout: "", stderr: "" }) : execReal(cmd, args, cwd));
  const w = new Worker(local(k), { claude: agent }, r.work, { exec, worktreeRoot: r.root, log: () => {} });
  const one = (await w.begin("claude"))!, two = (await w.begin("claude"))!;
  await Promise.all([one.done, two.done]);
  assert.deepEqual(agent.requests.map((q) => q.cwd), [join(r.root, "work", "T-1"), join(r.root, "work", "T-2")]);
  assert.match(agent.requests[0]!.prompt, /## 你是拆出来的一部分\n这个目标拆成了几个互不重叠的子任务/);
  assert.match(agent.requests[0]!.prompt, /可写范围：math\.mjs；允许的对外动作：无/);
  for (const t of ["T-1", "T-2"]) { const v = k.claim("codex", T0, sid())!; assert.equal(v.task.id, t); pass(k, v.run_id, t); }
  assert.equal(states(k)["T-3"], "queued");

  const m = (await w.begin("claude"))!;
  await m.done;
  const mp = agent.requests[2]!;
  assert.equal(mp.cwd, join(r.root, "work", "T-3"));
  assert.match(mp.prompt, /分支 xj\/T-3-half，从 xj\/T-1-math@[0-9a-f]{7} 拉出/, "提示词照实写从上游分支拉出；分支名不带子任务编号");
  assert.match(mp.prompt, /## 合并\n这个目标拆成了几个子任务.*你的工作区从 xj\/T-1-math 拉出，已经包含它的改动/);
  assert.match(mp.prompt, /`git merge --no-edit xj\/T-2-readme`/);
  assert.match(mp.prompt, /## 上游任务的产出\n- T-1（分支 xj\/T-1-math）：math\.mjs 加 half\n  回执：a 好了\n  交接：a 好了，已提交/);
  assert.equal(r.git(join(r.root, "work", "T-3"), "log", "--format=%s", "-3").split("\n").sort().join(","), ["Merge branch 'xj/T-2-readme' into xj/T-3-half", "half.txt", "readme.txt"].sort().join(","));
  // 合并任务的基底记成目标的基底（主干），验证者看到的是整个目标的改动。
  assert.equal(k.task("T-3")!.base_commit, r.main1);
  assert.match(k.why("T-3").find((e) => e.type === "workspace.prepared")!.note ?? "", /基底 xj\/T-1-math（目标基底 [0-9a-f]{7}）/);
  const vc = k.claim("codex", T0, sid())!;
  const vp = buildVerifyPrompt({ task: vc.task, goal: k.goal("G-1")!, receipt: null, checks: [], round: 1, workspace: { path: "/w", base_commit: vc.task.base_commit }, deps: vc.deps });
  assert.match(vp, /这是目标验收：目标拆成了 2 个子任务，各自验证过了，这里看合并后的整体/);
  assert.match(vp, new RegExp(`git diff ${r.main1.slice(0, 12)}\\.\\.HEAD`));

  // 目标审核卡的“结果”：分支、没推送、相对目标基底改了哪些文件（接单程序用 git 算的）；系统建的工作区路径不列。
  pass(k, vc.run_id, "T-3");
  const review = cardOf(k, (c) => c.kind === "review")!;
  assert.match(review.body, new RegExp(`\\*\\*结果\\*\\*\\n- 分支 \`xj/T-3-half\`，没推送\\n- 改动（相对基底 ${r.main1.slice(0, 7)}）：新增 half\\.txt、readme\\.txt\\n\\n\\*\\*执行者说明\\*\\*\\n合并好了，已提交`));
  assert.doesNotMatch(review.body, /xj-split-|工作区：/);
  assertFeishuLists(review.body);
});

test("审核卡的结果一段：改动由接单程序用 git 算（已提交的按新增、修改分组），没提交的单独写出来；说明截短、证据一条一行", async () => {
  const r = repo();
  const wt = join(r.dir, "wt1");
  r.git(r.work, "worktree", "add", "-q", "-b", "xj/T-1-x", wt, "main");
  writeFileSync(join(wt, "math.mjs"), "export const one = 2;\n"); writeFileSync(join(wt, "new.mjs"), "1");
  r.git(wt, "add", "."); r.git(wt, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "x");
  writeFileSync(join(wt, "draft.txt"), "没提交");
  const { workspaceChanges } = await import("../src/worker/worker.ts");
  assert.deepEqual(await workspaceChanges(wt, r.main1, execReal), { base: r.main1, files: [{ status: "M", path: "math.mjs" }, { status: "A", path: "new.mjs" }], uncommitted: ["draft.txt"] });
  assert.equal(await workspaceChanges(wt, "不是提交", execReal), null);

  const k = new Kernel(cfg({ claude: CLAUDE }), ":memory:");
  ev(k, "goal.confirmed", { title: "x" });
  const c = k.claim("claude", T0, sid())!;
  ev(k, "workspace.prepared", { task_id: "T-1", path: wt, branch: "xj/T-1-x", base: "main", base_commit: r.main1 }, "worker");
  receipt(k, c.run_id, "T-1", "done", { handoff: "长".repeat(400), evidence: Array.from({ length: 8 }, (_, i) => ({ check: `检查 ${i}`, result: "ok\n第二行" })),
    changes: await workspaceChanges(wt, r.main1, execReal) });
  const body = k.cards()[0]!.body;
  assert.match(body, /^\*\*结果\*\*\n- 分支 `xj\/T-1-x`，没推送\n- 改动（相对基底 [0-9a-f]{7}）：新增 new\.mjs；修改 math\.mjs\n- 还有没提交的改动：draft\.txt（清理工作区时不会删）/);
  assert.match(body, /\*\*执行者说明\*\*\n长{300}…\n\n\*\*证据\*\*\n- 检查 0 → ok 第二行\n/);
  assert.match(body, /- 检查 5 → ok 第二行\n- 另有 2 条，xj why 看$/);
  assertFeishuLists(body);
});
