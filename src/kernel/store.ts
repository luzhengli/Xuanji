// 存储：一个 SQLite 文件。事件表只追加；其余都是投影，与事件在同一事务写入。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  source    TEXT NOT NULL,
  source_id TEXT NOT NULL,
  type      TEXT NOT NULL,
  at        TEXT NOT NULL,
  about     TEXT,
  hops      INTEGER NOT NULL DEFAULT 0,
  payload   TEXT NOT NULL,
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS events_about ON events(about);

CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, acceptance TEXT NOT NULL, boundaries TEXT NOT NULL,
  grant_json TEXT NOT NULL, status TEXT NOT NULL, origin_event INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), state TEXT NOT NULL,
  contract TEXT NOT NULL, runs_used INTEGER NOT NULL DEFAULT 0, minutes_used REAL NOT NULL DEFAULT 0,
  session_id TEXT, workdir TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), agent TEXT NOT NULL, purpose TEXT NOT NULL,
  status TEXT NOT NULL, session_id TEXT, started_at TEXT, heartbeat_at TEXT, finished_at TEXT, receipt TEXT
);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, about TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  options TEXT NOT NULL, dedupe_key TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, external_ref TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_open ON cards(status, kind);
CREATE TABLE IF NOT EXISTS rulings (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_ref TEXT, text TEXT NOT NULL, origin TEXT NOT NULL,
  decided_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS leases (
  task_id TEXT NOT NULL REFERENCES tasks(id), pattern TEXT NOT NULL, PRIMARY KEY (task_id, pattern)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  task_id TEXT NOT NULL REFERENCES tasks(id), object_ref TEXT NOT NULL, PRIMARY KEY (task_id, object_ref)
);
CREATE TABLE IF NOT EXISTS timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, about TEXT NOT NULL, due_at TEXT NOT NULL, reason TEXT NOT NULL,
  fired INTEGER NOT NULL DEFAULT 0
);
-- 引用图最小版（P1-18）：归并时把每条事件涉及和签发的编号记下来，xj why 从任一编号找回全部事件。
CREATE TABLE IF NOT EXISTS event_refs (
  ref TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (ref, seq)
);
-- 判断点（P1-10 起）：主理人整理目标卡等无工具的模型调用。输入输出都落账。
CREATE TABLE IF NOT EXISTS judgments (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, about TEXT NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL,
  output TEXT, error TEXT, failures INTEGER NOT NULL DEFAULT 0, agent TEXT, worker TEXT, instance TEXT,
  session_id TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS judgments_status ON judgments(status);
-- 备份（P1-15）：快照和恢复演练各记最近一次成功、最近一次失败。
CREATE TABLE IF NOT EXISTS backups (
  kind TEXT NOT NULL, ok INTEGER NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL, PRIMARY KEY (kind, ok)
);
-- 对外动作（P1-21）：先落账后执行。key 是幂等键。
CREATE TABLE IF NOT EXISTS effects (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, params TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, not_before TEXT,
  result TEXT, error TEXT, worker TEXT, instance TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS effects_status ON effects(status);
CREATE TABLE IF NOT EXISTS quota (
  agent TEXT PRIMARY KEY, seven_day_utilization REAL, seven_day_resets_at TEXT,
  five_hour_utilization REAL, five_hour_resets_at TEXT, observed_at TEXT
);
`;

export type DB = DatabaseSync;

// 只加列不改列：旧账本打开时补上后来新增的列。
const ADDED_COLUMNS: [table: string, column: string, decl: string][] = [
  ["tasks", "feedback", "TEXT"],                          // 下一轮要带上的人的回答或退回意见
  ["tasks", "failures", "INTEGER NOT NULL DEFAULT 0"],    // 连续 failed 或中断的次数，用于退避和转受阻
  ["tasks", "recovery", "TEXT"],                          // 上一轮中断后的恢复说明（P1-14）；回执到达时清空
  ["runs", "worker", "TEXT"],                             // 领活的接单程序名
  ["runs", "instance", "TEXT"],                           // 领活的接单程序实例；它重启后，旧实例的轮次即中断
  ["runs", "lost_reason", "TEXT"],
  ["event_refs", "note", "TEXT"],                         // 归并对这个编号做了什么（看门狗判中断等），给 xj why 看
  ["cards", "form", "TEXT"],                              // 卡片样式：goal / budget / brief / reply 等（P1-10、P1-13、P1-17）
  ["runs", "feedback", "TEXT"],                           // 这一轮领活时带走的反馈；回执到了只清掉这部分，跑的过程中新到的补充留给下一轮（P1-23）
  ["tasks", "worktrees", "TEXT"],                         // Agent 建的 git worktree（JSON 数组，P1-28），任务结束后清理
  ["cards", "shown", "TEXT"],                             // 飞书上最后一次显示的状态（P1-27）
  ["goals", "base", "TEXT"],                              // 人写明的基底（P2-02）
  ["goals", "checks", "TEXT"],                            // 检查命令（JSON 数组，P2-05），人确认目标卡即批准
  ["tasks", "base_commit", "TEXT"],                       // 系统建的 worktree 的基底提交（P2-02），验证者看改动用
  ["tasks", "verify_due", "TEXT"],                        // 等哪个档案来验证（P2-05）
  ["tasks", "verify_failures", "INTEGER NOT NULL DEFAULT 0"],   // 连续没通过验证的轮数
  ["tasks", "verify_not_before", "TEXT"],                 // 验证者限流：这之前不派验证
  ["runs", "verdict", "TEXT"],                            // 验证轮的结论（JSON，P2-05）
];

export function openStore(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  for (const [table, column, decl] of ADDED_COLUMNS) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
  return db;
}

export function transaction<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

export function nextId(db: DB, name: string): number {
  db.prepare("INSERT INTO counters(name, n) VALUES (?, 0) ON CONFLICT(name) DO NOTHING").run(name);
  db.prepare("UPDATE counters SET n = n + 1 WHERE name = ?").run(name);
  return (db.prepare("SELECT n FROM counters WHERE name = ?").get(name) as { n: number }).n;
}

// 投影可以从事件日志重建：清空所有投影表，不动 events。
export function clearProjections(db: DB): void {
  for (const t of ["event_refs", "judgments", "effects", "backups", "leases", "subscriptions", "timers", "runs", "cards", "rulings", "tasks", "goals", "counters", "quota"]) {
    db.exec(`DELETE FROM ${t}`);
  }
}
