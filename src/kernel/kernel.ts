// 内核：唯一有状态的部分。确定性：不读时钟、不取随机数、不主动外连。
// ingest() 是唯一入口：追加事件、归并投影、对账，三者同一事务。
import { openStore, transaction, clearProjections, type DB } from "./store.ts";
import { appendEvent, readEvents, eventsAbout } from "./events.ts";
import { reduce } from "./reducer.ts";
import { reconcileGoals } from "./reconcile.ts";
import { pickNext } from "./scheduler.ts";
import { openCards } from "./attention.ts";
import type { Config } from "../shared/config.ts";
import type { Event, EventInput } from "./types.ts";

export class Kernel {
  readonly db: DB;
  readonly cfg: Config;
  constructor(cfg: Config, dbPath = cfg.db) { this.cfg = cfg; this.db = openStore(dbPath); }

  // 返回落账的事件；重复事件返回 null。
  ingest(input: EventInput): Event | null {
    return transaction(this.db, () => {
      const e = appendEvent(this.db, input);
      if (!e) return null;
      if ((e.hops ?? 0) > this.cfg.limits.hop_limit) return e; // 跳数熔断：只记录。TODO P3：出一张卡片
      reduce(this.db, e);
      reconcileGoals(this.db);
      return e;
    });
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

  claim(agent: string) { return pickNext(this.db, this.cfg, agent); }
  cards() { return openCards(this.db); }
  why(ref: string) { return eventsAbout(this.db, ref); }

  overview() {
    const tasks = this.db.prepare(`SELECT id, goal_id, state, runs_used FROM tasks ORDER BY created_at`).all();
    const goals = this.db.prepare(`SELECT id, title, status FROM goals ORDER BY created_at`).all();
    const quota = this.db.prepare(`SELECT * FROM quota`).all();
    return { goals, tasks, cards: this.cards(), quota };
  }

  close() { this.db.close(); }
}
