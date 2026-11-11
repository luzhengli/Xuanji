// 内核进程入口。由 launchd 拉起（P1-16）；重启后从账本重建状态（P1-14）。
import { loadConfig } from "../shared/config.ts";
import { Kernel } from "./kernel.ts";
import { startApi } from "./api.ts";
import { startTimerSource } from "../sources/timer.ts";

const cfg = loadConfig();
const kernel = new Kernel(cfg);
const n = kernel.rebuild();
// 重启也是一条事件（P1-14）。时间由进程入口取，内核类本身仍不读时钟。
const bootAt = new Date().toISOString();
kernel.ingest({ source: "kernel", source_id: `restarted-${bootAt}`, type: "kernel.restarted", at: bootAt, payload: {} });
startApi(kernel, cfg.port);
// 定时器来源与内核同进程起，但它和别的来源一样经本机接口注入 timer.tick；内核本身仍不读时钟。
startTimerSource(`http://127.0.0.1:${cfg.port}`, Number(process.env.XJ_TICK_MS ?? 60_000), cfg.brief_at);
console.log(`[kernel] 账本 ${cfg.db}，重放 ${n} 条事件，监听 127.0.0.1:${cfg.port}，每日简报 ${cfg.brief_at}`);
