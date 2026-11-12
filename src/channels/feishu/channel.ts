// 飞书通道：靠官方 lark-cli 的长连接收消息和卡片点击，不需要公网地址。
// 实测（2026-11-11）：im.message.receive_v1 已能经长连接收到；card.action.trigger 需在开发者后台的
// “事件与回调 → 回调配置”里订阅一次，否则收不到。
// 同一个飞书应用只能有一个卡片监听方，所以只在这台 Mac mini 上跑。
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderCard, renderAnswered, parseButtonName, parseRevokeName, renderRulings, SCOPES } from "./cards.ts";
import { route, HELP } from "./commands.ts";
import { showStatus, splitCards, type Overview } from "../format.ts";
import { localDate } from "../../sources/timer.ts";
import { retryConn } from "../../shared/retry.ts";
import type { Card, Ruling, RulingScope } from "../../kernel/types.ts";

const execFileP = promisify(execFile);

// ---- 两头的接口：内核（本机 HTTP）和飞书（lark-cli）。测试时换成假的。----
export interface KernelPort {
  emit(type: string, source_id: string, payload: Record<string, unknown>, about?: string): Promise<{ seq: number | null; duplicate: boolean; refs: string[] }>;
  get<T>(path: string): Promise<T>;
}

// 连不上内核时的重试间隔，合计约 5 分钟（P1-25）：lark-cli 不会重投已经交出来的消息和点击，
// 所以内核重启那几秒里到的消息，只能靠通道自己等内核回来；来源编号不变，内核去重。
export const KERNEL_RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000];

// 本机内核接口上的 KernelPort。来源固定为 feishu，来源编号由调用方给（飞书的 message_id、event_id），重投时内核去重。
// 事件时间取人发消息那一刻（第一次尝试时），不随重试后移。
export function httpKernelPort(base: string, retryMs: number[] = KERNEL_RETRY_MS): KernelPort {
  return {
    emit: async (type, source_id, payload, about) => {
      const body = JSON.stringify({ source: "feishu", source_id, type, at: new Date().toISOString(), about, payload });
      return retryConn(async () => {
        const res = await fetch(`${base}/events`, { method: "POST", headers: { "content-type": "application/json" }, body });
        if (!res.ok) throw new Error(`POST /events → ${res.status}`);
        return res.json() as Promise<{ seq: number | null; duplicate: boolean; refs: string[] }>;
      }, retryMs);
    },
    get: async <T>(path: string) => retryConn(async () => {
      const res = await fetch(base + path);
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
      return res.json() as Promise<T>;
    }, retryMs),
  };
}

export interface Lark {
  sendCard(card: Record<string, unknown>, idempotencyKey?: string): Promise<string>;   // 返回 message_id
  sendText(text: string, idempotencyKey?: string): Promise<void>;
  updateCard(token: string, card: Record<string, unknown>): Promise<void>;
  patchCard(messageId: string, card: Record<string, unknown>): Promise<void>;   // 不靠点击、按消息编号主动改卡（P1-27）
}

// 飞书的幂等键最长 50 个字符：长连接重投同一条消息时不会重复回复。
const idem = (...parts: string[]) => parts.join("-").slice(-50);

export class LarkCli implements Lark {
  private readonly owner: string;
  private readonly cli: string;
  private readonly recordDir: string | undefined;
  constructor(owner: string, opts: { cli?: string; recordDir?: string | undefined } = {}) {
    this.owner = owner; this.cli = opts.cli ?? "lark-cli"; this.recordDir = opts.recordDir;
  }

  // 一个 EventKey 一个 consume 进程。断线由 lark-cli 自己重连；进程退出就再拉起。设了 recordDir 就把原始事件存下来作录制件。
  listen(eventKey: "im.message.receive_v1" | "card.action.trigger", onLine: (line: string) => Promise<void>): void {
    const child = spawn(this.cli, ["event", "consume", eventKey, "--as", "bot"], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (this.recordDir) { mkdirSync(this.recordDir, { recursive: true }); appendFileSync(join(this.recordDir, `feishu-${eventKey}.ndjson`), line + "\n"); }
      onLine(line).catch((e) => console.error("[feishu]", (e as Error).message));
    });
    child.stderr.on("data", (c) => process.stderr.write(`[lark-cli ${eventKey}] ${c}`));
    child.on("close", (code) => { console.error(`[feishu] ${eventKey} 监听退出 ${code}，5 秒后重连`); setTimeout(() => this.listen(eventKey, onLine), 5_000); });
  }

  async sendCard(card: Record<string, unknown>, key?: string): Promise<string> {
    return this.send(["--msg-type", "interactive", "--content", JSON.stringify(card)], key);
  }
  async sendText(text: string, key?: string): Promise<void> { await this.send(["--text", text], key); }

  // token 30 分钟内有效，最多用 2 次；要传完整的新卡片 JSON。
  async updateCard(token: string, card: Record<string, unknown>): Promise<void> {
    await execFileP(this.cli, ["api", "POST", "/open-apis/interactive/v1/card/update", "--as", "bot", "--data", JSON.stringify({ token, card })]);
  }

  // 机器人发的卡片 14 天内可以按 message_id 改，要卡片里 update_multi = true（renderCard 都带了）。
  async patchCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    const { stdout } = await execFileP(this.cli, ["im", "messages", "patch", "--as", "bot", "--message-id", messageId, "--data", JSON.stringify({ content: JSON.stringify(card) })]);
    const r = JSON.parse(stdout || "{}") as { ok?: boolean; code?: number; msg?: string; error?: unknown };
    if (r.ok === false || (typeof r.code === "number" && r.code !== 0)) throw new Error(`改卡片失败：${JSON.stringify(r.error ?? r.msg ?? r)}`);
  }

  private async send(args: string[], key?: string): Promise<string> {
    const { stdout } = await execFileP(this.cli, ["im", "+messages-send", "--as", "bot", "--user-id", this.owner, ...args, ...(key ? ["--idempotency-key", key] : [])]);
    const r = JSON.parse(stdout) as { ok: boolean; data?: { message_id: string }; error?: unknown };
    if (!r.ok || !r.data) throw new Error(`发消息失败：${JSON.stringify(r.error)}`);
    return r.data.message_id;
  }
}

export interface ChannelDeps {
  owner_open_id: string;     // 只认你本人
  kernel: KernelPort;
  lark: Lark;
  log?: (line: string) => void;
}

export class FeishuChannel {
  private readonly deps: ChannelDeps;
  constructor(deps: ChannelDeps) { this.deps = deps; }

  // 长连接送来的一行事件。
  async handle(key: string, line: string): Promise<void> {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line); } catch { return; }
    if (key === "im.message.receive_v1") return this.onMessage(ev);
    if (key === "card.action.trigger") return this.onClick(ev);
  }

  // 发消息就是说目标，交给主理人整理成目标卡（P1-10）；“卡片”“待办”/card 回待处理卡片；/status 看全局。
  private async onMessage(ev: Record<string, unknown>): Promise<void> {
    if (ev.sender_id !== this.deps.owner_open_id) return;        // 其他人的消息不算
    if (ev.chat_type !== "p2p") return;                          // 只在私聊里收发，不进群
    const mid = String(ev.message_id);
    if (ev.message_type !== "text" && ev.message_type !== "post") {
      await this.deps.lark.sendText("现在只认文字消息。发 /help 看用法。", idem("r", mid));
      return;
    }
    const r = route(String(ev.content ?? ""));
    switch (r.kind) {
      case "goal": {
        // 来源编号用飞书的 message_id，长连接重投时内核会去重，也不会重复回复。目标卡或主理人的答复由 pushPending 推来。
        const res = await this.deps.kernel.emit("human.message", `msg:${mid}`, { text: r.title, message_id: mid, via: "feishu" });
        if (res.duplicate) return;
        const goal = res.refs.find((x) => x.startsWith("G-")) ?? "";
        await this.deps.lark.sendText(`收到（${goal}）。主理人整理好目标卡就发给你确认；小而明确的会直接立项。`, idem("r", mid));
        return;
      }
      case "brief": {
        // 手动要一份简报：和每天定时的一样，汇总后收起知会卡；简报卡随即推来。
        const res = await this.deps.kernel.emit("brief.due", `brief:${mid}`, { date: localDate(new Date()), manual: true });
        if (!res.duplicate) await this.pushPending();
        return;
      }
      case "stop": {
        const res = await this.deps.kernel.emit("human.stop", `msg:${mid}`, { about: r.about, via: "feishu" }, r.about);
        if (res.duplicate) return;
        const t = await this.deps.kernel.get<{ state: string }>(`/tasks/${encodeURIComponent(r.about)}`).catch(() => null);
        await this.deps.lark.sendText(t ? `已叫停 ${r.about}（现在 ${t.state}）。` : `没有 ${r.about} 这个任务。`, idem("r", mid));
        return;
      }
      case "cards": return this.sendPending(mid);
      case "rulings": {
        // 定论簿（P2-07）：生效中的定论一张卡，每条一个“作废”按钮。
        const rs = await this.deps.kernel.get<Ruling[]>("/rulings");
        if (!rs.length) { await this.deps.lark.sendText("没有生效中的定论。你在卡片上回答时选了“这个目标”“这个项目”“以后都这样”，或写了说明，就会记成定论。", idem("r", mid)); return; }
        await this.deps.lark.sendCard(renderRulings(rs), idem("r", mid));
        return;
      }
      case "status": {
        const o = await this.deps.kernel.get<Overview>("/overview");
        await this.deps.lark.sendText(showStatus(o, { cardsHint: "发 /card 查看", doneLimit: 3 }), idem("r", mid));
        return;
      }
      case "unknown": await this.deps.lark.sendText(`不认识的命令 ${r.command}。\n\n${HELP}`, idem("r", mid)); return;
      case "help": await this.deps.lark.sendText(HELP, idem("r", mid)); return;
    }
  }

  // 把要你处理的卡片（决策、审核）逐张发来，可以直接在卡片上回答；知会卡只列标题。
  private async sendPending(mid: string): Promise<void> {
    const { need, fyi } = splitCards(await this.deps.kernel.get<Card[]>("/cards"));
    for (const c of need) await this.deliver(c, idem("c", mid, c.id));
    const lines = [need.length ? `以上 ${need.length} 张卡片待你处理。` : "没有要你处理的卡片。"];
    if (fyi.length) lines.push(`知会 ${fyi.length} 条（不需要动作）：\n${fyi.map((c) => `· ${c.id} ${c.title}`).join("\n")}`);
    await this.deps.lark.sendText(lines.join("\n"), idem("r", mid));
  }

  // 补发：内核标了要推送的卡片（决策卡、目标卡、超预算卡、简报、主理人的答复）还没送达的推给你；
  // 审核卡和知会卡不推，随简报汇总，或发 /card 时再给。
  async pushPending(): Promise<void> {
    for (const c of await this.deps.kernel.get<Card[]>("/cards")) {
      if (!c.push || c.external_ref) continue;
      await this.deliver(c, idem("push", c.id));
    }
  }

  // 账本里已经撤回、收起，或在 xj 里回答了的卡片，飞书上还显示着按钮：主动改成现状（P1-27）。
  // 每张卡的每个状态只改一次，改没改成都报回内核（来源编号带状态，重复报内核去重）；改不成（超过 14 天等）记下，不反复重试。
  async refreshClosed(): Promise<void> {
    for (const c of await this.deps.kernel.get<Card[]>("/cards/stale")) {
      if (!c.external_ref) continue;
      let error: string | undefined;
      await this.deps.lark.patchCard(c.external_ref, renderAnswered(c)).catch((e) => { error = (e as Error).message.slice(0, 200); });
      if (error) this.log(`改 ${c.id} 失败：${error}`);
      await this.deps.kernel.emit("card.refreshed", `refreshed:${c.id}:${c.status}`, { card_id: c.id, status: c.status, ok: !error, ...(error ? { error } : {}) }, c.id);
    }
  }

  private async deliver(card: Card, key: string): Promise<void> {
    const messageId = await this.deps.lark.sendCard(renderCard(card), key);
    await this.deps.kernel.emit("card.delivered", `delivered:${messageId}`, { card_id: card.id, external_ref: messageId }, card.id);
  }

  // 点卡片：回答是一条事件；然后把卡片原地改成账本里记下的结论（重复点、过期点都显示已有的结论）。
  private async onClick(ev: Record<string, unknown>): Promise<void> {
    const revoke = parseRevokeClick(ev, this.deps.owner_open_id);
    if (revoke) return this.onRevoke(revoke);
    const click = parseCardClick(ev, this.deps.owner_open_id);
    if (!click) return;
    const card = await this.deps.kernel.get<Card>(`/cards/${encodeURIComponent(click.card_id)}`).catch(() => null);
    if (!card) return;
    const option = click.option_index !== undefined ? card.options[click.option_index] : card.options.find((o) => o.key === click.choice);
    const choice = option?.key ?? click.choice;
    const text = click.text?.trim() || undefined;
    if (card.status === "open") {
      if (!text && (!choice || option?.needs_text)) {
        await this.deps.lark.sendText(`${card.id}：点“${option?.label ?? "用上面这句话回答"}”之前，要先在文字框里写一句话。`, idem("e", click.event_id));
        return;
      }
      await this.deps.kernel.emit("card.answered", `click:${click.event_id}`,
        { card_id: card.id, choice, text, scope: card.kind === "decision" ? click.scope : undefined, via: "feishu" }, card.id);
    }
    const after = await this.deps.kernel.get<Card>(`/cards/${encodeURIComponent(card.id)}`);
    if (click.token) {
      const ok = await this.deps.lark.updateCard(click.token, after.status === "open" ? renderCard(after) : renderAnswered(after))
        .then(() => true, (e) => { this.log(`原地更新 ${card.id} 失败：${(e as Error).message}`); return false; });
      // 点击时已经原地改好了，告诉内核，免得补改时再改一遍。
      if (ok && after.status !== "open") {
        await this.deps.kernel.emit("card.refreshed", `refreshed:${after.id}:${after.status}`, { card_id: after.id, status: after.status, ok: true, via: "click" }, after.id);
      }
    }
  }

  // 定论簿卡上点“作废”（P2-07）：落一条 ruling.revoked（重复点内核去重、已作废的不再动），再把卡改成剩下的。
  private async onRevoke(c: { event_id: string; token: string; ruling_id: string }): Promise<void> {
    await this.deps.kernel.emit("ruling.revoked", `click:${c.event_id}`, { ruling_id: c.ruling_id, via: "feishu" }, c.ruling_id);
    if (!c.token) return;
    const rs = await this.deps.kernel.get<Ruling[]>("/rulings");
    await this.deps.lark.updateCard(c.token, renderRulings(rs, `已作废 ${c.ruling_id}，以后不再注入。`))
      .catch((e) => this.log(`原地更新定论簿失败：${(e as Error).message}`));
  }

  private log(line: string) { (this.deps.log ?? ((s: string) => console.error(`[feishu] ${s}`)))(line); }
}

export function parseRevokeClick(ev: Record<string, unknown>, owner: string): { event_id: string; token: string; ruling_id: string } | null {
  if (ev.operator_id !== owner || ev.action_tag !== "button") return null;
  const id = parseRevokeName(String(ev.action_name ?? ""));
  return id ? { event_id: String(ev.event_id), token: String(ev.token ?? ""), ruling_id: id } : null;
}

function safeJson(s: unknown): unknown { try { return typeof s === "string" && s ? JSON.parse(s) : {}; } catch { return {}; } }

export interface CardClick {
  event_id: string; card_id: string; token: string; message_id: string;
  choice?: string | undefined;          // 旧式回调按钮直接带选项
  option_index?: number | undefined;    // 表单按钮带选项序号，由通道对照账本里的卡片换成选项
  text?: string | undefined;            // 文字框
  scope?: RulingScope | undefined;      // 适用范围
}

// 从 card.action.trigger 事件里取回答。实测（2026-11-11）：action_value 是 JSON 字符串，operator_id 是点击者 open_id。
// 表单按钮（lark-cli 文档）：action_tag 仍是 button，action_name 是按钮名，form_value 是按组件名取值的 JSON 字符串。
export function parseCardClick(ev: Record<string, unknown>, owner: string): CardClick | null {
  if (ev.operator_id !== owner) return null;                   // 只认你本人
  if (ev.action_tag !== "button") return null;
  const base = { event_id: String(ev.event_id), token: String(ev.token ?? ""), message_id: String(ev.message_id) };
  const named = parseButtonName(String(ev.action_name ?? ""));
  if (named) {
    const form = safeJson(ev.form_value) as { text?: unknown; scope?: unknown };
    const scope = SCOPES.find((s) => s.value === form.scope)?.value;
    return { ...base, ...named, text: typeof form.text === "string" ? form.text : undefined, scope };
  }
  const value = safeJson(ev.action_value) as { card_id?: string; choice?: string };
  if (!value.card_id || !value.choice) return null;
  return { ...base, card_id: value.card_id, choice: value.choice };
}
