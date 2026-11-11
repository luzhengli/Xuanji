// P1-15 备份与恢复演练。设计文档“备份与恢复”：
// - 不直接拷贝正在写的数据库文件，快照一律由 SQLite 在线备份生成（node:sqlite 的 backup()）。
// - 每小时一份，先写系统盘上的备份目录，保留 48 份。
// - 备份失败要告诉人：结果作为事件报给内核，内核记最近一次成功的时间，失败或超时出异常卡。
// - 每周演练恢复：把最新快照恢复到临时目录，做完整性检查，再从事件日志重建投影，与快照里的投影比对。
// 它和定时器来源一样是内核进程里的一个来源插件：自己读时钟、做 IO，经本机接口把结果报成事件；内核本身仍是确定性的。
import { backup, DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "../kernel/kernel.ts";
import type { Config } from "../shared/config.ts";
import type { EventInput } from "../kernel/types.ts";

export const KEEP_SNAPSHOTS = 48;
export const DRILL_EVERY_MS = 7 * 86_400_000;
const PREFIX = "xuanji-";

export interface Snapshot { path: string; bytes: number; }

// 拍一份一致的快照，然后只留最新的 keep 份。文件名带 UTC 时间，按名字排序即按时间排序。
export async function snapshot(dbPath: string, dir: string, now: Date, keep = KEEP_SNAPSHOTS): Promise<Snapshot> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${PREFIX}${now.toISOString().replace(/[:.]/g, "-")}.db`);
  const src = new DatabaseSync(dbPath, { readOnly: true });
  try { await backup(src, path); } finally { src.close(); }
  const files = listSnapshots(dir);
  for (const f of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(join(dir, f));
  return { path, bytes: statSync(path).size };
}

export function listSnapshots(dir: string): string[] {
  try { return readdirSync(dir).filter((f) => f.startsWith(PREFIX) && f.endsWith(".db")).sort(); } catch { return []; }
}

// 投影表和比对时要忽略的列。定时器的自增编号在重建时会接着往上涨（sqlite_sequence 不随 DELETE 清零），不算差异。
const PROJECTIONS: Record<string, string[]> = {
  goals: [], tasks: [], runs: [], cards: [], rulings: [], leases: [], subscriptions: [], timers: ["id"],
  event_refs: [], judgments: [], quota: [], counters: [],
};

export interface DrillResult { ok: boolean; snapshot: string; events: number; integrity: string; mismatches: string[]; }

// 恢复演练：在副本上做，不碰快照本身，也不碰正在用的账本。
export function drill(snapshotPath: string, cfg: Config): DrillResult {
  const dir = mkdtempSync(join(tmpdir(), "xj-drill-"));
  const copy = join(dir, "xuanji.db");
  try {
    copyFileSync(snapshotPath, copy);
    const db = new DatabaseSync(copy);
    const integrity = (db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((r) => r.integrity_check).join("; ");
    const before = captureProjections(db);
    db.close();
    if (integrity !== "ok") return { ok: false, snapshot: snapshotPath, events: 0, integrity, mismatches: [] };
    const k = new Kernel(cfg, copy);
    const events = k.rebuild();
    const after = captureProjections(k.db);
    k.close();
    const mismatches = Object.keys(PROJECTIONS).filter((t) => before[t] !== after[t])
      .map((t) => `${t}：快照 ${countRows(before[t]!)} 行，重建 ${countRows(after[t]!)} 行，内容不一致`);
    return { ok: mismatches.length === 0, snapshot: snapshotPath, events, integrity, mismatches };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function captureProjections(db: DatabaseSync): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [table, ignore] of Object.entries(PROJECTIONS)) {
    const rows = (db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[])
      .map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !ignore.includes(k)))))
      .sort();
    out[table] = JSON.stringify(rows);
  }
  return out;
}
const countRows = (json: string) => (JSON.parse(json) as unknown[]).length;

// 一次备份：拍快照；该演练了就拿这份快照演练。返回要报给内核的事件。
export async function backupOnce(cfg: Config, now: Date, lastDrillAt: string | null): Promise<EventInput[]> {
  const at = now.toISOString();
  let snap: Snapshot;
  try {
    snap = await snapshot(cfg.db, cfg.backup_dir, now);
  } catch (err) {
    return [{ source: "backup", source_id: `failed-${at}`, type: "backup.failed", at, payload: { error: (err as Error).message.slice(0, 300) } }];
  }
  const out: EventInput[] = [{ source: "backup", source_id: `done-${at}`, type: "backup.done", at, payload: { path: snap.path, bytes: snap.bytes } }];
  if (!lastDrillAt || now.getTime() - Date.parse(lastDrillAt) >= DRILL_EVERY_MS) {
    let r: DrillResult;
    try { r = drill(snap.path, cfg); } catch (err) {
      r = { ok: false, snapshot: snap.path, events: 0, integrity: "", mismatches: [`演练出错：${(err as Error).message.slice(0, 200)}`] };
    }
    const done = new Date().toISOString();
    out.push({ source: "backup", source_id: `drilled-${done}`, type: "backup.drilled", at: done, payload: { ...r } });
  }
  return out;
}

// 内核进程里的备份来源：启动一分钟后备份一次，之后每小时一次。上次演练时间问内核要（账本里记着）。
export function startBackupSource(base: string, cfg: Config, intervalMs = 3_600_000, firstDelayMs = 60_000): void {
  const run = async () => {
    // 只看上次演练通过的时间：没通过就每次备份后再演练一次，直到通过（异常卡去重，不会重复推）。
    const status = await fetch(`${base}/backups`).then((r) => r.json() as Promise<{ drill_ok_at: string | null }>).catch(() => null);
    for (const e of await backupOnce(cfg, new Date(), status?.drill_ok_at ?? null)) {
      await fetch(`${base}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e) })
        .catch((err) => console.error("[backup] 报不进内核：", (err as Error).message));
      console.log(`[backup] ${e.type} ${JSON.stringify(e.payload).slice(0, 200)}`);
    }
  };
  setTimeout(() => { run(); setInterval(run, intervalMs); }, firstDelayMs);
}
