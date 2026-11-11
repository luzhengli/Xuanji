// 时间也是事件。内核不读时钟；定时器来源按固定间隔注入 timer.tick，内核据此触发对账、看门狗和到期的定时器。
// TODO P1-14 / P1-17：心跳超时、单轮超时、每日简报都由 tick 驱动。
export function startTimerSource(base: string, intervalMs = 60_000): NodeJS.Timeout {
  return setInterval(async () => {
    const at = new Date().toISOString();
    await fetch(`${base}/events`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "timer", source_id: at, type: "timer.tick", at, payload: {} }) }).catch(() => {});
  }, intervalMs);
}
