// 接单程序和通道用的内核客户端。来源编号由客户端生成，保证重放去重。
import type { KernelClient } from "./worker.ts";
import type { EventSource } from "../kernel/types.ts";

export function kernelClient(base: string, source: EventSource): KernelClient & { get<T>(path: string): Promise<T> } {
  let n = 0;
  const get = async <T>(path: string): Promise<T> => (await fetch(base + path)).json() as Promise<T>;
  const post = async <T>(path: string, body: unknown): Promise<T> =>
    (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<T>;
  return {
    get,
    claim: (agent) => post("/runs/claim", { agent }),
    emit: async (type, payload, about) => {
      await post("/events", { source, source_id: `${process.pid}-${Date.now()}-${n++}`, type, at: new Date().toISOString(), about, payload });
    },
    goal: async (id) => {
      const o = await get<{ goals: { id: string }[] }>("/overview");
      const g = o.goals.find((x) => x.id === id);
      if (!g) throw new Error(`目标不存在 ${id}`);
      return g as never; // TODO P1-05：补 GET /goals/:id
    },
  };
}
