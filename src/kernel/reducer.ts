// 归并：一条事件如何改变投影。纯函数式思路：输入 (db, event)，只写投影表，不做 IO，不读时钟。
// 每种事件一个处理器。没有处理器的事件只记录，这就是“只记录”的含义。
import type { DB } from "./store.ts";
import { nextId } from "./store.ts";
import { formatId } from "../shared/ids.ts";
import { dueAt } from "../shared/duration.ts";
import { assertTransition } from "./state.ts";
import type { Event, Goal, Grant, Task, TaskContract, TaskState, Receipt, CardKind, CardOption, RulingScope } from "./types.ts";

export type Handler = (db: DB, e: Event) => void;

const DEFAULT_GRANT: Grant = { level: "L1", effects: ["push-branch", "open-pr"], budget: { runs: 8, minutes: 120 }, ask_first: [] };

// failed 的退避：第 1、2 次失败分别隔 1 分钟、5 分钟再派；连续第 3 次转受阻，出卡片问人。
export const RETRY_BACKOFF_MS = [60_000, 300_000];
export const MAX_FAILURES = RETRY_BACKOFF_MS.length + 1;
const WAIT_FALLBACK_MS = 3_600_000;     // later 没给 timeout 或认不出时，1 小时后回来看一眼，不无限等
const RATE_LIMIT_FALLBACK_MS = 900_000; // 限流但拿不到重置时间：15 分钟后再试
// 看门狗的确定性检查（P1-19）。接单程序每 30 秒心跳一次，连续 6 次没到算心跳超时；
// 单轮超过预算时长再加 5 分钟宽限算单轮超时（接单程序自己会先在预算时长处结束进程，这里是兜底）。
// 阈值写死在归并里而不放配置，保证改配置后重放结果不变。
export const HEARTBEAT_TIMEOUT_MS = 180_000;
export const RUN_GRACE_MS = 300_000;

export const handlers: Record<string, Handler> = {
  // 人说目标：主理人整理后确认，或小而明确的请求直接立项。
  "goal.confirmed": (db, e) => {
    const p = e.payload as { title: string; acceptance?: string[]; boundaries?: string[]; grant?: Partial<Grant> };
    const id = formatId("G", nextId(db, "goal"));
    const grant = { ...DEFAULT_GRANT, ...(p.grant ?? {}) };
    db.prepare(`INSERT INTO goals VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
      .run(id, p.title, JSON.stringify(p.acceptance ?? []), JSON.stringify(p.boundaries ?? []), JSON.stringify(grant), e.seq, e.at, e.at);
    // 一期：默认不拆，一个目标一个任务。二期由规划生成任务图（P2）。
    const tid = formatId("T", nextId(db, "task"));
    const contract: TaskContract = {
      objective: p.title,
      acceptance: { checks: [], criteria: p.acceptance ?? [] },
      scope: { write: ["**"], effects: grant.effects },
      budget: grant.budget, ask_first: grant.ask_first, depends_on: [],
      agent: { kind: "code", tier: "strong" },
    };
    db.prepare(`INSERT INTO tasks(id, goal_id, state, contract, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)`)
      .run(tid, id, JSON.stringify(contract), e.at, e.at);
    link(db, e.seq, id); link(db, e.seq, tid);
  },

  // 领活：轮次编号在这里签发。内核的 /runs/claim 在同一事务里挑任务并落这条事件，再把编号返回给接单程序。
  "run.claimed": (db, e) => {
    const p = e.payload as { task_id: string; agent: string; purpose: string; worker?: string; instance?: string };
    const rid = formatId("RN", nextId(db, "run"));
    db.prepare(`INSERT INTO runs(id, task_id, agent, purpose, status, started_at, heartbeat_at, worker, instance) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
      .run(rid, p.task_id, p.agent, p.purpose, e.at, e.at, p.worker ?? null, p.instance ?? null);
    setTaskState(db, p.task_id, "running", e.at);
    db.prepare(`UPDATE tasks SET runs_used = runs_used + 1 WHERE id = ?`).run(p.task_id);
    link(db, e.seq, rid);
  },

  // 心跳顺带报会话编号：轮次中途断掉时，恢复的那一轮还能接上原会话。
  "run.heartbeat": (db, e) => {
    const p = e.payload as { run_id: string; session_id?: string };
    db.prepare(`UPDATE runs SET heartbeat_at = ?, session_id = COALESCE(session_id, ?) WHERE id = ? AND status = 'running'`)
      .run(e.at, p.session_id ?? null, p.run_id);
  },

  // 内核重启（P1-14）：接单程序和 Agent 进程是另外的进程，内核停机不等于它们停了。
  // 所以这里不判中断，只把执行中轮次的心跳时间刷新到重启时刻，给它们一个心跳超时的宽限；
  // 进程真不在了，由看门狗的心跳超时或接单程序重启报到来判。
  "kernel.restarted": (db, e) => graceRunning(db, e, "内核重启"),
  // 定时器来源发现时间跳了一大段（机器睡眠、进程挂起）：同样给执行中的轮次一个宽限。
  "timer.resumed": (db, e) => graceRunning(db, e, "机器睡眠或挂起后恢复"),

  // 接单程序启动时报到：同名接单程序的旧实例领的轮次，进程已随旧实例不在，立即判中断。
  "worker.started": (db, e) => {
    const p = e.payload as { worker: string; instance: string };
    const runs = db.prepare(`SELECT id FROM runs WHERE status = 'running' AND worker = ? AND instance IS NOT ?`).all(p.worker, p.instance) as { id: string }[];
    for (const r of runs) markLost(db, e, r.id, "接单程序重启");
  },

  // 回执到了：按六种结果决定任务去向。卡片的生成也在这里，保证与回执同事务。
  "run.receipt": (db, e) => {
    const p = e.payload as { run_id: string; task_id: string; session_id?: string; receipt: Receipt };
    const run = db.prepare(`SELECT status FROM runs WHERE id = ?`).get(p.run_id) as { status: string } | undefined;
    // 迟到的回执（本轮已被取消，或重复投递）只记录在轮次上，不改任务状态，不出卡片。
    if (run && run.status !== "running") {
      db.prepare(`UPDATE runs SET receipt = COALESCE(receipt, ?), session_id = COALESCE(session_id, ?) WHERE id = ?`)
        .run(JSON.stringify(p.receipt), p.session_id ?? null, p.run_id);
      return;
    }
    db.prepare(`UPDATE runs SET status = 'finished', finished_at = ?, session_id = ?, receipt = ? WHERE id = ?`)
      .run(e.at, p.session_id ?? null, JSON.stringify(p.receipt), p.run_id);
    if (p.session_id) db.prepare(`UPDATE tasks SET session_id = ? WHERE id = ?`).run(p.session_id, p.task_id);
    if (getTask(db, p.task_id)?.state !== "running") return;
    const r = p.receipt;
    // 带给这一轮的反馈和恢复说明已经用掉；连续失败计数只在 failed 时累加。
    db.prepare(`UPDATE tasks SET feedback = NULL, recovery = NULL, failures = CASE WHEN ? = 'failed' THEN failures + 1 ELSE 0 END WHERE id = ?`)
      .run(r.outcome, p.task_id);
    switch (r.outcome) {
      case "done":
        setTaskState(db, p.task_id, "verifying", e.at);
        // 一期先不做独立验证者，直接出审核卡（L1）。二期接 Codex 做验证（P2）。
        setTaskState(db, p.task_id, "awaiting_review", e.at);
        createCard(db, e, "review", p.task_id, `审核：${r.summary}`, reviewBody(r),
          [{ key: "accept", label: "接受", recommended: true }, { key: "return", label: "退回" }, { key: "takeover", label: "接管" }],
          `review:${p.task_id}:${p.run_id}`);
        break;
      case "ask": {
        setTaskState(db, p.task_id, "awaiting_answer", e.at);
        const a = r.ask![0]!;
        createCard(db, e, "decision", p.task_id, a.question, a.why ?? "",
          (a.options ?? []).map((o) => ({ key: o, label: o, recommended: o === a.recommended })),
          `ask:${p.task_id}:${a.question}`);
        break;
      }
      case "waiting":
        setTaskState(db, p.task_id, "awaiting_world", e.at);
        for (const l of r.later ?? []) {
          if (l.on) db.prepare(`INSERT OR IGNORE INTO subscriptions VALUES (?, ?)`).run(p.task_id, l.on);
          // 相对时长从回执事件的 at 起算；订阅要到三期才会触发，所以没给 timeout 也设一个兜底定时器。
          addTimer(db, p.task_id, dueAt(e.at, l.timeout, WAIT_FALLBACK_MS), l.about || r.summary);
        }
        if (!r.later?.length) addTimer(db, p.task_id, dueAt(e.at, undefined, WAIT_FALLBACK_MS), r.summary);
        break;
      case "blocked":
        setTaskState(db, p.task_id, "blocked", e.at);
        createCard(db, e, "decision", p.task_id, `受阻：${r.summary}`, r.handoff ?? "", [{ key: "unblocked", label: "已解除，继续" }, { key: "abandon", label: "放弃" }], `blocked:${p.task_id}`);
        break;
      case "failed": {
        // 临时故障退避重试，连续失败转受阻。退避用定时器表达：任务“等世界”到点再回队列，调度不必读时钟。
        const n = getTask(db, p.task_id)!.failures;
        if (n >= MAX_FAILURES) {
          setTaskState(db, p.task_id, "blocked", e.at);
          createCard(db, e, "decision", p.task_id, `连续失败 ${n} 次：${r.summary}`, r.handoff ?? "",
            [{ key: "unblocked", label: "已解除，继续" }, { key: "abandon", label: "放弃" }], `blocked:${p.task_id}`);
        } else {
          setTaskState(db, p.task_id, "awaiting_world", e.at);
          addTimer(db, p.task_id, new Date(Date.parse(e.at) + RETRY_BACKOFF_MS[n - 1]!).toISOString(), `第 ${n} 次失败后退避重试`);
        }
        break;
      }
      case "nothing":
        setTaskState(db, p.task_id, "done", e.at);
        break;
    }
    for (const f of r.found ?? []) {
      // 范围外事项送去研判（三期）。一期只记一张知会卡。
      createCard(db, e, "notice", p.task_id, `发现：${f.title}`, f.why ?? "", [], `found:${p.task_id}:${f.title}`);
    }
  },

  // 订阅额度用尽不算失败：任务转“等世界”，定时器设在额度重置时间（P1-12 的最小版）。
  "run.rate_limited": (db, e) => {
    const p = e.payload as { run_id?: string; task_id: string; resets_at?: number };
    if (p.run_id) db.prepare(`UPDATE runs SET status = 'finished', finished_at = ? WHERE id = ? AND status = 'running'`).run(e.at, p.run_id);
    if (getTask(db, p.task_id)?.state !== "running") return;
    setTaskState(db, p.task_id, "awaiting_world", e.at);
    const due = p.resets_at ? new Date(p.resets_at * 1000).toISOString() : dueAt(e.at, undefined, RATE_LIMIT_FALLBACK_MS);
    addTimer(db, p.task_id, due, "订阅额度重置");
  },

  // 时间也是事件：到期的定时器把“等世界”的任务放回队列。比较的是事件自带的 at，不是内核的时钟。
  "timer.tick": (db, e) => {
    const now = Date.parse(e.at);
    const timers = db.prepare(`SELECT id, about, due_at FROM timers WHERE fired = 0`).all() as { id: number; about: string; due_at: string }[];
    for (const t of timers) {
      if (Date.parse(t.due_at) > now) continue;
      db.prepare(`UPDATE timers SET fired = 1 WHERE id = ?`).run(t.id);
      const task = getTask(db, t.about);
      if (task?.state !== "awaiting_world") continue;
      setTaskState(db, task.id, "queued", e.at);
      clearWaits(db, task.id);
      link(db, e.seq, task.id, `定时器到点（${t.due_at}），回队列`);
    }
    watchdog(db, e);
  },

  // 人回答了卡片：回答本身是一条事件；回答落成定论；任务接上，回答作为下一轮的反馈。
  "card.answered": (db, e) => {
    const p = e.payload as { card_id: string; choice?: string; text?: string; scope?: RulingScope };
    const card = db.prepare(`SELECT * FROM cards WHERE id = ?`).get(p.card_id) as { id: string; about: string; kind: CardKind; status: string; title: string } | undefined;
    if (!card || card.status !== "open") return; // 重复或过期的回答只记录
    db.prepare(`UPDATE cards SET status = 'answered', answer = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ choice: p.choice, text: p.text, scope: p.scope }), e.at, p.card_id);
    if (p.text || (p.scope && p.scope !== "task")) {
      const rid = formatId("R", nextId(db, "ruling"));
      db.prepare(`INSERT INTO rulings VALUES (?, ?, ?, ?, ?, ?, 0)`)
        .run(rid, p.scope ?? "task", card.about, p.text ?? `${card.title} → ${p.choice}`, p.card_id, e.at);
      link(db, e.seq, rid);
    }
    const task = getTask(db, card.about);
    if (!task) return;
    if (card.kind === "review") {
      if (p.choice === "accept") setTaskState(db, task.id, "done", e.at);
      else if (p.choice === "return") {
        setTaskState(db, task.id, "queued", e.at);
        setFeedback(db, task.id, `审核退回（${card.id}）：${p.text ?? "没有附说明，请对照验收标准自查"}`);
      } else if (p.choice === "takeover") setTaskState(db, task.id, "stopped", e.at);
    } else if (card.kind === "decision") {
      if (p.choice === "abandon") setTaskState(db, task.id, "abandoned", e.at);
      else {
        setTaskState(db, task.id, "queued", e.at);  // 答复到了再接上原会话
        db.prepare(`UPDATE tasks SET failures = 0 WHERE id = ?`).run(task.id);
        setFeedback(db, task.id, `人对“${card.title}”（${card.id}）的回答：${p.choice ?? ""}${p.text ? `；说明：${p.text}` : ""}`);
      }
    }
  },

  "human.stop": (db, e) => {
    const p = e.payload as { about: string };
    const task = getTask(db, p.about);
    if (task && !["done", "abandoned", "stopped"].includes(task.state)) setTaskState(db, task.id, "stopped", e.at);
    db.prepare(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE task_id = ? AND status = 'running'`).run(e.at, p.about);
    if (task) clearWaits(db, task.id);
  },

  "card.delivered": (db, e) => {
    const p = e.payload as { card_id: string; external_ref: string };
    db.prepare(`UPDATE cards SET external_ref = ?, updated_at = ? WHERE id = ?`).run(p.external_ref, e.at, p.card_id);
  },

  // 接单程序从 Claude Code 的 stream-json 里读到的额度读数（实测 S3 的结论）。
  "quota.observed": (db, e) => {
    const p = e.payload as { agent: string; seven_day?: { utilization: number; resetsAt: number }; five_hour?: { utilization: number; resetsAt: number } };
    db.prepare(`INSERT INTO quota VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(agent) DO UPDATE SET
      seven_day_utilization = excluded.seven_day_utilization, seven_day_resets_at = excluded.seven_day_resets_at,
      five_hour_utilization = excluded.five_hour_utilization, five_hour_resets_at = excluded.five_hour_resets_at, observed_at = excluded.observed_at`)
      .run(p.agent, p.seven_day?.utilization ?? null, p.seven_day ? String(p.seven_day.resetsAt) : null,
        p.five_hour?.utilization ?? null, p.five_hour ? String(p.five_hour.resetsAt) : null, e.at);
  },

  // TODO P3:   "env.*" → 准入门、研判、订阅直达。
};

function graceRunning(db: DB, e: Event, why: string): void {
  const runs = db.prepare(`SELECT id, task_id FROM runs WHERE status = 'running'`).all() as { id: string; task_id: string }[];
  for (const r of runs) {
    db.prepare(`UPDATE runs SET heartbeat_at = ? WHERE id = ?`).run(e.at, r.id);
    link(db, e.seq, r.id, `${why}，等它恢复心跳`);
    link(db, e.seq, r.task_id, `${r.id} 执行中，${why}后等它恢复心跳`);
  }
}

// ---- 看门狗（P1-19）：每次 timer.tick 跑一遍确定性检查。只比较事件自带的 at，不读时钟。----
function watchdog(db: DB, e: Event): void {
  const now = Date.parse(e.at);
  const runs = db.prepare(`SELECT r.id, r.started_at, r.heartbeat_at, t.contract FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.status = 'running'`)
    .all() as { id: string; started_at: string; heartbeat_at: string; contract: string }[];
  for (const r of runs) {
    const budgetMs = (JSON.parse(r.contract) as TaskContract).budget.minutes * 60_000;
    if (now - Date.parse(r.started_at) > budgetMs + RUN_GRACE_MS) markLost(db, e, r.id, `单轮超时（预算 ${budgetMs / 60_000} 分钟）`);
    else if (now - Date.parse(r.heartbeat_at) > HEARTBEAT_TIMEOUT_MS) markLost(db, e, r.id, `心跳超时（最后心跳 ${r.heartbeat_at}）`);
  }
}

// 轮次中断：标为 lost，任务带恢复说明回队列；知道会话编号就接上原会话。
// 中断和 failed 共用连续失败计数：连续第 3 次不再自动重派，转受阻出卡片（处置阶梯的最后一级）。
function markLost(db: DB, e: Event, runId: string, reason: string): void {
  const run = db.prepare(`SELECT task_id, session_id FROM runs WHERE id = ?`).get(runId) as { task_id: string; session_id: string | null };
  db.prepare(`UPDATE runs SET status = 'lost', finished_at = ?, lost_reason = ? WHERE id = ?`).run(e.at, reason, runId);
  link(db, e.seq, runId, `中断：${reason}`);
  const task = getTask(db, run.task_id);
  if (task?.state !== "running") { link(db, e.seq, run.task_id, `${runId} 中断：${reason}`); return; }
  db.prepare(`UPDATE tasks SET failures = failures + 1, session_id = COALESCE(session_id, ?) WHERE id = ?`).run(run.session_id, task.id);
  const n = task.failures + 1;
  if (n >= MAX_FAILURES) {
    setTaskState(db, task.id, "blocked", e.at);
    createCard(db, e, "decision", task.id, `连续 ${n} 次失败或中断：${reason}`, `最近一轮 ${runId}。确认环境没问题后选“已解除，继续”。`,
      [{ key: "unblocked", label: "已解除，继续" }, { key: "abandon", label: "放弃" }], `blocked:${task.id}`);
    link(db, e.seq, task.id, `${runId} 中断：${reason}；连续第 ${n} 次，转受阻`);
    return;
  }
  setTaskState(db, task.id, "queued", e.at);
  db.prepare(`UPDATE tasks SET recovery = ? WHERE id = ?`).run(recoveryNote(runId, reason), task.id);
  link(db, e.seq, task.id, `${runId} 中断：${reason}；带恢复说明回队列`);
}

export function recoveryNote(runId: string, reason: string): string {
  return `上一轮 ${runId} 没有交回执就中断了（${reason}），它可能做了一半。` +
    `先检查工作目录、git 历史和远端状态，弄清上一轮已经做到哪一步，再接着做。` +
    `已经做过的对外动作（push、开 PR、发消息等）不要重复；拿不准是否已经做过时，先查证，查不到就交 ask 回执问人。`;
}

export function reduce(db: DB, e: Event): void {
  handlers[e.type]?.(db, e);
  // 引用图最小版（P1-18）：事件涉及的编号一律回写关联表。处理器签发的新编号在处理器里已经写过。
  const p = e.payload as Record<string, unknown>;
  for (const ref of [e.about, p.task_id, p.run_id, p.about]) if (typeof ref === "string") link(db, e.seq, ref);
  if (typeof p.card_id === "string") {
    link(db, e.seq, p.card_id);
    const card = db.prepare(`SELECT about FROM cards WHERE id = ?`).get(p.card_id) as { about: string } | undefined;
    if (card) link(db, e.seq, card.about);
  }
}

// 把一条事件挂到一个编号上。挂到任务上时顺带挂到它的目标上，这样 xj why G-x 也能看到整条线。
// note 写明归并对这个编号做了什么；同一条事件对同一编号的说明只留第一条。
export function link(db: DB, seq: number, ref: string, note?: string): void {
  if (!ref) return;
  const put = (r: string) => {
    db.prepare(`INSERT OR IGNORE INTO event_refs(ref, seq, note) VALUES (?, ?, ?)`).run(r, seq, note ?? null);
    if (note) db.prepare(`UPDATE event_refs SET note = ? WHERE ref = ? AND seq = ? AND note IS NULL`).run(note, r, seq);
  };
  put(ref);
  if (/^T-\d+$/.test(ref)) {
    const t = db.prepare(`SELECT goal_id FROM tasks WHERE id = ?`).get(ref) as { goal_id: string } | undefined;
    if (t) put(t.goal_id);
  }
}

// ---- 小工具 ----
export function getTask(db: DB, id: string): Task | undefined {
  const r = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? { ...(r as unknown as Task), contract: JSON.parse(r.contract as string) } : undefined;
}

export function getGoal(db: DB, id: string): Goal | undefined {
  const r = db.prepare(`SELECT * FROM goals WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  return { id: r.id as string, title: r.title as string, acceptance: JSON.parse(r.acceptance as string), boundaries: JSON.parse(r.boundaries as string),
    grant: JSON.parse(r.grant_json as string), status: r.status as Goal["status"], origin_event: r.origin_event as number,
    created_at: r.created_at as string, updated_at: r.updated_at as string };
}

function setTaskState(db: DB, taskId: string, to: TaskState, at: string): void {
  const t = getTask(db, taskId);
  if (!t) throw new Error(`任务不存在：${taskId}`);
  if (t.state === to) return;
  assertTransition(taskId, t.state, to);
  db.prepare(`UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?`).run(to, at, taskId);
}

function setFeedback(db: DB, taskId: string, text: string): void {
  db.prepare(`UPDATE tasks SET feedback = ? WHERE id = ?`).run(text, taskId);
}

function addTimer(db: DB, about: string, due: string, reason: string): void {
  db.prepare(`INSERT INTO timers(about, due_at, reason) VALUES (?, ?, ?)`).run(about, due, reason);
}

// 任务离开“等世界”后，它剩下的定时器和订阅作废，免得下次等待时被旧定时器提前叫醒。
function clearWaits(db: DB, taskId: string): void {
  db.prepare(`UPDATE timers SET fired = 1 WHERE about = ? AND fired = 0`).run(taskId);
  db.prepare(`DELETE FROM subscriptions WHERE task_id = ?`).run(taskId);
}

function reviewBody(r: Receipt): string {
  const ev = (r.evidence ?? []).map((x) => x.check ? `${x.check} → ${x.result ?? ""}` : `${x.artifact ?? ""} ${x.ref ?? ""}`).join("；");
  return [r.handoff ?? r.summary, ev && `证据：${ev}`].filter(Boolean).join("\n");
}

const CARD_BODY_MAX = 400;

function createCard(db: DB, e: Event, kind: CardKind, about: string, title: string, body: string, options: CardOption[], dedupeKey: string): void {
  const open = db.prepare(`SELECT id FROM cards WHERE dedupe_key = ? AND status = 'open'`).get(dedupeKey);
  if (open) return; // 同一个问题还开着时不重复发
  const id = formatId("C", nextId(db, "card"));
  db.prepare(`INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, ?)`)
    .run(id, kind, about, title, body.slice(0, CARD_BODY_MAX), JSON.stringify(options), dedupeKey, e.at, e.at);
  link(db, e.seq, id);
}
