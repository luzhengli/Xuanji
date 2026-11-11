// 手动备份一次（P1-15）。平时由内核进程里的备份来源每小时自动做，这个脚本用于手动补一份或强制演练：
//   node scripts/backup.ts           拍一份快照；上次演练通过已超过 7 天就顺带演练
//   node scripts/backup.ts --drill   拍一份快照并强制演练
// 内核在跑就把结果报成事件（xj status 能看到），不在跑只打印。
import { loadConfig } from "../src/shared/config.ts";
import { backupOnce } from "../src/ops/backup.ts";

const cfg = loadConfig();
const base = `http://127.0.0.1:${cfg.port}`;
const status = await fetch(`${base}/backups`).then((r) => r.json() as Promise<{ drill_ok_at: string | null }>).catch(() => null);
const lastDrill = process.argv.includes("--drill") ? null : status?.drill_ok_at ?? null;
let failed = false;
for (const e of await backupOnce(cfg, new Date(), status ? lastDrill : null)) {
  console.log(`${e.type} ${JSON.stringify(e.payload, null, 2)}`);
  if (e.type === "backup.failed" || (e.type === "backup.drilled" && !(e.payload as { ok: boolean }).ok)) failed = true;
  if (status) await fetch(`${base}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e) });
}
if (!status) console.log("（内核没在跑，结果没有入账）");
process.exit(failed ? 1 : 0);
