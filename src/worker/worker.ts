// 接单程序：领任务、起进程、心跳、停止、交回执。与内核同机，经本机接口连进来，自己保管凭据。
import { parseReceipt } from "../kernel/receipt.ts";
import { parseVerdict, checksVerdict } from "../kernel/verdict.ts";
import { parseDraft, type DraftResult } from "../kernel/intake.ts";
import { runLimitMinutes } from "../kernel/budget.ts";
import { buildPrompt, buildResumePrompt, buildIntakePrompt, buildVerifyPrompt } from "./context-pack.ts";
import type { AgentAdapter, RunRequest, RunResult } from "./adapters/types.ts";
import type { CheckResult, Effect, Goal, Judgment, Receipt, Task, Verdict, Worktree } from "../kernel/types.ts";
import { runEffect, execReal, taskWorktrees, type Exec } from "./effects.ts";
import { prepareWorkspace, staleProcesses, type Workspace } from "./workspace.ts";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { VERIFY_RUN_MINUTES } from "../kernel/reducer.ts";

// 判断点一轮最多跑多久。内核那边 5 分钟没结果判失败（JUDGMENT_TIMEOUT_MS），这里先结束进程。
export const JUDGMENT_RUN_MS = 180_000;

// 执行轮按角色给最小权限（2026-11-12 人定）。用允许清单而不是禁用清单：Claude Code 升级会悄悄加新工具
// （实测已有 Cron、ScheduleWakeup、RemoteTrigger、Monitor、SendMessage、EnterWorktree），允许清单下新工具默认拿不到。
// 子 Agent（Task）允许，不拆的大任务靠它；联网查资料允许，外部文字当资料。
export const EXECUTION_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "Task", "WebFetch", "WebSearch", "TodoWrite"];

// 不加载人的个人设置后，权限放行规则也没了；无界面下没人点“允许”，所以执行轮显式用 auto（人的个人设置原本就是 auto）。
export const EXECUTION_PERMISSION_MODE = "auto";

// Bash 里能绕开内核的命令禁掉。这是尽力而为的拦截（按前缀匹配，换个写法拦不住），真正的边界仍是沙箱。
// - 推送、改 PR：写进回执的 effects，由接单程序代为执行（P1-21）。查看类命令（gh pr view/list）不拦。
// - lark-cli：接单程序的环境里它已以机器人身份登录，能直接给人发飞书消息，是绕过内核的对外通道。
// - claude、codex：再起一个 Agent 会绕开并发名额和全部权限限制。
// - crontab、launchctl、at：在系统层排定时任务，等于在账本之外安排以后的工作。
// - osascript：操控桌面；人规定桌面操作只经 Codex 指定模型。
// 周用量过降档线时（P2-01）不起子 Agent：从允许清单拿掉，再显式禁用（工具现在叫 Agent，旧名 Task，两个都禁）。
export const SUBAGENT_TOOLS = ["Task", "Agent"];

export const EXECUTION_DISALLOWED = ["Bash(git push:*)", "Bash(gh pr create:*)", "Bash(gh pr merge:*)", "Bash(gh pr close:*)",
  "Bash(gh pr edit:*)", "Bash(gh pr comment:*)", "Bash(gh pr review:*)", "Bash(gh repo create:*)", "Bash(gh release:*)",
  "Bash(lark-cli:*)", "Bash(claude:*)", "Bash(codex:*)", "Bash(crontab:*)", "Bash(launchctl:*)", "Bash(at:*)", "Bash(osascript:*)"];

// 检查命令（P2-05）：一条最多跑 10 分钟，输出只留末尾。
export const CHECK_TIMEOUT_MS = 600_000;
const CHECK_OUTPUT_MAX = 2_000;

// 检查命令照用 Bash 禁用规则（2026-11-12 人定）：命令里任何一段（&&、||、;、|、$( ) 隔开的）以禁用的命令开头，就不跑。
// 和 Agent 那边一样是尽力而为的拦截；真正的边界是命令只在任务的 worktree 里跑、而且是人确认过的。
export const BLOCKED_COMMANDS = EXECUTION_DISALLOWED.map((r) => /^Bash\((.+):\*\)$/.exec(r)?.[1]).filter((x): x is string => !!x);
export function blockedBy(command: string): string | null {
  for (const seg of command.split(/&&|\|\||;|\||\$\(|`|\n/)) {
    const words = seg.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));   // 去掉开头的 FOO=1
    const head = words.join(" ");
    const hit = BLOCKED_COMMANDS.find((b) => head === b || head.startsWith(`${b} `));
    if (hit) return hit;
  }
  return null;
}

// 跑一条检查命令。用登录 shell，和人在终端里跑的环境一致（launchd 下 PATH 很短）。自成进程组，超时连子进程一起结束。
export type CheckRunner = (command: string, cwd: string, timeoutMs: number) => Promise<{ code: number | null; output: string }>;
export const runCheckReal: CheckRunner = (command, cwd, timeoutMs) => new Promise((resolve) => {
  const child = spawn("/bin/zsh", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = "", timedOut = false;
  const keep = (c: Buffer) => { out = (out + c).slice(-CHECK_OUTPUT_MAX * 2); };
  child.stdout.on("data", keep); child.stderr.on("data", keep);
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); } }, timeoutMs);
  child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, output: e.message }); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ code: timedOut ? null : code, output: `${out.slice(-CHECK_OUTPUT_MAX)}${timedOut ? `\n（超过 ${timeoutMs / 60_000} 分钟，结束了）` : ""}` }); });
});

export interface ClaimResult {
  task: Task;
  agent: string;
  purpose: string;
  subagents?: boolean;         // false：这一轮不准起子 Agent（P2-01 降档）
  run_id: string;              // 内核领活时签发
  feedback: string | null;     // 人的回答或退回意见，带进这一轮
  recovery?: string | null;    // 上一轮中断后的恢复说明（P1-14）
  previous: Receipt | null;    // 上一轮回执，取它的交接说明；验证轮里是要验证的那一轮的回执
  verify?: { round: number; subject: string | null; prior: { run_id: string; verdict: Verdict } | null } | undefined;   // 验证轮（P2-05）
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
  profiles?: Record<string, { model?: string | undefined; permission_mode?: string | undefined; effort?: string | undefined }>;
  heartbeatMs?: number;
  log?: (line: string) => void;
  identity?: { worker: string; instance: string } | undefined;   // 启动报到用，须与客户端领活时带的一致
  reap?: (() => string[]) | undefined;                            // 启动时清理上个实例留下的 Agent 进程
  exec?: Exec | undefined;                                        // 对外动作、建 worktree 用的命令执行器（测试时换成假的）
  worktreeRoot?: string | undefined;                              // 设了就每任务一个 worktree（P2-02）
  checkRunner?: CheckRunner | undefined;                          // 跑检查命令（P2-05，测试时换成假的）
}

export class Worker {
  private readonly kernel: KernelClient;
  private readonly adapters: Record<string, AgentAdapter>;
  private readonly workRoot: string;
  private readonly opts: WorkerOptions;
  private prepLock: Promise<unknown> = Promise.resolve();   // 建 worktree 一个一个来：同一仓库上并发 fetch、worktree add 会抢锁
  constructor(kernel: KernelClient, adapters: Record<string, AgentAdapter>, workRoot: string, opts: WorkerOptions = {}) {
    this.kernel = kernel; this.adapters = adapters; this.workRoot = workRoot; this.opts = opts;
  }

  // 启动：先清理上个实例留下的 Agent 进程，再向内核报到；内核据此把旧实例领的轮次判为中断，带恢复说明重派。
  async start(): Promise<void> {
    const reaped = this.opts.reap?.() ?? [];
    if (reaped.length) this.log(`结束上个实例留下的 Agent 进程：${reaped.join(", ")}`);
    if (this.opts.identity) await this.kernel.emit("worker.started", { ...this.opts.identity, reaped });
  }

  // 一次领活并跑完这一轮。真正的循环由 main 驱动；每轮用完即退，不常驻 Agent 进程。
  async once(agentName: string): Promise<boolean> {
    const run = await this.begin(agentName);
    if (!run) return false;
    await run.done;
    return true;
  }

  // 领一件活就开始跑，不等它跑完：返回这一轮的 Promise（包一层，async 函数会把返回的 Promise 摊平），没活可领返回 null。
  // 并行（二期）靠这个：接单程序接着领，领不到为止；同时跑几个由内核按名额决定（P2-01），接单程序不另设上限。
  async begin(agentName: string): Promise<{ done: Promise<void> } | null> {
    const a = await this.kernel.claim(agentName);
    if (!a.task) return null;
    this.log(`${a.run_id} 领到 ${a.task.id}${a.purpose === "verify" ? `的验证（第 ${a.verify?.round ?? 1} 轮）` : ""}${a.task.session_id && a.purpose !== "verify" ? `（接上会话 ${a.task.session_id}）` : ""}${a.recovery ? "，带恢复说明" : ""}${a.subagents === false && a.purpose !== "verify" ? "，不起子 Agent" : ""}`);
    if (a.purpose === "verify") {
      return { done: this.verify(agentName, a).catch(async (err) => {
        // 验证没跑成：交一个带错误的结论，内核让任务留在“验证中”重新派，连续 3 次问人。
        const msg = (err as Error).message;
        this.log(`${a.run_id} 验证出错：${msg}`);
        await this.kernel.emit("run.verdict", { run_id: a.run_id, task_id: a.task.id, error: `接单程序出错：${msg}`.slice(0, 300), reviewer: agentName }, a.task.id)
          .catch((e) => this.log(`${a.run_id} 交结论失败：${(e as Error).message}`));
      }) };
    }
    return { done: this.execute(agentName, a).catch(async (err) => {
      // 起不了进程、建不了 worktree 之类的故障：交一张 failed 回执，由内核退避重试，任务不会卡在“执行中”。
      const msg = (err as Error).message;
      this.log(`${a.run_id} 出错：${msg}`);
      await this.receipt(a, null, { outcome: "failed", summary: `接单程序出错：${msg}`.slice(0, 300) }).catch((e) => this.log(`${a.run_id} 交回执失败：${(e as Error).message}`));
    }) };
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
    this.log(`${x.id} 执行 ${x.kind} ${x.params.path ?? x.params.branch}（${x.task_id}，第 ${x.attempts} 次）`);
    let out;
    try { out = await runEffect(x, c.workdir ?? this.workRoot, c.goal_id ?? "", this.opts.exec ?? execReal); }
    catch (err) { out = { ok: false, detail: `接单程序出错：${(err as Error).message}`.slice(0, 300), retryable: true }; }
    await this.kernel.emit("effect.result", { effect_id: x.id, ...out }, x.task_id);
    this.log(`${x.id} ${out.ok ? `完成 ${out.ref ?? ""}` : `失败 ${out.detail}`}`);
    return true;
  }

  // 这一轮在哪个目录里做（P2-02）。第一轮之前建 worktree 并落账；以后每轮用账本里记的那个，被删了就在原分支上重建。
  // 二期之前就开始了的任务（已经有会话、没有 worktree）照旧在 workRoot 里做：换目录会接不上原会话。
  private async workspaceFor(a: ClaimResult): Promise<{ cwd: string; ws: Workspace | null }> {
    const { task } = a;
    const root = this.opts.worktreeRoot;
    const fresh = !task.workdir && !task.session_id && !a.previous;
    if (!root || !(fresh || (task.workdir && !existsSync(task.workdir)))) return { cwd: task.workdir ?? this.workRoot, ws: null };
    const prep = this.prepLock.then(() => prepareWorkspace(task, this.workRoot, root, this.opts.exec ?? execReal, (s) => this.log(`${a.run_id} ${s}`)));
    this.prepLock = prep.catch(() => {});
    const ws = await prep;
    if (!ws) return { cwd: task.workdir ?? this.workRoot, ws: null };   // workRoot 不是 git 仓库
    await this.kernel.emit("workspace.prepared", { task_id: task.id, run_id: a.run_id, ...ws }, task.id);
    this.log(`${a.run_id} 工作区 ${ws.path}（${ws.branch}，基底 ${ws.base}@${ws.base_commit.slice(0, 7)}）`);
    return { cwd: ws.path, ws };
  }

  private async execute(agentName: string, a: ClaimResult): Promise<void> {
    const { run_id } = a;
    const adapter = this.adapters[agentName];
    if (!adapter) throw new Error(`没有 ${agentName} 的适配器`);
    const { cwd, ws } = await this.workspaceFor(a);
    const task: Task = { ...a.task, workdir: cwd === this.workRoot && !a.task.workdir ? null : cwd };
    // 同一个工作区里还有别的进程（被判中断的上一轮的 Agent 还没停）：不起这一轮，免得两个 Agent 同时改一个目录（P2-03）。
    if (task.workdir && this.opts.worktreeRoot) {
      const stale = await staleProcesses(task.workdir, this.opts.exec ?? execReal).catch(() => []);
      if (stale.length) throw new Error(`工作区 ${task.workdir} 里还有进程在跑（pid ${stale.join(", ")}），可能是上一轮被判中断后没停下的 Agent；等它结束或手动结束后再派`);
    }
    const goal = await this.kernel.goal(task.goal_id);
    const profile = this.opts.profiles?.[agentName] ?? {};
    const subagents = a.subagents !== false;
    let session: string | null = task.session_id;
    const recovery = a.recovery ?? undefined;
    const beat = () => this.kernel.emit("run.heartbeat", { run_id, task_id: task.id, ...(session ? { session_id: session } : {}) }, task.id);
    const base: Omit<RunRequest, "prompt"> = {
      // 一拿到会话编号就报一次，不等下一次心跳：轮次随后断掉时，恢复的那一轮才接得上原会话。
      onSession: (id) => { session = id; beat().catch(() => {}); },
      cwd,
      model: profile.model, permission_mode: profile.permission_mode ?? EXECUTION_PERMISSION_MODE,
      timeout_ms: runLimitMinutes(task) * 60_000, label: run_id,   // 剩下的时长预算（P1-13）
      tools: subagents ? EXECUTION_TOOLS : EXECUTION_TOOLS.filter((t) => !SUBAGENT_TOOLS.includes(t)),
      disallowed_tools: subagents ? EXECUTION_DISALLOWED : [...EXECUTION_DISALLOWED, ...SUBAGENT_TOOLS],
    };
    const workspace = ws ?? (task.workdir ? { path: task.workdir } : undefined);
    const fresh = () => buildPrompt({ task, goal, rulings: [], previous: a.previous ?? undefined, feedback: a.feedback ?? undefined, recovery,
      workspace, subagents }); // TODO P2-07：按范围匹配定论

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
        res = await adapter.run({ ...base, prompt: buildResumePrompt({ task, feedback: a.feedback ?? undefined, recovery, subagents }), session_id: task.session_id }, stop.signal);
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

  // 验证一轮（P2-05）：先在任务的 worktree 里跑检查命令（便宜的先跑），没过就不请验证者；过了再起只读的验证者。
  // 内核只记结果。验证者每次开新会话，看不到执行者的会话；格式错了在它自己的会话里请它重写一次。
  private async verify(agentName: string, a: ClaimResult): Promise<void> {
    const { run_id, task } = a;
    const adapter = this.adapters[agentName];
    if (!adapter) throw new Error(`没有 ${agentName} 的适配器`);
    // 工作区被删了就不验证：退回人的工作目录去看，看到的是别的分支，结论不可信。交错误，连续 3 次问人。
    if (task.workdir && !existsSync(task.workdir)) throw new Error(`工作区 ${task.workdir} 不在了，没法验证`);
    const cwd = task.workdir ?? this.workRoot;
    const goal = await this.kernel.goal(task.goal_id);
    const profile = this.opts.profiles?.[agentName] ?? {};
    let session: string | null = null;
    const { stop, clear, beat } = this.heartbeat(run_id, task.id, () => session);
    const deadline = Date.now() + VERIFY_RUN_MINUTES * 60_000;
    let checks: CheckResult[] = [], verdict: Verdict | null = null, error = "", res: RunResult | null = null;
    try {
      checks = await this.runChecks(task.contract.acceptance.checks, cwd, deadline, stop.signal);
      verdict = checksVerdict(checks);
      if (verdict) this.log(`${run_id} 检查命令没过，不请验证者`);
      else if (!stop.signal.aborted) {
        const branch = (task.worktrees ? JSON.parse(task.worktrees) as Worktree[] : []).find((w) => w.path === cwd)?.branch;
        const base = { cwd, model: profile.model, effort: profile.effort, sandbox: "read-only" as const, tools: [] as string[],
          onSession: (id: string) => { session = id; beat().catch(() => {}); } };
        res = await adapter.run({ ...base, label: run_id, timeout_ms: Math.max(60_000, deadline - Date.now()),
          prompt: buildVerifyPrompt({ task, goal, receipt: a.previous, checks, round: a.verify?.round ?? 1, prior: a.verify?.prior,
            workspace: { path: cwd, branch, base_commit: task.base_commit } }) }, stop.signal);
        if (res.rate_limit) await this.kernel.emit("quota.observed", { agent: agentName, ...res.rate_limit });
        if (!res.rate_limited && !res.stopped) {
          let parsed = parseVerdict(res.last_message);
          if (!parsed.ok && res.session_id && !stop.signal.aborted) {
            this.log(`${run_id} 验证结论格式错误（${parsed.error}），请它重写`);
            const retry = await adapter.run({ ...base, prompt: `输出格式错误：${parsed.error}。只重写最后一条消息为合法的 JSON 对象。`,
              session_id: res.session_id, timeout_ms: 300_000, label: `${run_id}-rewrite` }, stop.signal);
            parsed = parseVerdict(retry.last_message);
          }
          if (parsed.ok) verdict = parsed.verdict;
          else error = `验证结论无法解析：${parsed.error}${res.exit_code ? `；退出码 ${res.exit_code}，${res.stderr.trim().slice(-200)}` : ""}`;
        }
      }
    } finally {
      clear();
    }
    if (!stop.signal.aborted && (await this.kernel.runStatus(run_id).catch(() => "running")) !== "running") stop.abort();
    if (stop.signal.aborted) { this.log(`${run_id} 已被内核取消（叫停或判为中断），不交结论`); return; }
    if (res?.rate_limited) {
      const w = Object.values(res.rate_limit ?? {}).find((x) => x && x.status && x.status !== "allowed") ?? res.rate_limit?.seven_day;
      await this.kernel.emit("run.rate_limited", { run_id, task_id: task.id, resets_at: w?.resetsAt }, task.id);
      this.log(`${run_id} 验证者限流，等额度重置`);
      return;
    }
    if (res?.stopped) error = `验证超时（限时 ${VERIFY_RUN_MINUTES} 分钟）`;
    await this.kernel.emit("run.verdict", { run_id, task_id: task.id, session_id: session ?? res?.session_id ?? undefined, checks, reviewer: agentName,
      ...(verdict && !error ? { verdict: { verdict: verdict.pass ? "pass" : "fail", summary: verdict.summary, issues: verdict.issues, risks: verdict.risks } } : { error: error || "没有结论" }),
      usage: res?.usage }, task.id);
    this.log(`${run_id} 交结论：${error ? `没跑成 ${error}` : `${verdict!.pass ? "通过" : "没通过"} ${verdict!.summary}`}`);
  }

  // 检查命令一条一条在工作区里跑。被禁用规则拦下的不跑，记为没跑；时间不够了后面的也不跑。
  private async runChecks(commands: string[], cwd: string, deadline: number, signal: AbortSignal): Promise<CheckResult[]> {
    const out: CheckResult[] = [];
    for (const command of commands) {
      if (signal.aborted) break;
      const blocked = blockedBy(command);
      if (blocked) { out.push({ command, ok: false, exit_code: null, output: "", skipped: `命中禁用规则 ${blocked}` }); continue; }
      const left = Math.min(CHECK_TIMEOUT_MS, deadline - Date.now() - 60_000);
      if (left <= 0) { out.push({ command, ok: false, exit_code: null, output: "", skipped: "验证限时用完了" }); continue; }
      const r = await (this.opts.checkRunner ?? runCheckReal)(command, cwd, left);
      out.push({ command, ok: r.code === 0, exit_code: r.code, output: r.output.slice(-CHECK_OUTPUT_MAX) });
      this.log(`检查 \`${command}\` → ${r.code === 0 ? "通过" : `退出码 ${r.code ?? "无（超时或没起来）"}`}`);
    }
    return out;
  }

  // 心跳：定期报到，顺便看内核是否已取消本轮（人说“停”、判了中断），是就 abort。
  private heartbeat(runId: string, taskId: string, session: () => string | null) {
    const stop = new AbortController();
    const beat = () => { const s = session(); return this.kernel.emit("run.heartbeat", { run_id: runId, task_id: taskId, ...(s ? { session_id: s } : {}) }, taskId); };
    const hb = setInterval(() => {
      beat().then(() => this.kernel.runStatus(runId)).then((st) => { if (st !== "running") stop.abort(); }).catch(() => {});
    }, this.opts.heartbeatMs ?? 30_000);
    return { stop, beat, clear: () => clearInterval(hb) };
  }

  private async receipt(a: ClaimResult, res: RunResult | null, receipt: Receipt): Promise<void> {
    // Agent 自己建的 worktree 随回执报上去（P1-28），内核在审核卡上列出、任务结束后排清理。查不到就算了，不挡回执。
    const worktrees = await taskWorktrees(a.task.id, a.task.workdir && existsSync(a.task.workdir) ? a.task.workdir : this.workRoot, this.opts.exec ?? execReal).catch(() => []);
    await this.kernel.emit("run.receipt", { task_id: a.task.id, run_id: a.run_id, session_id: res?.session_id ?? a.task.session_id ?? undefined,
      receipt: { ...receipt, usage: res?.usage }, ...(worktrees.length ? { worktrees } : {}) }, a.task.id);
    this.log(`${a.run_id} 交回执：${receipt.outcome} ${receipt.summary}`);
  }

  private log(line: string) { (this.opts.log ?? ((s: string) => console.log(`[worker] ${s}`)))(line); }
}
