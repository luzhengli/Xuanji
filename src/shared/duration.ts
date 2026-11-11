// 相对时长换算。只做日期算术，不读时钟：起点总是事件自带的 at，所以重放结果一致。
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

// "90s" "30m" "2h" "1d" "1.5h" "PT2H"，或者本身就是绝对时间。认不出返回 null。
export function parseDuration(text: string): number | null {
  const t = text.trim();
  const short = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(t);
  if (short) return Math.round(Number(short[1]) * UNIT_MS[short[2]!.toLowerCase() as keyof typeof UNIT_MS]);
  const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(t);
  if (iso && t.length > 1 && t.toUpperCase() !== "PT") {
    const [, d = "0", h = "0", m = "0", s = "0"] = iso;
    return Number(d) * UNIT_MS.d + Number(h) * UNIT_MS.h + Number(m) * UNIT_MS.m + Number(s) * UNIT_MS.s;
  }
  return null;
}

// 到期时间：相对时长从 at 起算；绝对时间原样规范化；认不出用 fallbackMs。
export function dueAt(at: string, timeout: string | undefined, fallbackMs: number): string {
  const base = Date.parse(at);
  if (timeout) {
    const ms = parseDuration(timeout);
    if (ms !== null) return new Date(base + ms).toISOString();
    const abs = Date.parse(timeout);
    if (!Number.isNaN(abs) && /\d{4}-\d{2}-\d{2}/.test(timeout)) return new Date(abs).toISOString();
  }
  return new Date(base + fallbackMs).toISOString();
}
