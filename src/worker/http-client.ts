// 接单程序和通道用的内核客户端。来源编号由客户端生成，保证重放去重。
import type { KernelClient } from "./worker.ts";
import type { EventSource } from "../kernel/types.ts";

export function kernelClient(base: string, source: EventSource): KernelClient & { get<T>(path: string): Promise<T> } {
  let n = 0;
  const sourceId = () => `${process.pid}-${Date.now()}-${n++}`;
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
    claim: (agent) => post("/runs/claim", { agent, at: new Date().toISOString(), source_id: sourceId() }),
    emit: async (type, payload, about) => {
      await post("/events", { source, source_id: sourceId(), type, at: new Date().toISOString(), about, payload });
    },
    goal: (id) => get(`/goals/${encodeURIComponent(id)}`),
    runStatus: async (id) => (await get<{ status: string }>(`/runs/${encodeURIComponent(id)}`)).status,
  };
}
