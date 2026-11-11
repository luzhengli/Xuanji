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
  permission_mode?: string;   // 无界面运行时的权限模式；不写沿用本机 Agent 的设置
  daily_usd?: number;
}

export interface Config {
  db: string;                 // 账本 SQLite 文件路径
  port: number;               // 内核只听 127.0.0.1
  owner_open_id: string;      // 只认你本人（飞书 open_id）
  backup_dir: string;         // 快照目录（首版在系统盘）
  brief_at: string;           // 每日简报的本机时间 HH:MM（人定 2026-11-12：09:00）
  limits: {
    backpressure_cards: number;      // 待处理决策卡+审核卡上限，默认 5
    weekly_quota_ratio: number;      // 自动化不超过订阅周限额的比例，默认 0.8（人定 2026-11-12，原为 0.6）
    per_goal_concurrency: number;
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
  limits: { backpressure_cards: 5, weekly_quota_ratio: 0.8, per_goal_concurrency: 2, hop_limit: 8 },
  agents: {
    claude: { use: "claude", kinds: ["code", "plan", "write", "judge"], tier: "strong", billing: "subscription", capacity: 2 },
  },
};

export function loadConfig(path = process.env.XJ_CONFIG ?? "xuanji.config.json"): Config {
  let raw: Partial<Config> = {};
  try { raw = JSON.parse(readFileSync(resolve(path), "utf8")); } catch { /* 没有配置文件就用默认值 */ }
  return { ...DEFAULTS, ...raw, limits: { ...DEFAULTS.limits, ...(raw.limits ?? {}) }, agents: raw.agents ?? DEFAULTS.agents };
}
