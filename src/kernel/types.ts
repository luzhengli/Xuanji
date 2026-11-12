// 七个名词：事件、目标、任务、一轮、回执、卡片、定论。新需求优先做成它们的属性。
import type { AgentKind } from "../shared/config.ts";

// ---- 事件 ----
// 只携带信息，不携带权限。来源 + 来源编号 用于去重。
export type EventSource = "human" | "feishu" | "cli" | "timer" | "worker" | "github" | "ci" | "kernel" | "backup";

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

// stopped：任务被人停掉或接管而结束（P1-24）。
export type GoalStatus = "proposed" | "active" | "paused" | "done" | "abandoned" | "stopped";

export interface Goal {
  id: string;
  title: string;
  acceptance: string[];
  boundaries: string[];
  grant: Grant;
  base?: string | null;          // 人写明的基底（分支或提交，P2-02）；没写从主干拉
  checks?: string[];             // 检查命令（P2-05）：主理人提议、写在目标卡上，人确认目标卡即批准；直接立项的没有
  split?: boolean;               // 主理人标了“可能要拆”（P2-08）：立项后先跑规划，没标的照旧一个任务
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
  // write：可写范围，登记成租约（P2-03）；exclusive：具名独占资源（预发环境、数据库迁移、发布通道）。
  scope: { write: string[]; effects: string[]; exclusive?: string[] };
  budget: { runs: number; minutes: number; usd?: number };
  ask_first: string[];
  depends_on: string[];
  agent: { kind: AgentKind; tier: "strong" | "light" };
  skill?: string;
  base?: string;                 // worktree 从哪拉（P2-02）：目标写明的分支或提交；没有就从主干拉
  // 拆开的目标（P2-08）里的角色：part 是拆出来的一部分，验证通过即完成、不出审核卡；
  // merge 是合并任务（P2-09），依赖全部 part，它的验证就是目标验收（P2-10），通过后出目标级审核卡。不拆的任务没有这个字段。
  role?: "part" | "merge";
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
  worktrees?: string | null;     // Agent 在这个任务里建的 git worktree（JSON 数组，P1-28）；任务结束后清理
  base_commit?: string | null;   // 系统建的 worktree 从哪个提交拉出（P2-02），验证者据此看改动
  verify_due?: string | null;    // 等哪个档案来验证最近一轮的产出（P2-05）；验证有了结论就清空
  verify_failures?: number;      // 连续没通过验证的轮数，到 3 出卡问人
  verify_not_before?: string | null;   // 验证者限流时，这之前不派验证
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
  verdict?: Verdict | null;      // 验证轮的结论（purpose = verify，P2-05）
  worker: string | null;         // 领活的接单程序名与实例
  instance: string | null;
  lost_reason: string | null;    // 中断原因：心跳超时、单轮超时、接单程序重启
}

// ---- 回执 ----
export type Outcome = "done" | "waiting" | "ask" | "blocked" | "failed" | "nothing";

export interface ReceiptEvidence { check?: string; result?: string; artifact?: string; ref?: string; }
// ruling：Agent 认为这条定论不适用于这次的情况（P2-07）。不得自行绕过，出卡请人定。
export interface ReceiptAsk { question: string; why?: string; options?: string[]; recommended?: string; ruling?: string; }
export interface ReceiptLater { on?: string; timeout?: string; about: string; }
export interface ReceiptFound { title: string; why?: string; }
// Agent 在任务里建的 git worktree（P1-28）：接单程序每轮结束后查 git worktree list，路径或分支名带任务编号的随回执上报。
// repo：所属仓库的主工作区，清理时在那里执行（系统建的每任务 worktree 才有，P2-02）。
export interface Worktree { path: string; branch?: string | undefined; repo?: string | undefined; }
// 要系统代为执行的对外动作（P1-21）。Agent 自己不做，写进回执；内核先落账，接单程序再执行。
export interface ReceiptEffect { kind: string; branch?: string; base?: string; remote?: string; title?: string; body?: string; }

// ---- 验证（P2-05）----
// 第一层：契约里的检查命令，接单程序在任务的 worktree 里跑，内核只记结果。
// skipped：没跑（被 Bash 禁用规则拦下等），不算没通过，写进残余风险。
export interface CheckResult { command: string; ok: boolean; exit_code: number | null; output: string; skipped?: string | undefined; }
export interface VerdictIssue { criterion?: string | undefined; problem: string; where?: string | undefined; }
// 第二层：验证者的结论。只报违反验收标准或会出错的问题；必须列出残余风险。
export interface Verdict {
  pass: boolean;
  summary: string;
  issues: VerdictIssue[];
  risks: string[];
  checks?: CheckResult[] | undefined;
  reviewer?: string | undefined;   // 档案名；检查命令没过、没请验证者时没有
}

export interface Receipt {
  outcome: Outcome;
  summary: string;
  evidence?: ReceiptEvidence[];
  handoff?: string;
  ask?: ReceiptAsk[];
  later?: ReceiptLater[];
  found?: ReceiptFound[];
  effects?: ReceiptEffect[];
  usage?: Record<string, unknown>;
}

// ---- 卡片 ----
export type CardKind = "decision" | "review" | "notice";
export type CardStatus = "open" | "answered" | "expired" | "withdrawn" | "folded";   // folded：知会卡随简报汇总后收起（P1-22）

// 卡片的样式：目标卡（主理人整理的，确认/修改/不做）、超预算卡、简报、主理人的答复。普通卡片为 null。
// alert：异常（备份失败、演练不通过），推送；恢复正常后撤回。
// effect：对外动作失败后问人（重试 / 跳过 / 放弃）。
// verify：验证三轮还不通过（再给 3 轮 / 按现状审核 / 放弃），或验证者连续没跑成（重新验证 / 按现状审核 / 放弃）。
// plan：规划出的拆分计划（按计划拆 / 不拆，一个任务做 / 修改，P2-08）。
// ruling：Agent 认为某条定论这次不适用（照定论做 / 这次例外 / 作废这条定论，P2-07）。
export type CardForm = "goal" | "budget" | "brief" | "reply" | "alert" | "effect" | "verify" | "plan" | "ruling";

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
  shown?: string | null;         // 飞书上最后一次显示的状态（P1-27）；和 status 不一致时，通道主动把卡片改成现状
  created_at: string;
  updated_at: string;
}

// ---- 对外动作（P1-21）----
// 先落账后执行：回执到达时与回执同事务写进 effects，接单程序领去执行，执行前先查远端，做过的不再做。
// remove-worktree 不是对外动作，是任务结束后清理 Agent 建的 git worktree（P1-28），借同一套落账、领取、重试。
export type EffectKind = "push-branch" | "open-pr" | "remove-worktree";
export type EffectStatus = "queued" | "running" | "done" | "failed" | "rejected" | "cancelled";

export interface Effect {
  id: string;                    // X-n
  task_id: string;
  run_id: string;
  kind: string;
  params: { branch: string; remote: string; base?: string; title?: string; body?: string; path?: string; repo?: string };
  key: string;                   // 幂等键：同一轮回执里重复的请求只记一次
  status: EffectStatus;
  attempts: number;
  not_before: string | null;     // 退避：这之前不派
  result: { ref?: string; detail?: string } | null;
  error: string | null;
  worker: string | null;
  instance: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

// ---- 判断点 ----
// 研判、规划、验证、主理人对话是无状态的模型调用，经接单程序起一次不给工具的 Agent（“判断点也是一轮”）。
// 主理人整理目标卡（intake），规划拆分（plan，P2-08）。轮次表的 task_id 不能为空，所以判断点单独一张表，编号 J-x。
export type JudgmentKind = "intake" | "plan";
export type JudgmentStatus = "queued" | "running" | "finished" | "failed";

// 在途的目标：主理人据此判断一句话是新目标，还是对它们的补充（P1-23）。
export interface PendingGoal { goal: string; title: string; status: "proposed" | "active"; task?: string | undefined; reviewing?: boolean; }

export interface IntakeInput {
  request: string;               // 人的原话
  pending?: PendingGoal[] | undefined;
  revision: number;              // 第几次修改，0 是初稿
  draft?: Draft | undefined;     // 上一版目标卡
  feedback?: string | undefined; // 人的修改意见
}

// 规划的输入（P2-08）：目标、适用的定论；人要求修改计划时带上一版和修改意见。
// 拆分上限在配置里，领判断点时随结果给（Kernel.claimJudgment），落账时写进结果事件；仓库里有哪些文件由接单程序现列。都不进这里。
export interface PlanInput {
  goal: { id: string; title: string; acceptance: string[]; boundaries: string[]; checks: string[]; base?: string | undefined };
  rulings: { id: string; text: string }[];
  revision: number;
  previous?: Plan | undefined;
  feedback?: string | undefined;   // 人对上一版计划的修改意见
  note?: string | undefined;       // 人确认目标卡时的补充：带给拆出来的每个任务的第一轮
}

// 规划的输出：任务图。split=false 时 tasks 为空，照旧一个任务。合并任务不由规划写，内核在拆分时自动加。
export interface PlanTask {
  key: string;                   // 规划里的名字（a、b…），depends_on 用它
  objective: string;
  criteria: string[];            // 各自独立的验收标准
  write: string[];               // 可写范围，互不重叠
  checks: string[];              // 只能从目标已批准的检查命令里挑
  depends_on: string[];
}
export interface Plan { split: boolean; why: string; tasks: PlanTask[]; }

export interface Judgment {
  id: string;
  kind: JudgmentKind;
  about: string;                 // G-x
  status: JudgmentStatus;
  input: IntakeInput | PlanInput;
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
  kind: "goal" | "not_goal" | "amend";   // amend：对在途目标 target 的补充（P1-23）
  target?: string | undefined;
  direct: boolean;               // 小而明确，跳过确认直接立项
  title: string;
  acceptance: string[];
  boundaries: string[];
  ask_first: string[];
  notes?: string[] | undefined;  // 提醒：人确认前该知道的情况（例如要加的函数已经有了），只上卡片，不进契约
  budget?: { runs: number; minutes: number } | undefined;   // 只有人明确提到才有
  base?: string | undefined;     // 只有人写明基于哪个分支或提交才有（P2-02）
  checks?: string[] | undefined; // 主理人提议的检查命令（P2-05），人确认目标卡才跑
  split?: boolean | undefined;   // 可能要拆（P2-08）：确认后先跑规划
  reply?: string | undefined;    // 不是目标时回人的一句话
}

// ---- 定论 ----
// 范围（P2-07）：task 只管那个任务；goal 管那个目标下的全部任务；project 管这个工作仓库（二期只有一个项目，等于全局）；global 管以后全部。
export type RulingScope = "task" | "goal" | "project" | "global";

export interface Ruling {
  id: string;
  scope: RulingScope;
  scope_ref: string | null;      // 出处卡片说的那件事（T-x / G-x）；按范围匹配时再换算成目标
  text: string;                  // 人的原话
  origin: string;                // 出处：卡片编号或事件编号
  decided_at: string;
  revoked: boolean;
}
