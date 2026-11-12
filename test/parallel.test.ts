// 二期第一批：调度与隔离。并发上限与按用量降档（P2-01）、背压（P2-06）、每任务一个 worktree（P2-02）、可写范围租约（P2-03）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "../src/kernel/kernel.ts";
import { DEFAULTS, type Config } from "../src/shared/config.ts";
import { patternsOverlap, leaseConflict } from "../src/kernel/scheduler.ts";
import { laneOf, backpressureLevel, lanePasses } from "../src/kernel/attention.ts";
import { normalizeDraft, goalCardBody } from "../src/kernel/intake.ts";
import { showStatus, type Overview } from "../src/channels/format.ts";
import { Worker, type KernelClient } from "../src/worker/worker.ts";
import { buildPrompt, buildResumePrompt } from "../src/worker/context-pack.ts";
import { execReal, type Exec } from "../src/worker/effects.ts";
import { prepareWorkspace, branchFor, staleProcesses } from "../src/worker/workspace.ts";
import type { AgentAdapter, RunRequest, RunResult } from "../src/worker/adapters/types.ts";
import type { EventInput, Task } from "../src/kernel/types.ts";

const T0 = "2026-11-13T08:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
let n = 0;
const sid = () => `p${n++}`;
const cfg = (limits: Partial<Config["limits"]> = {}, capacity = 2): Config =>
  ({ ...DEFAULTS, limits: { ...DEFAULTS.limits, ...limits }, agents: { claude: { ...DEFAULTS.agents.claude!, capacity } } });
const ev = (k: Kernel, type: string, payload: Record<string, unknown>, source: EventInput["source"] = "cli", t = T0) =>
  k.ingest({ source, source_id: sid(), type, at: t, payload });
const goal = (k: Kernel, title: string, source: EventInput["source"] = "cli", extra: Record<string, unknown> = {}) => ev(k, "goal.confirmed", { title, ...extra }, source);
const receipt = (k: Kernel, run: string, task: string, outcome: string, extra: Record<string, unknown> = {}) =>
  ev(k, "run.receipt", { run_id: run, task_id: task, receipt: { outcome, summary: `${task} ${outcome}`, handoff: "h", ...extra } }, "worker");
const quota = (k: Kernel, u: number) => ev(k, "quota.observed", { agent: "claude", seven_day: { utilization: u, resetsAt: 1 } }, "worker");
const claim = (k: Kernel) => k.claim("claude", T0, sid());
// 开 m 张待处理的决策卡：每个目标一个任务，跑一轮交 ask。
function openDecisions(k: Kernel, m: number) {
  for (let i = 0; i < m; i++) {
    goal(k, `问 ${i}`);
    const c = claim(k)!;
    receipt(k, c.run_id, c.task.id, "ask", { ask: [{ question: `问题 ${i}` }] });
  }
}

// ---- P2-01 并发上限与降档 ----

test("P2-01：执行同时 2 个，第三个等；每目标同时 1 个；一轮结束空出名额", () => {
  const k = new Kernel(cfg(), ":memory:");
  goal(k, "a"); goal(k, "b"); goal(k, "c");
  const a = claim(k)!, b = claim(k)!;
  assert.deepEqual([a.task.id, b.task.id], ["T-1", "T-2"]);
  assert.equal(a.subagents, true);
  assert.equal(claim(k), null, "名额满了");
  receipt(k, a.run_id, "T-1", "done");
  assert.equal(claim(k)!.task.id, "T-3");

  // 同一目标里第二个任务（第三批才会拆出来，这里直接写进投影）：前一个在跑就不派。
  const k2 = new Kernel(cfg(), ":memory:");
  goal(k2, "x");
  const first = claim(k2)!;
  k2.db.prepare(`INSERT INTO tasks(id, goal_id, state, contract, created_at, updated_at) VALUES ('T-9', 'G-1', 'queued', ?, ?, ?)`)
    .run(JSON.stringify({ ...first.task.contract, scope: { write: ["docs/**"], effects: [] } }), T0, T0);
  assert.equal(claim(k2), null, "每目标同时 1 个执行");
});

test("P2-01：周用量过 60% 执行降为 1 个、领活结果带 subagents: false；过 80% 只跑人亲自提的目标", () => {
  const k = new Kernel(cfg(), ":memory:");
  quota(k, 0.65);
  goal(k, "a"); goal(k, "b");
  const a = claim(k)!;
  assert.equal(a.subagents, false);
  assert.equal(claim(k), null, "降为 1 个");
  const s = k.overview().slots[0]!;
  assert.deepEqual([s.capacity, s.running, s.subagents, s.human_only], [1, 1, false, false]);

  const k2 = new Kernel(cfg(), ":memory:");
  quota(k2, 0.85);
  goal(k2, "定时器起的", "timer");
  goal(k2, "人提的", "feishu");
  const c = claim(k2)!;
  assert.equal(c.task.goal_id, "G-2", "环境触发的目标跳过，人提的照跑");
  assert.equal(c.subagents, false);
  receipt(k2, c.run_id, c.task.id, "done");
  assert.equal(claim(k2), null, "只剩环境触发的，不派");
  assert.match(showStatus(k2.overview() as unknown as Overview), /执行 claude：0\/1 在跑，周用量过上限，只跑你亲自提的目标/);
});

// ---- P2-06 背压 ----

test("P2-06：领活的道与两级上限是确定的规则", () => {
  assert.equal(laneOf({ runs_used: 0, feedback: "人确认目标卡时补充：x" }), "new");
  assert.equal(laneOf({ runs_used: 2, feedback: null }), "ongoing");
  assert.equal(laneOf({ runs_used: 2, feedback: "系统已执行你请求的对外动作：推分支" }), "ongoing", "系统写的反馈不算人回答");
  assert.equal(laneOf({ runs_used: 2, feedback: "系统已执行你请求的对外动作：x\n人对“y”（C-3）的回答：好" }), "answered");
  const lim = { soft: 5, hard: 8 };
  assert.deepEqual([4, 5, 8].map((o) => backpressureLevel(o, lim)), ["none", "soft", "hard"]);
  assert.deepEqual((["answered", "verify", "ongoing", "new"] as const).map((l) => lanePasses("soft", l)), [true, true, true, false]);
  assert.deepEqual((["answered", "verify", "ongoing", "new"] as const).map((l) => lanePasses("hard", l)), [true, true, false, false]);
});

// 直接开一张待处理的决策卡，只为凑背压的计数。
let fakeCards = 100;
const fakeCard = (k: Kernel) => k.db.prepare(`INSERT INTO cards(id, kind, about, title, body, options, dedupe_key, status, created_at, updated_at)
  VALUES (?, 'decision', 'G-0', 'x', '', '[]', ?, 'open', ?, ?)`).run(`C-${fakeCards}`, `fake:${fakeCards++}`, T0, T0);

test("P2-06：软上限不开新任务的第一轮，在做的照常；硬上限只放行带人回答的；知会卡不计", () => {
  const k = new Kernel(cfg({ backpressure_cards: 2, backpressure_hard: 3 }, 5), ":memory:");
  openDecisions(k, 1);                                   // T-1 等回答，C-1
  goal(k, "在做的");                                      // T-2 跑一轮失败、退避后回队列 → 在做的
  const c2 = claim(k)!;
  receipt(k, c2.run_id, "T-2", "failed");
  ev(k, "timer.tick", {}, "timer", at(120));
  assert.equal(k.task("T-2")!.state, "queued");
  fakeCard(k);                                           // 到软上限 2
  k.db.prepare(`INSERT INTO cards(id, kind, about, title, body, options, dedupe_key, status, created_at, updated_at) VALUES ('C-90','notice','G-0','知会','','[]','n','open',?,?)`).run(T0, T0);
  goal(k, "新活");                                        // T-3 新任务
  const v = k.overview().backpressure;
  assert.deepEqual([v.open, v.level, v.held_new], [2, "soft", 1], "知会卡不计");
  assert.match(showStatus(k.overview() as unknown as Overview), /队列满了，1 件新活在排队（待处理卡 2 张，到了软上限 2，不开新活）/);
  const ongoing = claim(k)!;
  assert.equal(ongoing.task.id, "T-2", "软上限下在做的照常");
  assert.equal(claim(k), null, "新任务不开第一轮");
  receipt(k, ongoing.run_id, "T-2", "ask", { ask: [{ question: "再问一个" }] });   // 到硬上限 3
  assert.equal(k.overview().backpressure.level, "hard");

  // 人回答了 C-1：T-1 带着回答回队列（卡片降到 2）；再凑一张回到硬上限，T-1 照样放行，新任务不放行。
  ev(k, "card.answered", { card_id: "C-1", choice: "好" }, "feishu");
  fakeCard(k);
  assert.equal(k.overview().backpressure.level, "hard");
  assert.equal(claim(k)!.task.id, "T-1", "硬上限下带人回答的放行");
  assert.equal(claim(k), null, "硬上限下新任务不放行");
  assert.match(showStatus(k.overview() as unknown as Overview), /队列满了，1 件新活在排队（待处理卡 3 张，到了硬上限 3，只放行带你回答的任务）/);
});

test("P2-06：领活顺序 带人回答的 > 在做的 > 新任务，同一条道上按排队先后", () => {
  const k = new Kernel(cfg({}, 5), ":memory:");
  goal(k, "新"); goal(k, "在做"); goal(k, "带回答"); goal(k, "又一个新");
  k.db.prepare(`UPDATE tasks SET runs_used = 1 WHERE id IN ('T-2','T-3')`).run();
  k.db.prepare(`UPDATE tasks SET feedback = '人对“x”（C-1）的回答：好' WHERE id = 'T-3'`).run();
  assert.deepEqual([1, 2, 3, 4].map(() => claim(k)!.task.id), ["T-3", "T-2", "T-1", "T-4"]);
});

test("P2-06：背压时简报写明排队数；上限在落账时记进事件，重放不随配置变", () => {
  const k = new Kernel(cfg({ backpressure_cards: 1 }), ":memory:");
  openDecisions(k, 1);
  goal(k, "新活 1"); goal(k, "新活 2");
  ev(k, "brief.due", { date: "2026-11-13" }, "timer");
  const brief = k.db.prepare(`SELECT body FROM cards WHERE form = 'brief'`).get() as { body: string };
  assert.match(brief.body, /\*\*队列满了\*\*：2 件新活在排队（待处理卡 1 张，到了软上限 1，不开新活）/);
  const e = k.db.prepare(`SELECT payload FROM events WHERE type = 'brief.due'`).get() as { payload: string };
  assert.deepEqual(JSON.parse(e.payload).backpressure, { soft: 1, hard: 8 });
  const before = JSON.stringify(k.db.prepare(`SELECT id, body FROM cards ORDER BY id`).all());
  const k2 = Object.assign(Object.create(Kernel.prototype), { db: k.db, cfg: cfg({ backpressure_cards: 9 }) }) as Kernel;
  k2.rebuild();
  assert.equal(JSON.stringify(k.db.prepare(`SELECT id, body FROM cards ORDER BY id`).all()), before);
});

// ---- P2-03 租约 ----

test("P2-03：范围重叠的保守判断", () => {
  assert.ok(patternsOverlap("**", "src/a.ts"));
  assert.ok(patternsOverlap("src/**", "src/kernel/x.ts"));
  assert.ok(!patternsOverlap("src/**", "docs/**"));
  assert.ok(patternsOverlap("./docs/*.md", "docs/a.md"));
});

test("P2-03：领活时登记租约，轮次结束释放；** 不挡跨目标；同目标重叠的不同时执行；具名资源跨目标独占", () => {
  const k = new Kernel(cfg({ per_goal_concurrency: 5 }, 5), ":memory:");
  goal(k, "a"); goal(k, "b");
  const a = claim(k)!, b = claim(k)!;
  assert.deepEqual([a.task.id, b.task.id], ["T-1", "T-2"], "默认 ** 不挡跨目标并行");
  assert.deepEqual(k.db.prepare(`SELECT task_id, pattern FROM leases ORDER BY task_id`).all().map((r) => ({ ...r })),
    [{ task_id: "T-1", pattern: "**" }, { task_id: "T-2", pattern: "**" }]);
  receipt(k, a.run_id, "T-1", "done");
  assert.deepEqual(k.db.prepare(`SELECT task_id FROM leases`).all().map((r) => ({ ...r })), [{ task_id: "T-2" }], "T-1 这一轮结束即释放");

  // 同一目标里的另一个任务（G-2 下），范围 src/** 和 T-2 的 ** 重叠：不派。
  const contract = (write: string[], exclusive?: string[]) => JSON.stringify({ ...b.task.contract, scope: { write, effects: [], ...(exclusive ? { exclusive } : {}) } });
  k.db.prepare(`INSERT INTO tasks(id, goal_id, state, contract, created_at, updated_at) VALUES ('T-8', 'G-2', 'queued', ?, ?, ?)`).run(contract(["src/**"]), T0, T0);
  assert.match(leaseConflict(k.db, k.task("T-8")!)!, /^T-2 \*\*$/);
  assert.equal(claim(k), null);
  k.db.prepare(`DELETE FROM tasks WHERE id = 'T-8'`).run();

  // 具名资源：T-2 在跑时持有 res:staging，另一个目标的任务也要它，不派；要别的资源的照派。
  k.db.prepare(`INSERT INTO leases VALUES ('T-2', 'res:staging')`).run();
  goal(k, "c");
  k.db.prepare(`UPDATE tasks SET contract = ? WHERE id = 'T-3'`).run(contract(["**"], ["staging"]));
  assert.equal(claim(k), null, "预发环境被 T-2 占着");
  k.db.prepare(`UPDATE tasks SET contract = ? WHERE id = 'T-3'`).run(contract(["**"], ["migrate"]));
  assert.equal(claim(k)!.task.id, "T-3");
  assert.ok(k.db.prepare(`SELECT 1 FROM leases WHERE task_id = 'T-3' AND pattern = 'res:migrate'`).get());
});

// ---- P2-02 worktree：归并 ----

test("P2-02：workspace.prepared 记进 tasks.workdir；接受后排清理，在主仓库里执行；重建投影一致", () => {
  const k = new Kernel(cfg(), ":memory:");
  goal(k, "加 pow");
  const c = claim(k)!;
  ev(k, "workspace.prepared", { task_id: "T-1", run_id: c.run_id, path: "/w/xj-worktrees/work/T-1", branch: "xj/T-1-pow", base: "main", base_commit: "abc1234def", repo: "/w/work" }, "worker");
  assert.equal(k.task("T-1")!.workdir, "/w/xj-worktrees/work/T-1");
  assert.ok(k.why("T-1").some((e) => e.note === "工作区 /w/xj-worktrees/work/T-1，分支 xj/T-1-pow，基底 main@abc1234"));
  receipt(k, c.run_id, "T-1", "done");
  assert.match(k.cards()[0]!.body, /工作区：\/w\/xj-worktrees\/work\/T-1（xj\/T-1-pow），任务结束后清理/);
  ev(k, "card.answered", { card_id: k.cards()[0]!.id, choice: "accept" }, "feishu");
  const x = k.effect("X-1")!;
  assert.equal(x.kind, "remove-worktree");
  assert.deepEqual(x.params, { branch: "xj/T-1-pow", remote: "", path: "/w/xj-worktrees/work/T-1", repo: "/w/work" });
  const snap = () => JSON.stringify([k.db.prepare(`SELECT * FROM tasks`).all(), k.db.prepare(`SELECT * FROM effects`).all()]);
  const before = snap();
  k.rebuild();
  assert.equal(snap(), before);
});

test("P2-02：主理人写明的基底进目标卡和契约；不合法的基底丢掉", () => {
  const d = normalizeDraft({ kind: "goal", title: "在 feat/greet 上加 greet3", acceptance: ["有 greet3"], base: "feat/greet" });
  assert.ok(d.ok && d.draft.base === "feat/greet");
  for (const bad of ["-x", "a..b", "a b", "x;rm"]) {
    const r = normalizeDraft({ kind: "goal", title: "t", acceptance: ["a"], base: bad });
    assert.ok(r.ok && r.draft.base === undefined, bad);
  }
  assert.match(goalCardBody({ acceptance: [], boundaries: [], grant: { level: "L1", effects: [], budget: { runs: 8, minutes: 120 }, ask_first: [] }, base: "feat/greet" }),
    /\*\*基底\*\* 从 feat\/greet 拉分支/);
  const k = new Kernel(cfg(), ":memory:");
  goal(k, "x", "cli", { base: "feat/greet" });
  assert.equal(k.task("T-1")!.contract.base, "feat/greet");
  assert.equal(k.goal("G-1")!.base, "feat/greet");
});

// ---- P2-02 worktree：接单程序，真的 git ----

function repo(withRemote: "none" | "no-main" | "main") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "xj-wt-")));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const work = join(dir, "work");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(work, "config", "user.email", "t@example.com"); git(work, "config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "1"); git(work, "add", "."); git(work, "commit", "-qm", "init");
  const main1 = git(work, "rev-parse", "HEAD");
  if (withRemote !== "none") {
    execFileSync("git", ["init", "-q", "--bare", join(dir, "remote.git")]);
    git(work, "remote", "add", "origin", join(dir, "remote.git"));
    if (withRemote === "main") git(work, "push", "-q", "origin", "main");
  }
  // 人在自己的分支上，有没提交的改动：worktree 不能从这里拉，也不能带上这些改动。
  git(work, "checkout", "-qb", "feat/greet");
  writeFileSync(join(work, "a.txt"), "2"); git(work, "commit", "-qam", "greet");
  writeFileSync(join(work, "a.txt"), "人没提交的改动");
  return { dir, work, git, main1, root: join(dir, "wt") };
}
const task = (id: string, objective: string, base?: string): Pick<Task, "id" | "contract"> =>
  ({ id, contract: { objective, acceptance: { checks: [], criteria: [] }, scope: { write: ["**"], effects: [] }, budget: { runs: 8, minutes: 120 },
    ask_first: [], depends_on: [], agent: { kind: "code", tier: "strong" }, ...(base ? { base } : {}) } });

test("P2-02：分支名 xj/T-x-<简述>，简述取目标里的英文词", () => {
  assert.equal(branchFor(task("T-12", "第一步先用 Bash 运行 sleep 30。第二步在 math.mjs 新增并导出 half(a)，用 node -e 验证 half(6) 等于 3")), "xj/T-12-math-half");
  assert.equal(branchFor(task("T-13", "新建 strings.mjs，导出 shout(s)")), "xj/T-13-strings-shout");
  assert.equal(branchFor(task("T-14", "add pow function")), "xj/T-14-add-pow-function");
  assert.equal(branchFor(task("T-3", "整理文档")), "xj/T-3");
});

test("P2-02：远端没有主干时从本地 main 拉；不从人当前分支拉、不带人没提交的改动；再建一次接着用", async () => {
  const r = repo("no-main");
  const ws = (await prepareWorkspace(task("T-1", "add pow"), r.work, r.root, execReal))!;
  assert.deepEqual(ws, { path: join(r.root, "work", "T-1"), branch: "xj/T-1-add-pow", base: "main", base_commit: r.main1, repo: r.work });
  assert.equal(r.git(ws.path, "rev-parse", "--abbrev-ref", "HEAD"), "xj/T-1-add-pow");
  assert.equal(r.git(ws.path, "show", "HEAD:a.txt"), "1", "从 main 拉，不是人的 feat/greet");
  assert.equal(r.git(ws.path, "status", "--porcelain"), "", "不带人没提交的改动");
  assert.equal(r.git(r.work, "rev-parse", "--abbrev-ref", "HEAD"), "feat/greet", "人的工作目录不动");
  const again = (await prepareWorkspace(task("T-1", "add pow"), r.work, r.root, execReal))!;
  assert.deepEqual([again.path, again.branch, again.base], [ws.path, ws.branch, "已有"]);
});

test("P2-02：有远端主干从 origin/main 拉；写明基底的从那里拉；找不到基底报错；目录被删了在原分支上重建", async () => {
  const r = repo("main");
  r.git(r.work, "stash", "-q");
  r.git(r.work, "checkout", "-q", "main");
  writeFileSync(join(r.work, "a.txt"), "本地 main 比远端新"); r.git(r.work, "commit", "-qam", "local");
  r.git(r.work, "checkout", "-q", "feat/greet"); r.git(r.work, "stash", "pop", "-q");
  const a = (await prepareWorkspace(task("T-1", "x"), r.work, r.root, execReal))!;
  assert.deepEqual([a.base, a.base_commit], ["origin/main", r.main1]);
  const b = (await prepareWorkspace(task("T-2", "y", "feat/greet"), r.work, r.root, execReal))!;
  assert.equal(b.base, "feat/greet");
  assert.equal(r.git(b.path, "show", "HEAD:a.txt"), "2");
  await assert.rejects(prepareWorkspace(task("T-3", "z", "nope"), r.work, r.root, execReal), /找不到基底：nope/);

  writeFileSync(join(a.path, "b.txt"), "x"); r.git(a.path, "add", "."); r.git(a.path, "commit", "-qm", "work");
  const head = r.git(a.path, "rev-parse", "HEAD");
  execFileSync("rm", ["-rf", a.path]);
  const c = (await prepareWorkspace(task("T-1", "x"), r.work, r.root, execReal))!;
  assert.deepEqual([c.path, c.base, c.base_commit], [a.path, "已有分支 xj/T-1-x", head]);
  assert.equal(r.git(c.path, "rev-parse", "HEAD"), head, "提交没丢");

  const plain = realpathSync(mkdtempSync(join(tmpdir(), "xj-plain-")));
  assert.equal(await prepareWorkspace(task("T-4", "x"), plain, r.root, execReal), null, "不是 git 仓库就不建");
});

test("P2-03：工作区里还有别的进程时查得出来（lsof 的输出）", async () => {
  const exec: Exec = async () => ({ code: 0, stdout: "p100\nfcwd\nn/w/T-1\np200\nfcwd\nn/w/T-10\np300\nfcwd\nn/w/T-1/src\np1\nfcwd\nn/w/T-1\n", stderr: "" });
  assert.deepEqual(await staleProcesses("/w/T-1", exec, 1), [100, 300]);
});

// 进程内的内核客户端：和本机接口同样的调用，只是不走 HTTP。
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

// 假的 Agent：在工作目录里提交一个文件，等放行再交 done 回执。
class Gate implements AgentAdapter {
  readonly name = "claude";
  readonly requests: RunRequest[] = [];
  private readonly waiting: (() => void)[] = [];
  started = 0;
  async run(req: RunRequest): Promise<RunResult> {
    this.requests.push(req);
    this.started++;
    const file = `${req.label}.txt`;
    writeFileSync(join(req.cwd, file), "x");
    execFileSync("git", ["add", file], { cwd: req.cwd });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", file], { cwd: req.cwd });
    await new Promise<void>((r) => this.waiting.push(r));
    return { last_message: JSON.stringify({ outcome: "done", summary: `${req.label} 好了`, handoff: "提交了" }), session_id: `s-${req.label}`,
      exit_code: 0, usage: {}, rate_limited: false, stderr: "" };
  }
  release() { for (const r of this.waiting.splice(0)) r(); }
}

test("出口（离线）：两个目标同时跑，各在自己的 worktree 里、分支从 main 拉；都出审核卡；接受后 worktree 清掉，分支留着", async () => {
  const r = repo("no-main");
  const k = new Kernel(cfg(), ":memory:");
  goal(k, "add pow"); goal(k, "add cube");
  const gate = new Gate();
  const exec: Exec = (cmd, args, cwd) => (cmd === "lsof" ? Promise.resolve({ code: 0, stdout: "", stderr: "" }) : execReal(cmd, args, cwd));
  const w = new Worker(local(k), { claude: gate }, r.work, { exec, worktreeRoot: r.root, log: () => {} });
  const one = (await w.begin("claude"))!, two = (await w.begin("claude"))!;
  assert.equal(await w.begin("claude"), null, "名额满了");
  while (gate.started < 2) await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(k.overview().tasks.map((t) => t.state), ["running", "running"], "两个执行同时在跑");
  assert.deepEqual(gate.requests.map((q) => q.cwd).sort(), [join(r.root, "work", "T-1"), join(r.root, "work", "T-2")]);
  assert.match(gate.requests.find((q) => q.cwd.endsWith("T-1"))!.prompt, /## 工作区\n你在系统为这个任务单独建的 git worktree 里：.*\/T-1，分支 xj\/T-1-add-pow，从 main@[0-9a-f]{7} 拉出/);
  assert.ok(gate.requests[0]!.tools!.includes("Task"));
  gate.release();
  await Promise.all([one.done, two.done]);
  assert.deepEqual(k.overview().tasks.map((t) => t.state), ["awaiting_review", "awaiting_review"]);
  for (const c of k.cards()) ev(k, "card.answered", { card_id: c.id, choice: "accept" }, "feishu");
  while (await w.effectOnce());
  assert.ok(!existsSync(join(r.root, "work", "T-1")) && !existsSync(join(r.root, "work", "T-2")), "worktree 清掉了");
  assert.deepEqual(r.git(r.work, "branch", "--list", "xj/*").split("\n").map((s) => s.trim()), ["xj/T-1-add-pow", "xj/T-2-add-cube"], "分支留着");
  assert.equal(r.git(r.work, "log", "-1", "--format=%s", "xj/T-1-add-pow"), "RN-1.txt");
});

test("P2-01：降档的一轮从允许清单拿掉起子 Agent 的工具并显式禁用，提示词说明不能起子 Agent", async () => {
  const k = new Kernel(cfg(), ":memory:");
  quota(k, 0.7);
  goal(k, "x");
  const gate = new Gate();
  const dir = mkdtempSync(join(tmpdir(), "xj-sub-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const w = new Worker(local(k), { claude: gate }, dir, { log: () => {} });
  const run = (await w.begin("claude"))!;
  while (!gate.started) await new Promise((res) => setTimeout(res, 10));
  const req = gate.requests[0]!;
  assert.ok(!req.tools!.includes("Task"));
  assert.ok(req.disallowed_tools!.includes("Task") && req.disallowed_tools!.includes("Agent"));
  assert.match(req.prompt, /这一轮不能起子 Agent/);
  assert.doesNotMatch(req.prompt, /同时最多 3 个/);
  gate.release(); await run.done;
  const t = k.task("T-1")!;
  assert.match(buildResumePrompt({ task: t, subagents: false }), /这一轮不能起子 Agent/);
  assert.match(buildPrompt({ task: t, goal: k.goal("G-1")!, rulings: [] }), /同时最多 3 个/);
});
