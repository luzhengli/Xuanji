// P1-15 备份：每小时用 SQLite 在线备份生成一致快照，保留 48 份；失败出异常卡；每周演练恢复。
// 不直接拷贝正在写的数据库文件。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/shared/config.ts";

const cfg = loadConfig();
mkdirSync(cfg.backup_dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = join(cfg.backup_dir, `xuanji-${stamp}.db`);
const src = new DatabaseSync(cfg.db);
// Node 24 的 node:sqlite 提供 backup()；它用 SQLite 在线备份接口，拿到的是一致状态。
await (await import("node:sqlite")).backup(src, dest);
src.close();
const keep = 48;
const files = readdirSync(cfg.backup_dir).filter((f) => f.startsWith("xuanji-")).sort();
for (const f of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(join(cfg.backup_dir, f));
console.log(`[backup] ${dest}`);
// TODO P1-15：把最近一次成功时间写进账本（xj status 显示）；超阈值出异常卡；每周把最新快照恢复到临时目录并 rebuild 比对。
