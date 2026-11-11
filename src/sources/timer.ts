// 时间也是事件。内核不读时钟；定时器来源按固定间隔注入 timer.tick，内核据此触发到期的定时器和看门狗（P1-19）。
// TODO P1-17：每日简报也由 tick 驱动。
import type { EventInput } from "../kernel/types.ts";

// 两次 tick 之间隔得太久（机器睡眠、进程被挂起），说明这段时间谁都没在跑：先补一条 timer.resumed，
// 让内核像重启时一样给执行中的轮次一个宽限，免得醒来的第一次 tick 就把它们全判成心跳超时。
export function ticksFor(lastAt: string | null, at: string, intervalMs: number): EventInput[] {
  const out: EventInput[] = [];
  if (lastAt && Date.parse(at) - Date.parse(lastAt) > intervalMs * 3) {
    out.push({ source: "timer", source_id: `resumed-${at}`, type: "timer.resumed", at, payload: { gap_ms: Date.parse(at) - Date.parse(lastAt) } });
  }
  out.push({ source: "timer", source_id: at, type: "timer.tick", at, payload: {} });
  return out;
}

export function startTimerSource(base: string, intervalMs = 60_000): NodeJS.Timeout {
  let lastAt: string | null = null;
  return setInterval(async () => {
    const at = new Date().toISOString();
    for (const e of ticksFor(lastAt, at, intervalMs)) {
      await fetch(`${base}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e) }).catch(() => {});
    }
    lastAt = at;
  }, intervalMs);
}
