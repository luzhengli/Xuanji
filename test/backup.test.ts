// P1-15 备份：在线快照与保留份数、恢复演练（完整性 + 重放比对）、失败与超时出异常卡、恢复脚本。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Kernel } from "../src/kernel/kernel.ts";
import { BACKUP_STALE_MS } from "../src/kernel/reducer.ts";
import { snapshot, listSnapshots, drill, backupOnce, DRILL_EVERY_MS } from "../src/ops/backup.ts";
import { showBackup } from "../src/channels/format.ts";
import { DEFAULTS, type Config } from "../src/shared/config.ts";

const execFileP = promisify(execFile);
const T0 = "2026-11-12T10:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
let n = 0;
const sid = () => `bk${n++}`;

// 一本有点内容的账本：立项、跑一轮、出卡、回答、定时器、主理人。
function ledger(): { cfg: Config; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "xj-bk-"));
  const cfg = { ...DEFAULTS, db: join(dir, "xuanji.db"), backup_dir: join(dir, "backups") };
  const k = new Kernel(cfg);
  k.ingest({ source: "cli", source_id: sid(), type: "goal.confirmed", at: T0, payload: { title: "x" } });
  const c = k.claim("claude", T0, sid())!;
  k.ingest({ source: "worker", source_id: sid(), type: "run.receipt", at: at(60_000), payload: { run_id: c.run_id, task_id: "T-1", receipt: { outcome: "waiting", summary: "等", later: [{ timeout: "1h", about: "看" }] } } });
  k.ingest({ source: "timer", source_id: sid(), type: "timer.tick", at: at(2 * 3_600_000), payload: {} });
  k.ingest({ source: "feishu", source_id: sid(), type: "human.message", at: T0, payload: { text: "再加一个" } });
  k.close();
  return { cfg, dir };
}

test("快照：在线备份出一份一致的副本；只留最新的 N 份", async () => {
  const { cfg } = ledger();
  for (let i = 0; i < 4; i++) await snapshot(cfg.db, cfg.backup_dir, new Date(Date.parse(T0) + i * 3_600_000), 3);
  const files = listSnapshots(cfg.backup_dir);
  assert.deepEqual(files, ["xuanji-2026-11-12T11-00-00-000Z.db", "xuanji-2026-11-12T12-00-00-000Z.db", "xuanji-2026-11-12T13-00-00-000Z.db"]);
  const copy = new DatabaseSync(join(cfg.backup_dir, files[2]!), { readOnly: true });
  assert.equal((copy.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n, 5);
  copy.close();
});

test("恢复演练：完整性 ok、重放后投影与快照一致才算通过；快照里的投影被改过就报出是哪张表", async () => {
  const { cfg } = ledger();
  const s = await snapshot(cfg.db, cfg.backup_dir, new Date(T0));
  const ok = drill(s.path, cfg);
  assert.deepEqual([ok.ok, ok.integrity, ok.events, ok.mismatches], [true, "ok", 5, []]);

  const db = new DatabaseSync(s.path);
  db.prepare("UPDATE tasks SET state = 'done'").run();
  db.close();
  const bad = drill(s.path, cfg);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.mismatches, ["tasks：快照 1 行，重建 1 行，内容不一致"]);
  assert.equal(listSnapshots(cfg.backup_dir).length, 1, "演练在副本上做，不多出文件");
});

test("一次备份：该演练了才演练；备份失败报 backup.failed", async () => {
  const { cfg } = ledger();
  const now = new Date(T0);
  assert.deepEqual((await backupOnce(cfg, now, null)).map((e) => e.type), ["backup.done", "backup.drilled"], "从没演练过");
  assert.deepEqual((await backupOnce(cfg, now, at(-DRILL_EVERY_MS + 60_000))).map((e) => e.type), ["backup.done"], "不到 7 天");
  assert.deepEqual((await backupOnce(cfg, now, at(-DRILL_EVERY_MS))).map((e) => e.type), ["backup.done", "backup.drilled"]);
  const broken = await backupOnce({ ...cfg, db: join(cfg.backup_dir, "没有这个文件.db") }, now, null);
  assert.deepEqual(broken.map((e) => e.type), ["backup.failed"]);
  assert.ok((broken[0]!.payload as { error: string }).error);
});

// ---- 内核：结果入账、异常卡、超时、简报 ----
const ev = (k: Kernel, type: string, t: string, payload: Record<string, unknown>) => k.ingest({ source: "backup", source_id: sid(), type, at: t, payload });
const tick = (k: Kernel, t: string) => k.ingest({ source: "timer", source_id: sid(), type: "timer.tick", at: t, payload: {} });

test("备份失败出推送的异常卡，重复失败不重发；下次成功就撤回", () => {
  const k = new Kernel(DEFAULTS, ":memory:");
  ev(k, "backup.done", T0, { path: "/b/1.db", bytes: 10 });
  ev(k, "backup.failed", at(3_600_000), { error: "磁盘满了" });
  ev(k, "backup.failed", at(2 * 3_600_000), { error: "磁盘满了" });
  const alerts = k.cards();
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0]!.kind, alerts[0]!.form, alerts[0]!.push, alerts[0]!.title], ["notice", "alert", true, "备份失败"]);
  assert.match(alerts[0]!.body, /^磁盘满了\n最近一次成功是 1 小时前/);
  ev(k, "backup.done", at(3 * 3_600_000), { path: "/b/2.db", bytes: 10 });
  assert.equal(k.cards().length, 0);
  assert.equal(k.card(alerts[0]!.id)!.status, "withdrawn");
  const s = k.backups();
  assert.deepEqual([s.snapshot_ok_at, s.snapshot_failed_at], [at(3 * 3_600_000), at(2 * 3_600_000)]);
});

test("看门狗：最近一次成功超过 3 小时就出异常卡（备份来源停了也能发现）；从没备份过不报", () => {
  const k = new Kernel(DEFAULTS, ":memory:");
  tick(k, at(10 * 3_600_000));
  assert.equal(k.cards().length, 0, "还没部署备份时不报");
  ev(k, "backup.done", T0, { path: "/b/1.db", bytes: 10 });
  tick(k, at(BACKUP_STALE_MS));
  assert.equal(k.cards().length, 0);
  tick(k, at(BACKUP_STALE_MS + 60_000));
  tick(k, at(BACKUP_STALE_MS + 120_000));
  assert.deepEqual(k.cards().map((c) => c.title), ["备份超过 3 小时没有成功"]);
  assert.match(k.cards()[0]!.body, /最近一次成功是 3 小时前/);
});

test("演练没通过出异常卡，通过后撤回；简报里有备份一行；重建一致", () => {
  const k = new Kernel(DEFAULTS, ":memory:");
  ev(k, "backup.done", T0, { path: "/b/1.db", bytes: 10 });
  ev(k, "backup.drilled", T0, { ok: false, snapshot: "/b/1.db", events: 0, integrity: "ok", mismatches: ["tasks：快照 1 行，重建 1 行，内容不一致"] });
  assert.deepEqual(k.cards().map((c) => [c.title, c.form]), [["恢复演练没通过", "alert"]]);
  assert.match(k.cards()[0]!.body, /tasks：快照 1 行/);
  ev(k, "backup.drilled", at(3_600_000), { ok: true, snapshot: "/b/2.db", events: 9, integrity: "ok", mismatches: [] });
  assert.equal(k.cards().length, 0);
  k.ingest({ source: "timer", source_id: "brief-2026-11-12", type: "brief.due", at: at(2 * 3_600_000), payload: { date: "2026-11-12" } });
  assert.match(k.cards()[0]!.body, /\*\*备份\*\* 最近成功 2 小时前；恢复演练 1 小时前通过$/);
  const snap = JSON.stringify([k.backups(), k.db.prepare("SELECT * FROM cards ORDER BY id").all()]);
  k.rebuild();
  assert.equal(JSON.stringify([k.backups(), k.db.prepare("SELECT * FROM cards ORDER BY id").all()]), snap);
});

test("xj status 的备份一行：最近成功多久以前；最近一次失败照实说", () => {
  const now = new Date(at(90 * 60_000));
  const b = { snapshot_ok_at: T0, snapshot_failed_at: null, drill_ok_at: T0, drill_failed_at: null };
  assert.equal(showBackup({ ...b, snapshot_ok_at: null, drill_ok_at: null }, now), null);
  assert.equal(showBackup(b, now), "备份：最近成功 2 小时前；恢复演练 2 小时前通过");
  assert.equal(showBackup({ ...b, snapshot_failed_at: at(60 * 60_000), drill_failed_at: at(60 * 60_000) }, now),
    "备份：最近成功 2 小时前（30 分钟前失败过一次）；恢复演练 30 分钟前没通过");
});

// ---- 恢复脚本：真的子进程 ----
const RESTORE = new URL("../scripts/restore.ts", import.meta.url).pathname;

test("恢复脚本：列出快照；内核在跑就拒绝；内核停着就换上快照，原账本挪到一旁不删", async () => {
  const { cfg, dir } = ledger();
  const s = await snapshot(cfg.db, cfg.backup_dir, new Date(T0));
  const k = new Kernel(cfg);   // 快照之后又发生的事
  k.ingest({ source: "cli", source_id: sid(), type: "goal.confirmed", at: at(3_600_000), payload: { title: "快照之后" } });
  k.close();
  const cfgPath = join(dir, "config.json");
  const run = (port: number, ...args: string[]) => {
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, port }));
    return execFileP(process.execPath, [RESTORE, ...args], { env: { ...process.env, XJ_CONFIG: cfgPath } });
  };
  assert.equal((await run(1)).stdout.trim(), s.path);

  const { createServer } = await import("node:http");
  const fake = createServer((_q, r) => r.end("{}")).listen(0, "127.0.0.1");
  await new Promise((r) => fake.once("listening", r));
  const port = (fake.address() as { port: number }).port;
  await assert.rejects(run(port, s.path), /内核还在跑/);
  fake.close();

  const out = (await run(port, s.path)).stdout;
  assert.match(out, /已换上 .*（5 条事件）/);
  const restored = new Kernel(cfg);
  restored.rebuild();
  assert.equal(restored.overview().goals.length, 2, "快照之后立的目标不在了（最多丢一小时）");
  restored.close();
  const aside = readdirSync(dir).find((f) => f.startsWith("before-restore-"))!;
  assert.ok(existsSync(join(dir, aside, "xuanji.db")), "原账本留着");
});
