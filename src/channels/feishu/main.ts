// 飞书通道进程入口。只认你本人；只在私聊里收发。
// 环境变量：XJ_RECORD_DIR 设了就把收到的原始事件存下来，作测试用的录制件。
import { loadConfig } from "../../shared/config.ts";
import { FeishuChannel, LarkCli, httpKernelPort } from "./channel.ts";

const cfg = loadConfig();
if (!cfg.owner_open_id) throw new Error("配置里缺 owner_open_id");
const base = `http://127.0.0.1:${cfg.port}`;

const kernel = httpKernelPort(base);

const lark = new LarkCli(cfg.owner_open_id, { recordDir: process.env.XJ_RECORD_DIR });
const channel = new FeishuChannel({ owner_open_id: cfg.owner_open_id, kernel, lark });
lark.listen("im.message.receive_v1", (line) => channel.handle("im.message.receive_v1", line));
lark.listen("card.action.trigger", (line) => channel.handle("card.action.trigger", line));
console.log(`[feishu] 只认 ${cfg.owner_open_id}，内核 ${base}`);

// 补发：账本里还没送达的决策卡推给你；已经关闭的卡片在飞书上改成现状（P1-27）。
// 内核停着时一次补发可能在重试里等好几分钟（P1-25），上一次没完就跳过这一轮，免得越积越多。
let pushing = false;
setInterval(() => {
  if (pushing) return;
  pushing = true;
  channel.pushPending().then(() => channel.refreshClosed())
    .catch((e) => console.error("[feishu]", (e as Error).message)).finally(() => { pushing = false; });
}, 10_000);
