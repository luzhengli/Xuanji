// 连不上内核时重试。内核由 launchd 拉起，重启通常几秒；事件带来源编号，内核按它去重，所以重试不会记两次。
// 只对“连不上”重试；内核明确拒绝（4xx/5xx）的不重试。
export function isConnError(err: unknown): boolean {
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

export async function retryConn<T>(fn: () => Promise<T>, delaysMs: number[]): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (err) {
      if (i >= delaysMs.length || !isConnError(err)) throw err;
      await new Promise((r) => setTimeout(r, delaysMs[i]));
    }
  }
}
