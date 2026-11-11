// 飞书通道进程入口。只认你本人；只在私聊里收发。
import { loadConfig } from "../../shared/config.ts";
import { FeishuChannel } from "./channel.ts";
import { kernelClient } from "../../worker/http-client.ts";
import type { Card } from "../../kernel/types.ts";

const cfg = loadConfig();
if (!cfg.owner_open_id) throw new Error("配置里缺 owner_open_id");
const base = `http://127.0.0.1:${cfg.port}`;
const client = kernelClient(base, "feishu");

const channel = new FeishuChannel({
  owner_open_id: cfg.owner_open_id,
  emit: async (type, source_id, payload, about) => {
    await fetch(`${base}/events`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "feishu", source_id, type, at: new Date().toISOString(), about, payload }) });
  },
  openCards: () => client.get<Card[]>("/cards"),
});
channel.listen("im.message.receive_v1");
channel.listen("card.action.trigger");

// 补发：把账本里还没送达的卡片发出去。只推阻塞性的决策卡；审核卡和知会卡随简报（P1-17）。
setInterval(async () => {
  for (const card of await client.get<Card[]>("/cards")) {
    if (card.external_ref || card.kind !== "decision") continue;
    try {
      const mid = await channel.send(card);
      await client.emit("card.delivered", { card_id: card.id, external_ref: mid }, card.id);
    } catch (e) { console.error("[feishu]", (e as Error).message); }
  }
}, 10_000);
