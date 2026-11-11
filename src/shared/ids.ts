// 编号格式。编号只由内核按计数器签发，不含随机数，保证重放一致。
export type Prefix = "G" | "T" | "RN" | "C" | "R" | "E" | "J";
export const PREFIX_OF = { goal: "G", task: "T", run: "RN", card: "C", ruling: "R", event: "E", judgment: "J" } as const;
export function formatId(prefix: Prefix, n: number): string { return `${prefix}-${n}`; }
export function parseId(id: string): { prefix: Prefix; n: number } | null {
  const m = /^(G|T|RN|C|R|E|J)-(\d+)$/.exec(id);
  return m ? { prefix: m[1] as Prefix, n: Number(m[2]) } : null;
}
