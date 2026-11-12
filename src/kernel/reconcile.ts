// 目标层对账：每条相关事件到达时和定时心跳时都跑一次。有差距就补动作，所以对漏掉的事件不敏感。
import type { DB } from "./store.ts";

export interface Gap { goal_id: string; kind: "undispatched" | "goal_acceptance_pending" | "found_unhandled"; detail: string; }

export function reconcileGoals(db: DB): Gap[] {
  const gaps: Gap[] = [];
  const goals = db.prepare(`SELECT id FROM goals WHERE status = 'active'`).all() as { id: string }[];
  for (const { id } of goals) {
    const states = (db.prepare(`SELECT state FROM tasks WHERE goal_id = ?`).all(id) as { state: string }[]).map((r) => r.state);
    if (states.length && states.every((s) => s === "done")) {
      gaps.push({ goal_id: id, kind: "goal_acceptance_pending", detail: "全部任务完成，目标验收还没跑" });
      // TODO P2：目标验收；一期一个目标一个任务，任务完成即目标完成。
      db.prepare(`UPDATE goals SET status = 'done' WHERE id = ?`).run(id);
    } else if (states.length && states.every((s) => s === "done" || s === "stopped" || s === "abandoned")) {
      // 任务都不再等了但没全做完（P1-24）：被人停掉或接管的记 stopped，其余（放弃）记 abandoned，不再挂在“在做”里。
      db.prepare(`UPDATE goals SET status = ? WHERE id = ?`).run(states.includes("stopped") ? "stopped" : "abandoned", id);
    }
    // TODO P2：依赖已满足但还没派发的任务（awaiting_deps → queued）。
    // TODO P3：回执里的范围外事项还没处理。
  }
  return gaps;
}
