// Claude Code 无界面模式。实测（2026-11-11，Claude Code 2.1.322）：
//   claude -p --output-format stream-json --verbose [--resume <id>] [--model m] [--tools ""]
// 事件流里有 system/init、assistant、rate_limit_event、result。result.result 是最后一条消息，
// result.session_id 可用于 --resume；rate_limit_event.rate_limit_info.unifiedWindows 给周用量和重置时间。
// 状态栏脚本在无界面模式下不会被调用，所以用量读数来自这里，不来自状态栏文件。
import { spawn } from "node:child_process";
import type { AgentAdapter, RunRequest, RunResult, RateLimitWindow } from "./types.ts";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude";
  private readonly bin: string;
  constructor(bin = "claude") { this.bin = bin; }

  run(req: RunRequest, signal?: AbortSignal): Promise<RunResult> {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (req.session_id) args.push("--resume", req.session_id);
    if (req.model) args.push("--model", req.model);
    if (req.tools) args.push("--tools", req.tools.join(","));
    if (req.permission_mode) args.push("--permission-mode", req.permission_mode);
    args.push(req.prompt);

    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { cwd: req.cwd, stdio: ["ignore", "pipe", "pipe"], signal: signal as AbortSignal });
      let out = "", err = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), req.timeout_ms);
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ ...parseStream(out), exit_code: code ?? -1, stderr: err });
      });
    });
  }
}

// 从 stream-json 里取出回执所需的字段。独立成函数以便用录制的输出做测试。
export function parseStream(ndjson: string): Omit<RunResult, "exit_code" | "stderr"> {
  let last_message = "", session_id: string | null = null, usage: Record<string, unknown> = {};
  let rate_limit: RunResult["rate_limit"], rate_limited = false;
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "result") {
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
  return { last_message, session_id, usage, rate_limit, rate_limited };
}
