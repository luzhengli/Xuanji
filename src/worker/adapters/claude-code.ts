// Claude Code 无界面模式。实测（2026-11-11，Claude Code 2.1.322）：
//   claude -p --output-format stream-json --verbose [--resume <id>] [--model m] [--tools ""]
// 事件流里有 system/init、assistant、rate_limit_event、result。result.result 是最后一条消息，
// result.session_id 可用于 --resume；rate_limit_event.rate_limit_info.unifiedWindows 给周用量和重置时间。
// 状态栏脚本在无界面模式下不会被调用，所以用量读数来自这里，不来自状态栏文件。
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, RunRequest, RunResult, RateLimitWindow } from "./types.ts";

export interface ClaudeCodeOptions {
  bin?: string;
  recordDir?: string | undefined;   // 设了就把每轮原始的 stream-json 存下来，作测试用的录制输出
  pidDir?: string | undefined;      // 设了就为每个在跑的 Agent 进程组留一个 pid 文件，接单程序重启时据此清理孤儿进程
}

export function buildArgs(req: RunRequest): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (req.session_id) args.push("--resume", req.session_id);
  if (req.model) args.push("--model", req.model);
  if (req.tools) args.push("--tools", req.tools.join(","));
  if (req.disallowed_tools?.length) args.push("--disallowedTools", ...req.disallowed_tools);
  if (req.permission_mode) args.push("--permission-mode", req.permission_mode);
  // --tools、--disallowedTools 能接多个值，不隔开就会把提示词也吞成工具名（2026-11-12 实测：Claude Code 收不到提示词直接报错退出）。
  args.push("--", req.prompt);
  return args;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude";
  private readonly bin: string;
  private readonly recordDir: string | undefined;
  private readonly pidDir: string | undefined;
  constructor(opts: ClaudeCodeOptions = {}) { this.bin = opts.bin ?? "claude"; this.recordDir = opts.recordDir; this.pidDir = opts.pidDir; }

  run(req: RunRequest, signal?: AbortSignal): Promise<RunResult> {
    const args = buildArgs(req);
    return new Promise((resolve, reject) => {
      // 自成一个进程组：停止时连同 Agent 起的子进程一起结束。
      const child = spawn(this.bin, args, { cwd: req.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
      let out = "", err = "", stopped = false, session: string | null = null;
      const pidFile = this.pidDir && child.pid ? join(this.pidDir, `${req.label ?? child.pid}.pid`) : null;
      if (pidFile) { mkdirSync(this.pidDir!, { recursive: true }); writeFileSync(pidFile, String(child.pid)); }
      const kill = () => { stopped = true; try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); } };
      const timer = setTimeout(kill, req.timeout_ms);
      signal?.addEventListener("abort", kill, { once: true });
      child.stdout.on("data", (c) => {
        out += c;
        // 会话编号在第一行 system/init 里就有；尽早交给接单程序随心跳上报，中途断了也能接上。
        if (!session) { session = initSession(out); if (session) req.onSession?.(session); }
      });
      child.stderr.on("data", (c) => (err += c));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", kill);
        if (pidFile) try { unlinkSync(pidFile); } catch { /* 已被清理 */ }
        if (this.recordDir) {
          mkdirSync(this.recordDir, { recursive: true });
          writeFileSync(join(this.recordDir, `${req.label ?? Date.now()}.ndjson`), out);
        }
        resolve({ ...parseStream(out), exit_code: code ?? -1, stderr: err, stopped });
      });
    });
  }
}

function initSession(out: string): string | null {
  const m = /"type":"system","subtype":"init"[^\n]*?"session_id":"([^"]+)"/.exec(out);
  return m ? m[1]! : null;
}

// 接单程序启动时调用：上一个实例留下的 Agent 进程组还在跑的，结束掉，免得和重新派发的一轮同时改一个工作目录。
// 只结束命令行里确实是这个 Agent 的进程，防止 pid 被系统复用后误杀别的进程。返回结束了几个。
export function reapOrphans(pidDir: string, bin = "claude"): string[] {
  let files: string[] = [];
  try { files = readdirSync(pidDir).filter((f) => f.endsWith(".pid")); } catch { return []; }
  const reaped: string[] = [];
  for (const f of files) {
    const path = join(pidDir, f);
    const pid = Number(readFileSync(path, "utf8").trim());
    try {
      const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      if (cmd.includes(bin)) { process.kill(-pid, "SIGTERM"); reaped.push(f.replace(/\.pid$/, "")); }
    } catch { /* 进程已经不在 */ }
    try { unlinkSync(path); } catch { /* 忽略 */ }
  }
  return reaped;
}

// 从 stream-json 里取出回执所需的字段。独立成函数以便用录制的输出做测试。
export function parseStream(ndjson: string): Omit<RunResult, "exit_code" | "stderr"> {
  let last_message = "", session_id: string | null = null, usage: Record<string, unknown> = {};
  let lastText = "", sawResult = false;
  let rate_limit: RunResult["rate_limit"], rate_limited = false;
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "system" && ev.subtype === "init" && !session_id) {
      session_id = (ev.session_id as string) ?? null;   // 没有 result（中途被结束）时也知道是哪个会话
    } else if (ev.type === "assistant") {
      const content = (ev.message as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [];
      const text = content.filter((c) => c.type === "text" && c.text).map((c) => c.text).join("");
      if (text) lastText = text;
    } else if (ev.type === "result") {
      sawResult = true;
      last_message = typeof ev.result === "string" ? ev.result : "";
      session_id = (ev.session_id as string) ?? null;
      usage = { usage: ev.usage, modelUsage: ev.modelUsage, num_turns: ev.num_turns, duration_ms: ev.duration_ms, subtype: ev.subtype };
      if (ev.is_error && /rate.?limit|usage limit/i.test(String(ev.result))) rate_limited = true;
    } else if (ev.type === "rate_limit_event") {
      const info = ev.rate_limit_info as { status?: string; unifiedWindows?: Record<string, RateLimitWindow> } | undefined;
      const w = info?.unifiedWindows ?? {};
      rate_limit = {};
      if (w.five_hour) rate_limit.five_hour = w.five_hour;
      if (w.seven_day) rate_limit.seven_day = w.seven_day;
      if (info?.status && info.status !== "allowed") rate_limited = true;
    }
  }
  // 没有完整的 result 行：用最后一条 assistant 文本。2026-11-12 实测：读端停住时管道写满，
  // Claude Code 退出时最后一行只写出一半，而回执就在它前面那条 assistant 消息里。
  if (!sawResult) last_message = lastText;
  return { last_message, session_id, usage, rate_limit, rate_limited };
}
