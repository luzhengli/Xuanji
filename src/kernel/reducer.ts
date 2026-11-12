// 归并：一条事件如何改变投影。纯函数式思路：输入 (db, event)，只写投影表，不做 IO，不读时钟。
// 每种事件一个处理器。没有处理器的事件只记录，这就是“只记录”的含义。
import type { DB } from "./store.ts";
import { nextId } from "./store.ts";
import { formatId } from "../shared/ids.ts";
import { dueAt } from "../shared/duration.ts";
import { assertTransition, waitingOn } from "./state.ts";
import { BUDGET_EXTEND, overBudget, runLimitMinutes } from "./budget.ts";
import { TITLE_MAX, goalCardBody, normalizeDraft, minutesText } from "./intake.ts";
import type { Event, Goal, GoalStatus, Grant, Task, TaskContract, TaskState, Receipt, CardKind, CardForm, CardOption, RulingScope,
  Draft, IntakeInput, Judgment, JudgmentKind, PendingGoal, Effect, ReceiptEffect } from "./types.ts";

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
// 判断点不给工具、不发心跳，接单程序 3 分钟结束进程；内核这里 5 分钟没结果就判失败，重新排队。
export const JUDGMENT_TIMEOUT_MS = 300_000;
// 备份每小时一次；最近一次成功超过 3 小时（连着 3 次没成）就出异常卡。
export const BACKUP_STALE_MS = 3 * 3_600_000;
// 对外动作（P1-21）：可重试的失败第 1、2 次分别隔 1 分钟、5 分钟再试，第 3 次还不行就问人；执行超过 5 分钟没结果算一次可重试的失败。
export const EFFECT_BACKOFF_MS = [60_000, 300_000];
export const EFFECT_TIMEOUT_MS = 300_000;
export const SUPPORTED_EFFECTS = ["push-branch", "open-pr"];
export const EFFECT_OPTIONS: CardOption[] = [
  { key: "retry", label: "重试", recommended: true }, { key: "skip", label: "跳过，直接审核" }, { key: "abandon", label: "放弃" },
];

// 目标卡的三个按钮（人定 2026-11-12：确认 / 修改 / 不做，文字框写修改意见）。
export const GOAL_OPTIONS: CardOption[] = [
  { key: "confirm", label: "确认", recommended: true }, { key: "revise", label: "修改", needs_text: true }, { key: "drop", label: "不做" },
];
// 超预算卡（人定 2026-11-12：追加 / 停掉 / 接管，推荐停掉；不答就一直停着，不因超时自动执行）。
export const BUDGET_OPTIONS: CardOption[] = [
  { key: "extend", label: `追加 ${BUDGET_EXTEND.runs} 轮和 ${minutesText(BUDGET_EXTEND.minutes)}` },
  { key: "stop", label: "停掉", recommended: true }, { key: "takeover", label: "接管" },
];

export const handlers: Record<string, Handler> = {
  // 人直接立项（xj goal --direct；P1-10 之前的飞书私聊也走这里）。不经主理人。
  "goal.confirmed": (db, e) => {
    const p = e.payload as { title: string; acceptance?: string[]; boundaries?: string[]; grant?: Partial<Grant> };
    const grant = { ...DEFAULT_GRANT, ...(p.grant ?? {}) };
    const id = insertGoal(db, e, p.title, p.acceptance ?? [], p.boundaries ?? [], grant, "active");
    createTask(db, e, id);
  },

  // 人说了一句话（P1-10）：先记一个待确认的目标，排一个主理人判断点，由它整理成目标卡。
  "human.message": (db, e) => {
    const text = String((e.payload as { text?: unknown }).text ?? "").trim();
    if (!text) return;
    const pending = pendingGoals(db);   // 先算，不含这句话自己的目标
    const id = insertGoal(db, e, text.slice(0, TITLE_MAX), [], [], DEFAULT_GRANT, "proposed");
    queueJudgment(db, e, "intake", id, { request: text, revision: 0, ...(pending.length ? { pending } : {}) });
  },

  // 判断点被领走。编号在排队时已经签发，这里只记谁在做。
  "judgment.claimed": (db, e) => {
    const p = e.payload as { judgment_id: string; agent: string; worker?: string; instance?: string };
    db.prepare(`UPDATE judgments SET status = 'running', agent = ?, worker = ?, instance = ?, started_at = ?, finished_at = NULL WHERE id = ? AND status = 'queued'`)
      .run(p.agent, p.worker ?? null, p.instance ?? null, e.at, p.judgment_id);
  },

  // 判断点的结果。迟到的（已判超时、已重新排队）只记录。输出在这里再清洗一遍，不信任模型给的权限字段。
  "judgment.result": (db, e) => {
    const p = e.payload as { judgment_id: string; output?: unknown; error?: string; session_id?: string };
    const j = getJudgment(db, p.judgment_id);
    if (!j || j.status !== "running") return;
    db.prepare(`UPDATE judgments SET output = ?, session_id = ? WHERE id = ?`)
      .run(p.output === undefined ? null : JSON.stringify(p.output), p.session_id ?? null, j.id);
    const d = p.error ? { ok: false as const, error: p.error } : normalizeDraft(p.output);
    if (!d.ok) { judgmentFailed(db, e, j, d.error); return; }
    db.prepare(`UPDATE judgments SET status = 'finished', finished_at = ?, error = NULL WHERE id = ?`).run(e.at, j.id);
    if (j.kind === "intake") onIntake(db, e, j, d.draft);
  },

  // 备份（P1-15）：备份来源报来的结果。成功就撤回还开着的异常卡，失败出异常卡（推送）。
  "backup.done": (db, e) => {
    const p = e.payload as { path: string; bytes: number };
    putBackup(db, "snapshot", true, e.at, `${p.path}（${p.bytes} 字节）`);
    withdrawAlert(db, e, "alert:backup", "备份恢复正常");
  },
  "backup.failed": (db, e) => {
    const p = e.payload as { error: string };
    putBackup(db, "snapshot", false, e.at, p.error);
    alert(db, e, "alert:backup", "备份失败", `${p.error}\n${lastBackupLine(db, e.at)}。账本没有快照就防不了误操作和文件损坏，请看内核日志。`);
  },
  "backup.drilled": (db, e) => {
    const p = e.payload as { ok: boolean; snapshot: string; events: number; integrity: string; mismatches: string[] };
    const detail = p.ok ? `${p.snapshot}：完整性 ok，重放 ${p.events} 条事件，投影一致`
      : `${p.snapshot}：完整性 ${p.integrity || "未检查"}；${p.mismatches.join("；") || "没有比对结果"}`;
    putBackup(db, "drill", p.ok, e.at, detail);
    if (p.ok) withdrawAlert(db, e, "alert:drill", "恢复演练通过");
    else alert(db, e, "alert:drill", "恢复演练没通过", `${detail}\n快照可能恢复不出现在的状态，或者重放结果和在线投影不一致。`);
  },

  // 每日简报（P1-17），兼作心跳；汇总过的知会卡收起（P1-22）。定时器来源每天到点发一次，人也可以手动要。
  "brief.due": (db, e) => brief(db, e),

  // 领活：轮次编号在这里签发。内核的 /runs/claim 在同一事务里挑任务并落这条事件，再把编号返回给接单程序。
  "run.claimed": (db, e) => {
    const p = e.payload as { task_id: string; agent: string; purpose: string; worker?: string; instance?: string };
    const rid = formatId("RN", nextId(db, "run"));
    db.prepare(`INSERT INTO runs(id, task_id, agent, purpose, status, started_at, heartbeat_at, worker, instance) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
      .run(rid, p.task_id, p.agent, p.purpose, e.at, e.at, p.worker ?? null, p.instance ?? null);
    setTaskState(db, p.task_id, "running", e.at);
    // 记下这一轮带走的反馈：回执到了只清掉这部分，跑的过程中新到的补充留给下一轮（P1-23）。
    db.prepare(`UPDATE runs SET feedback = (SELECT feedback FROM tasks WHERE id = ?) WHERE id = ?`).run(p.task_id, rid);
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
    const js = db.prepare(`SELECT id FROM judgments WHERE status = 'running' AND worker = ? AND instance IS NOT ?`).all(p.worker, p.instance) as { id: string }[];
    for (const j of js) judgmentFailed(db, e, getJudgment(db, j.id)!, "接单程序重启");
    const fx = db.prepare(`SELECT id FROM effects WHERE status = 'running' AND worker = ? AND instance IS NOT ?`).all(p.worker, p.instance) as { id: string }[];
    for (const x of fx) effectFailed(db, e, getEffect(db, x.id)!, "接单程序重启", true);
  },

  // 回执到了：按六种结果决定任务去向。卡片的生成也在这里，保证与回执同事务。
  "run.receipt": (db, e) => {
    const p = e.payload as { run_id: string; task_id: string; session_id?: string; receipt: Receipt };
    const run = db.prepare(`SELECT status, feedback FROM runs WHERE id = ?`).get(p.run_id) as { status: string; feedback: string | null } | undefined;
    // 迟到的回执（本轮已被取消，或重复投递）只记录在轮次上，不改任务状态，不出卡片。
    if (run && run.status !== "running") {
      db.prepare(`UPDATE runs SET receipt = COALESCE(receipt, ?), session_id = COALESCE(session_id, ?) WHERE id = ?`)
        .run(JSON.stringify(p.receipt), p.session_id ?? null, p.run_id);
      return;
    }
    db.prepare(`UPDATE runs SET status = 'finished', finished_at = ?, session_id = ?, receipt = ? WHERE id = ?`)
      .run(e.at, p.session_id ?? null, JSON.stringify(p.receipt), p.run_id);
    if (run) chargeRun(db, p.run_id, e.at);
    if (p.session_id) db.prepare(`UPDATE tasks SET session_id = ? WHERE id = ?`).run(p.session_id, p.task_id);
    if (getTask(db, p.task_id)?.state !== "running") return;
    const r = p.receipt;
    // 带给这一轮的反馈和恢复说明已经用掉（只清这一轮领走的那部分反馈）；连续失败计数只在 failed 时累加。
    const left = remainingFeedback(getTask(db, p.task_id)!.feedback, run?.feedback ?? null);
    db.prepare(`UPDATE tasks SET feedback = ?, recovery = NULL, failures = CASE WHEN ? = 'failed' THEN failures + 1 ELSE 0 END WHERE id = ?`)
      .run(left, r.outcome, p.task_id);
    // 对外动作先落账（P1-21）：和回执同一个事务写进 effects，接单程序随后执行。
    const pendingFx = requestEffects(db, e, getTask(db, p.task_id)!, p.run_id, r.effects ?? []);
    // 只在等自己请求的对外动作（waiting 但没写 later）：等的就是系统，按 done 处理，动作做完出审核卡。
    const outcome = r.outcome === "waiting" && pendingFx && !r.later?.length ? "done" : r.outcome;
    if (outcome !== r.outcome) link(db, e.seq, p.task_id, "回执在等自己请求的对外动作，按做完处理");
    switch (outcome) {
      case "done":
        // 跑的过程中人又补充了话：不出审核卡，带着补充立即开下一轮（设计“运行途中的新输入”）。
        if (left) { requeue(db, e, p.task_id, "回执到时已有新的补充，带着补充开下一轮"); break; }
        setTaskState(db, p.task_id, "verifying", e.at);
        // 一期先不做独立验证者（二期接 Codex，P2）。有对外动作就等它们做完再出审核卡，卡上带着结果。
        if (pendingFx) { link(db, e.seq, p.task_id, `等 ${pendingFx} 个对外动作做完再出审核卡`); break; }
        reviewCard(db, e, p.task_id, p.run_id);
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
        // 预算已经用完就不必退避了，直接停下出超预算卡。
        const t = getTask(db, p.task_id)!;
        const n = t.failures, over = overBudget(t);
        if (over) budgetStop(db, e, t, over);
        else if (n >= MAX_FAILURES) {
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
        if (left) requeue(db, e, p.task_id, "回执到时已有新的补充，带着补充开下一轮");
        else setTaskState(db, p.task_id, "done", e.at);
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
    if (p.run_id && db.prepare(`UPDATE runs SET status = 'finished', finished_at = ? WHERE id = ? AND status = 'running'`).run(e.at, p.run_id).changes) {
      chargeRun(db, p.run_id, e.at);
    }
    if (getTask(db, p.task_id)?.state !== "running") return;
    setTaskState(db, p.task_id, "awaiting_world", e.at);
    const due = p.resets_at ? new Date(p.resets_at * 1000).toISOString() : dueAt(e.at, undefined, RATE_LIMIT_FALLBACK_MS);
    addTimer(db, p.task_id, due, "订阅额度重置");
  },

  // 对外动作被领走（P1-21）。
  "effect.claimed": (db, e) => {
    const p = e.payload as { effect_id: string; worker?: string; instance?: string };
    db.prepare(`UPDATE effects SET status = 'running', attempts = attempts + 1, worker = ?, instance = ?, started_at = ?, finished_at = NULL WHERE id = ? AND status = 'queued'`)
      .run(p.worker ?? null, p.instance ?? null, e.at, p.effect_id);
  },

  // 对外动作的结果。迟到的（已判超时重排）只记录。
  "effect.result": (db, e) => {
    const p = e.payload as { effect_id: string; ok: boolean; ref?: string; detail?: string; retryable?: boolean };
    const x = getEffect(db, p.effect_id);
    if (!x || x.status !== "running") return;
    if (!p.ok) { effectFailed(db, e, x, p.detail ?? "没有说明", p.retryable === true); return; }
    db.prepare(`UPDATE effects SET status = 'done', result = ?, error = NULL, finished_at = ? WHERE id = ?`)
      .run(JSON.stringify({ ref: p.ref, detail: p.detail }), e.at, x.id);
    link(db, e.seq, x.task_id, `${x.id} ${describeEffect(x)} 完成${p.ref ? `：${p.ref}` : ""}`);
    settleEffects(db, e, x.task_id);
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
      clearWaits(db, task.id);
      requeue(db, e, task.id, `定时器到点（${t.due_at}），回队列`);
    }
    watchdog(db, e);
    backupWatch(db, e);
  },

  // 人回答了卡片：回答本身是一条事件；回答落成定论；任务接上，回答作为下一轮的反馈。
  "card.answered": (db, e) => {
    const p = e.payload as { card_id: string; choice?: string; text?: string; scope?: RulingScope };
    const card = db.prepare(`SELECT * FROM cards WHERE id = ?`).get(p.card_id) as AnsweredCard | undefined;
    if (!card || card.status !== "open" || card.kind === "notice") return; // 重复或过期的回答只记录；知会卡不需要回答
    db.prepare(`UPDATE cards SET status = 'answered', answer = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ choice: p.choice, text: p.text, scope: p.scope }), e.at, p.card_id);
    if (card.form === "goal") { answerGoalCard(db, e, card, p); return; }
    if (card.form === "budget") { answerBudgetCard(db, e, card, p); return; }
    if (card.form === "effect") { answerEffectCard(db, e, card, p); return; }
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
        setFeedback(db, task.id, `审核退回（${card.id}）：${p.text ?? "没有附说明，请对照验收标准自查"}`);
        requeue(db, e, task.id);
      } else if (p.choice === "takeover") setTaskState(db, task.id, "stopped", e.at);
    } else if (card.kind === "decision") {
      if (p.choice === "abandon") setTaskState(db, task.id, "abandoned", e.at);
      else {
        // 答复到了再接上原会话。回答先记成反馈，这样即使回队列时被预算拦下，追加预算后也不会丢。
        db.prepare(`UPDATE tasks SET failures = 0 WHERE id = ?`).run(task.id);
        setFeedback(db, task.id, `人对“${card.title}”（${card.id}）的回答：${[p.choice, p.text && (p.choice ? `说明：${p.text}` : p.text)].filter(Boolean).join("；")}`);
        requeue(db, e, task.id);
      }
    }
  },

  "human.stop": (db, e) => {
    const p = e.payload as { about: string };
    const task = getTask(db, p.about);
    if (task && !["done", "abandoned", "stopped"].includes(task.state)) setTaskState(db, task.id, "stopped", e.at);
    for (const r of db.prepare(`SELECT id FROM runs WHERE task_id = ? AND status = 'running'`).all(p.about) as { id: string }[]) chargeRun(db, r.id, e.at);
    db.prepare(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE task_id = ? AND status = 'running'`).run(e.at, p.about);
    // 还没执行的对外动作作废；正在执行的拦不住，结果照常记账。
    db.prepare(`UPDATE effects SET status = 'cancelled', error = '任务被叫停', finished_at = ? WHERE task_id = ? AND status = 'queued'`).run(e.at, p.about);
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
  const runs = db.prepare(`SELECT r.id, r.started_at, r.heartbeat_at, t.contract, t.runs_used, t.minutes_used FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.status = 'running'`)
    .all() as { id: string; started_at: string; heartbeat_at: string; contract: string; runs_used: number; minutes_used: number }[];
  for (const r of runs) {
    // 单轮限时是领活时剩下的时长预算（轮次在跑时 minutes_used 不变，所以重放结果一致）。
    const limit = runLimitMinutes({ ...r, contract: JSON.parse(r.contract) as TaskContract });
    if (now - Date.parse(r.started_at) > limit * 60_000 + RUN_GRACE_MS) markLost(db, e, r.id, `单轮超时（本轮限时 ${Math.round(limit)} 分钟）`);
    else if (now - Date.parse(r.heartbeat_at) > HEARTBEAT_TIMEOUT_MS) markLost(db, e, r.id, `心跳超时（最后心跳 ${r.heartbeat_at}）`);
  }
  const js = db.prepare(`SELECT id, started_at FROM judgments WHERE status = 'running'`).all() as { id: string; started_at: string }[];
  for (const j of js) {
    if (now - Date.parse(j.started_at) > JUDGMENT_TIMEOUT_MS) judgmentFailed(db, e, getJudgment(db, j.id)!, "判断点超时");
  }
  // 对外动作执行太久没结果：按可重试的失败处理，接单程序重做时先查远端，做过的不会再做一遍。
  const fx = db.prepare(`SELECT id, started_at FROM effects WHERE status = 'running'`).all() as { id: string; started_at: string }[];
  for (const x of fx) {
    if (now - Date.parse(x.started_at) > EFFECT_TIMEOUT_MS) effectFailed(db, e, getEffect(db, x.id)!, "执行超时", true);
  }
}

// 轮次中断：标为 lost，任务带恢复说明回队列；知道会话编号就接上原会话。
// 中断和 failed 共用连续失败计数：连续第 3 次不再自动重派，转受阻出卡片（处置阶梯的最后一级）。
function markLost(db: DB, e: Event, runId: string, reason: string): void {
  const run = db.prepare(`SELECT task_id, session_id FROM runs WHERE id = ?`).get(runId) as { task_id: string; session_id: string | null };
  db.prepare(`UPDATE runs SET status = 'lost', finished_at = ?, lost_reason = ? WHERE id = ?`).run(e.at, reason, runId);
  chargeRun(db, runId, e.at);
  link(db, e.seq, runId, `中断：${reason}`);
  const task = getTask(db, run.task_id);
  if (task?.state !== "running") { link(db, e.seq, run.task_id, `${runId} 中断：${reason}`); return; }
  // 恢复说明总是记下：即使这次因为预算或连续失败停下，人放行后的下一轮也要先查清上一轮做到哪。
  db.prepare(`UPDATE tasks SET failures = failures + 1, session_id = COALESCE(session_id, ?), recovery = ? WHERE id = ?`)
    .run(run.session_id, recoveryNote(runId, reason), task.id);
  const n = task.failures + 1;
  const over = overBudget(getTask(db, task.id)!);
  if (over) { budgetStop(db, e, getTask(db, task.id)!, over); link(db, e.seq, task.id, `${runId} 中断：${reason}；超出预算，停下等人定`); return; }
  if (n >= MAX_FAILURES) {
    setTaskState(db, task.id, "blocked", e.at);
    createCard(db, e, "decision", task.id, `连续 ${n} 次失败或中断：${reason}`, `最近一轮 ${runId}。确认环境没问题后选“已解除，继续”。`,
      [{ key: "unblocked", label: "已解除，继续" }, { key: "abandon", label: "放弃" }], `blocked:${task.id}`);
    link(db, e.seq, task.id, `${runId} 中断：${reason}；连续第 ${n} 次，转受阻`);
    return;
  }
  setTaskState(db, task.id, "queued", e.at);
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
  if (typeof p.effect_id === "string") {
    link(db, e.seq, p.effect_id);
    const x = db.prepare(`SELECT task_id FROM effects WHERE id = ?`).get(p.effect_id) as { task_id: string } | undefined;
    if (x) link(db, e.seq, x.task_id);
  }
  if (typeof p.judgment_id === "string") {
    link(db, e.seq, p.judgment_id);
    const j = db.prepare(`SELECT about FROM judgments WHERE id = ?`).get(p.judgment_id) as { about: string } | undefined;
    if (j) link(db, e.seq, j.about);
  }
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
  // 任务结束了，它还开着的待办卡片没有意义了，撤回（实测：/stop T-10 后 C-30 还在 /card 里）。知会卡留着。
  if (["done", "abandoned", "stopped"].includes(to)) {
    db.prepare(`UPDATE cards SET status = 'withdrawn', updated_at = ? WHERE about = ? AND status = 'open' AND kind != 'notice'`).run(at, taskId);
  }
}

// 反馈只追加：下一轮开始前可能攒了几条（回答了问题，又追加了预算），回执到达时一起清空。
function setFeedback(db: DB, taskId: string, text: string): void {
  db.prepare(`UPDATE tasks SET feedback = CASE WHEN feedback IS NULL THEN ? ELSE feedback || char(10) || ? END WHERE id = ?`).run(text, text, taskId);
}

function addTimer(db: DB, about: string, due: string, reason: string): void {
  db.prepare(`INSERT INTO timers(about, due_at, reason) VALUES (?, ?, ?)`).run(about, due, reason);
}

// 任务离开“等世界”后，它剩下的定时器和订阅作废，免得下次等待时被旧定时器提前叫醒。
function clearWaits(db: DB, taskId: string): void {
  db.prepare(`UPDATE timers SET fired = 1 WHERE about = ? AND fired = 0`).run(taskId);
  db.prepare(`DELETE FROM subscriptions WHERE task_id = ?`).run(taskId);
}

function effectsLine(effects: Effect[]): string {
  return effects.map((x) => `${describeEffect(x)}：${x.status === "done" ? (x.result?.ref ?? "完成") : `${EFFECT_STATUS[x.status]}${x.error ? `（${x.error}）` : ""}`}`).join("；");
}

function reviewBody(r: Receipt, effects: Effect[] = []): string {
  const ev = (r.evidence ?? []).map((x) => x.check ? `${x.check} → ${x.result ?? ""}` : `${x.artifact ?? ""} ${x.ref ?? ""}`).join("；");
  const fx = effectsLine(effects);
  // 对外动作放在最前面：截断时先截交接说明，不截人最该看的“推到了哪、PR 在哪”。
  return [fx && `对外动作：${fx}`, r.handoff ?? r.summary, ev && `证据：${ev}`].filter(Boolean).join("\n");
}

const EFFECT_STATUS: Record<Effect["status"], string> = { queued: "未执行", running: "执行中", done: "完成", failed: "失败", rejected: "没执行", cancelled: "作废" };

// 卡片正文的长度上限，细节放证据链接。目标卡和简报要列几条，放宽一些。
const CARD_BODY_MAX: Record<CardForm | "plain", number> = { plain: 400, budget: 400, alert: 600, effect: 600, goal: 900, reply: 900, brief: 1500 };

function createCard(db: DB, e: Event, kind: CardKind, about: string, title: string, body: string, options: CardOption[], dedupeKey: string,
  form: CardForm | null = null): string | null {
  const open = db.prepare(`SELECT id FROM cards WHERE dedupe_key = ? AND status = 'open'`).get(dedupeKey);
  if (open) return null; // 同一个问题还开着时不重复发
  const id = formatId("C", nextId(db, "card"));
  db.prepare(`INSERT INTO cards(id, kind, about, title, body, options, dedupe_key, status, answer, external_ref, created_at, updated_at, form)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, ?, ?)`)
    .run(id, kind, about, title, body.slice(0, CARD_BODY_MAX[form ?? "plain"]), JSON.stringify(options), dedupeKey, e.at, e.at, form);
  link(db, e.seq, id);
  return id;
}

// ---- 目标与任务 ----
function insertGoal(db: DB, e: Event, title: string, acceptance: string[], boundaries: string[], grant: Grant, status: GoalStatus): string {
  const id = formatId("G", nextId(db, "goal"));
  db.prepare(`INSERT INTO goals(id, title, acceptance, boundaries, grant_json, status, origin_event, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, title, JSON.stringify(acceptance), JSON.stringify(boundaries), JSON.stringify(grant), status, e.seq, e.at, e.at);
  link(db, e.seq, id);
  return id;
}

function setGoalStatus(db: DB, id: string, status: GoalStatus, at: string): void {
  db.prepare(`UPDATE goals SET status = ?, updated_at = ? WHERE id = ?`).run(status, at, id);
}

// 一期：默认不拆，一个目标一个任务。二期由规划生成任务图（P2）。
function createTask(db: DB, e: Event, goalId: string): string {
  const g = getGoal(db, goalId)!;
  const tid = formatId("T", nextId(db, "task"));
  const contract: TaskContract = {
    objective: g.title,
    acceptance: { checks: [], criteria: g.acceptance },
    scope: { write: ["**"], effects: g.grant.effects },
    budget: g.grant.budget, ask_first: g.grant.ask_first, depends_on: [],
    agent: { kind: "code", tier: "strong" },
  };
  db.prepare(`INSERT INTO tasks(id, goal_id, state, contract, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)`)
    .run(tid, goalId, JSON.stringify(contract), e.at, e.at);
  link(db, e.seq, tid);
  return tid;
}

// 待确认的目标转为立项：目标 active，按它现在的内容建任务。
function activateGoal(db: DB, e: Event, goalId: string): string {
  setGoalStatus(db, goalId, "active", e.at);
  return createTask(db, e, goalId);
}

// ---- 预算（P1-13）----
// 一轮结束（回执、中断、限流、叫停）时把它跑的时长记到任务上。时间取自事件，不读时钟。
function chargeRun(db: DB, runId: string, at: string): void {
  const r = db.prepare(`SELECT task_id, started_at FROM runs WHERE id = ?`).get(runId) as { task_id: string; started_at: string | null } | undefined;
  if (!r?.started_at) return;
  const minutes = Math.max(0, (Date.parse(at) - Date.parse(r.started_at)) / 60_000);
  db.prepare(`UPDATE tasks SET minutes_used = minutes_used + ? WHERE id = ?`).run(minutes, r.task_id);
}

// 任务要回队列时一律经过这里：预算用完就不回队列，转受阻并出超预算卡。
function requeue(db: DB, e: Event, taskId: string, note?: string): void {
  const t = getTask(db, taskId)!;
  const over = overBudget(t);
  if (over) { budgetStop(db, e, t, over); return; }
  setTaskState(db, taskId, "queued", e.at);
  if (note) link(db, e.seq, taskId, note);
}

function budgetStop(db: DB, e: Event, t: Task, over: string): void {
  setTaskState(db, t.id, "blocked", e.at);
  const last = db.prepare(`SELECT receipt FROM runs WHERE task_id = ? AND receipt IS NOT NULL ORDER BY rowid DESC LIMIT 1`).get(t.id) as { receipt: string } | undefined;
  const summary = last ? (JSON.parse(last.receipt) as Receipt).summary : "（还没有回执）";
  createCard(db, e, "decision", t.id, `超出预算：${over}`,
    [`任务：${t.contract.objective}`, `最近一轮：${summary}`,
      `追加：再给 ${BUDGET_EXTEND.runs} 轮和 ${minutesText(BUDGET_EXTEND.minutes)}，接着做。停掉：任务结束。接管：交给你，系统不再派发。`].join("\n"),
    BUDGET_OPTIONS, `budget:${t.id}`, "budget");
  link(db, e.seq, t.id, `超出预算（${over}），停下等人定`);
}

type AnsweredCard = { id: string; about: string; kind: CardKind; status: string; title: string; form: CardForm | null };
type Answer = { choice?: string; text?: string; scope?: RulingScope };

function answerBudgetCard(db: DB, e: Event, card: AnsweredCard, p: Answer): void {
  const task = getTask(db, card.about);
  if (!task || task.state !== "blocked") return;
  if (p.choice === "extend") {
    // 追加在“已用”和“原预算”中较大的那个之上，保证追加后确实有余量。
    const b = task.contract.budget;
    const budget = { ...b, runs: Math.max(b.runs, task.runs_used) + BUDGET_EXTEND.runs, minutes: Math.max(b.minutes, Math.ceil(task.minutes_used)) + BUDGET_EXTEND.minutes };
    db.prepare(`UPDATE tasks SET contract = ?, failures = 0 WHERE id = ?`).run(JSON.stringify({ ...task.contract, budget }), task.id);
    if (p.text) setFeedback(db, task.id, `人追加预算时说（${card.id}）：${p.text}`);
    requeue(db, e, task.id, `人追加预算到 ${budget.runs} 轮、${budget.minutes} 分钟，回队列`);
  } else {
    setTaskState(db, task.id, "stopped", e.at);
    link(db, e.seq, task.id, p.choice === "takeover" ? "超出预算，人接管" : "超出预算，人停掉");
  }
}

// ---- 审核卡 ----
function reviewCard(db: DB, e: Event, taskId: string, runId: string): void {
  const row = db.prepare(`SELECT receipt FROM runs WHERE id = ?`).get(runId) as { receipt: string | null } | undefined;
  const r: Receipt = row?.receipt ? JSON.parse(row.receipt) : { outcome: "done", summary: "（没有回执）" };
  setTaskState(db, taskId, "awaiting_review", e.at);
  createCard(db, e, "review", taskId, `审核：${r.summary}`, reviewBody(r, effectsOfTask(db, taskId)),
    [{ key: "accept", label: "接受", recommended: true }, { key: "return", label: "退回" }, { key: "takeover", label: "接管" }],
    `review:${taskId}:${runId}`);
}

// 回执清掉的只是这一轮领走的那部分反馈（反馈只追加，所以是前缀）；之后新到的留下。
function remainingFeedback(now: string | null, delivered: string | null): string | null {
  if (!now) return null;
  if (!delivered) return now;
  if (now === delivered) return null;
  return now.startsWith(`${delivered}\n`) ? now.slice(delivered.length + 1) : now;
}

// ---- 对外动作（P1-21）：先落账后执行 ----
export function getEffect(db: DB, id: string): Effect | undefined {
  const r = db.prepare(`SELECT * FROM effects WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? rowToEffect(r) : undefined;
}
function rowToEffect(r: Record<string, unknown>): Effect {
  return { ...(r as unknown as Effect), params: JSON.parse(r.params as string), result: r.result ? JSON.parse(r.result as string) : null };
}
// 审核卡列这个任务做过的全部对外动作：请求它的那一轮未必是最后一轮（实测 T-9：RN-16 请求推送，RN-18 才交 done）。
function effectsOfTask(db: DB, taskId: string): Effect[] {
  return (db.prepare(`SELECT * FROM effects WHERE task_id = ? ORDER BY rowid`).all(taskId) as Record<string, unknown>[]).map(rowToEffect);
}
function effectsOfRun(db: DB, runId: string): Effect[] {
  return (db.prepare(`SELECT * FROM effects WHERE run_id = ? ORDER BY rowid`).all(runId) as Record<string, unknown>[]).map(rowToEffect);
}
export function describeEffect(x: Pick<Effect, "kind" | "params">): string {
  return x.kind === "open-pr" ? `开 PR ${x.params.branch} → ${x.params.base ?? "main"}` : x.kind === "push-branch" ? `推分支 ${x.params.remote}/${x.params.branch}` : x.kind;
}

// 回执里的对外动作请求：校验后落账。不在授权内、不认识的、分支名不带任务编号的记为 rejected（审核卡上照实列出）。
// 返回排上队的个数。
function requestEffects(db: DB, e: Event, t: Task, runId: string, effects: ReceiptEffect[]): number {
  let queued = 0;
  for (const [i, raw] of effects.slice(0, 5).entries()) {
    const kind = String(raw?.kind ?? "");
    const branch = String(raw?.branch ?? "").trim();
    const params = { branch, remote: String(raw?.remote ?? "origin").trim() || "origin",
      ...(kind === "open-pr" ? { base: String(raw?.base ?? "main").trim() || "main", title: String(raw?.title ?? "").slice(0, 200), body: String(raw?.body ?? "").slice(0, 4000) } : {}) };
    const why = !SUPPORTED_EFFECTS.includes(kind) ? `一期只支持 ${SUPPORTED_EFFECTS.join("、")}`
      : !t.contract.scope.effects.includes(kind) ? "不在这个目标的授权内"
      : !/^[A-Za-z0-9._\/-]+$/.test(branch) || branch.includes("..") ? "分支名不合法"
      : !branch.toLowerCase().includes(t.id.toLowerCase()) ? `分支名要带任务编号 ${t.id}（出身标记）`
      : /^(main|master)$/.test(branch) || params.remote !== "origin" && !/^[A-Za-z0-9._-]+$/.test(params.remote) ? "不能推主干，远端名要合法"
      : kind === "open-pr" && !params.title ? "开 PR 要有标题" : null;
    const id = formatId("X", nextId(db, "effect"));
    const key = `${runId}:${kind}:${params.remote}:${branch}`;
    const r = db.prepare(`INSERT OR IGNORE INTO effects(id, task_id, run_id, kind, params, key, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, t.id, runId, kind || `#${i}`, JSON.stringify(params), key, why ? "rejected" : "queued", why, e.at);
    if (!r.changes) continue;   // 同一轮回执里重复的请求
    link(db, e.seq, id, why ? `没执行：${why}` : "落账，等接单程序执行");
    if (!why) queued++;
  }
  return queued;
}

// 失败：可重试的退避后再排；不可重试或第 3 次还不行就判失败，这一轮后面的对外动作作废，问人。
function effectFailed(db: DB, e: Event, x: Effect, reason: string, retryable: boolean): void {
  if (retryable && x.attempts < EFFECT_BACKOFF_MS.length + 1) {
    const due = new Date(Date.parse(e.at) + EFFECT_BACKOFF_MS[Math.min(x.attempts, EFFECT_BACKOFF_MS.length) - 1]!).toISOString();
    db.prepare(`UPDATE effects SET status = 'queued', error = ?, not_before = ?, worker = NULL, instance = NULL, started_at = NULL WHERE id = ?`).run(reason, due, x.id);
    link(db, e.seq, x.id, `第 ${x.attempts} 次失败（${reason}），${due} 后重试`);
    return;
  }
  db.prepare(`UPDATE effects SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(reason, e.at, x.id);
  db.prepare(`UPDATE effects SET status = 'cancelled', error = '前一个对外动作失败，没有执行', finished_at = ? WHERE run_id = ? AND status = 'queued'`).run(e.at, x.run_id);
  link(db, e.seq, x.id, `失败：${reason}`);
  const t = getTask(db, x.task_id);
  if (t?.state === "awaiting_world") clearWaits(db, t.id);
  if (t?.state === "verifying" || t?.state === "awaiting_world") setTaskState(db, t.id, "blocked", e.at);
  createCard(db, e, "decision", x.task_id, `对外动作失败：${describeEffect(x)}`,
    `${reason}\n重试：重新执行这一轮没做成的对外动作（会先查远端，做过的不再做）。跳过：不做了，直接出审核卡。放弃：任务结束。`,
    EFFECT_OPTIONS, `effect:${x.task_id}`, "effect");
  link(db, e.seq, x.task_id, `${x.id} ${describeEffect(x)} 失败，问人`);
}

// 对外动作都做完了：任务在等它们（verifying）就出审核卡；
// 回执是 waiting 的（Agent 说要等推送结果再看），把结果当反馈叫它回来接着做，不干等兜底定时器。
function settleEffects(db: DB, e: Event, taskId: string): void {
  const t = getTask(db, taskId);
  if (t?.state !== "verifying" && t?.state !== "awaiting_world") return;
  const open = db.prepare(`SELECT 1 FROM effects WHERE task_id = ? AND status IN ('queued','running')`).get(taskId);
  if (open) return;
  const run = db.prepare(`SELECT id FROM runs WHERE task_id = ? AND receipt IS NOT NULL ORDER BY rowid DESC LIMIT 1`).get(taskId) as { id: string };
  if (t.state === "verifying") { reviewCard(db, e, taskId, run.id); return; }
  const fx = effectsOfRun(db, run.id);
  if (!fx.length) return;
  clearWaits(db, taskId);
  setFeedback(db, taskId, `系统已执行你请求的对外动作：${effectsLine(fx)}。据此接着做；做完了就交 done。`);
  requeue(db, e, taskId, "请求的对外动作做完了，带着结果回队列");
}

function answerEffectCard(db: DB, e: Event, card: AnsweredCard, p: Answer): void {
  const t = getTask(db, card.about);
  if (!t) return;
  if (p.choice === "abandon") {
    if (!["done", "abandoned", "stopped"].includes(t.state)) setTaskState(db, t.id, "abandoned", e.at);
    return;
  }
  const last = db.prepare(`SELECT run_id FROM effects WHERE task_id = ? ORDER BY rowid DESC LIMIT 1`).get(t.id) as { run_id: string } | undefined;
  if (p.choice === "retry" && last) {
    db.prepare(`UPDATE effects SET status = 'queued', attempts = 0, not_before = NULL, error = NULL, worker = NULL, instance = NULL, started_at = NULL, finished_at = NULL
        WHERE run_id = ? AND status IN ('failed','cancelled')`).run(last.run_id);
    if (t.state === "blocked") setTaskState(db, t.id, "verifying", e.at);
    link(db, e.seq, t.id, "人选重试对外动作");
    return;
  }
  // 跳过：直接出审核卡，卡上照实写哪些没做成。
  if (t.state === "blocked" && last) reviewCard(db, e, t.id, last.run_id);
}

// ---- 补充（P1-23）----
// 在途的目标：等人确认的目标卡，以及任务还没结束的目标（含审核卡已出、等人审核的：实测 G-11 是对审核中的 G-10 的补充）。
function pendingGoals(db: DB): PendingGoal[] {
  const proposed = db.prepare(`SELECT id, title FROM goals WHERE status = 'proposed' ORDER BY rowid`).all() as { id: string; title: string }[];
  const active = db.prepare(`SELECT g.id, g.title, t.id AS task, t.state FROM goals g JOIN tasks t ON t.goal_id = g.id
      WHERE g.status = 'active' AND t.state IN ('queued','running','verifying','awaiting_world','awaiting_answer','blocked','awaiting_review') ORDER BY g.rowid`).all() as { id: string; title: string; task: string; state: string }[];
  return [...proposed.map((g) => ({ goal: g.id, title: g.title, status: "proposed" as const })),
    ...active.map((g) => ({ goal: g.id, title: g.title, status: "active" as const, task: g.task, ...(g.state === "awaiting_review" ? { reviewing: true } : {}) }))].slice(-10);
}

// 主理人判断这句话是对在途目标 target 的补充：这句话的目标作废（并入），补充送到 target。
function amendGoal(db: DB, e: Event, j: Judgment, self: Goal, target: string): void {
  const hit = j.input.pending?.find((x) => x.goal === target);
  if (!hit) { judgmentFailed(db, e, j, `补充指向的 ${target} 不在在途目标里`); return; }
  setGoalStatus(db, self.id, "abandoned", e.at);
  link(db, e.seq, self.id, `是对 ${target} 的补充，并入`);
  const text = j.input.request;
  const g = getGoal(db, target);
  let how: string;
  if (g?.status === "proposed") {
    // 撤回还开着的目标卡，带着这句话重整一张。
    for (const c of db.prepare(`SELECT id FROM cards WHERE about = ? AND form = 'goal' AND status = 'open'`).all(target) as { id: string }[]) {
      db.prepare(`UPDATE cards SET status = 'withdrawn', updated_at = ? WHERE id = ?`).run(e.at, c.id);
      link(db, e.seq, c.id, `人补充了一句，撤回重整`);
    }
    const prev = db.prepare(`SELECT id FROM judgments WHERE about = ? AND kind = 'intake' ORDER BY rowid DESC LIMIT 1`).get(target) as { id: string } | undefined;
    const input = prev ? getJudgment(db, prev.id)!.input : { request: g.title, revision: 0 };
    queueJudgment(db, e, "intake", target, { request: input.request, revision: input.revision + 1, draft: draftOf(g), feedback: `人补充：${text}` });
    how = "主理人按这句话重整目标卡，稍后发来";
  } else {
    const t = hit.task ? getTask(db, hit.task) : undefined;
    if (!t || ["done", "abandoned", "stopped"].includes(t.state)) { judgmentFailed(db, e, j, `${target} 的任务已经不在做了`); return; }
    const was = t.state;
    setFeedback(db, t.id, `人的补充（${self.id}）：${text}`);
    if (was === "awaiting_world") { clearWaits(db, t.id); requeue(db, e, t.id, "人补充了一句，不再等，带着补充回队列"); }
    else if (was === "awaiting_review") {
      // 审核时补充：等于带着这句话退回，撤回那张审核卡。
      for (const c of db.prepare(`SELECT id FROM cards WHERE about = ? AND kind = 'review' AND status = 'open'`).all(t.id) as { id: string }[]) {
        db.prepare(`UPDATE cards SET status = 'withdrawn', updated_at = ? WHERE id = ?`).run(e.at, c.id);
        link(db, e.seq, c.id, "人审核时补充了一句，撤回审核卡");
      }
      requeue(db, e, t.id, "人审核时补充了一句，当作退回，带着补充开下一轮");
    } else link(db, e.seq, t.id, "人补充了一句，下一轮带上");
    how = was === "running" ? `${t.id} 这一轮跑完后带着它开下一轮` : was === "awaiting_review" ? `撤回了 ${t.id} 的审核卡，带着补充再做一轮，做完重新出审核卡` : `${t.id} 下一轮带上`;
  }
  createCard(db, e, "notice", self.id, `已并入 ${target}：${text.slice(0, 40)}`, `主理人判断这句话是对 ${target}（${hit.title}）的补充。${how}。`, [], `reply:${self.id}`, "reply");
}

function draftOf(g: Goal): Draft {
  return { kind: "goal", direct: false, title: g.title, acceptance: g.acceptance, boundaries: g.boundaries, ask_first: g.grant.ask_first, budget: g.grant.budget };
}

// ---- 主理人（P1-10）----
function queueJudgment(db: DB, e: Event, kind: JudgmentKind, about: string, input: IntakeInput): string {
  const id = formatId("J", nextId(db, "judgment"));
  db.prepare(`INSERT INTO judgments(id, kind, about, status, input, created_at) VALUES (?, ?, ?, 'queued', ?, ?)`)
    .run(id, kind, about, JSON.stringify(input), e.at);
  link(db, e.seq, id); link(db, e.seq, about);
  return id;
}

export function getJudgment(db: DB, id: string): Judgment | undefined {
  const r = db.prepare(`SELECT * FROM judgments WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  return { ...(r as unknown as Judgment), input: JSON.parse(r.input as string), output: r.output ? JSON.parse(r.output as string) : null };
}

// 判断点失败（输出不合格式、超时、接单程序重启）：重新排队；连续第 3 次就不再找模型，退回人手里。
function judgmentFailed(db: DB, e: Event, j: Judgment, reason: string): void {
  const n = j.failures + 1;
  if (n < MAX_FAILURES) {
    db.prepare(`UPDATE judgments SET status = 'queued', failures = ?, error = ?, agent = NULL, worker = NULL, instance = NULL, started_at = NULL, finished_at = ? WHERE id = ?`)
      .run(n, reason, e.at, j.id);
    link(db, e.seq, j.id, `失败（${reason}），重新排队`); link(db, e.seq, j.about, `${j.id} 失败（${reason}），重新排队`);
    return;
  }
  db.prepare(`UPDATE judgments SET status = 'failed', failures = ?, error = ?, finished_at = ? WHERE id = ?`).run(n, reason, e.at, j.id);
  link(db, e.seq, j.id, `连续 ${n} 次失败（${reason}）`);
  if (j.kind === "intake") {
    // 主理人整理不出来：按原话出目标卡，人可以直接确认，也可以写修改意见再让它试一次。
    const goal = getGoal(db, j.about);
    if (goal?.status !== "proposed") return;
    goalCard(db, e, goal.id, j.input.revision, `主理人连续 ${n} 次没整理出来（${reason}），下面按原话列出。`);
    link(db, e.seq, goal.id, `${j.id} 连续 ${n} 次失败，按原话出目标卡`);
  }
}

function onIntake(db: DB, e: Event, j: Judgment, draft: Draft): void {
  const goal = getGoal(db, j.about);
  if (!goal || goal.status !== "proposed") return;
  // 人改过的目标卡又有新的整理在排队：这次的结果已经过时，不出卡片（P1-23 并入补充时会这样）。
  const newer = db.prepare(`SELECT 1 FROM judgments WHERE about = ? AND kind = 'intake' AND status IN ('queued','running') AND rowid > (SELECT rowid FROM judgments WHERE id = ?)`).get(goal.id, j.id);
  if (newer) { link(db, e.seq, goal.id, `${j.id} 的结果已被后来的补充取代`); return; }
  if (draft.kind === "amend") { amendGoal(db, e, j, goal, draft.target!); return; }
  if (draft.kind === "not_goal") {
    setGoalStatus(db, goal.id, "abandoned", e.at);
    createCard(db, e, "notice", goal.id, `主理人：${draft.reply}`, `你说的是：“${j.input.request}”。不像要系统去做的事，没有立项；要做的话换个说法再发一次。`,
      [], `reply:${goal.id}`, "reply");
    link(db, e.seq, goal.id, "主理人判断不是目标，没有立项");
    return;
  }
  const grant: Grant = { ...goal.grant, ask_first: draft.ask_first, budget: draft.budget ?? DEFAULT_GRANT.budget };
  db.prepare(`UPDATE goals SET title = ?, acceptance = ?, boundaries = ?, grant_json = ?, updated_at = ? WHERE id = ?`)
    .run(draft.title, JSON.stringify(draft.acceptance), JSON.stringify(draft.boundaries), JSON.stringify(grant), e.at, goal.id);
  // 小而明确的请求跳过确认、直接立项（设计文档“说目标”）。只认初稿，不能改默认预算，也不能带提醒；
  // 改过一次的、主理人觉得有事要人知道的，一律请人确认。
  if (draft.direct && j.input.revision === 0 && !draft.budget && !draft.notes?.length) {
    const tid = activateGoal(db, e, goal.id);
    createCard(db, e, "notice", goal.id, `已立项 ${goal.id} · ${tid}：${draft.title}`,
      `${goalCardBody(getGoal(db, goal.id)!)}\n\n小而明确，没等你确认就开工了。做完会出审核卡；不想做发 /stop ${tid}。`, [], `reply:${goal.id}`, "reply");
    link(db, e.seq, goal.id, `小而明确，直接立项 ${tid}`);
    return;
  }
  goalCard(db, e, goal.id, j.input.revision, "", draft.notes);
}

function goalCard(db: DB, e: Event, goalId: string, revision: number, note = "", notes: string[] = []): void {
  const g = getGoal(db, goalId)!;
  createCard(db, e, "decision", g.id, `目标卡：${g.title}`, [note, goalCardBody(g, notes)].filter(Boolean).join("\n\n"), GOAL_OPTIONS, `goal:${g.id}:${revision}`, "goal");
}

function answerGoalCard(db: DB, e: Event, card: AnsweredCard, p: Answer): void {
  const goal = getGoal(db, card.about);
  if (!goal || goal.status !== "proposed") return;
  if (p.choice === "confirm") {
    const tid = activateGoal(db, e, goal.id);
    // 确认时写的那句话是人的补充，带进第一轮（不能丢）。
    const note = p.text?.trim();
    if (note) setFeedback(db, tid, `人确认目标卡时补充：${note}`);
    link(db, e.seq, goal.id, `人确认目标卡，立项 ${tid}${note ? "，带着补充" : ""}`);
  } else if (p.choice === "drop") {
    setGoalStatus(db, goal.id, "abandoned", e.at);
    link(db, e.seq, goal.id, "人选不做");
  } else {
    // 修改（只写了字没点按钮也算修改）：带着上一版和修改意见，再排一次主理人。
    const prev = db.prepare(`SELECT id FROM judgments WHERE about = ? AND kind = 'intake' ORDER BY rowid DESC LIMIT 1`).get(goal.id) as { id: string } | undefined;
    const input = prev ? getJudgment(db, prev.id)!.input : { request: goal.title, revision: 0 };
    queueJudgment(db, e, "intake", goal.id, {
      request: input.request, revision: input.revision + 1,
      draft: { kind: "goal", direct: false, title: goal.title, acceptance: goal.acceptance, boundaries: goal.boundaries, ask_first: goal.grant.ask_first, budget: goal.grant.budget },
      feedback: p.text?.trim() || "人要求修改，但没写改什么",
    });
  }
}

// ---- 备份（P1-15）----
function putBackup(db: DB, kind: "snapshot" | "drill", ok: boolean, at: string, detail: string): void {
  db.prepare(`INSERT INTO backups VALUES (?, ?, ?, ?) ON CONFLICT(kind, ok) DO UPDATE SET at = excluded.at, detail = excluded.detail`).run(kind, ok ? 1 : 0, at, detail);
}

export function backupStatus(db: DB): { snapshot_ok_at: string | null; snapshot_failed_at: string | null; drill_ok_at: string | null; drill_failed_at: string | null; snapshot: string | null; drill: string | null } {
  const rows = db.prepare(`SELECT kind, ok, at, detail FROM backups`).all() as { kind: string; ok: number; at: string; detail: string }[];
  const get = (kind: string, ok: number) => rows.find((r) => r.kind === kind && r.ok === ok);
  const latest = (kind: string) => [get(kind, 1), get(kind, 0)].filter(Boolean).sort((a, b) => a!.at.localeCompare(b!.at)).at(-1);
  const line = (kind: string) => { const r = latest(kind); return r ? `${r.ok ? "成功" : "失败"}：${r.detail}` : null; };
  return { snapshot_ok_at: get("snapshot", 1)?.at ?? null, snapshot_failed_at: get("snapshot", 0)?.at ?? null,
    drill_ok_at: get("drill", 1)?.at ?? null, drill_failed_at: get("drill", 0)?.at ?? null, snapshot: line("snapshot"), drill: line("drill") };
}

// 相对时长的说法，只拿两个事件时间相减，不读时钟。
function ago(at: string, now: string): string {
  const m = Math.max(0, Math.round((Date.parse(now) - Date.parse(at)) / 60_000));
  return m < 60 ? `${m} 分钟前` : m < 2880 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
}

function lastBackupLine(db: DB, now: string): string {
  const s = backupStatus(db);
  return s.snapshot_ok_at ? `最近一次成功是 ${ago(s.snapshot_ok_at, now)}` : "还没有成功过";
}

// 每次 tick 看一眼：最近一次成功的备份太旧，说明备份来源停了或一直在失败。
function backupWatch(db: DB, e: Event): void {
  const s = backupStatus(db);
  if (!s.snapshot_ok_at || Date.parse(e.at) - Date.parse(s.snapshot_ok_at) <= BACKUP_STALE_MS) return;
  alert(db, e, "alert:backup", "备份超过 3 小时没有成功", `${lastBackupLine(db, e.at)}。备份每小时一次，看内核日志里的 [backup]。`);
}

function alert(db: DB, e: Event, key: string, title: string, body: string): void {
  const id = createCard(db, e, "notice", "备份", title, body, [], key, "alert");
  if (id) link(db, e.seq, id, title);
}

function withdrawAlert(db: DB, e: Event, key: string, why: string): void {
  const open = db.prepare(`SELECT id FROM cards WHERE dedupe_key = ? AND status = 'open'`).all(key) as { id: string }[];
  for (const c of open) {
    db.prepare(`UPDATE cards SET status = 'withdrawn', updated_at = ? WHERE id = ?`).run(e.at, c.id);
    link(db, e.seq, c.id, `${why}，撤回`);
  }
}

// ---- 每日简报（P1-17）与知会卡收起（P1-22）----
// 简报本身是一张知会卡，内核从账本现算：要你处理的卡片、上次简报以来完成的任务、在做的事、知会、额度。
// 汇总过的知会卡（含上一份简报）收起，不再出现在 /card 和 /status 里。
function brief(db: DB, e: Event): void {
  const p = e.payload as { date?: unknown };
  const date = typeof p.date === "string" ? p.date : e.at.slice(0, 10);
  const last = db.prepare(`SELECT created_at FROM cards WHERE form = 'brief' ORDER BY rowid DESC LIMIT 1`).get() as { created_at: string } | undefined;
  const open = db.prepare(`SELECT id, kind, title, form FROM cards WHERE status = 'open' ORDER BY created_at, rowid`).all() as { id: string; kind: CardKind; title: string; form: CardForm | null }[];
  const need = open.filter((c) => c.kind !== "notice");
  const notices = open.filter((c) => c.kind === "notice" && c.form !== "brief");
  const done = db.prepare(`SELECT id, contract FROM tasks WHERE state = 'done' AND updated_at > ? ORDER BY updated_at, rowid`).all(last?.created_at ?? "") as { id: string; contract: string }[];
  const states = (db.prepare(`SELECT state FROM tasks`).all() as { state: TaskState }[]).map((r) => waitingOn(r.state));
  const quota = db.prepare(`SELECT agent, seven_day_utilization AS u FROM quota ORDER BY agent`).all() as { agent: string; u: number | null }[];

  // 每条只留开头一截：简报是一眼看完的东西，细节用 xj why / /card 看。
  const clip = (x: string) => (x.length > 40 ? `${x.slice(0, 40)}…` : x);
  const list = (xs: string[], max = 6) => [...xs.slice(0, max).map((x) => `· ${clip(x)}`), ...(xs.length > max ? [`· 另有 ${xs.length - max} 条`] : [])];
  const count = (k: CardKind) => need.filter((c) => c.kind === k).length;
  const lines: string[] = [];
  if (need.length) {
    lines.push(`**需要你**：${[count("decision") && `决策 ${count("decision")} 张`, count("review") && `审核 ${count("review")} 张`].filter(Boolean).join("、")}（发 /card 取）`,
      ...list(need.map((c) => `${c.id} ${c.title}`)));
  } else lines.push("**需要你**：没有");
  if (done.length) lines.push(`**完成** ${done.length} 件`, ...list(done.map((t) => `${t.id} ${(JSON.parse(t.contract) as TaskContract).objective}`)));
  const busy = (["agent", "world", "human"] as const).map((w) => [w, states.filter((s) => s === w).length] as const).filter(([, n]) => n);
  lines.push(`**在做**：${busy.length ? busy.map(([w, n]) => `${{ agent: "等 Agent", world: "等世界", human: "等人" }[w]} ${n}`).join(" · ") : "没有"}`);
  if (notices.length) lines.push(`**知会** ${notices.length} 条（已收起）`, ...list(notices.map((c) => `${c.id} ${c.title}`)));
  for (const q of quota) if (q.u != null) lines.push(`**额度** ${q.agent} 周用量 ${Math.round(q.u * 100)}%`);
  const bs = backupStatus(db);
  if (bs.snapshot_ok_at || bs.snapshot_failed_at) {
    lines.push(`**备份** ${bs.snapshot_ok_at ? `最近成功 ${ago(bs.snapshot_ok_at, e.at)}` : "还没有成功过"}` +
      `${bs.drill_ok_at ? `；恢复演练 ${ago(bs.drill_ok_at, e.at)}通过` : "；还没演练通过"}`);
  }

  const id = createCard(db, e, "notice", "简报", `简报 ${date}`, lines.join("\n"), [], `brief:${e.seq}`, "brief");
  const folded = db.prepare(`SELECT id FROM cards WHERE status = 'open' AND kind = 'notice' AND id IS NOT ?`).all(id) as { id: string }[];
  for (const c of folded) {
    db.prepare(`UPDATE cards SET status = 'folded', updated_at = ? WHERE id = ?`).run(e.at, c.id);
    link(db, e.seq, c.id, `随简报 ${id} 收起`);
  }
}
