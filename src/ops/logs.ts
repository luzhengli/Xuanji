// P1-26 日志轮转。launchd 把三个服务的输出写进 data/logs/*.log、*.err，自己不轮转，文件会一直变大。
// 内核进程每小时看一眼：超过上限的文件先拷成 .1（旧的依次后移，只留 keep 份），再把原文件截断到 0。
// 用“拷贝再截断”而不是改名，是因为 launchd 一直开着原文件；它以追加方式写，截断后从头接着写。
import { copyFileSync, existsSync, readdirSync, renameSync, statSync, truncateSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP = 3;

export function rotateLogs(dir: string, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP): string[] {
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => /\.(log|err)$/.test(f)); } catch { return []; }
  const rotated: string[] = [];
  for (const f of files) {
    const path = join(dir, f);
    if (statSync(path).size <= maxBytes) continue;
    if (existsSync(`${path}.${keep}`)) unlinkSync(`${path}.${keep}`);
    for (let i = keep - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    copyFileSync(path, `${path}.1`);
    truncateSync(path, 0);
    rotated.push(f);
  }
  return rotated;
}

export function startLogRotation(dir: string, intervalMs = 3_600_000): void {
  const run = () => { try { const r = rotateLogs(dir); if (r.length) console.log(`[logs] 轮转 ${r.join(", ")}`); } catch (e) { console.error("[logs]", (e as Error).message); } };
  run();
  setInterval(run, intervalMs);
}
