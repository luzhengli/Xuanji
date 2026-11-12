// 内核进程入口。由 launchd 拉起（P1-16）；重启后从账本重建状态（P1-14）。
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../shared/config.ts";
import { Kernel } from "./kernel.ts";
import { startApi } from "./api.ts";
import { startTimerSource } from "../sources/timer.ts";
import { startBackupSource } from "../ops/backup.ts";
import { startLogRotation } from "../ops/logs.ts";

const cfg = loadConfig();
const kernel = new Kernel(cfg);
const n = kernel.rebuild();
// 重启也是一条事件（P1-14）。时间由进程入口取，内核类本身仍不读时钟。
const bootAt = new Date().toISOString();
kernel.ingest({ source: "kernel", source_id: `restarted-${bootAt}`, type: "kernel.restarted", at: bootAt, payload: {} });
startApi(kernel, cfg.port);
// 定时器来源与内核同进程起，但它和别的来源一样经本机接口注入 timer.tick；内核本身仍不读时钟。
startTimerSource(`http://127.0.0.1:${cfg.port}`, Number(process.env.XJ_TICK_MS ?? 60_000), cfg.brief_at);
// 备份来源（P1-15）同样在内核进程里起、经本机接口报结果。XJ_BACKUP_MS=0 关掉（测试或临时账本用）。
const backupMs = Number(process.env.XJ_BACKUP_MS ?? 3_600_000);
if (backupMs > 0) startBackupSource(`http://127.0.0.1:${cfg.port}`, cfg, backupMs);
// 日志轮转（P1-26）：三个服务的日志都在账本旁边的 logs/ 里（launchd 的 plist 这样写）。
startLogRotation(join(dirname(resolve(cfg.db)), "logs"));
console.log(`[kernel] 账本 ${cfg.db}，重放 ${n} 条事件，监听 127.0.0.1:${cfg.port}，每日简报 ${cfg.brief_at}，备份到 ${cfg.backup_dir}${backupMs > 0 ? `（每 ${Math.round(backupMs / 60_000)} 分钟）` : "（已关）"}`);
