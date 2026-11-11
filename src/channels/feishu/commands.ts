// 私聊里一句话怎么处理。人定（2026-11-12）：一期直接立项（主理人确认见 P1-10）；发“卡片”“待办”或 /card 回待处理卡片。
export type Route =
  | { kind: "goal"; title: string }
  | { kind: "cards" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "unknown"; command: string };

// 斜杠命令看第一个词；中文关键词要整条消息完全一致，免得“卡片样式改成蓝色”这种目标被当成命令。
const SLASH: Record<string, Route["kind"]> = {
  "/card": "cards", "/cards": "cards", "/todo": "cards",
  "/status": "status",
  "/help": "help", "/?": "help",
  "/goal": "goal",
};
const WORDS: Record<string, Route["kind"]> = { "卡片": "cards", "待办": "cards", "状态": "status", "进度": "status", "帮助": "help" };

export const HELP = `直接说一句话就立项（一期不经确认），例如：在 math.mjs 加一个 div 函数。
命令：
/card 或 卡片、待办：发来待处理的卡片，可以直接在卡片上回答
/status 或 状态、进度：目标、任务在等谁、额度
/goal <一句话>：立项（以 / 开头的目标用它）
/help 或 帮助：本说明`;

export function route(raw: string): Route {
  // 中文输入法下“/”常打成全角“／”
  const text = raw.trim().replace(/^／/, "/");
  if (!text) return { kind: "help" };
  if (WORDS[text.replace(/[。！!？?]$/, "")]) return { kind: WORDS[text.replace(/[。！!？?]$/, "")]! } as Route;
  if (text.startsWith("/")) {
    const [head = "", ...rest] = text.split(/\s+/);
    const kind = SLASH[head.toLowerCase()];
    if (!kind) return { kind: "unknown", command: head };
    if (kind === "goal") return rest.length ? { kind: "goal", title: rest.join(" ") } : { kind: "help" };
    return { kind } as Route;
  }
  return { kind: "goal", title: text };
}
