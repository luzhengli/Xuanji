// 归并：一条事件如何改变投影。纯函数式思路：输入 (db, event)，只写投影表，不做 IO，不读时钟。
// 每种事件一个处理器。没有处理器的事件只记录，这就是“只记录”的含义。
import type { DB } from "./store.ts";
import { nextId } from "./store.ts";
import { formatId } from "../shared/ids.ts";
import { dueAt } from "../shared/duration.ts";
import { assertTransition, waitingOn } from "./state.ts";
import { BUDGET_EXTEND, overBudget, runLimitMinutes } from "./budget.ts";
import { TITLE_MAX, goalCardBody, normalizeDraft, normalizeBase, minutesText } from "./intake.ts";
import { backpressureView, backpressureLine, SYSTEM_FEEDBACK_PREFIX } from "./attention.ts";
import { leasePatterns } from "./scheduler.ts";
import { MAX_VERIFY_ROUNDS, normalizeChecks, normalizeVerdict, verifyFeedback, issueLine, skippedRisks } from "./verdict.ts";
import { PLAN_OPTIONS, DEFAULT_MAX_TASKS, normalizePlan, planCardBody, mergeObjective } from "./plan.ts";
import type { Event, Goal, GoalStatus, Grant, Task, TaskContract, TaskState, Receipt, CardKind, CardForm, CardOption, RulingScope, Ruling,
  Draft, IntakeInput, PlanInput, Plan, Judgment, JudgmentKind, PendingGoal, Effect, ReceiptEffect, Worktree, Verdict, CheckResult } from "./types.ts";

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
// 验证（P2-05）。验证轮不占任务的轮数和时长预算（它有自己的上限：最多 3 轮），单轮限时写死在这里，接单程序先在这个时长处结束进程。
export const VERIFY_RUN_MINUTES = 30;
// 验证三轮还不通过（2026-11-12 人定：再给 3 轮 / 按现状审核 / 放弃，推荐按现状审核）。
export const VERIFY_OPTIONS: CardOption[] = [
  { key: "more", label: `再给 ${MAX_VERIFY_ROUNDS} 轮` }, { key: "review", label: "按现状审核", recommended: true }, { key: "abandon", label: "放弃" },
];
// 验证者连续没跑成（进程出错、输出不合格式、超时）：Agent 定，选项照上面的样子。
export const VERIFY_ERROR_OPTIONS: CardOption[] = [
  { key: "retry", label: "重新验证" }, { key: "review", label: "按现状审核", recommended: true }, { key: "abandon", label: "放弃" },
];
// Agent 认为某条定论这次不适用（P2-07）：不得自行绕过，出卡请人定。Agent 定，可逆。
export const RULING_OPTIONS: CardOption[] = [
  { key: "keep", label: "照定论做" }, { key: "except", label: "这次例外" }, { key: "revoke", label: "作废这条定论" },
];
// 判断点的超时：主理人 5 分钟；规划（P2-08）用强模型、输出整张任务图，放宽到 10 分钟。
export const PLAN_TIMEOUT_MS = 600_000;
export const BUDGET_OPTIONS: CardOption[] = [
  { key: "extend", label: `追加 ${BUDGET_EXTEND.runs} 轮和 ${minutesText(BUDGET_EXTEND.minutes)}` },
  { key: "stop", label: "停掉", recommended: true }, { key: "takeover", label: "接管" },
];

export const handlers: Record<string, Handler> = {
  // 人直接立项（xj goal --direct；P1-10 之前的飞书私聊也走这里）。不经主理人。
  "goal.confirmed": (db, e) => {
    const p = e.payload as { title: string; acceptance?: string[]; boundaries?: string[]; grant?: Partial<Grant>; base?: string; checks?: unknown; split?: unknown };
    const grant = { ...DEFAULT_GRANT, ...(p.grant ?? {}) };
    const id = insertGoal(db, e, p.title, p.acceptance ?? [], p.boundaries ?? [], grant, "active");
    const base = normalizeBase(p.base);
    if (base) db.prepare(`UPDATE goals SET base = ? WHERE id = ?`).run(base, id);
    // 人自己写的检查命令（xj goal --check）就是人批准的（P2-05）。
    const checks = normalizeChecks(p.checks);
    if (checks.length) db.prepare(`UPDATE goals SET checks = ? WHERE id = ?`).run(JSON.stringify(checks), id);
    // 人自己标了要拆（xj goal --split，P2-08）：先规划。
    if (p.split === true) { db.prepare(`UPDATE goals SET split = 1 WHERE id = ?`).run(id); queuePlan(db, e, id, { revision: 0 }); return; }
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
    if (j.kind === "plan") {
      // 规划（P2-08）：拆分上限在配置里，内核落账时写进了这条事件（Kernel.stamp），重放不随配置变。
      const max = typeof (e.payload as { max_tasks?: unknown }).max_tasks === "number" ? (e.payload as { max_tasks: number }).max_tasks : DEFAULT_MAX_TASKS;
      const goal = getGoal(db, j.about);
      const r = p.error ? { ok: false as const, error: p.error } : normalizePlan(p.output, { max_tasks: max, checks: goal?.checks ?? [] });
      if (!r.ok) { judgmentFailed(db, e, j, r.error); return; }
      db.prepare(`UPDATE judgments SET status = 'finished', finished_at = ?, error = NULL, output = ? WHERE id = ?`).run(e.at, JSON.stringify(r.plan), j.id);
      onPlan(db, e, j, r.plan);
      return;
    }
    const d = p.error ? { ok: false as const, error: p.error } : normalizeDraft(p.output);
    if (!d.ok) { judgmentFailed(db, e, j, d.error); return; }
    db.prepare(`UPDATE judgments SET status = 'finished', finished_at = ?, error = NULL WHERE id = ?`).run(e.at, j.id);
    if (j.kind === "intake") onIntake(db, e, j, d.draft);
  },

  // 人作废一条定论（P2-07）：飞书 /rulings 卡上的“作废”按钮，或 xj revoke R-x。之后不再注入。
  "ruling.revoked": (db, e) => {
    const p = e.payload as { ruling_id?: unknown };
    const id = typeof p.ruling_id === "string" ? p.ruling_id : "";
    if (db.prepare(`UPDATE rulings SET revoked = 1 WHERE id = ? AND revoked = 0`).run(id).changes) link(db, e.seq, id, "人作废了这条定论");
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
    // 验证轮（P2-05）：任务留在“验证中”，只读，不登记租约，不占任务的轮数预算。
    if (p.purpose === "verify") { link(db, e.seq, rid); link(db, e.seq, p.task_id, `${rid} 验证（${p.agent}）`); return; }
    setTaskState(db, p.task_id, "running", e.at);
    // 记下这一轮带走的反馈：回执到了只清掉这部分，跑的过程中新到的补充留给下一轮（P1-23）。
    db.prepare(`UPDATE runs SET feedback = (SELECT feedback FROM tasks WHERE id = ?) WHERE id = ?`).run(p.task_id, rid);
    db.prepare(`UPDATE tasks SET runs_used = runs_used + 1 WHERE id = ?`).run(p.task_id);
    // 租约（P2-03）：这一轮的可写范围和独占资源登记进账本，轮次结束即释放（见 reduce 末尾）。
    const t = getTask(db, p.task_id);
    if (t) for (const pat of leasePatterns(t.contract)) db.prepare(`INSERT OR IGNORE INTO leases VALUES (?, ?)`).run(t.id, pat);
    link(db, e.seq, rid);
  },

  // 接单程序在第一轮之前给任务建好了 worktree（P2-02）：路径、分支、基底提交落账，以后每轮都在这里做。
  // 任务结束后照 P1-28 的办法清理（没提交的改动不删，分支留着）。
  "workspace.prepared": (db, e) => {
    const p = e.payload as { task_id: string; path?: unknown; branch?: unknown; base?: unknown; base_commit?: unknown; repo?: unknown };
    const t = getTask(db, p.task_id);
    const str = (x: unknown) => (typeof x === "string" ? x : "");
    const path = str(p.path), branch = str(p.branch), repo = str(p.repo);
    if (!t || !path.startsWith("/")) return;
    db.prepare(`UPDATE tasks SET workdir = ?, base_commit = COALESCE(?, base_commit) WHERE id = ?`).run(path, /^[0-9a-f]{7,40}$/.test(str(p.base_commit)) ? str(p.base_commit) : null, t.id);
    const have = worktreesOf(db, t.id).filter((w) => w.path !== path);
    db.prepare(`UPDATE tasks SET worktrees = ? WHERE id = ?`)
      .run(JSON.stringify([...have, { path, ...(branch ? { branch } : {}), ...(repo.startsWith("/") ? { repo } : {}) }]), t.id);
    link(db, e.seq, t.id, `工作区 ${path}，分支 ${branch || "?"}，基底 ${str(p.base) || "?"}@${str(p.base_commit).slice(0, 7) || "?"}`);
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
    // verifier：内核落账时按配置写进来的验证者档案（P2-05，Kernel.stamp），重放不随配置变。没有就不验证，直接出审核卡。
    const p = e.payload as { run_id: string; task_id: string; session_id?: string; receipt: Receipt; worktrees?: Worktree[]; verifier?: string };
    // Agent 建的 worktree 先记下（P1-28），迟到的回执也记：任务结束后要清理，审核卡上要列出。
    if (Array.isArray(p.worktrees) && p.worktrees.length) addWorktrees(db, e, p.task_id, p.worktrees);
    const run = db.prepare(`SELECT status, feedback, purpose FROM runs WHERE id = ?`).get(p.run_id) as { status: string; feedback: string | null; purpose: string } | undefined;
    // 验证轮不交回执，交的是结论（run.verdict）。接单程序出错时也走结论那条路，这里只防万一。
    if (run?.purpose === "verify") { link(db, e.seq, p.run_id, "验证轮交了回执，不算数"); return; }
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
        // 验证在人之前（P2-05）：有验证者就等它，通过才出审核卡。有对外动作先等它们做完，验证者看的是最终的样子。
        if (typeof p.verifier === "string" && p.verifier) {
          db.prepare(`UPDATE tasks SET verify_due = ?, verify_not_before = NULL WHERE id = ?`).run(p.verifier, p.task_id);
          link(db, e.seq, p.task_id, pendingFx ? `等 ${pendingFx} 个对外动作做完，再请 ${p.verifier} 验证` : `请 ${p.verifier} 验证`);
          break;
        }
        // 没有验证者（配置里没有可用的，或 P2-05 之前的回执）：有对外动作就等它们做完再出审核卡，卡上带着结果。
        if (pendingFx) { link(db, e.seq, p.task_id, `等 ${pendingFx} 个对外动作做完再出审核卡`); break; }
        finishVerified(db, e, p.task_id, p.run_id);
        break;
      case "ask": {
        setTaskState(db, p.task_id, "awaiting_answer", e.at);
        const a = r.ask![0]!;
        // Agent 认为某条定论这次不适用（P2-07）：不得自行绕过，出一张专门的卡请人定。
        const ruling = typeof a.ruling === "string" ? getRuling(db, a.ruling) : undefined;
        if (ruling && !ruling.revoked) { rulingCard(db, e, p.task_id, ruling, a.question, a.why ?? ""); break; }
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
      const title = `发现：${f.title}`;
      const id = createCard(db, e, "notice", p.task_id, title, f.why ?? "", [], `found:${p.task_id}:${f.title}`);
      // 别的任务已经报过同一件事、那张还开着（P1-30，实测 C-31、C-35）：照常记下再收起，不重复打扰。
      // 不是干脆不建：重放旧账本时卡片编号要和当初一致，后面的回答才对得上。
      const dup = id && db.prepare(`SELECT id, about FROM cards WHERE kind = 'notice' AND status = 'open' AND title = ? AND dedupe_key LIKE 'found:%' AND id != ? ORDER BY rowid LIMIT 1`)
        .get(title, id) as { id: string; about: string } | undefined;
      if (id && dup) {
        db.prepare(`UPDATE cards SET status = 'folded', updated_at = ? WHERE id = ?`).run(e.at, id);
        link(db, e.seq, id, `和 ${dup.id}（${dup.about}）是同一件事，收起`);
      }
    }
  },

  // 验证的结论（P2-05）：检查命令的结果和验证者的结论。通过出审核卡，没通过带着意见开下一轮，三轮不过问人。
  // 迟到的（这一轮已被判中断、任务已不在验证中）只记在轮次上。验证者的输出在这里再清洗一遍。
  "run.verdict": (db, e) => {
    const p = e.payload as { run_id: string; task_id: string; session_id?: string; verdict?: unknown; checks?: unknown; error?: string; reviewer?: string };
    const run = db.prepare(`SELECT status, purpose, agent FROM runs WHERE id = ?`).get(p.run_id) as { status: string; purpose: string; agent: string } | undefined;
    if (!run || run.purpose !== "verify") return;
    const checks = normalizeCheckResults(p.checks);
    const v = p.error ? { ok: false as const, error: p.error } : normalizeVerdict(p.verdict);
    const verdict: Verdict | null = v.ok ? { ...v.verdict, risks: [...v.verdict.risks, ...skippedRisks(checks)], ...(checks.length ? { checks } : {}),
      ...(p.reviewer ? { reviewer: String(p.reviewer).slice(0, 40) } : {}) } : null;
    const late = run.status !== "running";
    db.prepare(`UPDATE runs SET status = CASE WHEN status = 'running' THEN 'finished' ELSE status END, finished_at = COALESCE(finished_at, ?),
        session_id = COALESCE(session_id, ?), verdict = COALESCE(verdict, ?), lost_reason = COALESCE(lost_reason, ?) WHERE id = ?`)
      .run(e.at, p.session_id ?? null, verdict ? JSON.stringify(verdict) : null, v.ok ? null : `验证者没跑成：${v.error}`.slice(0, 300), p.run_id);
    const t = getTask(db, p.task_id);
    if (late || !t || t.state !== "verifying" || !t.verify_due) return;
    if (!v.ok) { verifyErrored(db, e, t, p.run_id, v.error); return; }
    db.prepare(`UPDATE tasks SET verify_due = NULL, verify_not_before = NULL, failures = 0 WHERE id = ?`).run(t.id);
    if (verdict!.pass) {
      db.prepare(`UPDATE tasks SET verify_failures = 0 WHERE id = ?`).run(t.id);
      link(db, e.seq, t.id, `${p.run_id} 验证通过`);
      // 验证期间人又补充了话：不出审核卡，带着补充开下一轮（和 done 时一样）。
      if (t.feedback) { requeue(db, e, t.id, "验证通过，但验证期间人又补充了话，带着补充开下一轮"); return; }
      finishVerified(db, e, t.id, subjectRun(db, t.id) ?? p.run_id);
      return;
    }
    const n = (t.verify_failures ?? 0) + 1;
    db.prepare(`UPDATE tasks SET verify_failures = ? WHERE id = ?`).run(n, t.id);
    if (n >= MAX_VERIFY_ROUNDS) {
      setTaskState(db, t.id, "blocked", e.at);
      createCard(db, e, "decision", t.id, `验证 ${n} 轮没通过：${verdict!.summary}`,
        [`任务：${t.contract.objective}`, `最后一轮验证意见（${p.run_id}）：\n${verdict!.issues.map((i) => `- ${issueLine(i)}`).join("\n")}`,
          `残余风险：\n${verdict!.risks.map((r) => `- ${r}`).join("\n")}`,
          `再给 ${MAX_VERIFY_ROUNDS} 轮：带着这次的意见接着改。按现状审核：出审核卡，你自己看。放弃：任务结束。`].join("\n\n"),   // 列表前后空一行（飞书）
        VERIFY_OPTIONS, `verify:${t.id}`, "verify", 900);
      link(db, e.seq, t.id, `${p.run_id} 验证没通过，连续第 ${n} 轮，问人`);
      return;
    }
    setFeedback(db, t.id, verifyFeedback(p.run_id, n, verdict!));
    requeue(db, e, t.id, `${p.run_id} 验证没通过（第 ${n} 轮），带着验证意见开下一轮`);
  },

  // 订阅额度用尽不算失败：任务转“等世界”，定时器设在额度重置时间（P1-12 的最小版）。
  "run.rate_limited": (db, e) => {
    const p = e.payload as { run_id?: string; task_id: string; resets_at?: number };
    const purpose = p.run_id ? (db.prepare(`SELECT purpose FROM runs WHERE id = ?`).get(p.run_id) as { purpose: string } | undefined)?.purpose : undefined;
    if (purpose === "verify") {
      // 验证者限流：任务留在“验证中”，到重置时间再派验证（不回执行队列）。
      const due = p.resets_at ? new Date(p.resets_at * 1000).toISOString() : dueAt(e.at, undefined, RATE_LIMIT_FALLBACK_MS);
      if (db.prepare(`UPDATE runs SET status = 'finished', finished_at = ?, lost_reason = '验证者限流' WHERE id = ? AND status = 'running'`).run(e.at, p.run_id!).changes) {
        db.prepare(`UPDATE tasks SET verify_not_before = ? WHERE id = ? AND state = 'verifying'`).run(due, p.task_id);
        link(db, e.seq, p.task_id, `验证者限流，${due} 后再验证`);
      }
      return;
    }
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
    const p = e.payload as { effect_id: string; ok: boolean; ref?: string; detail?: string; retryable?: boolean; skipped?: boolean };
    const x = getEffect(db, p.effect_id);
    if (!x || x.status !== "running") return;
    // 做不了也不必问人的（远端不是 GitHub 就开不了 PR，P1-29）：记为没执行，照常往下走，审核卡上照实列出。
    if (!p.ok && p.skipped) {
      db.prepare(`UPDATE effects SET status = 'rejected', error = ?, finished_at = ? WHERE id = ?`).run(p.detail ?? "做不了", e.at, x.id);
      link(db, e.seq, x.task_id, `${x.id} ${describeEffect(x)} 没执行：${p.detail ?? "做不了"}`);
      settleEffects(db, e, x.task_id);
      return;
    }
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
    if (card.form === "verify") { answerVerifyCard(db, e, card, p); return; }
    if (card.form === "plan") { answerPlanCard(db, e, card, p); return; }
    if (card.form === "ruling") { answerRulingCard(db, e, card, p); return; }
    if (p.text || (p.scope && p.scope !== "task")) {
      const rid = formatId("R", nextId(db, "ruling"));
      db.prepare(`INSERT INTO rulings VALUES (?, ?, ?, ?, ?, ?, 0)`)
        .run(rid, p.scope ?? "task", card.about, p.text ?? `${card.title} → ${p.choice}`, p.card_id, e.at);
      link(db, e.seq, rid);
    }
    const task = getTask(db, card.about);
    if (!task) return;
    if (card.kind === "review") {
      db.prepare(`UPDATE tasks SET verify_failures = 0 WHERE id = ?`).run(task.id);   // 人看过了，验证轮数重新算
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
    db.prepare(`UPDATE effects SET status = 'cancelled', error = '任务被叫停', finished_at = ? WHERE task_id = ? AND status = 'queued' AND kind != 'remove-worktree'`).run(e.at, p.about);
    if (task) clearWaits(db, task.id);
  },

  "card.delivered": (db, e) => {
    const p = e.payload as { card_id: string; external_ref: string };
    db.prepare(`UPDATE cards SET external_ref = ?, shown = 'open', updated_at = ? WHERE id = ?`).run(p.external_ref, e.at, p.card_id);
  },

  // 飞书上的卡片已改成账本里的现状（P1-27）：撤回、收起、在 xj 里回答了的卡片，通道主动改灰后报回来。
  // 改失败（超过 14 天不能改等）也报，记下试过，不反复重试。
  "card.refreshed": (db, e) => {
    const p = e.payload as { card_id: string; status: string; ok?: boolean; error?: string };
    db.prepare(`UPDATE cards SET shown = ? WHERE id = ?`).run(p.status, p.card_id);
    if (p.ok === false) link(db, e.seq, p.card_id, `飞书上没改成：${p.error ?? "没有说明"}`);
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
  const runs = db.prepare(`SELECT r.id, r.purpose, r.started_at, r.heartbeat_at, t.contract, t.runs_used, t.minutes_used FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.status = 'running'`)
    .all() as { id: string; purpose: string; started_at: string; heartbeat_at: string; contract: string; runs_used: number; minutes_used: number }[];
  for (const r of runs) {
    // 单轮限时是领活时剩下的时长预算（轮次在跑时 minutes_used 不变，所以重放结果一致）。验证轮固定 30 分钟。
    const limit = r.purpose === "verify" ? VERIFY_RUN_MINUTES : runLimitMinutes({ ...r, contract: JSON.parse(r.contract) as TaskContract });
    if (now - Date.parse(r.started_at) > limit * 60_000 + RUN_GRACE_MS) markLost(db, e, r.id, `单轮超时（本轮限时 ${Math.round(limit)} 分钟）`);
    else if (now - Date.parse(r.heartbeat_at) > HEARTBEAT_TIMEOUT_MS) markLost(db, e, r.id, `心跳超时（最后心跳 ${r.heartbeat_at}）`);
  }
  const js = db.prepare(`SELECT id, kind, started_at FROM judgments WHERE status = 'running'`).all() as { id: string; kind: string; started_at: string }[];
  for (const j of js) {
    if (now - Date.parse(j.started_at) > (j.kind === "plan" ? PLAN_TIMEOUT_MS : JUDGMENT_TIMEOUT_MS)) judgmentFailed(db, e, getJudgment(db, j.id)!, "判断点超时");
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
  const run = db.prepare(`SELECT task_id, session_id, purpose FROM runs WHERE id = ?`).get(runId) as { task_id: string; session_id: string | null; purpose: string };
  db.prepare(`UPDATE runs SET status = 'lost', finished_at = ?, lost_reason = ? WHERE id = ?`).run(e.at, reason, runId);
  chargeRun(db, runId, e.at);
  link(db, e.seq, runId, `中断：${reason}`);
  const task = getTask(db, run.task_id);
  // 验证轮中断：任务留在“验证中”重新派验证，不回执行队列；连续没跑成的次数和执行共用。
  if (run.purpose === "verify") {
    if (task?.state === "verifying" && task.verify_due) verifyErrored(db, e, task, runId, `中断：${reason}`);
    else link(db, e.seq, run.task_id, `${runId} 验证中断：${reason}`);
    return;
  }
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
  releaseDeps(db, e);
  queueCleanups(db, e);
  // 轮次结束（回执、中断、限流、叫停）租约即释放。放在这里而不是各个结束轮次的地方，漏不掉。
  db.prepare(`DELETE FROM leases WHERE task_id NOT IN (SELECT task_id FROM runs WHERE status = 'running')`).run();
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
    grant: JSON.parse(r.grant_json as string), base: (r.base as string | null) ?? null,
    ...(r.checks ? { checks: JSON.parse(r.checks as string) as string[] } : {}), ...(r.split ? { split: true } : {}),
    status: r.status as Goal["status"], origin_event: r.origin_event as number,
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

// 审核卡上验证之后的三段：结果、执行者说明、证据（2026-11-13 人看 C-42 觉得不好懂后改）。
// 结果放最前面，是人最该看的：分支、推没推、相对基底改了哪些文件（接单程序用 git 算的，不靠执行者自己说）、有没有没提交的改动。
// 系统建的工作区路径不列（审核接受后就清掉，对人没用）；Agent 自己另建的照旧列出（P1-28）。说明截短，证据一条一行。
const HANDOFF_SHOWN = 300, EVIDENCE_SHOWN = 6, FILES_SHOWN = 12;
function reviewBody(t: Pick<Task, "workdir">, r: Receipt, effects: Effect[] = [], worktrees: Worktree[] = []): string {
  const own = worktrees.find((w) => w.path === t.workdir);
  const extra = worktrees.filter((w) => w.path !== t.workdir);
  const fx = effects.filter((x) => x.kind !== "remove-worktree");
  const ch = normalizeChanges(r.changes);
  const result = [
    own?.branch ? `- 分支 \`${own.branch}\`${fx.some((x) => x.status === "done") ? "" : "，没推送"}` : "",
    ...fx.map((x) => `- ${describeEffect(x)}：${x.status === "done" ? (x.result?.ref ?? "完成") : `${EFFECT_STATUS[x.status]}${x.error ? `（${x.error}）` : ""}`}`),
    ch ? `- 改动（相对基底 ${ch.base.slice(0, 7)}）：${changesLine(ch.files)}` : "",
    ch?.uncommitted.length ? `- 还有没提交的改动：${ch.uncommitted.slice(0, FILES_SHOWN).join("、")}（清理工作区时不会删）` : "",
    ...extra.map((w) => `- Agent 另建的工作区 ${w.path}${w.branch ? `（${w.branch}）` : ""}，任务结束后清理`),
  ].filter(Boolean);
  const note = (r.handoff ?? r.summary).trim();
  const ev = (r.evidence ?? []).slice(0, EVIDENCE_SHOWN).map((x) => `- ${x.check ? `${x.check} → ${x.result ?? ""}` : `${x.artifact ?? ""} ${x.ref ?? ""}`.trim()}`.replace(/\s*\n\s*/g, " "));
  return [
    result.length ? `**结果**\n${result.join("\n")}` : "",
    `**执行者说明**\n${note.length > HANDOFF_SHOWN ? `${note.slice(0, HANDOFF_SHOWN)}…` : note}`,
    ev.length ? `**证据**\n${ev.join("\n")}${(r.evidence?.length ?? 0) > EVIDENCE_SHOWN ? `\n- 另有 ${r.evidence!.length - EVIDENCE_SHOWN} 条，xj why 看` : ""}` : "",
  ].filter(Boolean).join("\n\n");
}

// 改了哪些文件：按新增、修改、删除分组，一组一句。
function changesLine(files: { status: string; path: string }[]): string {
  if (!files.length) return "没有提交新的改动";
  const groups: [string, string][] = [["A", "新增"], ["M", "修改"], ["D", "删除"]];
  const shown = files.slice(0, FILES_SHOWN);
  const parts = groups.map(([k, label]) => [label, shown.filter((f) => (k === "M" ? !["A", "D"].includes(f.status) : f.status === k)).map((f) => f.path)] as const)
    .filter(([, xs]) => xs.length).map(([label, xs]) => `${label} ${xs.join("、")}`);
  return `${parts.join("；")}${files.length > FILES_SHOWN ? `；另有 ${files.length - FILES_SHOWN} 个` : ""}`;
}
function normalizeChanges(x: unknown): { base: string; files: { status: string; path: string }[]; uncommitted: string[] } | null {
  const c = x as { base?: unknown; files?: unknown; uncommitted?: unknown } | undefined;
  if (!c || typeof c.base !== "string" || !Array.isArray(c.files)) return null;
  const files = c.files.filter((f): f is { status: string; path: string } => typeof f?.status === "string" && typeof f?.path === "string");
  return { base: c.base, files, uncommitted: Array.isArray(c.uncommitted) ? c.uncommitted.filter((u): u is string => typeof u === "string") : [] };
}

const EFFECT_STATUS: Record<Effect["status"], string> = { queued: "未执行", running: "执行中", done: "完成", failed: "失败", rejected: "没执行", cancelled: "作废" };

// 卡片正文的长度上限，细节放证据链接。目标卡和简报要列几条，放宽一些。
const CARD_BODY_MAX: Record<CardForm | "plain", number> = { plain: 400, budget: 400, alert: 600, effect: 600, goal: 900, reply: 900, brief: 1500, verify: 900, plan: 1500, ruling: 900 };

function createCard(db: DB, e: Event, kind: CardKind, about: string, title: string, body: string, options: CardOption[], dedupeKey: string,
  form: CardForm | null = null, maxBody?: number): string | null {
  const open = db.prepare(`SELECT id FROM cards WHERE dedupe_key = ? AND status = 'open'`).get(dedupeKey);
  if (open) return null; // 同一个问题还开着时不重复发
  const id = formatId("C", nextId(db, "card"));
  db.prepare(`INSERT INTO cards(id, kind, about, title, body, options, dedupe_key, status, answer, external_ref, created_at, updated_at, form)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, ?, ?)`)
    .run(id, kind, about, title, body.slice(0, maxBody ?? CARD_BODY_MAX[form ?? "plain"]), JSON.stringify(options), dedupeKey, e.at, e.at, form);
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

// 默认不拆，一个目标一个任务。标了“可能要拆”的目标先跑规划，人确认拆分计划后按任务图建（P2-08）。
function createTask(db: DB, e: Event, goalId: string, tid = formatId("T", nextId(db, "task")), override: Partial<TaskContract> = {}, state: TaskState = "queued"): string {
  const g = getGoal(db, goalId)!;
  const contract: TaskContract = {
    objective: g.title,
    acceptance: { checks: g.checks ?? [], criteria: g.acceptance },
    scope: { write: ["**"], effects: g.grant.effects },
    budget: g.grant.budget, ask_first: g.grant.ask_first, depends_on: [],
    agent: { kind: "code", tier: "strong" },
    ...(g.base ? { base: g.base } : {}),
    ...override,
  };
  // 有依赖的任务从前一个任务的分支拉（设计“隔离”），不用目标写明的基底：接单程序按依赖找分支。
  if (contract.depends_on.length) delete contract.base;
  db.prepare(`INSERT INTO tasks(id, goal_id, state, contract, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(tid, goalId, state, JSON.stringify(contract), e.at, e.at);
  link(db, e.seq, tid);
  return tid;
}

// 待确认的目标转为立项：目标 active，按它现在的内容建任务；标了要拆的先排规划（返回 null）。
function activateGoal(db: DB, e: Event, goalId: string, note?: string): string | null {
  setGoalStatus(db, goalId, "active", e.at);
  if (getGoal(db, goalId)!.split) { queuePlan(db, e, goalId, { revision: 0, ...(note ? { note } : {}) }); return null; }
  const tid = createTask(db, e, goalId);
  if (note) setFeedback(db, tid, note);
  return tid;
}

// ---- 预算（P1-13）----
// 一轮结束（回执、中断、限流、叫停）时把它跑的时长记到任务上。时间取自事件，不读时钟。
function chargeRun(db: DB, runId: string, at: string): void {
  const r = db.prepare(`SELECT task_id, started_at, purpose FROM runs WHERE id = ?`).get(runId) as { task_id: string; started_at: string | null; purpose: string } | undefined;
  if (!r?.started_at || r.purpose === "verify") return;   // 验证轮不占任务的时长预算（P2-05）
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

type AnsweredCard = { id: string; about: string; kind: CardKind; status: string; title: string; form: CardForm | null; dedupe_key: string };
type Answer = { choice?: string; text?: string; scope?: RulingScope };

function answerBudgetCard(db: DB, e: Event, card: AnsweredCard, p: Answer): void {
  const task = getTask(db, card.about);
  if (!task || task.state !== "blocked") return;
  if (p.choice === "extend") {
    // 追加在“已用”和“原预算”中较大的那个之上，保证追加后确实有余量。
    const b = task.contract.budget;
    const budget = { ...b, runs: Math.max(b.runs, task.runs_used) + BUDGET_EXTEND.runs, minutes: Math.max(b.minutes, Math.ceil(task.minutes_used)) + BUDGET_EXTEND.minutes };
    db.prepare(`UPDATE tasks SET contract = ?, failures = 0 WHERE id = ?`).run(JSON.stringify({ ...task.contract, budget }), task.id);
    // 只追加预算、没写话的，不算“带人回答”（背压下按在做的处理，P2-06）：没有要带给下一轮的内容。
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
  // 验证过的（P2-05）：卡上写验证结论，残余风险原样列出；正文放宽，免得截掉人最该看的部分。没验证过的照旧。
  const v = verdictAfter(db, taskId, runId);
  const body = reviewBody(getTask(db, taskId)!, r, effectsOfTask(db, taskId), worktreesOf(db, taskId));
  const t = getTask(db, taskId)!;
  // 合并任务（P2-09、P2-10）：它的验证就是目标验收，出一张目标级审核卡，列出各子任务和它们的残余风险（2026-11-12 人定：只审合并后的结果）。
  if (t.contract.role === "merge") {
    const g = getGoal(db, t.goal_id)!;
    createCard(db, e, "review", taskId, `目标审核：${g.title}`,
      [v ? verdictBody(v.id, v.verdict, "目标验收") : "", partsBody(db, t), body].filter(Boolean).join("\n\n"),
      [{ key: "accept", label: "接受", recommended: true }, { key: "return", label: "退回" }, { key: "takeover", label: "接管" }],
      `review:${taskId}:${runId}`, null, 2000);
    return;
  }
  createCard(db, e, "review", taskId, `审核：${r.summary}`, v ? `${verdictBody(v.id, v.verdict)}\n\n${body}` : body,
    [{ key: "accept", label: "接受", recommended: true }, { key: "return", label: "退回" }, { key: "takeover", label: "接管" }],
    `review:${taskId}:${runId}`, null, v ? 1500 : 1000);   // 结果、说明、证据分段后（2026-11-13）400 字放不下
}

// 验证通过（或没有验证者）之后：拆出来的子任务直接完成，不出审核卡，等合并后一起审（P2-08，2026-11-12 人定）；其余出审核卡。
function finishVerified(db: DB, e: Event, taskId: string, runId: string): void {
  const t = getTask(db, taskId)!;
  if (t.contract.role === "part") {
    setTaskState(db, taskId, "done", e.at);
    link(db, e.seq, taskId, "拆出来的子任务验证通过，完成；等合并后一起审核");
    return;
  }
  reviewCard(db, e, taskId, runId);
}

// 目标审核卡上的子任务一段：每个子任务一行，再把它们的残余风险列在一起。列表后面空一行（飞书）。
function partsBody(db: DB, merge: Task): string {
  const parts = merge.contract.depends_on.map((id) => getTask(db, id)).filter((x): x is Task => !!x);
  if (!parts.length) return "";
  const lines = parts.map((p) => {
    const v = lastVerdict(db, p.id);
    return `- ${p.id} ${p.contract.objective}：${p.state === "done" ? (v ? `验证通过（${v.id}）` : "完成，没有验证") : p.state}`;
  });
  const risks = parts.flatMap((p) => (lastVerdict(db, p.id)?.verdict.risks ?? []).map((x) => `- ${p.id}：${x}`));
  return [`**子任务**\n${lines.join("\n")}`, risks.length ? `**子任务的残余风险**\n${risks.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

// 审核卡上的验证一段：结论、检查命令、问题（没通过、人选了按现状审核时才有）、残余风险。
function verdictBody(runId: string, v: Verdict, label = "验证"): string {
  const checks = (v.checks ?? []).map((c) => `\`${c.command}\` ${c.skipped ? "没跑" : c.ok ? "通过" : c.exit_code == null ? "没跑成" : `退出码 ${c.exit_code}`}`).join("；");
  // 列表前后空一行：飞书的 markdown 不空行时，后面的文字会接到列表最后一项的末尾（2026-11-12 真实一轮 C-39 看到）。
  return [
    [`**${label}** ${v.pass ? "通过" : "没通过"}（${runId}${v.reviewer ? `，${v.reviewer}` : ""}）：${v.summary}`, checks && `检查命令：${checks}`].filter(Boolean).join("\n"),
    v.issues.length ? `问题：\n${v.issues.map((i) => `- ${issueLine(i)}`).join("\n")}` : "",
    `**残余风险**\n${v.risks.map((x) => `- ${x}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");
}

// ---- 验证（P2-05）----
// 被验证的那一轮：最近一个交了回执的执行轮。
function subjectRun(db: DB, taskId: string): string | null {
  const r = db.prepare(`SELECT id FROM runs WHERE task_id = ? AND purpose = 'execute' AND receipt IS NOT NULL ORDER BY rowid DESC LIMIT 1`).get(taskId) as { id: string } | undefined;
  return r?.id ?? null;
}
// 这一轮之后最近的验证结论。
function verdictAfter(db: DB, taskId: string, runId: string): { id: string; verdict: Verdict } | null {
  const r = db.prepare(`SELECT id, verdict FROM runs WHERE task_id = ? AND purpose = 'verify' AND verdict IS NOT NULL
      AND rowid > COALESCE((SELECT rowid FROM runs WHERE id = ?), 0) ORDER BY rowid DESC LIMIT 1`).get(taskId, runId) as { id: string; verdict: string } | undefined;
  return r ? { id: r.id, verdict: JSON.parse(r.verdict) as Verdict } : null;
}
export function lastVerdict(db: DB, taskId: string): { id: string; verdict: Verdict } | null {
  return verdictAfter(db, taskId, "");
}

function normalizeCheckResults(x: unknown): CheckResult[] {
  if (!Array.isArray(x)) return [];
  return x.slice(0, 5).map((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    return { command: String(o.command ?? "").slice(0, 200), ok: o.ok === true, exit_code: typeof o.exit_code === "number" ? o.exit_code : null,
      output: String(o.output ?? "").slice(-1000), ...(typeof o.skipped === "string" && o.skipped ? { skipped: o.skipped.slice(0, 200) } : {}) };
  }).filter((c) => c.command);
}

// 验证者没跑成（出错、输出不合格式、中断）：任务留在“验证中”重新派；连续第 3 次问人。
function verifyErrored(db: DB, e: Event, t: Task, runId: string, reason: string): void {
  const n = t.failures + 1;
  db.prepare(`UPDATE tasks SET failures = ? WHERE id = ?`).run(n, t.id);
  if (n < MAX_FAILURES) { link(db, e.seq, t.id, `${runId} 验证者没跑成（${reason}），重新派验证`); return; }
  setTaskState(db, t.id, "blocked", e.at);
  createCard(db, e, "decision", t.id, `验证者连续 ${n} 次没跑成`, `最近一次（${runId}）：${reason}\n重新验证：确认验证者能用后再试。按现状审核：不验证了，出审核卡你自己看。放弃：任务结束。`,
    VERIFY_ERROR_OPTIONS, `verify:${t.id}`, "verify");
  link(db, e.seq, t.id, `${runId} 验证者连续 ${n} 次没跑成，问人`);
}

function answerVerifyCard(db: DB, e: Event, card: AnsweredCard, p: Answer): void {
  const t = getTask(db, card.about);
  if (!t || t.state !== "blocked") return;
  const note = p.text?.trim();
  if (p.choice === "abandon") { setTaskState(db, t.id, "abandoned", e.at); return; }
  if (p.choice === "review") {
    db.prepare(`UPDATE tasks SET verify_due = NULL, failures = 0 WHERE id = ?`).run(t.id);
    const run = subjectRun(db, t.id);
    if (run) reviewCard(db, e, t.id, run);
    link(db, e.seq, t.id, "人选按现状审核");
    return;
  }
  if (p.choice === "retry" && t.verify_due) {
    db.prepare(`UPDATE tasks SET failures = 0, verify_not_before = NULL WHERE id = ?`).run(t.id);
    setTaskState(db, t.id, "verifying", e.at);
    link(db, e.seq, t.id, "人选重新验证");
    return;
  }
  // 再给 3 轮（只写了字没点按钮也算）：轮数重新算，带着最后一次验证意见开下一轮。
  db.prepare(`UPDATE tasks SET verify_failures = 0, failures = 0 WHERE id = ?`).run(t.id);
  const last = lastVerdict(db, t.id);
  if (last && !last.verdict.pass) setFeedback(db, t.id, verifyFeedback(last.id, MAX_VERIFY_ROUNDS, last.verdict));
  if (note) setFeedback(db, t.id, `人对验证卡的说明（${card.id}）：${note}`);
  requeue(db, e, t.id, `人选再给 ${MAX_VERIFY_ROUNDS} 轮验证`);
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
// ---- Agent 建的 worktree（P1-28）----
// 每个任务一个隔离工作区要到二期；在那之前 Agent 自己建的 worktree 由系统记下，审核卡上列出，任务结束后清理。
function worktreesOf(db: DB, taskId: string): Worktree[] {
  const r = db.prepare(`SELECT worktrees FROM tasks WHERE id = ?`).get(taskId) as { worktrees: string | null } | undefined;
  return r?.worktrees ? JSON.parse(r.worktrees) as Worktree[] : [];
}
function addWorktrees(db: DB, e: Event, taskId: string, reported: Worktree[]): void {
  if (!getTask(db, taskId)) return;
  const have = worktreesOf(db, taskId);
  const fresh = reported.slice(0, 10).filter((w) => typeof w?.path === "string" && w.path.startsWith("/") && !have.some((h) => h.path === w.path))
    .map((w) => ({ path: w.path, ...(typeof w.branch === "string" && w.branch ? { branch: w.branch } : {}) }));
  if (!fresh.length) return;
  db.prepare(`UPDATE tasks SET worktrees = ? WHERE id = ?`).run(JSON.stringify([...have, ...fresh]), taskId);
  link(db, e.seq, taskId, `Agent 建了工作区 ${fresh.map((w) => w.path).join("、")}，任务结束后清理`);
}
// 每条事件归并后看一眼：结束了的任务还有没排清理的 worktree，就排上。放在这里而不是各个结束任务的地方，漏不掉。
function queueCleanups(db: DB, e: Event): void {
  const rows = db.prepare(`SELECT id, worktrees FROM tasks WHERE worktrees IS NOT NULL AND state IN ('done','abandoned','stopped')`).all() as { id: string; worktrees: string }[];
  for (const t of rows) {
    for (const w of JSON.parse(t.worktrees) as Worktree[]) {
      const key = `cleanup:${t.id}:${w.path}`;
      if (db.prepare(`SELECT 1 FROM effects WHERE key = ?`).get(key)) continue;
      const run = db.prepare(`SELECT id FROM runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1`).get(t.id) as { id: string } | undefined;
      const id = formatId("X", nextId(db, "effect"));
      db.prepare(`INSERT INTO effects(id, task_id, run_id, kind, params, key, status, created_at) VALUES (?, ?, ?, 'remove-worktree', ?, ?, 'queued', ?)`)
        .run(id, t.id, run?.id ?? "", JSON.stringify({ branch: w.branch ?? "", remote: "", path: w.path, ...(w.repo ? { repo: w.repo } : {}) }), key, e.at);
      link(db, e.seq, id, `任务结束，清理工作区 ${w.path}`);
      link(db, e.seq, t.id, `${id} 清理工作区 ${w.path}`);
    }
  }
}

export function describeEffect(x: Pick<Effect, "kind" | "params">): string {
  return x.kind === "open-pr" ? `开 PR ${x.params.branch} → ${x.params.base ?? "main"}` : x.kind === "push-branch" ? `推分支 ${x.params.remote}/${x.params.branch}`
    : x.kind === "remove-worktree" ? `清理工作区 ${x.params.path}` : x.kind;
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
  link(db, e.seq, x.id, `失败：${reason}`);
  if (x.kind === "remove-worktree") {
    // 清理不掉（有没提交的改动等）：任务已经结束，不挡任何事，记一张知会卡让人自己看，不删人的东西。
    createCard(db, e, "notice", x.task_id, `没清掉工作区 ${x.params.path}`, `${reason}\n确认里面没有要留的东西后，手动 git worktree remove。`, [], `cleanup:${x.task_id}:${x.params.path}`);
    return;
  }
  db.prepare(`UPDATE effects SET status = 'cancelled', error = '前一个对外动作失败，没有执行', finished_at = ? WHERE run_id = ? AND status = 'queued' AND kind != 'remove-worktree'`).run(e.at, x.run_id);
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
  if (t.state === "verifying" && t.verify_due) { link(db, e.seq, taskId, `对外动作做完了，等 ${t.verify_due} 验证`); return; }
  if (t.state === "verifying") { finishVerified(db, e, taskId, run.id); return; }
  const fx = effectsOfRun(db, run.id);
  if (!fx.length) return;
  clearWaits(db, taskId);
  setFeedback(db, taskId, `${SYSTEM_FEEDBACK_PREFIX}你请求的对外动作：${effectsLine(fx)}。据此接着做；做完了就交 done。`);
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
  // 跳过：直接出审核卡，卡上照实写哪些没做成。还没验证的先去验证（P2-05）。
  if (t.state === "blocked" && t.verify_due) { setTaskState(db, t.id, "verifying", e.at); link(db, e.seq, t.id, "人选跳过对外动作，先验证"); return; }
  if (t.state === "blocked" && last) reviewCard(db, e, t.id, last.run_id);
}

// ---- 补充（P1-23）----
// 在途的目标：等人确认的目标卡，以及任务还没结束的目标（含审核卡已出、等人审核的：实测 G-11 是对审核中的 G-10 的补充）。
function pendingGoals(db: DB): PendingGoal[] {
  const proposed = db.prepare(`SELECT id, title FROM goals WHERE status = 'proposed' ORDER BY rowid`).all() as { id: string; title: string }[];
  const rows = db.prepare(`SELECT g.id, g.title, t.id AS task, t.state, t.contract FROM goals g JOIN tasks t ON t.goal_id = g.id
      WHERE g.status = 'active' AND t.state IN ('queued','running','verifying','awaiting_world','awaiting_answer','blocked','awaiting_review','awaiting_deps') ORDER BY g.rowid, t.rowid`).all() as { id: string; title: string; task: string; state: string; contract: string }[];
  // 拆开的目标（P2-08）有几个任务：每个目标只列一次，补充送到合并任务（最终结果在它那里），还没拆完的送到第一个没结束的任务。
  // 不拆的目标只有一个任务，和以前一样（等依赖的状态只有拆开的目标才有）。
  const active: typeof rows = [];
  for (const r of rows) {
    const i = active.findIndex((x) => x.id === r.id);
    if (i < 0) active.push(r);
    else if ((JSON.parse(r.contract) as TaskContract).role === "merge") active[i] = r;
  }
  return [...proposed.map((g) => ({ goal: g.id, title: g.title, status: "proposed" as const })),
    ...active.map((g) => ({ goal: g.id, title: g.title, status: "active" as const, task: g.task, ...(g.state === "awaiting_review" ? { reviewing: true } : {}) }))].slice(-10);
}

// 主理人判断这句话是对在途目标 target 的补充：这句话的目标作废（并入），补充送到 target。
function amendGoal(db: DB, e: Event, j: Judgment, self: Goal, target: string): void {
  const hit = (j.input as IntakeInput).pending?.find((x) => x.goal === target);
  if (!hit) { judgmentFailed(db, e, j, `补充指向的 ${target} 不在在途目标里`); return; }
  setGoalStatus(db, self.id, "abandoned", e.at);
  link(db, e.seq, self.id, `是对 ${target} 的补充，并入`);
  const text = (j.input as IntakeInput).request;
  const g = getGoal(db, target);
  let how: string;
  if (g?.status === "proposed") {
    // 撤回还开着的目标卡，带着这句话重整一张。
    for (const c of db.prepare(`SELECT id FROM cards WHERE about = ? AND form = 'goal' AND status = 'open'`).all(target) as { id: string }[]) {
      db.prepare(`UPDATE cards SET status = 'withdrawn', updated_at = ? WHERE id = ?`).run(e.at, c.id);
      link(db, e.seq, c.id, `人补充了一句，撤回重整`);
    }
    const prev = db.prepare(`SELECT id FROM judgments WHERE about = ? AND kind = 'intake' ORDER BY rowid DESC LIMIT 1`).get(target) as { id: string } | undefined;
    const input = prev ? getJudgment(db, prev.id)!.input as IntakeInput : { request: g.title, revision: 0 };
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
  return { kind: "goal", direct: false, title: g.title, acceptance: g.acceptance, boundaries: g.boundaries, ask_first: g.grant.ask_first, budget: g.grant.budget,
    ...(g.base ? { base: g.base } : {}), ...(g.checks?.length ? { checks: g.checks } : {}), ...(g.split ? { split: true } : {}) };
}

// ---- 主理人（P1-10）----
function queueJudgment(db: DB, e: Event, kind: JudgmentKind, about: string, input: IntakeInput | PlanInput): string {
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
  if (j.kind === "plan") {
    // 规划连续没成：不拆，照旧一个任务做（默认就是不拆），知会人一声。
    const goal = getGoal(db, j.about);
    if (goal?.status !== "active" || taskCount(db, goal.id)) return;
    const tid = createTask(db, e, goal.id);
    const note = (j.input as PlanInput).note;
    if (note) setFeedback(db, tid, note);
    createCard(db, e, "notice", goal.id, `规划没成，${goal.id} 不拆：${tid}`, `规划连续 ${n} 次没成（${reason}），按默认不拆，一个任务做。`, [], `plan:${goal.id}:failed`);
    link(db, e.seq, goal.id, `${j.id} 连续 ${n} 次失败，不拆，立项 ${tid}`);
    return;
  }
  if (j.kind === "intake") {
    // 主理人整理不出来：按原话出目标卡，人可以直接确认，也可以写修改意见再让它试一次。
    const goal = getGoal(db, j.about);
    if (goal?.status !== "proposed") return;
    goalCard(db, e, goal.id, (j.input as IntakeInput).revision, `主理人连续 ${n} 次没整理出来（${reason}），下面按原话列出。`);
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
    createCard(db, e, "notice", goal.id, `主理人：${draft.reply}`, `你说的是：“${(j.input as IntakeInput).request}”。不像要系统去做的事，没有立项；要做的话换个说法再发一次。`,
      [], `reply:${goal.id}`, "reply");
    link(db, e.seq, goal.id, "主理人判断不是目标，没有立项");
    return;
  }
  const grant: Grant = { ...goal.grant, ask_first: draft.ask_first, budget: draft.budget ?? DEFAULT_GRANT.budget };
  db.prepare(`UPDATE goals SET title = ?, acceptance = ?, boundaries = ?, grant_json = ?, updated_at = ? WHERE id = ?`)
    .run(draft.title, JSON.stringify(draft.acceptance), JSON.stringify(draft.boundaries), JSON.stringify(grant), e.at, goal.id);
  db.prepare(`UPDATE goals SET base = ? WHERE id = ?`).run(draft.base ?? null, goal.id);
  const direct = draft.direct && (j.input as IntakeInput).revision === 0 && !draft.budget && !draft.notes?.length;
  // 检查命令只上目标卡，人确认了才跑；直接立项的不带（P2-05，2026-11-12 人定）。
  db.prepare(`UPDATE goals SET checks = ? WHERE id = ?`).run(!direct && draft.checks?.length ? JSON.stringify(draft.checks) : null, goal.id);
  db.prepare(`UPDATE goals SET split = ? WHERE id = ?`).run(draft.split ? 1 : null, goal.id);   // 可能要拆（P2-08）
  // 小而明确的请求跳过确认、直接立项（设计文档“说目标”）。只认初稿，不能改默认预算，也不能带提醒；
  // 改过一次的、主理人觉得有事要人知道的，一律请人确认。
  if (direct) {
    const tid = activateGoal(db, e, goal.id)!;   // 标了要拆的不会直接立项（normalizeDraft）
    createCard(db, e, "notice", goal.id, `已立项 ${goal.id} · ${tid}：${draft.title}`,
      `${goalCardBody(getGoal(db, goal.id)!)}\n\n小而明确，没等你确认就开工了。做完会出审核卡；不想做发 /stop ${tid}。`, [], `reply:${goal.id}`, "reply");
    link(db, e.seq, goal.id, `小而明确，直接立项 ${tid}`);
    return;
  }
  goalCard(db, e, goal.id, (j.input as IntakeInput).revision, "", draft.notes);
}

function goalCard(db: DB, e: Event, goalId: string, revision: number, note = "", notes: string[] = []): void {
  const g = getGoal(db, goalId)!;
  createCard(db, e, "decision", g.id, `目标卡：${g.title}`, [note, goalCardBody(g, notes)].filter(Boolean).join("\n\n"), GOAL_OPTIONS, `goal:${g.id}:${revision}`, "goal");
}

function answerGoalCard(db: DB, e: Event, card: AnsweredCard, p: Answer): void {
  const goal = getGoal(db, card.about);
  if (!goal || goal.status !== "proposed") return;
  if (p.choice === "confirm") {
    // 确认时写的那句话是人的补充，带进第一轮（不能丢）；要拆的目标先带进规划，再带给拆出来的每个任务。
    const note = p.text?.trim();
    const tid = activateGoal(db, e, goal.id, note ? `人确认目标卡时补充：${note}` : undefined);
    link(db, e.seq, goal.id, `人确认目标卡，${tid ? `立项 ${tid}` : "先规划拆分"}${note ? "，带着补充" : ""}`);
  } else if (p.choice === "drop") {
    setGoalStatus(db, goal.id, "abandoned", e.at);
    link(db, e.seq, goal.id, "人选不做");
  } else {
    // 修改（只写了字没点按钮也算修改）：带着上一版和修改意见，再排一次主理人。
    const prev = db.prepare(`SELECT id FROM judgments WHERE about = ? AND kind = 'intake' ORDER BY rowid DESC LIMIT 1`).get(goal.id) as { id: string } | undefined;
    const input = prev ? getJudgment(db, prev.id)!.input as IntakeInput : { request: goal.title, revision: 0 };
    queueJudgment(db, e, "intake", goal.id, {
      request: input.request, revision: input.revision + 1,
      draft: draftOf(goal),
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
  // 背压上限在配置里，内核落账时写进了这条事件（Kernel.ingest），所以重放结果不随配置变。
  const p = e.payload as { date?: unknown; backpressure?: { soft?: unknown; hard?: unknown } };
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
  const bl = p.backpressure;
  if (bl && typeof bl.soft === "number" && typeof bl.hard === "number") {
    const line = backpressureLine(backpressureView(db, { soft: bl.soft, hard: bl.hard }));
    if (line) lines.push(`**${line.split("，")[0]}**：${line.slice(line.indexOf("，") + 1)}`);
  }
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

// ---- 定论（P2-07）----
// 范围怎么匹配：task 只管出处那个任务；goal 管出处所在目标的全部任务；project 等于工作仓库（二期只有一个），和 global 一样都管。
// 出处记的是卡片说的那件事（T-x 或 G-x），这里再换算成目标，账本里的老定论不用改。
export const RULINGS_MAX = 20;
function rowToRuling(r: Record<string, unknown>): Ruling {
  return { id: r.id as string, scope: r.scope as RulingScope, scope_ref: (r.scope_ref as string | null) ?? null, text: r.text as string,
    origin: r.origin as string, decided_at: r.decided_at as string, revoked: !!r.revoked };
}
export function getRuling(db: DB, id: string): Ruling | undefined {
  const r = db.prepare(`SELECT * FROM rulings WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? rowToRuling(r) : undefined;
}
export function listRulings(db: DB, all = false): Ruling[] {
  return (db.prepare(`SELECT * FROM rulings ${all ? "" : "WHERE revoked = 0"} ORDER BY rowid`).all() as Record<string, unknown>[]).map(rowToRuling);
}
function goalOfRef(db: DB, ref: string | null): string | null {
  if (!ref) return null;
  if (/^G-\d+$/.test(ref)) return ref;
  return (db.prepare(`SELECT goal_id FROM tasks WHERE id = ?`).get(ref) as { goal_id: string } | undefined)?.goal_id ?? null;
}
// 一件事适用的定论：生效中的、范围对得上的，最近的 20 条。task 不给时只看目标（规划时还没有任务）。
export function rulingsFor(db: DB, at: { goal_id: string; task_id?: string | undefined }): Ruling[] {
  return listRulings(db).filter((r) => r.scope === "global" || r.scope === "project"
    || (r.scope === "goal" && goalOfRef(db, r.scope_ref) === at.goal_id)
    || (r.scope === "task" && !!at.task_id && r.scope_ref === at.task_id)).slice(-RULINGS_MAX);
}
export const SCOPE_TEXT: Record<RulingScope, string> = { task: "仅这件事", goal: "这个目标", project: "这个项目", global: "以后都这样" };

function rulingCard(db: DB, e: Event, taskId: string, r: Ruling, question: string, why: string): void {
  createCard(db, e, "decision", taskId, `定论 ${r.id} 这次不适用？${question}`.slice(0, 120),
    [`**定论 ${r.id}**（${SCOPE_TEXT[r.scope]}，${r.decided_at.slice(0, 10)}，出处 ${r.origin}）：${r.text}`,
      `**Agent 认为不适用的理由** ${why || "（没写）"}`,
      "照定论做：Agent 照这条定论接着做。这次例外：只这个任务这一次不照它做，定论留着。作废这条定论：以后都不再注入。"].join("\n\n"),
    RULING_OPTIONS, `ruling:${taskId}:${r.id}`, "ruling", 900);
}

function answerRulingCard(db: DB, e: Event, card: AnsweredCard, p: Answer): void {
  const t = getTask(db, card.about);
  if (!t || t.state !== "awaiting_answer") return;
  const rid = card.dedupe_key.split(":")[2] ?? "";
  const note = p.text?.trim();
  const said = note ? `；说明：${note}` : "";
  if (p.choice === "revoke") {
    if (db.prepare(`UPDATE rulings SET revoked = 1 WHERE id = ? AND revoked = 0`).run(rid).changes) link(db, e.seq, rid, `人在 ${card.id} 上作废了这条定论`);
    setFeedback(db, t.id, `人对“定论 ${rid} 不适用”（${card.id}）的回答：作废这条定论，不用再照它做${said}`);
  } else if (p.choice === "except") {
    setFeedback(db, t.id, `人对“定论 ${rid} 不适用”（${card.id}）的回答：这次例外，这个任务可以不照 ${rid} 做，定论本身留着${said}`);
  } else {
    setFeedback(db, t.id, `人对“定论 ${rid} 不适用”（${card.id}）的回答：${p.choice === "keep" ? `照定论 ${rid} 做` : (note ?? "")}${p.choice === "keep" ? said : ""}`);
  }
  db.prepare(`UPDATE tasks SET failures = 0 WHERE id = ?`).run(t.id);
  requeue(db, e, t.id);
}

// ---- 规划与任务图（P2-08、P2-09）----
function taskCount(db: DB, goalId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE goal_id = ?`).get(goalId) as { n: number }).n;
}

// 排一次规划：输入是目标和它适用的定论，修改时带上一版和修改意见。
function queuePlan(db: DB, e: Event, goalId: string, extra: { revision: number; previous?: Plan; feedback?: string; note?: string }): string {
  const g = getGoal(db, goalId)!;
  const input: PlanInput = {
    goal: { id: g.id, title: g.title, acceptance: g.acceptance, boundaries: g.boundaries, checks: g.checks ?? [], ...(g.base ? { base: g.base } : {}) },
    rulings: rulingsFor(db, { goal_id: g.id }).map((r) => ({ id: r.id, text: r.text })),
    ...extra,
  };
  const id = queueJudgment(db, e, "plan", goalId, input);
  link(db, e.seq, goalId, `${id} 规划拆分`);
  return id;
}

function onPlan(db: DB, e: Event, j: Judgment, plan: Plan): void {
  const goal = getGoal(db, j.about);
  if (!goal || goal.status !== "active" || taskCount(db, goal.id)) { link(db, e.seq, j.about, `${j.id} 的计划已经用不上了`); return; }
  const newer = db.prepare(`SELECT 1 FROM judgments WHERE about = ? AND kind = 'plan' AND status IN ('queued','running') AND rowid > (SELECT rowid FROM judgments WHERE id = ?)`).get(goal.id, j.id);
  if (newer) { link(db, e.seq, goal.id, `${j.id} 的计划已被后来的修改取代`); return; }
  const input = j.input as PlanInput;
  if (!plan.split) {
    // 规划判断不拆：照旧一个任务，知会人一声（不拆不出决策卡）。
    const tid = createTask(db, e, goal.id);
    if (input.note) setFeedback(db, tid, input.note);
    createCard(db, e, "notice", goal.id, `规划：${goal.id} 不拆，一个任务做（${tid}）`, plan.why, [], `plan:${goal.id}:${input.revision}`);
    link(db, e.seq, goal.id, `${j.id} 规划不拆，立项 ${tid}`);
    return;
  }
  // 二期每次拆分都出决策卡，人确认后才开工（2026-11-12 人定）。
  createCard(db, e, "decision", goal.id, `拆分计划：${goal.title}`.slice(0, 120), planCardBody(plan, { acceptance: goal.acceptance, checks: goal.checks ?? [] }, input.revision),
    PLAN_OPTIONS, `plan:${goal.id}:${input.revision}`, "plan", 1500);
  link(db, e.seq, goal.id, `${j.id} 规划拆成 ${plan.tasks.length} 个，等人确认`);
}

function latestPlan(db: DB, goalId: string): { j: Judgment; plan: Plan } | null {
  const r = db.prepare(`SELECT id FROM judgments WHERE about = ? AND kind = 'plan' AND status = 'finished' ORDER BY rowid DESC LIMIT 1`).get(goalId) as { id: string } | undefined;
  const j = r ? getJudgment(db, r.id) : undefined;
  return j?.output ? { j, plan: j.output as Plan } : null;
}

function answerPlanCard(db: DB, e: Event, card: AnsweredCard, p: Answer): void {
  const goal = getGoal(db, card.about);
  if (!goal || goal.status !== "active" || taskCount(db, goal.id)) return;
  const last = latestPlan(db, goal.id);
  const input = last?.j.input as PlanInput | undefined;
  const note = p.text?.trim();
  if (p.choice === "split" && last?.plan.split) {
    const ids = createPlanTasks(db, e, goal, last.plan, [input?.note, note && `人确认拆分计划时补充：${note}`].filter((x): x is string => !!x).join("\n") || undefined);
    link(db, e.seq, goal.id, `人确认拆分，建 ${ids.join("、")}`);
    return;
  }
  if (p.choice === "single") {
    const tid = createTask(db, e, goal.id);
    for (const x of [input?.note, note && `人选不拆时补充：${note}`]) if (x) setFeedback(db, tid, x);
    link(db, e.seq, goal.id, `人选不拆，立项 ${tid}`);
    return;
  }
  // 修改（只写了字没点按钮也算修改）：带着上一版和修改意见再规划一次。
  queuePlan(db, e, goal.id, { revision: (input?.revision ?? 0) + 1, ...(last ? { previous: last.plan } : {}),
    feedback: note || "人要求修改，但没写改什么", ...(input?.note ? { note: input.note } : {}) });
}

// 按计划建任务：拆出来的各部分（part）加一个合并任务（merge）。编号先按计划顺序签发，依赖再换成编号。
// 子任务只能改自己的可写范围，不做对外动作；对外动作留给合并任务。预算每个任务照目标的授权给（Agent 定，可逆）。
function createPlanTasks(db: DB, e: Event, g: Goal, plan: Plan, note?: string): string[] {
  const ids = new Map(plan.tasks.map((t) => [t.key, formatId("T", nextId(db, "task"))] as const));
  const parts = plan.tasks.map((t) => {
    const deps = t.depends_on.map((k) => ids.get(k)!);
    const id = createTask(db, e, g.id, ids.get(t.key)!, {
      objective: t.objective, acceptance: { checks: t.checks, criteria: t.criteria }, scope: { write: t.write, effects: [] },
      depends_on: deps, role: "part",
    }, deps.length ? "awaiting_deps" : "queued");
    link(db, e.seq, id, `拆分计划里的 ${t.key}${deps.length ? `，等 ${deps.join("、")}` : ""}`);
    return id;
  });
  const merge = createTask(db, e, g.id, undefined, { objective: mergeObjective(g.title, parts), depends_on: parts, role: "merge" }, "awaiting_deps");
  link(db, e.seq, merge, `合并任务，等 ${parts.join("、")}`);
  if (note) for (const id of [...parts, merge]) setFeedback(db, id, note);
  return [...parts, merge];
}

// 依赖放行（P2-08，设计“目标层的对账”）：等依赖的任务，依赖都完成了就回队列；有依赖没做完就结束（放弃或被停），它也不再做。
// 每条事件归并后看一眼，放在这里而不是各个结束任务的地方，漏不掉。
function releaseDeps(db: DB, e: Event): void {
  for (let changed = true; changed;) {
    changed = false;
    for (const { id } of db.prepare(`SELECT id FROM tasks WHERE state = 'awaiting_deps' ORDER BY rowid`).all() as { id: string }[]) {
      const t = getTask(db, id)!;
      const deps = t.contract.depends_on.map((d) => ({ id: d, state: getTask(db, d)?.state }));
      const dead = deps.find((d) => !d.state || ["abandoned", "stopped"].includes(d.state));
      if (dead) {
        setTaskState(db, id, "abandoned", e.at);
        link(db, e.seq, id, `依赖的 ${dead.id} 没做完（${dead.state ?? "不存在"}），不再做`);
        changed = true;
      } else if (deps.every((d) => d.state === "done")) {
        setTaskState(db, id, "queued", e.at);
        link(db, e.seq, id, `依赖的 ${deps.map((d) => d.id).join("、")} 都完成了，开工`);
        changed = true;
      }
    }
  }
}
