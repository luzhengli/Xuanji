// 命令行 xj：同一组接口上的第二个客户端。看全局、排查、飞书不可用时照常答卡片。
import { loadConfig } from "../../shared/config.ts";
import type { Card, Event } from "../../kernel/types.ts";
import { showCard, showStatus, type Overview } from "../format.ts";

const cfg = loadConfig();
const base = `http://127.0.0.1:${cfg.port}`;
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const [cmd = "status", ...rest] = argv.filter((a) => a !== "--json");

const get = async (p: string): Promise<any> => (await fetch(base + p)).json();
type Emitted = { seq: number | null; duplicate: boolean; refs: string[] };
const emit = async (type: string, payload: Record<string, unknown>, about?: string): Promise<Emitted> =>
  (await fetch(`${base}/events`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "cli", source_id: `${process.pid}-${Date.now()}`, type, at: new Date().toISOString(), about, payload }) })).json() as Promise<Emitted>;

const USAGE = `用法：
  xj goal "<一句话目标>"        说目标（一期：直接立项；主理人确认见 P1-10）
  xj status                     目标、任务按“在等谁”分组，卡片队列，额度读数
  xj cards                      待处理卡片
  xj answer <C-x> <选项> [说明] [--scope task|goal|project|global]
  xj stop <T-x>                 停一个任务
  xj why <编号>                 事件时间线
  xj recall <编号>              链式召回（P2）
  加 --json 输出原始数据`;

function showEvent(e: Event): string {
  const p = e.payload as Record<string, unknown>;
  let what = "";
  switch (e.type) {
    case "goal.confirmed": what = String(p.title); break;
    case "run.claimed": what = `${p.task_id} 由 ${p.agent} 执行`; break;
    case "run.receipt": {
      const r = p.receipt as { outcome: string; summary: string };
      what = `${p.run_id} ${r.outcome}：${r.summary}${p.session_id ? `（会话 ${p.session_id}）` : ""}`; break;
    }
    case "run.heartbeat": what = String(p.run_id); break;
    case "card.answered": what = `${p.card_id} → ${p.choice ?? ""}${p.text ? `：${p.text}` : ""}`; break;
    case "human.stop": what = String(p.about); break;
    case "kernel.restarted": what = "内核重启"; break;
    case "worker.started": what = `接单程序 ${p.worker} 启动`; break;
    case "timer.tick": what = ""; break;
    case "timer.resumed": what = `时间跳了 ${Math.round(Number(p.gap_ms) / 60_000)} 分钟`; break;
    default: what = JSON.stringify(p).slice(0, 120);
  }
  return `#${e.seq}  ${e.at}  ${e.source.padEnd(6)} ${e.type.padEnd(16)} ${what}${e.note ? `${what ? "  " : ""}→ ${e.note}` : ""}`;
}

const print = (data: unknown, human: () => string) => console.log(asJson ? JSON.stringify(data, null, 2) : human());

switch (cmd) {
  case "goal": { const r = await emit("goal.confirmed", { title: rest.join(" ") }); print(r, () => `已立项 ${r.refs.join(" · ")}（事件 #${r.seq}），xj status 查看`); break; }
  case "status": { const o = await get("/overview") as Overview; print(o, () => showStatus(o, { cardsHint: "xj cards" })); break; }
  case "cards": { const c = await get("/cards") as Card[]; print(c, () => c.map(showCard).join("\n\n") || "没有待处理的卡片"); break; }
  case "answer": {
    const [card, choice, ...note] = rest;
    const si = note.indexOf("--scope");
    const scope = si >= 0 ? note.splice(si, 2)[1] : undefined;
    const r = await emit("card.answered", { card_id: card, choice, text: note.join(" ") || undefined, scope }, card);
    print(r, () => (r.duplicate ? "重复的回答，已忽略" : `已回答 ${card} → ${choice}（事件 #${r.seq}）`)); break;
  }
  case "stop": { const r = await emit("human.stop", { about: rest[0] }, rest[0]); print(r, () => `已叫停 ${rest[0]}（事件 #${r.seq}）`); break; }
  case "why": { const ev = await get(`/why/${encodeURIComponent(rest[0] ?? "")}`) as Event[]; print(ev, () => ev.map(showEvent).join("\n") || `没有关于 ${rest[0]} 的事件`); break; }
  case "recall": console.log(await get(`/recall/${encodeURIComponent(rest[0] ?? "")}`)); break;
  default: console.log(USAGE);
}
