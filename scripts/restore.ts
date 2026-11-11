// 从快照恢复账本（设计文档“备份与恢复”的第 1 步）。用法：
//   node scripts/restore.ts                列出可用的快照
//   node scripts/restore.ts <快照文件>      换上这份快照
// 只在内核停着时动手。现在的账本连同 -wal、-shm 挪到 data/before-restore-<时间>/，不删除。
// 换好后照常起内核：它从账本重建状态，执行中的轮次由看门狗或接单程序报到判中断，带恢复说明重新派发（第 2 步）。
import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/shared/config.ts";
import { listSnapshots } from "../src/ops/backup.ts";

const cfg = loadConfig();
const arg = process.argv[2];
if (!arg) {
  const files = listSnapshots(cfg.backup_dir);
  console.log(files.length ? files.map((f) => join(cfg.backup_dir, f)).join("\n") : `${cfg.backup_dir} 里没有快照`);
  process.exit(0);
}
const up = await fetch(`http://127.0.0.1:${cfg.port}/health`).then(() => true).catch(() => false);
if (up) { console.error(`内核还在跑（127.0.0.1:${cfg.port}），先停内核再恢复。`); process.exit(1); }
const snap = resolve(arg);
const check = new DatabaseSync(snap, { readOnly: true });
const integrity = (check.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
const events = (check.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
check.close();
if (integrity !== "ok") { console.error(`快照完整性检查没过：${integrity}`); process.exit(1); }

const db = resolve(cfg.db);
const aside = join(dirname(db), `before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(aside, { recursive: true });
for (const f of [db, `${db}-wal`, `${db}-shm`]) if (existsSync(f)) renameSync(f, join(aside, basename(f)));
copyFileSync(snap, db);
console.log(`已换上 ${snap}（${events} 条事件）。原账本挪到 ${aside}。
接下来：重新签发密钥（如需要），然后起内核（launchd 装好时它会自己拉起）。`);
