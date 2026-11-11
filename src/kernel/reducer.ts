// 归并：一条事件如何改变投影。纯函数式思路：输入 (db, event)，只写投影表，不做 IO，不读时钟。
// 每种事件一个处理器。没有处理器的事件只记录，这就是“只记录”的含义。
import type { DB } from "./store.ts";
import { nextId } from "./store.ts";
import { formatId } from "../shared/ids.ts";
import { assertTransition } from "./state.ts";
import type { Event, Goal, Grant, Task, TaskContract, TaskState, Receipt, CardKind, CardOption, RulingScope } from "./types.ts";

export type Handler = (db: DB, e: Event) => void;

const DEFAULT_GRANT: Grant = { level: "L1", effects: ["push-branch", "open-pr"], budget: { runs: 8, minutes: 120 }, ask_first: [] };

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
  },

  "run.claimed": (db, e) => {
    const p = e.payload as { task_id: string; agent: string; purpose: string };
    const rid = formatId("RN", nextId(db, "run"));
    db.prepare(`INSERT INTO runs(id, task_id, agent, purpose, status, started_at, heartbeat_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`)
      .run(rid, p.task_id, p.agent, p.purpose, e.at, e.at);
    setTaskState(db, p.task_id, "running", e.at);
    db.prepare(`UPDATE tasks SET runs_used = runs_used + 1 WHERE id = ?`).run(p.task_id);
  },

  "run.heartbeat": (db, e) => {
    const p = e.payload as { run_id: string };
    db.prepare(`UPDATE runs SET heartbeat_at = ? WHERE id = ?`).run(e.at, p.run_id);
  },

  // 回执到了：按六种结果决定任务去向。卡片的生成也在这里，保证与回执同事务。
  "run.receipt": (db, e) => {
    const p = e.payload as { run_id: string; task_id: string; session_id?: string; receipt: Receipt };
    db.prepare(`UPDATE runs SET status = 'finished', finished_at = ?, session_id = ?, receipt = ? WHERE id = ?`)
      .run(e.at, p.session_id ?? null, JSON.stringify(p.receipt), p.run_id);
    if (p.session_id) db.prepare(`UPDATE tasks SET session_id = ? WHERE id = ?`).run(p.session_id, p.task_id);
    // 迟到的回执（本轮已被取消，或重复投递）只记录在轮次上，不改任务状态，不出卡片。
    if (getTask(db, p.task_id)?.state !== "running") return;
    const r = p.receipt;
    switch (r.outcome) {
      case "done":
        setTaskState(db, p.task_id, "verifying", e.at);
        // TODO P1: 一期先不做独立验证者，直接出审核卡（L1）。二期接 Codex 做验证（P2）。
        setTaskState(db, p.task_id, "awaiting_review", e.at);
        createCard(db, e, "review", p.task_id, `审核：${r.summary}`, r.handoff ?? r.summary,
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
          if (l.timeout) db.prepare(`INSERT INTO timers(about, due_at, reason) VALUES (?, ?, ?)`).run(p.task_id, l.timeout, l.about);
          // TODO P1-08: timeout 是相对时长（"2h"），due_at 需要由事件的 at 加上时长算出；放这里的是占位。
        }
        break;
      case "blocked":
        setTaskState(db, p.task_id, "blocked", e.at);
        createCard(db, e, "decision", p.task_id, `受阻：${r.summary}`, r.handoff ?? "", [{ key: "unblocked", label: "已解除，继续" }, { key: "abandon", label: "放弃" }], `blocked:${p.task_id}`);
        break;
      case "failed":
        // TODO P1-07: 临时故障退避重试，连续失败转受阻。一期先直接回队列。
        setTaskState(db, p.task_id, "queued", e.at);
        break;
      case "nothing":
        setTaskState(db, p.task_id, "done", e.at);
        break;
    }
    for (const f of r.found ?? []) {
      // 范围外事项送去研判（三期）。一期只记一张知会卡。
      createCard(db, e, "notice", p.task_id, `发现：${f.title}`, f.why ?? "", [], `found:${p.task_id}:${f.title}`);
    }
  },

  // 人回答了卡片：回答本身是一条事件；回答落成定论；任务接上。
  "card.answered": (db, e) => {
    const p = e.payload as { card_id: string; choice?: string; text?: string; scope?: RulingScope };
    const card = db.prepare(`SELECT * FROM cards WHERE id = ?`).get(p.card_id) as { about: string; kind: CardKind; status: string; title: string } | undefined;
    if (!card || card.status !== "open") return; // 重复或过期的回答只记录
    db.prepare(`UPDATE cards SET status = 'answered', answer = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ choice: p.choice, text: p.text, scope: p.scope }), e.at, p.card_id);
    if (p.text || (p.scope && p.scope !== "task")) {
      const rid = formatId("R", nextId(db, "ruling"));
      db.prepare(`INSERT INTO rulings VALUES (?, ?, ?, ?, ?, ?, 0)`)
        .run(rid, p.scope ?? "task", card.about, p.text ?? `${card.title} → ${p.choice}`, p.card_id, e.at);
    }
    const task = getTask(db, card.about);
    if (!task) return;
    if (card.kind === "review") {
      if (p.choice === "accept") setTaskState(db, task.id, "done", e.at);
      else if (p.choice === "return") setTaskState(db, task.id, "queued", e.at);
      else if (p.choice === "takeover") setTaskState(db, task.id, "stopped", e.at);
    } else if (card.kind === "decision") {
      if (p.choice === "abandon") setTaskState(db, task.id, "abandoned", e.at);
      else setTaskState(db, task.id, "queued", e.at);  // 答复到了再接上原会话
    }
  },

  "human.stop": (db, e) => {
    const p = e.payload as { about: string };
    const task = getTask(db, p.about);
    if (task) setTaskState(db, task.id, "stopped", e.at);
    db.prepare(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE task_id = ? AND status = 'running'`).run(e.at, p.about);
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

  // TODO P1-12: "run.rate_limited" → 任务转 awaiting_world，定时器设在重置时间。
  // TODO P1-14: "kernel.restarted" → 执行中但进程已不在的轮次标为 lost，任务回队列并附恢复说明。
  // TODO P3:   "env.*" → 准入门、研判、订阅直达。
};

export function reduce(db: DB, e: Event): void {
  handlers[e.type]?.(db, e);
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

const CARD_BODY_MAX = 400;

function createCard(db: DB, e: Event, kind: CardKind, about: string, title: string, body: string, options: CardOption[], dedupeKey: string): void {
  const open = db.prepare(`SELECT id FROM cards WHERE dedupe_key = ? AND status = 'open'`).get(dedupeKey);
  if (open) return; // 同一个问题还开着时不重复发
  const id = formatId("C", nextId(db, "card"));
  db.prepare(`INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, ?)`)
    .run(id, kind, about, title, body.slice(0, CARD_BODY_MAX), JSON.stringify(options), dedupeKey, e.at, e.at);
}
