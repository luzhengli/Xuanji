// 接单程序：领任务、起进程、心跳、停止、交回执。与内核同机，经本机接口连进来，自己保管凭据。
import { parseReceipt } from "../kernel/receipt.ts";
import { buildPrompt, buildResumePrompt } from "./context-pack.ts";
import type { AgentAdapter, RunRequest, RunResult } from "./adapters/types.ts";
import type { Goal, Receipt, Task } from "../kernel/types.ts";

export interface ClaimResult {
  task: Task;
  agent: string;
  purpose: string;
  run_id: string;              // 内核领活时签发
  feedback: string | null;     // 人的回答或退回意见，带进这一轮
  previous: Receipt | null;    // 上一轮回执，取它的交接说明
}

export interface KernelClient {
  claim(agent: string): Promise<ClaimResult | { task: null }>;
  emit(type: string, payload: Record<string, unknown>, about?: string): Promise<void>;
  goal(id: string): Promise<Goal>;
  runStatus(runId: string): Promise<string>;
}

export interface WorkerOptions {
  profiles?: Record<string, { model?: string | undefined; permission_mode?: string | undefined }>;
  heartbeatMs?: number;
  log?: (line: string) => void;
}

export class Worker {
  private readonly kernel: KernelClient;
  private readonly adapters: Record<string, AgentAdapter>;
  private readonly workRoot: string;
  private readonly opts: WorkerOptions;
  constructor(kernel: KernelClient, adapters: Record<string, AgentAdapter>, workRoot: string, opts: WorkerOptions = {}) {
    this.kernel = kernel; this.adapters = adapters; this.workRoot = workRoot; this.opts = opts;
  }

  // 一次领活。真正的循环由 main 用定时器驱动；每轮用完即退，不常驻 Agent 进程。
  async once(agentName: string): Promise<boolean> {
    const a = await this.kernel.claim(agentName);
    if (!a.task) return false;
    this.log(`${a.run_id} 领到 ${a.task.id}${a.task.session_id ? `（接上会话 ${a.task.session_id}）` : ""}`);
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

  private async execute(agentName: string, a: ClaimResult): Promise<void> {
    const { task, run_id } = a;
    const adapter = this.adapters[agentName];
    if (!adapter) throw new Error(`没有 ${agentName} 的适配器`);
    const goal = await this.kernel.goal(task.goal_id);
    const profile = this.opts.profiles?.[agentName] ?? {};
    const base: Omit<RunRequest, "prompt"> = {
      cwd: task.workdir ?? this.workRoot,                         // TODO P2：每任务一个 worktree
      model: profile.model, permission_mode: profile.permission_mode,
      timeout_ms: task.contract.budget.minutes * 60_000, label: run_id,
    };
    const fresh = () => buildPrompt({ task, goal, rulings: [], previous: a.previous ?? undefined, feedback: a.feedback ?? undefined }); // TODO P2：按范围匹配定论

    // 心跳：定期报到，顺便看内核是否已取消本轮（人说“停”），是就结束进程组。
    const stop = new AbortController();
    const hb = setInterval(() => {
      this.kernel.emit("run.heartbeat", { run_id, task_id: task.id }, task.id)
        .then(() => this.kernel.runStatus(run_id))
        .then((s) => { if (s !== "running") stop.abort(); })
        .catch(() => {});
    }, this.opts.heartbeatMs ?? 30_000);

    let res: RunResult;
    try {
      if (task.session_id) {
        res = await adapter.run({ ...base, prompt: buildResumePrompt({ task, feedback: a.feedback ?? undefined }), session_id: task.session_id }, stop.signal);
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
    if (stop.signal.aborted) { this.log(`${run_id} 已被叫停，不交回执`); return; }
    if (res.rate_limited) {
      const w = Object.values(res.rate_limit ?? {}).find((x) => x && x.status && x.status !== "allowed") ?? res.rate_limit?.five_hour;
      await this.kernel.emit("run.rate_limited", { run_id, task_id: task.id, resets_at: w?.resetsAt }, task.id);
      this.log(`${run_id} 限流，等额度重置`);
      return;
    }
    if (res.stopped) { await this.receipt(a, res, { outcome: "failed", summary: `单轮超时（${task.contract.budget.minutes} 分钟）` }); return; }

    let parsed = parseReceipt(res.last_message);
    if (!parsed.ok && res.session_id) {
      // 回执格式错了不重做业务，只在原会话里重写最后一条消息。
      this.log(`${run_id} 回执格式错误（${parsed.error}），请 Agent 重写`);
      const retry = await adapter.run({ ...base, prompt: `回执格式错误：${parsed.error}。只重写最后一条消息为合法的回执 JSON。`,
        session_id: res.session_id, tools: [], timeout_ms: 120_000, label: `${run_id}-rewrite` });
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
