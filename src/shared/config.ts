// 配置：一个 JSON 文件，零运行时依赖。示例见仓库根目录 xuanji.config.example.json。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Billing = "subscription" | "api";
export type AgentKind = "code" | "plan" | "write" | "judge" | "review" | "ops" | "watch" | "brief";

export interface AgentProfile {
  use: "claude" | "codex" | "dsh";
  kinds: AgentKind[];
  tier: "strong" | "light";
  billing: Billing;
  capacity: number;
  model?: string;             // 例：claude-haiku-5-5；不写用 Agent 自己的默认
  effort?: string;            // 思考强度（Codex 的 model_reasoning_effort）。Codex 不加载人的个人配置，所以要显式写（P2-04）
  permission_mode?: string;   // 无界面运行时的权限模式；不写沿用本机 Agent 的设置
  daily_usd?: number;
}

export interface Config {
  db: string;                 // 账本 SQLite 文件路径
  port: number;               // 内核只听 127.0.0.1
  owner_open_id: string;      // 只认你本人（飞书 open_id）
  backup_dir: string;         // 快照目录（首版在系统盘）
  brief_at: string;           // 每日简报的本机时间 HH:MM（人定 2026-11-12：09:00）
  worktree_root: string;      // 每任务一个 worktree 的根目录（P2-02），默认 ~/xj-worktrees，下面按仓库名分
  // 调度上限（2026-11-12 人定，暂定）。只影响调度，不影响账本重放。
  limits: {
    backpressure_cards: number;      // 背压软上限：待处理决策卡+审核卡到这个数，不开新任务的第一轮。默认 5
    backpressure_hard: number;       // 背压硬上限：到这个数，只放行带人回答的任务和验证轮。默认 8
    weekly_quota_ratio: number;      // 周用量到这个比例只跑人亲自提的目标，默认 0.8（人定 2026-11-12，原为 0.6）
    downgrade_quota_ratio: number;   // 周用量到这个比例执行降为 1 个、禁用子 Agent，默认 0.6
    per_goal_concurrency: number;    // 每个目标同时几个执行，默认 1
    verify_concurrency: number;      // 验证同时几个，默认 1（P2-05）
    max_tasks_per_goal: number;      // 一个目标最多拆几个任务，默认 4（二期第三批规划时用）
    hop_limit: number;               // 跳数熔断，默认 8
  };
  agents: Record<string, AgentProfile>;
}

export const DEFAULTS: Config = {
  db: "./data/xuanji.db",
  port: 7331,
  owner_open_id: "",
  backup_dir: "./data/backups",
  brief_at: "09:00",
  worktree_root: "~/xj-worktrees",
  limits: { backpressure_cards: 5, backpressure_hard: 8, weekly_quota_ratio: 0.8, downgrade_quota_ratio: 0.6,
    per_goal_concurrency: 1, verify_concurrency: 1, max_tasks_per_goal: 4, hop_limit: 8 },
  agents: {
    claude: { use: "claude", kinds: ["code", "plan", "write", "judge"], tier: "strong", billing: "subscription", capacity: 2 },
  },
};

export function loadConfig(path = process.env.XJ_CONFIG ?? "xuanji.config.json"): Config {
  let raw: Partial<Config> = {};
  try { raw = JSON.parse(readFileSync(resolve(path), "utf8")); } catch { /* 没有配置文件就用默认值 */ }
  return { ...DEFAULTS, ...raw, limits: { ...DEFAULTS.limits, ...(raw.limits ?? {}) }, agents: raw.agents ?? DEFAULTS.agents };
}
