// 命令行 xj：同一组接口上的第二个客户端。看全局、排查、飞书不可用时照常答卡片。
import { loadConfig } from "../../shared/config.ts";
import type { Card, Event } from "../../kernel/types.ts";
import { showCard, showStatus, foldHeartbeats, type Overview } from "../format.ts";
import { localDate } from "../../sources/timer.ts";

const cfg = loadConfig();
const base = `http://127.0.0.1:${cfg.port}`;
const argv = process.argv.slice(2);
const FLAGS = ["--json", "--all", "--direct"];
const asJson = argv.includes("--json");
const showAll = argv.includes("--all");
const direct = argv.includes("--direct");
const [cmd = "status", ...rest] = argv.filter((a) => !FLAGS.includes(a));

const get = async (p: string): Promise<any> => (await fetch(base + p)).json();
type Emitted = { seq: number | null; duplicate: boolean; refs: string[] };
const emit = async (type: string, payload: Record<string, unknown>, about?: string): Promise<Emitted> =>
  (await fetch(`${base}/events`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "cli", source_id: `${process.pid}-${Date.now()}`, type, at: new Date().toISOString(), about, payload }) })).json() as Promise<Emitted>;

const USAGE = `用法：
  xj goal "<一句话目标>"        说目标：主理人整理成目标卡请你确认（xj cards 看，xj answer 答）
  xj goal --direct "<一句话>"   跳过主理人直接立项
  xj status                     目标、任务按“在等谁”分组，卡片队列，额度读数
  xj cards                      待处理卡片
  xj answer <C-x> <选项> [说明] [--scope task|goal|project|global]
  xj stop <T-x>                 停一个任务
  xj why <编号> [--all]         事件时间线；连续的心跳默认折成一行，--all 全部列出
  xj brief                      现在出一份简报（汇总后收起知会卡）
  xj recall <编号>              链式召回（P2）
  加 --json 输出原始数据`;

function showEvent(e: Event): string {
  const p = e.payload as Record<string, unknown>;
  let what = "";
  switch (e.type) {
    case "goal.confirmed": what = String(p.title); break;
    case "human.message": what = `“${String(p.text)}”`; break;
    case "judgment.claimed": what = `${p.judgment_id} 由 ${p.agent} 整理`; break;
    case "judgment.result": {
      const o = p.output as { kind?: string; title?: string; reply?: string; direct?: boolean } | undefined;
      what = `${p.judgment_id} ${p.error ? `失败：${p.error}` : o?.kind === "not_goal" ? `不是目标：${o.reply}` : `${o?.direct ? "直接立项" : "目标卡"}：${o?.title}`}`; break;
    }
    case "brief.due": what = `${p.date ?? ""}${p.manual ? "（手动）" : ""}`; break;
    case "run.claimed": what = `${p.task_id} 由 ${p.agent} 执行`; break;
    case "run.receipt": {
      const r = p.receipt as { outcome: string; summary: string };
      what = `${p.run_id} ${r.outcome}：${r.summary}${p.session_id ? `（会话 ${p.session_id}）` : ""}`; break;
    }
    case "run.heartbeat": what = String(p.run_id); break;
    case "card.answered": what = `${p.card_id} → ${p.choice ?? ""}${p.text ? `：${p.text}` : ""}`; break;
    case "human.stop": what = String(p.about); break;
    case "card.delivered": what = `${p.card_id} 已送达`; break;
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
  case "goal": {
    const text = rest.join(" ");
    if (direct) { const r = await emit("goal.confirmed", { title: text }); print(r, () => `已立项 ${r.refs.join(" · ")}（事件 #${r.seq}），xj status 查看`); break; }
    const r = await emit("human.message", { text, via: "cli" });
    print(r, () => `收到 ${r.refs.filter((x) => x.startsWith("G-")).join("")}（事件 #${r.seq}）。主理人整理好目标卡后用 xj cards 查看，xj answer <C-x> confirm|revise|drop 回答`);
    break;
  }
  case "brief": {
    const r = await emit("brief.due", { date: localDate(new Date()), manual: true });
    // 这条事件挂上的编号里还有被收起的知会卡；新简报是唯一还开着的简报卡。
    const card = r.duplicate ? null : (await get("/cards") as Card[]).find((c) => c.form === "brief") ?? null;
    print(card ?? r, () => (card ? showCard(card) : "没出简报"));
    break;
  }
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
  case "why": {
    const ev = await get(`/why/${encodeURIComponent(rest[0] ?? "")}`) as Event[];
    const lines = showAll ? ev.map(showEvent) : foldHeartbeats(ev).map((x) => (x.kind === "event" ? showEvent(x.event)
      : `#${x.first.seq}–#${x.last.seq}  ${x.first.at} – ${x.last.at}  心跳 ${x.count} 次${x.runs.length ? `（${x.runs.join("、")}）` : ""}`));
    print(ev, () => lines.join("\n") || `没有关于 ${rest[0]} 的事件`);
    break;
  }
  case "recall": console.log(await get(`/recall/${encodeURIComponent(rest[0] ?? "")}`)); break;
  default: console.log(USAGE);
}
