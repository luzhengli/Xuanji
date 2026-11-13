// 内核：唯一有状态的部分。确定性：不读时钟、不取随机数、不主动外连。
// ingest() 是唯一入口：追加事件、归并投影、对账，三者同一事务。
import { openStore, transaction, clearProjections, type DB } from "./store.ts";
import { appendEvent, readEvents, eventsAbout } from "./events.ts";
import { reduce, getGoal, getTask, getJudgment, getEffect, backupStatus, lastVerdict, rulingsFor, listRulings } from "./reducer.ts";
import { reconcileGoals } from "./reconcile.ts";
import { pickNext, throttle, chooseVerifier, goalFromHuman } from "./scheduler.ts";
import { openCards, rowToCard, backpressureView } from "./attention.ts";
import { waitingOn } from "./state.ts";
import type { Config } from "../shared/config.ts";
import type { Card, Effect, Event, EventInput, Judgment, Receipt, Ruling, Run, Task, TaskState, Verdict, Worktree } from "./types.ts";

// 领对外动作的结果：动作本身，加上执行时要用的工作目录和出身标记所需的编号。
export interface EffectClaim { effect: Effect; workdir: string | null; goal_id: string; }

// 领活的结果：一件任务、内核签发的轮次编号，以及这一轮要带上的反馈和上一轮回执。
export interface Claim {
  task: Task;
  agent: string;
  purpose: "execute" | "verify";
  subagents: boolean;          // 这一轮能不能起子 Agent（周用量过降档线时 false，P2-01）
  run_id: string;
  feedback: string | null;
  recovery: string | null;     // 上一轮中断后的恢复说明（P1-14）
  previous: Receipt | null;    // 上一轮回执；验证轮里就是要验证的那一轮的回执
  verify?: VerifyClaim;        // 验证轮才有（P2-05）
  rulings: Ruling[];           // 按范围匹配的定论（P2-07），内联进提示词
  deps: DepOutput[];           // 上游任务的产出（P2-08）：交接说明的摘要和分支；有依赖的任务从第一个依赖的分支拉
}

// 上游任务的产出（设计“上下文”：内联摘要，附路径）。
export interface DepOutput { task_id: string; objective: string; branch: string | null; base_commit: string | null; summary: string; handoff: string; }

// 验证轮要带的东西：第几轮、被验证的执行轮、上一次验证意见（第 2 轮起，看问题改了没有）。检查命令在契约里。
export interface VerifyClaim { round: number; subject: string | null; prior: { run_id: string; verdict: Verdict } | null; }

// 领活的是哪个接单程序。它重启后报到（worker.started），旧实例领的轮次即判中断。
export interface WorkerIdentity { worker: string; instance: string; }

export class Kernel {
  readonly db: DB;
  readonly cfg: Config;
  constructor(cfg: Config, dbPath = cfg.db) { this.cfg = cfg; this.db = openStore(dbPath); }

  // 返回落账的事件；重复事件返回 null。
  ingest(input: EventInput): Event | null {
    return transaction(this.db, () => this.apply(stamp(input, this.cfg, this.db)));
  }

  private apply(input: EventInput): Event | null {
    const e = appendEvent(this.db, input);
    if (!e) return null;
    if ((e.hops ?? 0) > this.cfg.limits.hop_limit) return e; // 跳数熔断：只记录。TODO P3：出一张卡片
    reduce(this.db, e);
    reconcileGoals(this.db);
    return e;
  }

  // 从事件日志重建全部投影。重启恢复和备份演练都用它。
  rebuild(): number {
    return transaction(this.db, () => {
      clearProjections(this.db);
      const events = readEvents(this.db);
      for (const e of events) { if ((e.hops ?? 0) <= this.cfg.limits.hop_limit) reduce(this.db, e); }
      reconcileGoals(this.db);
      return events.length;
    });
  }

  // 领活：挑任务和落 run.claimed 在同一事务里，两个接单程序不会领到同一件。
  // 时间和来源编号由接单程序给（内核不读时钟），轮次编号由归并按计数器签发，重放一致。
  claim(agent: string, at: string, source_id: string, who?: WorkerIdentity): Claim | null {
    return transaction(this.db, () => {
      const a = pickNext(this.db, this.cfg, agent, at);
      if (!a) return null;
      const before = a.task;
      const e = this.apply({ source: "worker", source_id, type: "run.claimed", at, about: before.id,
        payload: { task_id: before.id, agent, purpose: a.purpose, ...(who ?? {}) } });
      if (!e) return null; // 同一个来源编号重复领活：不再派第二次
      const run = this.db.prepare(`SELECT id FROM runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1`)
        .get(before.id) as { id: string };
      const ctx = { rulings: rulingsFor(this.db, { goal_id: before.goal_id, task_id: before.id }), deps: this.depsOf(before) };
      if (a.purpose === "verify") {
        const subject = this.db.prepare(`SELECT id FROM runs WHERE task_id = ? AND purpose = 'execute' AND receipt IS NOT NULL ORDER BY rowid DESC LIMIT 1`).get(before.id) as { id: string } | undefined;
        const prior = lastVerdict(this.db, before.id);
        return { task: getTask(this.db, before.id)!, agent, purpose: "verify", subagents: false, run_id: run.id, feedback: null, recovery: null,
          previous: this.lastReceipt(before.id), ...ctx,
          verify: { round: (before.verify_failures ?? 0) + 1, subject: subject?.id ?? null, prior: prior && !prior.verdict.pass && (before.verify_failures ?? 0) > 0 ? { run_id: prior.id, verdict: prior.verdict } : null } };
      }
      return { task: getTask(this.db, before.id)!, agent, purpose: a.purpose, subagents: a.subagents, run_id: run.id,
        feedback: before.feedback, recovery: before.recovery, previous: this.lastReceipt(before.id), ...ctx };
    });
  }

  // 领判断点（P1-10 主理人）：和领活分开，判断点不占执行的并发名额，也不受背压和额度挡，
  // 因为它是人刚说的话、不给工具、几十秒就结束；否则人发一句话要等正在跑的长任务做完才有回音。
  // 规划（P2-08）只给 kinds 有 plan 的档案（配置里单独一个强模型档案，2026-11-12 人定）。它用强模型、
  // 输出大，受额度管：同一档案同时不超过名额（降档时 1 个），过 80% 只规划人亲自提的目标。
  claimJudgment(agent: string, at: string, source_id: string, who?: WorkerIdentity): (Judgment & { max_tasks?: number }) | null {
    return transaction(this.db, () => {
      const kinds = this.cfg.agents[agent]?.kinds ?? [];
      const th = throttle(this.db, this.cfg, agent);
      const planning = (this.db.prepare(`SELECT COUNT(*) AS n FROM judgments WHERE status = 'running' AND kind = 'plan' AND agent = ?`).get(agent) as { n: number }).n;
      const queued = this.db.prepare(`SELECT id, kind, about FROM judgments WHERE status = 'queued' ORDER BY created_at, rowid`).all() as { id: string; kind: string; about: string }[];
      const next = queued.find((j) => j.kind === "intake" ? kinds.includes("judge")
        : j.kind === "plan" && kinds.includes("plan") && !!th && planning < th.capacity && (!th.human_only || goalFromHuman(this.db, j.about)));
      if (!next) return null;
      const e = this.apply({ source: "worker", source_id, type: "judgment.claimed", at, about: next.about,
        payload: { judgment_id: next.id, agent, ...(who ?? {}) } });
      if (!e) return null;
      const j = getJudgment(this.db, next.id);
      return j ? { ...j, ...(j.kind === "plan" ? { max_tasks: this.cfg.limits.max_tasks_per_goal } : {}) } : null;
    });
  }
  judgment(id: string) { return getJudgment(this.db, id) ?? null; }

  // 领对外动作（P1-21）。每个任务按落账顺序一个一个来：前一个没结束，后一个不派（先推分支再开 PR）。
  // 退避中的（not_before 还没到）不派；比较的是接单程序给的 at，内核不读时钟。
  claimEffect(at: string, source_id: string, who?: WorkerIdentity): EffectClaim | null {
    return transaction(this.db, () => {
      const heads = this.db.prepare(`SELECT id, status, not_before FROM effects e WHERE status IN ('queued','running')
          AND rowid = (SELECT MIN(rowid) FROM effects WHERE task_id = e.task_id AND status IN ('queued','running')) ORDER BY rowid`).all() as { id: string; status: string; not_before: string | null }[];
      const next = heads.find((h) => h.status === "queued" && (!h.not_before || Date.parse(h.not_before) <= Date.parse(at)));
      if (!next) return null;
      const x = getEffect(this.db, next.id)!;
      const e = this.apply({ source: "worker", source_id, type: "effect.claimed", at, about: x.task_id, payload: { effect_id: x.id, ...(who ?? {}) } });
      if (!e) return null;
      const t = getTask(this.db, x.task_id)!;
      return { effect: getEffect(this.db, x.id)!, workdir: t.workdir, goal_id: t.goal_id };
    });
  }
  effect(id: string) { return getEffect(this.db, id) ?? null; }
  backups() { return backupStatus(this.db); }

  // 依赖任务的产出：最后一个交了回执的执行轮的摘要和交接说明，以及它的分支和基底。
  private depsOf(t: Task): DepOutput[] {
    return t.contract.depends_on.map((id) => {
      const d = getTask(this.db, id);
      const r = this.lastReceipt(id);
      const wt = d?.worktrees ? (JSON.parse(d.worktrees) as Worktree[]).find((w) => w.path === d.workdir) : undefined;
      return { task_id: id, objective: d?.contract.objective ?? "", branch: wt?.branch ?? null, base_commit: d?.base_commit ?? null,
        summary: r?.summary ?? "", handoff: (r?.handoff ?? "").slice(0, 1200) };
    });
  }

  rulings(all = false): Ruling[] { return listRulings(this.db, all); }

  private lastReceipt(taskId: string): Receipt | null {
    const r = this.db.prepare(`SELECT receipt FROM runs WHERE task_id = ? AND purpose = 'execute' AND receipt IS NOT NULL ORDER BY rowid DESC LIMIT 1`).get(taskId) as { receipt: string } | undefined;
    return r ? JSON.parse(r.receipt) : null;
  }

  cards() { return openCards(this.db); }
  // 飞书上还显示着旧状态的卡片（P1-27）：已经送达，账本里不再是 open，飞书上还没改过来。
  staleCards(): Card[] {
    return (this.db.prepare(`SELECT * FROM cards WHERE external_ref IS NOT NULL AND status != 'open' AND shown IS NOT status ORDER BY rowid LIMIT 20`)
      .all() as Record<string, unknown>[]).map(rowToCard);
  }
  // 单张卡片，不论是否已回答。飞书点击后据此把卡片原地改成账本里记下的结论。
  card(id: string): Card | null {
    const r = this.db.prepare(`SELECT * FROM cards WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? rowToCard(r) : null;
  }
  // 一条事件挂上的编号，含它签发的（立项事件 → G-x、T-x）。
  refsOf(seq: number): string[] {
    return (this.db.prepare(`SELECT ref FROM event_refs WHERE seq = ? ORDER BY ref`).all(seq) as { ref: string }[]).map((r) => r.ref);
  }
  why(ref: string) { return eventsAbout(this.db, ref); }
  goal(id: string) { return getGoal(this.db, id) ?? null; }
  task(id: string) { return getTask(this.db, id) ?? null; }
  run(id: string): Run | null {
    const r = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? { ...(r as unknown as Run), receipt: r.receipt ? JSON.parse(r.receipt as string) : null, verdict: r.verdict ? JSON.parse(r.verdict as string) : null } : null;
  }

  overview() {
    const tasks = (this.db.prepare(`SELECT id, goal_id, state, runs_used, session_id FROM tasks ORDER BY created_at, rowid`).all() as { id: string; goal_id: string; state: TaskState; runs_used: number; session_id: string | null }[])
      .map((t) => ({ ...t, waiting_on: waitingOn(t.state) }));
    const goals = this.db.prepare(`SELECT id, title, status FROM goals ORDER BY created_at, rowid`).all();
    const runs = this.db.prepare(`SELECT id, task_id, agent, status, session_id, started_at, finished_at FROM runs ORDER BY rowid`).all();
    const quota = this.db.prepare(`SELECT * FROM quota`).all();
    // 调度现状（P2-01、P2-06）：背压在哪一档、挡着几件活；各档案的名额和是否降档。按配置现算，不入库。
    const backpressure = backpressureView(this.db, { soft: this.cfg.limits.backpressure_cards, hard: this.cfg.limits.backpressure_hard });
    const slots = Object.keys(this.cfg.agents).map((agent) => ({ agent, ...throttle(this.db, this.cfg, agent)!,
      // 验证者（P2-05）：kinds 有 review 的档案，单列在验证的名额里。
      ...(this.cfg.agents[agent]!.kinds.includes("review") ? { verifying: (this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE agent = ? AND status = 'running' AND purpose = 'verify'`).get(agent) as { n: number }).n,
        verify_capacity: this.cfg.limits.verify_concurrency } : {}),
      // 规划（P2-08）：kinds 有 plan 的档案，单列规划的名额。
      ...(this.cfg.agents[agent]!.kinds.includes("plan") ? { planning: (this.db.prepare(`SELECT COUNT(*) AS n FROM judgments WHERE agent = ? AND status = 'running' AND kind = 'plan'`).get(agent) as { n: number }).n } : {}),
      executes: this.cfg.agents[agent]!.kinds.includes("code") }));
    // 额度按账号（2026-11-13）：同一个 Agent 的几个档案共用一份订阅，取最近的一次读数，和调度用的一样。
    const rows = quota as { agent: string; seven_day_utilization: number | null; seven_day_resets_at: string | null; five_hour_utilization: number | null; five_hour_resets_at: string | null; observed_at: string | null }[];
    const accounts = [...new Set(Object.values(this.cfg.agents).map((p) => p.use))].map((use) => {
      const names = Object.entries(this.cfg.agents).filter(([, p]) => p.use === use).map(([n]) => n);
      const r = rows.filter((x) => names.includes(x.agent)).sort((a, b) => (a.observed_at ?? "").localeCompare(b.observed_at ?? "")).at(-1);
      return { use, agents: names, seven_day: r?.seven_day_utilization ?? null, seven_day_resets_at: r?.seven_day_resets_at ? Number(r.seven_day_resets_at) : null,
        five_hour: r?.five_hour_utilization ?? null, five_hour_resets_at: r?.five_hour_resets_at ? Number(r.five_hour_resets_at) : null };
    });
    return { goals, tasks, runs, cards: this.cards(), quota, accounts, backup: this.backups(), backpressure, slots };
  }

  close() { this.db.close(); }
}

// 落账前补上要随事件记下的配置，重放时不随配置变：
// - 简报要写背压，背压上限在配置里（P2-06）。
// - done 回执要不要验证、谁来验证（P2-05）：按配置选验证者，写进事件。由内核定，不听接单程序带来的。
// - 规划的结果按多少个任务的上限校验（P2-08）：上限在配置里，写进事件。
function stamp(input: EventInput, cfg: Config, db: DB): EventInput {
  if (input.type === "judgment.result") {
    const { max_tasks: _ignored, ...payload } = input.payload;
    const kind = (db.prepare(`SELECT kind FROM judgments WHERE id = ?`).get(String(payload.judgment_id ?? "")) as { kind: string } | undefined)?.kind;
    return { ...input, payload: kind === "plan" ? { ...payload, max_tasks: cfg.limits.max_tasks_per_goal } : payload };
  }
  if (input.type === "brief.due" && !input.payload.backpressure) {
    return { ...input, payload: { ...input.payload, backpressure: { soft: cfg.limits.backpressure_cards, hard: cfg.limits.backpressure_hard } } };
  }
  if (input.type === "run.receipt") {
    const { verifier: _ignored, ...payload } = input.payload;
    const outcome = (payload.receipt as { outcome?: unknown } | undefined)?.outcome;
    const run = db.prepare(`SELECT agent FROM runs WHERE id = ?`).get(String(payload.run_id ?? "")) as { agent: string } | undefined;
    const verifier = outcome === "done" && run ? chooseVerifier(cfg, run.agent) : null;
    return { ...input, payload: verifier ? { ...payload, verifier } : payload };
  }
  return input;
}
