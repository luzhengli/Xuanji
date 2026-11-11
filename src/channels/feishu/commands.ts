// 私聊里一句话怎么处理。不是命令的话交给主理人整理成目标卡（P1-10）；发“卡片”“待办”或 /card 回待处理卡片（人定 2026-11-12）。
export type Route =
  | { kind: "goal"; title: string }
  | { kind: "cards" }
  | { kind: "status" }
  | { kind: "brief" }
  | { kind: "stop"; about: string }
  | { kind: "help" }
  | { kind: "unknown"; command: string };

// 斜杠命令看第一个词；中文关键词要整条消息完全一致，免得“卡片样式改成蓝色”这种目标被当成命令。
const SLASH: Record<string, Route["kind"]> = {
  "/card": "cards", "/cards": "cards", "/todo": "cards",
  "/status": "status",
  "/brief": "brief",
  "/stop": "stop",
  "/help": "help", "/?": "help",
  "/goal": "goal",
};
const WORDS: Record<string, Route["kind"]> = { "卡片": "cards", "待办": "cards", "状态": "status", "进度": "status", "简报": "brief", "帮助": "help" };

export const HELP = `直接说一句话就是说目标，例如：在 math.mjs 加一个 div 函数。主理人整理成目标卡发给你确认；小而明确的直接立项。
命令：
/card 或 卡片、待办：发来待处理的卡片，可以直接在卡片上回答
/status 或 状态、进度：目标、任务在等谁、额度
/brief 或 简报：现在就出一份简报（每天 9 点会自动发）
/stop T-x：停一个任务
/goal <一句话>：说目标（以 / 开头的目标用它）
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
    if (kind === "stop") return /^T-\d+$/i.test(rest[0] ?? "") ? { kind: "stop", about: rest[0]!.toUpperCase() } : { kind: "help" };
    return { kind } as Route;
  }
  return { kind: "goal", title: text };
}
