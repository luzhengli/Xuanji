// 七个名词：事件、目标、任务、一轮、回执、卡片、定论。新需求优先做成它们的属性。
import type { AgentKind } from "../shared/config.ts";

// ---- 事件 ----
// 只携带信息，不携带权限。来源 + 来源编号 用于去重。
export type EventSource = "human" | "feishu" | "cli" | "timer" | "worker" | "github" | "ci" | "kernel";

export interface EventInput {
  source: EventSource;
  source_id: string;          // 同一来源同一编号只记一次
  type: string;               // 例：human.message、card.answered、run.receipt、timer.tick
  at: string;                 // ISO 时间，由来源提供；内核不读时钟
  about?: string | undefined; // 关联对象编号：T-1 / G-2 / C-3 / 外部对象 github:acme/shop#318
  hops?: number | undefined;  // Agent 产生的事件再触发 Agent 时层数累加（跳数熔断）
  payload: Record<string, unknown>;
}

export interface Event extends EventInput { seq: number; note?: string | undefined; }  // note 只在 why 查询时带上

// ---- 目标 ----
export type AutonomyLevel = "L0" | "L1" | "L2" | "L3";

export interface Grant {
  level: AutonomyLevel;
  effects: string[];                        // 允许的共享可逆动作：push-branch、open-pr…
  budget: { runs: number; minutes: number; usd?: number };
  ask_first: string[];                      // 必须先问的类别
}

export type GoalStatus = "proposed" | "active" | "paused" | "done" | "abandoned";

export interface Goal {
  id: string;
  title: string;
  acceptance: string[];
  boundaries: string[];
  grant: Grant;
  status: GoalStatus;
  origin_event: number;
  created_at: string;
  updated_at: string;
}

// ---- 任务 ----
// 状态只回答一个问题：它在等谁。
export type TaskState =
  | "awaiting_answer" | "awaiting_review" | "blocked"          // 等人
  | "queued" | "running" | "verifying"                          // 等 Agent
  | "awaiting_world" | "awaiting_deps"                           // 等世界
  | "done" | "abandoned" | "stopped";                            // 不再等

export interface TaskContract {
  objective: string;
  acceptance: { checks: string[]; criteria: string[] };
  scope: { write: string[]; effects: string[] };
  budget: { runs: number; minutes: number; usd?: number };
  ask_first: string[];
  depends_on: string[];
  agent: { kind: AgentKind; tier: "strong" | "light" };
  skill?: string;
}

export interface Task {
  id: string;
  goal_id: string;
  state: TaskState;
  contract: TaskContract;
  runs_used: number;
  minutes_used: number;
  session_id: string | null;     // 挂起后接上原会话用
  workdir: string | null;
  feedback: string | null;       // 下一轮要带上的人的回答或退回意见；回执到达时清空
  failures: number;              // 连续 failed 或中断的次数
  recovery: string | null;       // 上一轮中断后的恢复说明；回执到达时清空
  created_at: string;
  updated_at: string;
}

// ---- 一轮 ----
export type RunStatus = "claimed" | "running" | "finished" | "cancelled" | "lost";

export interface Run {
  id: string;
  task_id: string;
  agent: string;                 // 档案名：claude / codex / dsh
  purpose: "execute" | "verify" | "judge" | "plan" | "converse";
  status: RunStatus;
  session_id: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
  receipt: Receipt | null;
  worker: string | null;         // 领活的接单程序名与实例
  instance: string | null;
  lost_reason: string | null;    // 中断原因：心跳超时、单轮超时、接单程序重启
}

// ---- 回执 ----
export type Outcome = "done" | "waiting" | "ask" | "blocked" | "failed" | "nothing";

export interface ReceiptEvidence { check?: string; result?: string; artifact?: string; ref?: string; }
export interface ReceiptAsk { question: string; why?: string; options?: string[]; recommended?: string; }
export interface ReceiptLater { on?: string; timeout?: string; about: string; }
export interface ReceiptFound { title: string; why?: string; }

export interface Receipt {
  outcome: Outcome;
  summary: string;
  evidence?: ReceiptEvidence[];
  handoff?: string;
  ask?: ReceiptAsk[];
  later?: ReceiptLater[];
  found?: ReceiptFound[];
  usage?: Record<string, unknown>;
}

// ---- 卡片 ----
export type CardKind = "decision" | "review" | "notice";
export type CardStatus = "open" | "answered" | "expired" | "withdrawn" | "folded";   // folded：知会卡随简报汇总后收起（P1-22）

// 卡片的样式：目标卡（主理人整理的，确认/修改/不做）、超预算卡、简报、主理人的答复。普通卡片为 null。
export type CardForm = "goal" | "budget" | "brief" | "reply";

export interface CardOption { key: string; label: string; recommended?: boolean; needs_text?: boolean; }

export interface Card {
  id: string;
  kind: CardKind;
  about: string;                 // T-x / G-x
  title: string;
  body: string;                  // 正文有长度上限，细节放证据链接
  options: CardOption[];
  dedupe_key: string;            // 同一个问题还开着时不重复发
  status: CardStatus;
  answer: { choice?: string; text?: string; scope?: RulingScope } | null;
  external_ref: string | null;   // 飞书 message_id
  form: CardForm | null;
  push?: boolean;                // 内核定的：要不要主动推给人（注意力调度），只在读出时算，不入库
  created_at: string;
  updated_at: string;
}

// ---- 判断点 ----
// 研判、规划、验证、主理人对话是无状态的模型调用，经接单程序起一次不给工具的 Agent（“判断点也是一轮”）。
// 一期只有主理人整理目标卡（intake）。轮次表的 task_id 不能为空，所以判断点单独一张表，编号 J-x。
export type JudgmentKind = "intake";
export type JudgmentStatus = "queued" | "running" | "finished" | "failed";

export interface IntakeInput {
  request: string;               // 人的原话
  revision: number;              // 第几次修改，0 是初稿
  draft?: Draft | undefined;     // 上一版目标卡
  feedback?: string | undefined; // 人的修改意见
}

export interface Judgment {
  id: string;
  kind: JudgmentKind;
  about: string;                 // G-x
  status: JudgmentStatus;
  input: IntakeInput;
  output: unknown;
  error: string | null;
  failures: number;
  agent: string | null;
  worker: string | null;
  instance: string | null;
  session_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

// 主理人整理出的目标卡草稿。自主级别不在里面：权限只由人或人写的规则授予。
export interface Draft {
  kind: "goal" | "not_goal";
  direct: boolean;               // 小而明确，跳过确认直接立项
  title: string;
  acceptance: string[];
  boundaries: string[];
  ask_first: string[];
  notes?: string[] | undefined;  // 提醒：人确认前该知道的情况（例如要加的函数已经有了），只上卡片，不进契约
  budget?: { runs: number; minutes: number } | undefined;   // 只有人明确提到才有
  reply?: string | undefined;    // 不是目标时回人的一句话
}

// ---- 定论 ----
export type RulingScope = "task" | "goal" | "project" | "global";

export interface Ruling {
  id: string;
  scope: RulingScope;
  scope_ref: string | null;
  text: string;                  // 人的原话
  origin: string;                // 出处：卡片编号或事件编号
  decided_at: string;
  revoked: boolean;
}
