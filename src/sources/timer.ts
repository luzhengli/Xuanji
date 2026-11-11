// 时间也是事件。内核不读时钟；定时器来源按固定间隔注入 timer.tick，内核据此触发到期的定时器和看门狗（P1-19）。
// 每日简报（P1-17）也由这里发：本机时间过了简报时刻，每次 tick 都带一条 brief.due，来源编号是当天的日期，
// 所以内核只认第一条。机器睡过了点、进程停过，醒来后的第一次 tick 就补发；停了一整天，那天就没有简报，这正是心跳的意思。
import type { EventInput } from "../kernel/types.ts";

// 本机时区的日期，YYYY-MM-DD。
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 到了简报时刻（本机时间 HH:MM）就给出当天的 brief.due，没到返回 null。
export function briefDue(now: Date, briefAt: string): EventInput | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(briefAt.trim());
  if (!m) return null;
  if (now.getHours() * 60 + now.getMinutes() < Number(m[1]) * 60 + Number(m[2])) return null;
  const date = localDate(now);
  return { source: "timer", source_id: `brief-${date}`, type: "brief.due", at: now.toISOString(), payload: { date } };
}

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

export function startTimerSource(base: string, intervalMs = 60_000, briefAt?: string): NodeJS.Timeout {
  let lastAt: string | null = null;
  return setInterval(async () => {
    const now = new Date();
    const at = now.toISOString();
    const brief = briefAt ? briefDue(now, briefAt) : null;
    for (const e of [...ticksFor(lastAt, at, intervalMs), ...(brief ? [brief] : [])]) {
      await fetch(`${base}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e) }).catch(() => {});
    }
    lastAt = at;
  }, intervalMs);
}
