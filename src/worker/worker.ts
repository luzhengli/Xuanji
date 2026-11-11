// 接单程序：领任务、起进程、心跳、停止、交回执。与内核同机，经本机接口连进来，自己保管凭据。
import { parseReceipt } from "../kernel/receipt.ts";
import { buildPrompt } from "./context-pack.ts";
import type { AgentAdapter } from "./adapters/types.ts";
import type { Goal, Task } from "../kernel/types.ts";

export interface KernelClient {
  claim(agent: string): Promise<{ task: Task; agent: string; purpose: string } | { task: null }>;
  emit(type: string, payload: Record<string, unknown>, about?: string): Promise<void>;
  goal(id: string): Promise<Goal>;
}

export class Worker {
  private readonly kernel: KernelClient;
  private readonly adapters: Record<string, AgentAdapter>;
  private readonly workRoot: string;
  constructor(kernel: KernelClient, adapters: Record<string, AgentAdapter>, workRoot: string) {
    this.kernel = kernel; this.adapters = adapters; this.workRoot = workRoot;
  }

  // 一次领活。真正的循环由 main 用定时器驱动；每轮用完即退，不常驻 Agent 进程。
  async once(agentName: string): Promise<boolean> {
    const a = await this.kernel.claim(agentName);
    if (!a.task) return false;
    const task = a.task;
    const goal = await this.kernel.goal(task.goal_id);
    await this.kernel.emit("run.claimed", { task_id: task.id, agent: agentName, purpose: a.purpose }, task.id);
    // TODO P1-05：run_id 应由内核在领活时返回；现在由回执事件的 about 关联。
    const adapter = this.adapters[agentName]!;
    const prompt = buildPrompt({ task, goal, rulings: [] });   // TODO P2：按范围匹配定论
    const cwd = task.workdir ?? this.workRoot;                   // TODO P2：每任务一个 worktree
    const res = await adapter.run({ prompt, cwd, session_id: task.session_id ?? undefined, timeout_ms: task.contract.budget.minutes * 60_000 });

    if (res.rate_limit) await this.kernel.emit("quota.observed", { agent: agentName, ...res.rate_limit });
    if (res.rate_limited) { await this.kernel.emit("run.rate_limited", { task_id: task.id, resets_at: res.rate_limit?.five_hour?.resetsAt }, task.id); return true; }

    let parsed = parseReceipt(res.last_message);
    if (!parsed.ok && res.session_id) {
      // 回执格式错了不重做业务，只在原会话里重写最后一条消息。
      const retry = await adapter.run({ prompt: `回执格式错误：${parsed.error}。只重写最后一条消息为合法的回执 JSON。`, cwd, session_id: res.session_id, tools: [], timeout_ms: 120_000 });
      parsed = parseReceipt(retry.last_message);
    }
    const receipt = parsed.ok ? parsed.receipt : { outcome: "failed" as const, summary: `回执无法解析：${parsed.ok ? "" : parsed.error}` };
    await this.kernel.emit("run.receipt", { task_id: task.id, run_id: "TODO", session_id: res.session_id, receipt: { ...receipt, usage: res.usage } }, task.id);
    return true;
  }
}
