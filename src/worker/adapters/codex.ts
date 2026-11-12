// Codex 无界面模式（P2-04）。实测（2026-11-12，codex-cli 0.167.0，见 BACKLOG S4）：
//   codex exec --json -o <文件> [-m 模型] [-s 沙箱] -C <目录> -- <提示词>
//   codex exec resume <会话编号> --json -o <文件> -- <提示词>     （resume 不认 -C 和 -s：进程 cwd 设成工作目录，沙箱用 -c sandbox_mode）
// 事件流里 thread.started.thread_id 是会话编号，turn.completed.usage 是 token 用量；-o 写出最后一条消息，即回执。
// 周用量不在事件流里，在会话文件 ~/.codex/sessions/<年>/<月>/<日>/rollout-*-<会话编号>.jsonl 的 token_count.rate_limits 里。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, RunRequest, RunResult, RateLimitWindow } from "./types.ts";

export interface CodexOptions {
  bin?: string;
  recordDir?: string | undefined;    // 设了就把每轮原始的 JSONL 存下来，作测试用的录制输出
  pidDir?: string | undefined;       // 同 Claude Code：接单程序重启时据此清理孤儿进程
  sessionsDir?: string | undefined;  // 会话文件目录，默认 ~/.codex/sessions
}

// 系统起的 Codex 和人的个人配置隔开（同 Claude Code 的 ISOLATION_ARGS，2026-11-12 人定）：
// - 不加载 ~/.codex/config.toml（人的模型、通知、MCP、审批设置），登录照常用 CODEX_HOME 里的订阅。
// - 无界面没人点同意：审批一律 never，越权的命令直接被沙箱拦下。
// - 不联网查资料（验证者“不联网”）。工作区可写沙箱默认也不给网络，所以 git push 本来就推不出去。
// - 关掉不该在无人值守时用的功能：操控桌面和浏览器（人规定桌面操作另有负责人）、插件和应用、记忆、子 Agent、hooks。
//   名字写错 Codex 会直接报错退出（实测 Unknown feature flag），升级改名时会马上暴露，不会悄悄失效。
export const CODEX_DISABLED_FEATURES = ["computer_use", "browser_use", "browser_use_external", "in_app_browser", "apps", "plugins", "memories", "multi_agent", "hooks"];
export const CODEX_ISOLATION_ARGS = ["--ignore-user-config", "--skip-git-repo-check",
  "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "-c", "notify=[]",
  ...CODEX_DISABLED_FEATURES.flatMap((f) => ["--disable", f])];

export type CodexSandbox = "read-only" | "workspace-write";

// 沙箱：显式给的为准；不给工具（判断点，tools = []）只读；其余工作区可写。
export function sandboxOf(req: RunRequest): CodexSandbox {
  return req.sandbox ?? (req.tools && req.tools.length === 0 ? "read-only" : "workspace-write");
}

export function buildCodexArgs(req: RunRequest, outFile: string): string[] {
  const sandbox = sandboxOf(req);
  const common = ["--json", "-o", outFile, ...CODEX_ISOLATION_ARGS];
  if (req.model) common.push("-m", req.model);
  if (req.effort) common.push("-c", `model_reasoning_effort="${req.effort.replace(/[^A-Za-z0-9_-]/g, "")}"`);
  // 提示词前加 --：和 Claude Code 一样，防止以 - 开头的提示词被当成参数。
  return req.session_id
    ? ["exec", "resume", ...common, "-c", `sandbox_mode="${sandbox}"`, req.session_id, "--", req.prompt]
    : ["exec", ...common, "-s", sandbox, "-C", req.cwd, "--", req.prompt];
}

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";
  private readonly bin: string;
  private readonly recordDir: string | undefined;
  private readonly pidDir: string | undefined;
  private readonly sessionsDir: string;
  constructor(opts: CodexOptions = {}) {
    this.bin = opts.bin ?? "codex"; this.recordDir = opts.recordDir; this.pidDir = opts.pidDir;
    this.sessionsDir = opts.sessionsDir ?? join(homedir(), ".codex", "sessions");
  }

  run(req: RunRequest, signal?: AbortSignal): Promise<RunResult> {
    const dir = mkdtempSync(join(tmpdir(), "xj-codex-"));
    const outFile = join(dir, "last-message.md");
    const args = buildCodexArgs(req, outFile);
    return new Promise((resolve, reject) => {
      // stdin 关掉，否则 Codex 会等输入（实测）。自成进程组，停止时连同它起的命令一起结束。
      const child = spawn(this.bin, args, { cwd: req.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: process.env });
      let out = "", err = "", stopped = false, session: string | null = null;
      const pidFile = this.pidDir && child.pid ? join(this.pidDir, `${req.label ?? child.pid}.pid`) : null;
      if (pidFile) { mkdirSync(this.pidDir!, { recursive: true }); writeFileSync(pidFile, String(child.pid)); }
      const kill = () => { stopped = true; try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); } };
      const timer = setTimeout(kill, req.timeout_ms);
      signal?.addEventListener("abort", kill, { once: true });
      child.stdout.on("data", (c) => {
        out += c;
        if (!session) { session = threadOf(out); if (session) req.onSession?.(session); }
      });
      child.stderr.on("data", (c) => (err += c));
      child.on("error", (e) => { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", kill);
        if (pidFile) try { unlinkSync(pidFile); } catch { /* 已被清理 */ }
        if (this.recordDir) {
          mkdirSync(this.recordDir, { recursive: true });
          writeFileSync(join(this.recordDir, `${req.label ?? Date.now()}.codex.jsonl`), out);
        }
        let lastFile = "";
        try { lastFile = readFileSync(outFile, "utf8"); } catch { /* 没写出来：用事件流里最后一条 agent_message */ }
        rmSync(dir, { recursive: true, force: true });
        const parsed = parseCodexStream(out);
        const sid = parsed.session_id;
        const rl = sid ? readRateLimits(this.sessionsDir, sid) : null;
        const last_message = lastFile.trim() || parsed.last_message;
        // 触顶标记只在这一轮没交出东西时才算限流：做完了才触顶的，这一轮照常算数，下一轮再说。
        resolve({ ...parsed, last_message, exit_code: code ?? -1, stderr: err, stopped,
          rate_limit: rl?.rate_limit, rate_limited: parsed.rate_limited || (!!rl?.reached && !last_message) });
      });
    });
  }
}

function threadOf(out: string): string | null {
  const m = /"type":"thread\.started","thread_id":"([^"]+)"/.exec(out);
  return m ? m[1]! : null;
}

// 从 codex exec --json 的事件流里取回执所需的字段。独立成函数以便用录制件做测试。
// 人的 config.toml 里有过时设置时，每轮会多出 error 项（实测），不是失败，忽略。
export function parseCodexStream(jsonl: string): Omit<RunResult, "exit_code" | "stderr"> {
  let last_message = "", session_id: string | null = null, usage: Record<string, unknown> = {}, rate_limited = false;
  let commands = 0, failure = "";
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line); } catch { continue; }
    const item = ev.item as { type?: string; text?: string; message?: string } | undefined;
    if (ev.type === "thread.started" && !session_id) session_id = (ev.thread_id as string) ?? null;
    else if (ev.type === "item.completed" && item?.type === "agent_message" && item.text) last_message = item.text;
    else if (ev.type === "item.completed" && item?.type === "command_execution") commands++;
    else if (ev.type === "turn.completed") usage = { usage: ev.usage };
    else if (ev.type === "turn.failed" || ev.type === "error") {
      failure = String((ev.error as { message?: string } | undefined)?.message ?? ev.message ?? "");
      if (/rate.?limit|usage limit|quota/i.test(failure)) rate_limited = true;
    }
  }
  if (commands) usage = { ...usage, commands };
  if (failure) usage = { ...usage, failure: failure.slice(0, 300) };
  return { last_message, session_id, usage, rate_limited };
}

// 会话文件：~/.codex/sessions/<年>/<月>/<日>/rollout-<时间>-<会话编号>.jsonl。按日期目录从新往旧找，只看最近几天。
export function findSessionFile(sessionsDir: string, threadId: string): string | null {
  const suffix = `-${threadId}.jsonl`;
  const sorted = (p: string) => { try { return readdirSync(p).sort().reverse(); } catch { return []; } };
  let days = 0;
  for (const y of sorted(sessionsDir)) for (const m of sorted(join(sessionsDir, y))) for (const d of sorted(join(sessionsDir, y, m))) {
    const dir = join(sessionsDir, y, m, d);
    const hit = sorted(dir).find((f) => f.endsWith(suffix));
    if (hit) return join(dir, hit);
    if (++days >= 7) return null;
  }
  return null;
}

// 会话文件最后一条带 rate_limits 的 token_count，换成和 Claude Code 一样的读数（utilization 0~1、resetsAt Unix 秒）。
// window_minutes 10080 是一周，300 是五小时。rate_limit_reached_type 非空表示已经触顶。读数是“已用”。
export function parseRateLimits(jsonl: string): { rate_limit: NonNullable<RunResult["rate_limit"]>; reached: boolean } | null {
  let last: Record<string, unknown> | null = null;
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) continue;
    try {
      const ev = JSON.parse(line) as { payload?: { type?: string; rate_limits?: Record<string, unknown> } };
      if (ev.payload?.type === "token_count" && ev.payload.rate_limits) last = ev.payload.rate_limits;
    } catch { /* 写到一半的行 */ }
  }
  if (!last) return null;
  const reached = last.rate_limit_reached_type != null;
  const rate_limit: NonNullable<RunResult["rate_limit"]> = {};
  for (const key of ["primary", "secondary"]) {
    const w = last[key] as { used_percent?: number; window_minutes?: number; resets_at?: number } | null | undefined;
    if (!w || typeof w.used_percent !== "number") continue;
    const win: RateLimitWindow = { utilization: w.used_percent / 100, resetsAt: w.resets_at ?? 0, status: reached ? "rejected" : "allowed" };
    if (w.window_minutes === 10080) rate_limit.seven_day = win;
    else if (w.window_minutes === 300) rate_limit.five_hour = win;
  }
  return { rate_limit, reached };
}

function readRateLimits(sessionsDir: string, threadId: string) {
  const f = existsSync(sessionsDir) ? findSessionFile(sessionsDir, threadId) : null;
  if (!f) return null;
  try { return parseRateLimits(readFileSync(f, "utf8")); } catch { return null; }
}
