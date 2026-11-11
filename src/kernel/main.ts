// 内核进程入口。由 launchd 拉起（P1-16）；重启后从账本重建状态（P1-14）。
import { loadConfig } from "../shared/config.ts";
import { Kernel } from "./kernel.ts";
import { startApi } from "./api.ts";

const cfg = loadConfig();
const kernel = new Kernel(cfg);
const n = kernel.rebuild();
startApi(kernel, cfg.port);
console.log(`[kernel] 账本 ${cfg.db}，重放 ${n} 条事件，监听 127.0.0.1:${cfg.port}`);
// TODO P1-14: 启动时注入一条 kernel.restarted 事件，让执行中但进程已不在的轮次带恢复说明重新派发。
