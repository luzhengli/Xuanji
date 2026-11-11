// 内核：唯一有状态的部分。确定性：不读时钟、不取随机数、不主动外连。
// ingest() 是唯一入口：追加事件、归并投影、对账，三者同一事务。
import { openStore, transaction, clearProjections, type DB } from "./store.ts";
import { appendEvent, readEvents, eventsAbout } from "./events.ts";
import { reduce, getGoal, getTask } from "./reducer.ts";
import { reconcileGoals } from "./reconcile.ts";
import { pickNext } from "./scheduler.ts";
import { openCards } from "./attention.ts";
import { waitingOn } from "./state.ts";
import type { Config } from "../shared/config.ts";
import type { Event, EventInput, Receipt, Run, Task, TaskState } from "./types.ts";

// 领活的结果：一件任务、内核签发的轮次编号，以及这一轮要带上的反馈和上一轮回执。
export interface Claim {
  task: Task;
  agent: string;
  purpose: "execute";
  run_id: string;
  feedback: string | null;
  previous: Receipt | null;
}

export class Kernel {
  readonly db: DB;
  readonly cfg: Config;
  constructor(cfg: Config, dbPath = cfg.db) { this.cfg = cfg; this.db = openStore(dbPath); }

  // 返回落账的事件；重复事件返回 null。
  ingest(input: EventInput): Event | null {
    return transaction(this.db, () => this.apply(input));
  }

  private apply(input: EventInput): Event | null {
    const e = appendEvent(this.db, input);
    if (!e) return null;
    if ((e.hops ?? 0) > this.cfg.limits.hop_limit) return e; // 跳数熔断：只记录。TODO P3：出一张卡片
    reduce(this.db, e);
    reconcileGoals(this.db);
    return e;
  }

  // 从事件日志重建全部投影。重启恢复和备份演练都用它。
  rebuild(): number {
    return transaction(this.db, () => {
      clearProjections(this.db);
      const events = readEvents(this.db);
      for (const e of events) { if ((e.hops ?? 0) <= this.cfg.limits.hop_limit) reduce(this.db, e); }
      reconcileGoals(this.db);
      return events.length;
    });
  }

  // 领活：挑任务和落 run.claimed 在同一事务里，两个接单程序不会领到同一件。
  // 时间和来源编号由接单程序给（内核不读时钟），轮次编号由归并按计数器签发，重放一致。
  claim(agent: string, at: string, source_id: string): Claim | null {
    return transaction(this.db, () => {
      const a = pickNext(this.db, this.cfg, agent);
      if (!a) return null;
      const before = a.task;
      const e = this.apply({ source: "worker", source_id, type: "run.claimed", at, about: before.id,
        payload: { task_id: before.id, agent, purpose: a.purpose } });
      if (!e) return null; // 同一个来源编号重复领活：不再派第二次
      const run = this.db.prepare(`SELECT id FROM runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1`)
        .get(before.id) as { id: string };
      return { task: getTask(this.db, before.id)!, agent, purpose: a.purpose, run_id: run.id,
        feedback: before.feedback, previous: this.lastReceipt(before.id) };
    });
  }

  private lastReceipt(taskId: string): Receipt | null {
    const r = this.db.prepare(`SELECT receipt FROM runs WHERE task_id = ? AND receipt IS NOT NULL ORDER BY rowid DESC LIMIT 1`).get(taskId) as { receipt: string } | undefined;
    return r ? JSON.parse(r.receipt) : null;
  }

  cards() { return openCards(this.db); }
  why(ref: string) { return eventsAbout(this.db, ref); }
  goal(id: string) { return getGoal(this.db, id) ?? null; }
  task(id: string) { return getTask(this.db, id) ?? null; }
  run(id: string): Run | null {
    const r = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? { ...(r as unknown as Run), receipt: r.receipt ? JSON.parse(r.receipt as string) : null } : null;
  }

  overview() {
    const tasks = (this.db.prepare(`SELECT id, goal_id, state, runs_used, session_id FROM tasks ORDER BY created_at, rowid`).all() as { id: string; goal_id: string; state: TaskState; runs_used: number; session_id: string | null }[])
      .map((t) => ({ ...t, waiting_on: waitingOn(t.state) }));
    const goals = this.db.prepare(`SELECT id, title, status FROM goals ORDER BY created_at, rowid`).all();
    const runs = this.db.prepare(`SELECT id, task_id, agent, status, session_id, started_at, finished_at FROM runs ORDER BY rowid`).all();
    const quota = this.db.prepare(`SELECT * FROM quota`).all();
    return { goals, tasks, runs, cards: this.cards(), quota };
  }

  close() { this.db.close(); }
}
