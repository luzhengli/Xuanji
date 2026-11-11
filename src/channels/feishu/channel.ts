// 飞书通道：靠官方 lark-cli 的长连接收消息和卡片点击，不需要公网地址。
// 实测（2026-11-11）：im.message.receive_v1 已能经长连接收到；card.action.trigger 需在开发者后台的
// “事件与回调 → 回调配置”里订阅一次，否则 lark-cli 直接报 failed_precondition。
// 同一个飞书应用只能有一个卡片监听方，所以只在这台 Mac mini 上跑。
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { renderCard, renderAnswered } from "./cards.ts";
import type { Card } from "../../kernel/types.ts";

const execFileP = promisify(execFile);

export interface ChannelDeps {
  owner_open_id: string;                                      // 只认你本人
  emit(type: string, source_id: string, payload: Record<string, unknown>, about?: string): Promise<void>;
  openCards(): Promise<Card[]>;
}

export class FeishuChannel {
  private readonly deps: ChannelDeps;
  private readonly cli: string;
  constructor(deps: ChannelDeps, cli = "lark-cli") { this.deps = deps; this.cli = cli; }

  // 一个 EventKey 一个 consume 进程。断线由 lark-cli 自己重连；进程退出就再拉起。
  listen(eventKey: "im.message.receive_v1" | "card.action.trigger"): void {
    const child = spawn(this.cli, ["event", "consume", eventKey, "--as", "bot"], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: child.stdout }).on("line", (line) => this.onEvent(eventKey, line).catch((e) => console.error("[feishu]", e)));
    child.stderr.on("data", (c) => process.stderr.write(`[lark-cli ${eventKey}] ${c}`));
    child.on("close", (code) => { console.error(`[feishu] ${eventKey} 监听退出 ${code}，5 秒后重连`); setTimeout(() => this.listen(eventKey), 5_000); });
  }

  private async onEvent(key: string, line: string): Promise<void> {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line); } catch { return; }
    const who = (ev.operator_id ?? ev.sender_id) as string | undefined;
    if (who !== this.deps.owner_open_id) return;                 // 其他人的消息和点击都不算
    if (key === "im.message.receive_v1") {
      if (ev.chat_type !== "p2p") return;                         // 只在私聊里收发，不进群
      await this.deps.emit("human.message", `msg:${ev.message_id}`, { text: ev.content, message_id: ev.message_id });
      // TODO P1-10：主理人把一句话整理成目标卡请人确认；小而明确的请求直接 goal.confirmed。
    } else if (key === "card.action.trigger") {
      const click = parseCardClick(ev, this.deps.owner_open_id);
      if (!click) return;
      await this.deps.emit("card.answered", `click:${click.event_id}`, { card_id: click.card_id, choice: click.choice, token: click.token }, click.card_id);
      // 回答后卡片原地改成结论（实测 S1 验证了 token 更新接口）。TODO P1-11：从账本取卡片正文，而不是只传编号。
      await this.updateInPlace(click.token, { id: click.card_id, title: click.card_id, body: "", kind: "decision", about: "", options: [], dedupe_key: "", status: "answered", answer: null, external_ref: null, created_at: "", updated_at: "" }, click.choice).catch((e) => console.error("[feishu] 原地更新失败", (e as Error).message));
    }
  }

  // token 30 分钟内有效，最多用 2 次；要传完整的新卡片 JSON。
  async updateInPlace(token: string, card: Card, choice: string): Promise<void> {
    await execFileP(this.cli, ["api", "POST", "/open-apis/interactive/v1/card/update", "--as", "bot",
      "--data", JSON.stringify({ token, card: renderAnswered(card, choice) })]);
  }

  // 发卡片：返回 message_id，内核记为 card.delivered。飞书不可用时卡片留在账本里，连上后补发。
  async send(card: Card): Promise<string> {
    const { stdout } = await execFileP(this.cli, ["im", "+messages-send", "--as", "bot", "--user-id", this.deps.owner_open_id,
      "--msg-type", "interactive", "--content", JSON.stringify(renderCard(card))]);
    const r = JSON.parse(stdout) as { ok: boolean; data?: { message_id: string }; error?: unknown };
    if (!r.ok || !r.data) throw new Error(`发卡片失败：${JSON.stringify(r.error)}`);
    return r.data.message_id;
  }
}

function safeJson(s: string | undefined): unknown { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }

export interface CardClick { event_id: string; card_id: string; choice: string; token: string; message_id: string; }

// 从 card.action.trigger 事件里取回答。实测（2026-11-11）：action_value 是 JSON 字符串，operator_id 是点击者 open_id。
export function parseCardClick(ev: Record<string, unknown>, owner: string): CardClick | null {
  if (ev.operator_id !== owner) return null;                   // 只认你本人
  if (ev.action_tag !== "button") return null;                 // TODO P1-11：form 提交（文字框）走 form_value
  const value = safeJson(ev.action_value as string) as { card_id?: string; choice?: string };
  if (!value.card_id || !value.choice) return null;
  return { event_id: String(ev.event_id), card_id: value.card_id, choice: value.choice, token: String(ev.token), message_id: String(ev.message_id) };
}
