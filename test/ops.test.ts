// P1-26 日志轮转。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLogs } from "../src/ops/logs.ts";

test("日志轮转：超过上限的拷成 .1、旧的后移、只留 keep 份；原文件截断，开着的写端接着追加", () => {
  const dir = mkdtempSync(join(tmpdir(), "xj-logs-"));
  const log = join(dir, "kernel.log");
  writeFileSync(join(dir, "small.err"), "x");
  const fd = openSync(log, "a");                       // 像 launchd 一样以追加方式一直开着
  for (let round = 1; round <= 4; round++) {
    writeSync(fd, `第 ${round} 轮`.padEnd(100, "."));
    assert.deepEqual(rotateLogs(dir, 50, 2), ["kernel.log"]);
  }
  writeSync(fd, "之后");
  closeSync(fd);
  assert.equal(readFileSync(log, "utf8"), "之后", "截断后从头接着写");
  assert.deepEqual(readdirSync(dir).sort(), ["kernel.log", "kernel.log.1", "kernel.log.2", "small.err"]);
  assert.match(readFileSync(`${log}.1`, "utf8"), /^第 4 轮/);
  assert.match(readFileSync(`${log}.2`, "utf8"), /^第 3 轮/);
  assert.deepEqual(rotateLogs(join(dir, "没有"), 50), []);
});
