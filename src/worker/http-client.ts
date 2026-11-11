// 接单程序和通道用的内核客户端。来源编号由客户端生成，保证重放去重。
import type { KernelClient } from "./worker.ts";
import type { EventSource } from "../kernel/types.ts";

export interface ClientOptions {
  worker?: { worker: string; instance: string } | undefined;  // 接单程序的身份，领活时带上
  retryDelaysMs?: number[];                                   // 事件投递失败时的重试间隔
}

// 内核由 launchd 拉起，重启通常几秒到一分钟。回执这类事件不能丢：用同一个来源编号重试，内核按来源编号去重。
const DEFAULT_RETRY = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000];

export function kernelClient(base: string, source: EventSource, opts: ClientOptions = {}): KernelClient & { get<T>(path: string): Promise<T> } {
  let n = 0;
  const sourceId = () => `${process.pid}-${Date.now()}-${n++}`;
  const retry = opts.retryDelaysMs ?? DEFAULT_RETRY;
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(base + path);
    const data = await res.json();
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${(data as { error?: string }).error ?? ""}`);
    return data as T;
  };
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${(data as { error?: string }).error ?? ""}`);
    return data as T;
  };
  return {
    get,
    claim: (agent) => post("/runs/claim", { agent, at: new Date().toISOString(), source_id: sourceId(), ...(opts.worker ?? {}) }),
    claimJudgment: (agent) => post("/judgments/claim", { agent, at: new Date().toISOString(), source_id: sourceId(), ...(opts.worker ?? {}) }),
    emit: async (type, payload, about) => {
      const event = { source, source_id: sourceId(), type, at: new Date().toISOString(), about, payload };
      // 心跳丢一次无妨，下一次会补上；其余事件连不上内核就按间隔重试，来源编号不变。
      const delays = type === "run.heartbeat" ? [] : retry;
      for (let i = 0; ; i++) {
        try { await post("/events", event); return; } catch (err) {
          if (i >= delays.length || !isConnError(err)) throw err;
          await new Promise((r) => setTimeout(r, delays[i]));
        }
      }
    },
    goal: (id) => get(`/goals/${encodeURIComponent(id)}`),
    runStatus: async (id) => (await get<{ status: string }>(`/runs/${encodeURIComponent(id)}`)).status,
  };
}

// 只对连不上内核重试；内核明确拒绝（4xx/5xx）的不重试。
function isConnError(err: unknown): boolean {
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}
