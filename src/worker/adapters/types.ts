// Agent 接入只有一条约定：提示词进，最后一条消息（回执）出。
export interface RunRequest {
  prompt: string;
  cwd: string;
  session_id?: string | undefined;   // 有则接上原会话
  model?: string | undefined;
  tools?: string[] | undefined;      // 判断点不给工具权限：[]
  permission_mode?: string | undefined;
  timeout_ms: number;
}

export interface RateLimitWindow { utilization: number; resetsAt: number; status: string; }

export interface RunResult {
  last_message: string;
  session_id: string | null;
  exit_code: number;
  usage: Record<string, unknown>;
  rate_limit?: { five_hour?: RateLimitWindow; seven_day?: RateLimitWindow } | undefined;
  rate_limited: boolean;             // 识别到限流：任务应转“等世界”到重置时间
  stderr: string;
}

export interface AgentAdapter {
  readonly name: string;
  run(req: RunRequest, signal?: AbortSignal): Promise<RunResult>;
}
