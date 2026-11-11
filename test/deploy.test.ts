// P1-16 部署：模板填好后是合法的 plist，三个服务各跑对的入口，接单程序有固定名字和工作目录，PATH 找得到 Agent。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render, detect, LABELS } from "../scripts/launchd.ts";

const tpl = (label: string) => readFileSync(new URL(`../deploy/${label}.plist`, import.meta.url), "utf8");
const opts = { repo: "/Users/x/Xuanji", node: "/opt/homebrew/bin/node", path: "/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin:/bin", workRoot: "/Users/x/xj-work" };

test("模板填好后 plutil 检查通过；没有剩下的占位符", () => {
  const dir = mkdtempSync(join(tmpdir(), "xj-plist-"));
  for (const label of LABELS) {
    const out = render(tpl(label), opts);
    assert.doesNotMatch(out, /__[A-Z_]+__/);
    const file = join(dir, `${label}.plist`);
    writeFileSync(file, out);
    execFileSync("/usr/bin/plutil", ["-lint", file]);
  }
});

test("三个服务：入口、工作目录、日志、随登录拉起并保活；只有接单程序带名字和工作目录", () => {
  const json = (label: string) => {
    const dir = mkdtempSync(join(tmpdir(), "xj-plist-"));
    const file = join(dir, "p.plist");
    writeFileSync(file, render(tpl(label), opts));
    return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
  };
  const k = json("com.xuanji.kernel"), w = json("com.xuanji.worker"), f = json("com.xuanji.feishu");
  assert.deepEqual(k.ProgramArguments, ["/opt/homebrew/bin/node", "src/kernel/main.ts"]);
  assert.deepEqual(w.ProgramArguments, ["/opt/homebrew/bin/node", "src/worker/main.ts"]);
  assert.deepEqual(f.ProgramArguments, ["/opt/homebrew/bin/node", "src/channels/feishu/main.ts"]);
  for (const p of [k, w, f]) {
    assert.equal(p.WorkingDirectory, "/Users/x/Xuanji");
    assert.equal(p.RunAtLoad, true); assert.equal(p.KeepAlive, true);
    assert.equal(p.EnvironmentVariables.PATH, opts.path);
    assert.match(p.StandardOutPath, /^\/Users\/x\/Xuanji\/data\/logs\/(kernel|worker|feishu)\.log$/);
  }
  assert.deepEqual([w.EnvironmentVariables.XJ_WORKER_NAME, w.EnvironmentVariables.XJ_WORK_ROOT], ["local", "/Users/x/xj-work"]);
  assert.equal(k.EnvironmentVariables.XJ_WORKER_NAME, undefined);
});

test("本机：node、claude、lark-cli、git 都找得到，PATH 含它们的目录和系统目录", () => {
  const d = detect();
  assert.deepEqual(d.missing, []);
  assert.ok(d.path.split(":").includes("/usr/bin"));
  assert.equal(d.node, process.execPath);
});
