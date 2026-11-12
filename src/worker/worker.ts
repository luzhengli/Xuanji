// 接单程序：领任务、起进程、心跳、停止、交回执。与内核同机，经本机接口连进来，自己保管凭据。
import { parseReceipt } from "../kernel/receipt.ts";
import { parseDraft, type DraftResult } from "../kernel/intake.ts";
import { runLimitMinutes } from "../kernel/budget.ts";
import { buildPrompt, buildResumePrompt, buildIntakePrompt } from "./context-pack.ts";
import type { AgentAdapter, RunRequest, RunResult } from "./adapters/types.ts";
import type { Effect, Goal, Judgment, Receipt, Task } from "../kernel/types.ts";
import { runEffect, execReal, type Exec } from "./effects.ts";

// 判断点一轮最多跑多久。内核那边 5 分钟没结果判失败（JUDGMENT_TIMEOUT_MS），这里先结束进程。
export const JUDGMENT_RUN_MS = 180_000;

// 执行的 Agent 不能自己做对外动作：推送和改 PR 的命令禁掉，写进回执的 effects 由接单程序代为执行（P1-21）。
// 这是尽力而为的拦截（换个写法的命令拦不住），真正的边界仍是沙箱和权限模式；查看类命令（gh pr view/list）不拦。
export const EXECUTION_DISALLOWED = ["Bash(git push:*)", "Bash(gh pr create:*)", "Bash(gh pr merge:*)", "Bash(gh pr close:*)",
  "Bash(gh pr edit:*)", "Bash(gh pr comment:*)", "Bash(gh pr review:*)", "Bash(gh repo create:*)", "Bash(gh release:*)"];

export interface ClaimResult {
  task: Task;
  agent: string;
  purpose: string;
  run_id: string;              // 内核领活时签发
  feedback: string | null;     // 人的回答或退回意见，带进这一轮
  recovery?: string | null;    // 上一轮中断后的恢复说明（P1-14）
  previous: Receipt | null;    // 上一轮回执，取它的交接说明
}

export interface KernelClient {
  claim(agent: string): Promise<ClaimResult | { task: null }>;
  claimJudgment(agent: string): Promise<{ judgment: Judgment | null }>;
  claimEffect(): Promise<{ effect: Effect | null; workdir?: string | null; goal_id?: string }>;
  emit(type: string, payload: Record<string, unknown>, about?: string): Promise<void>;
  goal(id: string): Promise<Goal>;
  runStatus(runId: string): Promise<string>;
}

export interface WorkerOptions {
  profiles?: Record<string, { model?: string | undefined; permission_mode?: string | undefined }>;
  heartbeatMs?: number;
  log?: (line: string) => void;
  identity?: { worker: string; instance: string } | undefined;   // 启动报到用，须与客户端领活时带的一致
  reap?: (() => string[]) | undefined;                            // 启动时清理上个实例留下的 Agent 进程
  exec?: Exec | undefined;                                        // 对外动作用的命令执行器（测试时换成假的）
}

export class Worker {
  private readonly kernel: KernelClient;
  private readonly adapters: Record<string, AgentAdapter>;
  private readonly workRoot: string;
  private readonly opts: WorkerOptions;
  constructor(kernel: KernelClient, adapters: Record<string, AgentAdapter>, workRoot: string, opts: WorkerOptions = {}) {
    this.kernel = kernel; this.adapters = adapters; this.workRoot = workRoot; this.opts = opts;
  }

  // 启动：先清理上个实例留下的 Agent 进程，再向内核报到；内核据此把旧实例领的轮次判为中断，带恢复说明重派。
  async start(): Promise<void> {
    const reaped = this.opts.reap?.() ?? [];
    if (reaped.length) this.log(`结束上个实例留下的 Agent 进程：${reaped.join(", ")}`);
    if (this.opts.identity) await this.kernel.emit("worker.started", { ...this.opts.identity, reaped });
  }

  // 一次领活。真正的循环由 main 用定时器驱动；每轮用完即退，不常驻 Agent 进程。
  async once(agentName: string): Promise<boolean> {
    const a = await this.kernel.claim(agentName);
    if (!a.task) return false;
    this.log(`${a.run_id} 领到 ${a.task.id}${a.task.session_id ? `（接上会话 ${a.task.session_id}）` : ""}${a.recovery ? "，带恢复说明" : ""}`);
    try {
      await this.execute(agentName, a);
    } catch (err) {
      // 起不了进程之类的故障：交一张 failed 回执，由内核退避重试，任务不会卡在“执行中”。
      const msg = (err as Error).message;
      this.log(`${a.run_id} 出错：${msg}`);
      await this.receipt(a, null, { outcome: "failed", summary: `接单程序出错：${msg}`.slice(0, 300) });
    }
    return true;
  }

  // 一次领判断点（P1-10 主理人）：起一次不给工具的 Agent，取最后一条消息里的目标卡草稿交回内核。
  // 不接会话、不发心跳；格式错了在同一会话里请它重写一次，还不行就交错误，由内核重新排队或退回人手里。
  async judgeOnce(agentName: string): Promise<boolean> {
    const { judgment: j } = await this.kernel.claimJudgment(agentName);
    if (!j) return false;
    this.log(`${j.id} 领到主理人判断点（${j.about}）`);
    let parsed: DraftResult = { ok: false, error: "没有运行" }, res: RunResult | null = null;
    try {
      const adapter = this.adapters[agentName];
      if (!adapter) throw new Error(`没有 ${agentName} 的适配器`);
      const profile = this.opts.profiles?.[agentName] ?? {};
      const base = { cwd: this.workRoot, model: profile.model, permission_mode: profile.permission_mode, tools: [] as string[], timeout_ms: JUDGMENT_RUN_MS };
      res = await adapter.run({ ...base, prompt: buildIntakePrompt(j.input), label: j.id });
      if (res.rate_limit) await this.kernel.emit("quota.observed", { agent: agentName, ...res.rate_limit });
      parsed = res.stopped ? { ok: false, error: "判断点超时" } : res.rate_limited ? { ok: false, error: "订阅额度限流" } : parseDraft(res.last_message);
      if (!parsed.ok && res.session_id && !res.stopped && !res.rate_limited) {
        this.log(`${j.id} 输出格式错误（${parsed.error}），请它重写`);
        const retry = await adapter.run({ ...base, prompt: `输出格式错误：${parsed.error}。只重写最后一条消息为合法的 JSON 对象。`,
          session_id: res.session_id, timeout_ms: 120_000, label: `${j.id}-rewrite` });
        parsed = parseDraft(retry.last_message);
      }
    } catch (err) {
      parsed = { ok: false, error: `接单程序出错：${(err as Error).message}`.slice(0, 300) };
    }
    await this.kernel.emit("judgment.result", { judgment_id: j.id, ...(parsed.ok ? { output: parsed.draft } : { error: parsed.error }),
      session_id: res?.session_id ?? undefined, usage: res?.usage }, j.about);
    this.log(`${j.id} 交结果：${parsed.ok ? `${parsed.draft.kind}${parsed.draft.direct ? "（直接立项）" : ""} ${parsed.draft.title || parsed.draft.reply}` : `失败 ${parsed.error}`}`);
    return true;
  }

  // 一次领对外动作（P1-21）：内核已落账，这里执行并把结果报回去。不起 Agent。
  async effectOnce(): Promise<boolean> {
    const c = await this.kernel.claimEffect();
    if (!c.effect) return false;
    const x = c.effect;
    this.log(`${x.id} 执行 ${x.kind} ${x.params.branch}（${x.task_id}，第 ${x.attempts} 次）`);
    let out;
    try { out = await runEffect(x, c.workdir ?? this.workRoot, c.goal_id ?? "", this.opts.exec ?? execReal); }
    catch (err) { out = { ok: false, detail: `接单程序出错：${(err as Error).message}`.slice(0, 300), retryable: true }; }
    await this.kernel.emit("effect.result", { effect_id: x.id, ...out }, x.task_id);
    this.log(`${x.id} ${out.ok ? `完成 ${out.ref ?? ""}` : `失败 ${out.detail}`}`);
    return true;
  }

  private async execute(agentName: string, a: ClaimResult): Promise<void> {
    const { task, run_id } = a;
    const adapter = this.adapters[agentName];
    if (!adapter) throw new Error(`没有 ${agentName} 的适配器`);
    const goal = await this.kernel.goal(task.goal_id);
    const profile = this.opts.profiles?.[agentName] ?? {};
    let session: string | null = task.session_id;
    const recovery = a.recovery ?? undefined;
    const beat = () => this.kernel.emit("run.heartbeat", { run_id, task_id: task.id, ...(session ? { session_id: session } : {}) }, task.id);
    const base: Omit<RunRequest, "prompt"> = {
      // 一拿到会话编号就报一次，不等下一次心跳：轮次随后断掉时，恢复的那一轮才接得上原会话。
      onSession: (id) => { session = id; beat().catch(() => {}); },
      cwd: task.workdir ?? this.workRoot,                         // TODO P2：每任务一个 worktree
      model: profile.model, permission_mode: profile.permission_mode,
      timeout_ms: runLimitMinutes(task) * 60_000, label: run_id,   // 剩下的时长预算（P1-13）
      disallowed_tools: EXECUTION_DISALLOWED,                       // 对外动作由系统代为执行（P1-21）
    };
    const fresh = () => buildPrompt({ task, goal, rulings: [], previous: a.previous ?? undefined, feedback: a.feedback ?? undefined, recovery }); // TODO P2：按范围匹配定论

    // 心跳：定期报到，顺便看内核是否已取消本轮（人说“停”），是就结束进程组。
    const stop = new AbortController();
    const hb = setInterval(() => {
      beat()
        .then(() => this.kernel.runStatus(run_id))
        .then((s) => { if (s !== "running") stop.abort(); })
        .catch(() => {});
    }, this.opts.heartbeatMs ?? 30_000);

    let res: RunResult;
    try {
      if (task.session_id) {
        res = await adapter.run({ ...base, prompt: buildResumePrompt({ task, feedback: a.feedback ?? undefined, recovery }), session_id: task.session_id }, stop.signal);
        // 原会话接不上（已被清理或过期）：开新会话，带完整上下文包重来。
        if (!res.session_id && !res.last_message && !stop.signal.aborted) {
          this.log(`${run_id} 会话 ${task.session_id} 接不上，开新会话`);
          res = await adapter.run({ ...base, prompt: fresh(), label: `${run_id}-fresh` }, stop.signal);
        }
      } else {
        res = await adapter.run({ ...base, prompt: fresh() }, stop.signal);
      }
    } finally {
      clearInterval(hb);
    }

    if (res.rate_limit) await this.kernel.emit("quota.observed", { agent: agentName, ...res.rate_limit });
    // Agent 结束后先问内核这一轮还算不算数：接单程序被冻住或断网时，内核可能已经判它中断并重派了。
    if (!stop.signal.aborted && (await this.kernel.runStatus(run_id).catch(() => "running")) !== "running") stop.abort();
    if (stop.signal.aborted) { this.log(`${run_id} 已被内核取消（叫停或判为中断），不交回执`); return; }
    if (res.rate_limited) {
      const w = Object.values(res.rate_limit ?? {}).find((x) => x && x.status && x.status !== "allowed") ?? res.rate_limit?.five_hour;
      await this.kernel.emit("run.rate_limited", { run_id, task_id: task.id, resets_at: w?.resetsAt }, task.id);
      this.log(`${run_id} 限流，等额度重置`);
      return;
    }
    if (res.stopped) { await this.receipt(a, res, { outcome: "failed", summary: `单轮超时（本轮限时 ${Math.round(runLimitMinutes(task))} 分钟）` }); return; }

    let parsed = parseReceipt(res.last_message);
    if (!parsed.ok && res.session_id) {
      // 回执格式错了不重做业务，只在原会话里重写最后一条消息。
      this.log(`${run_id} 回执格式错误（${parsed.error}），请 Agent 重写`);
      const retry = await adapter.run({ ...base, prompt: `回执格式错误：${parsed.error}。只重写最后一条消息为合法的回执 JSON。`,
        session_id: res.session_id, tools: [], disallowed_tools: undefined, timeout_ms: 120_000, label: `${run_id}-rewrite` });
      parsed = parseReceipt(retry.last_message);
    }
    const receipt: Receipt = parsed.ok ? parsed.receipt
      : { outcome: "failed", summary: `回执无法解析：${parsed.error}${res.exit_code ? `；退出码 ${res.exit_code}，${res.stderr.trim().slice(-200)}` : ""}` };
    await this.receipt(a, res, receipt);
  }

  private async receipt(a: ClaimResult, res: RunResult | null, receipt: Receipt): Promise<void> {
    await this.kernel.emit("run.receipt", { task_id: a.task.id, run_id: a.run_id, session_id: res?.session_id ?? a.task.session_id ?? undefined,
      receipt: { ...receipt, usage: res?.usage } }, a.task.id);
    this.log(`${a.run_id} 交回执：${receipt.outcome} ${receipt.summary}`);
  }

  private log(line: string) { (this.opts.log ?? ((s: string) => console.log(`[worker] ${s}`)))(line); }
}
