// 命令行 xj：同一组接口上的第二个客户端。看全局、排查、飞书不可用时照常答卡片。
import { loadConfig } from "../../shared/config.ts";

const cfg = loadConfig();
const base = `http://127.0.0.1:${cfg.port}`;
const [cmd = "status", ...rest] = process.argv.slice(2);

const get = async (p: string) => (await fetch(base + p)).json();
const emit = async (type: string, payload: Record<string, unknown>, about?: string) =>
  (await fetch(`${base}/events`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "cli", source_id: `${process.pid}-${Date.now()}`, type, at: new Date().toISOString(), about, payload }) })).json();

const USAGE = `用法：
  xj goal "<一句话目标>"        说目标（一期：直接立项；主理人确认见 P1-10）
  xj status                     目标、任务按“在等谁”分组，卡片队列，额度读数
  xj cards                      待处理卡片
  xj answer <C-x> <选项> [说明] [--scope task|goal|project|global]
  xj stop <T-x>                 停一个任务
  xj why <编号>                 事件时间线
  xj recall <编号>              链式召回（P2）`;

switch (cmd) {
  case "goal": console.log(await emit("goal.confirmed", { title: rest.join(" ") })); break;
  case "status": console.log(JSON.stringify(await get("/overview"), null, 2)); break;
  case "cards": console.log(JSON.stringify(await get("/cards"), null, 2)); break;
  case "answer": {
    const [card, choice, ...note] = rest;
    const si = note.indexOf("--scope");
    const scope = si >= 0 ? note.splice(si, 2)[1] : undefined;
    console.log(await emit("card.answered", { card_id: card, choice, text: note.join(" ") || undefined, scope }, card)); break;
  }
  case "stop": console.log(await emit("human.stop", { about: rest[0] }, rest[0])); break;
  case "why": console.log(JSON.stringify(await get(`/why/${encodeURIComponent(rest[0] ?? "")}`), null, 2)); break;
  case "recall": console.log(await get(`/recall/${encodeURIComponent(rest[0] ?? "")}`)); break;
  default: console.log(USAGE);
}
