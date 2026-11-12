// 一期收尾的几个小项：worktree 清理（P1-28）、不要求的 PR 和非 GitHub 远端（P1-29）、“发现”跨任务去重（P1-30）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "../src/kernel/kernel.ts";
import { RECEIPT_INSTRUCTIONS } from "../src/kernel/receipt.ts";
import { DEFAULTS } from "../src/shared/config.ts";
import { runEffect, taskWorktrees, parseWorktrees, type Exec } from "../src/worker/effects.ts";
import type { Receipt, Worktree } from "../src/kernel/types.ts";

const T0 = "2026-11-12T10:00:00.000Z";
let n = 0;
const sid = () => `td${n++}`;

function goal(k: Kernel, title: string) {
  k.ingest({ source: "cli", source_id: sid(), type: "goal.confirmed", at: T0, payload: { title } });
}
function round(k: Kernel, receipt: Receipt, worktrees?: Worktree[]) {
  const c = k.claim("claude", T0, sid())!;
  k.ingest({ source: "worker", source_id: sid(), type: "run.receipt", at: T0, payload: { run_id: c.run_id, task_id: c.task.id, receipt, ...(worktrees ? { worktrees } : {}) } });
  return c;
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "xj-tidy-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

// ---- P1-30 ----
test("P1-30 别的任务已经报过同一件事：照常记下再收起，不重复出现在 /card 和简报里；编号照常签发", () => {
  const k = new Kernel(DEFAULTS, ":memory:");
  const found = [{ title: "feat/greet 工作区有未提交改动（greet2、pow）" }];
  goal(k, "加 cube"); round(k, { outcome: "nothing", summary: "没什么要做", found });
  goal(k, "解释 cube"); round(k, { outcome: "nothing", summary: "没什么要做", found: [...found, { title: "README 过时" }] });
  const cards = k.db.prepare(`SELECT id, about, status FROM cards ORDER BY rowid`).all() as { id: string; about: string; status: string }[];
  assert.deepEqual(cards.map((c) => [c.id, c.about, c.status]), [["C-1", "T-1", "open"], ["C-2", "T-2", "folded"], ["C-3", "T-2", "open"]]);
  assert.match(k.why("C-2").at(-1)!.note ?? "", /和 C-1（T-1）是同一件事，收起/);
  assert.deepEqual(k.cards().map((c) => c.id), ["C-1", "C-3"]);
});

// ---- P1-29 ----
test("P1-29 回执约定写明：授权是上限，目标没要 PR 就不开", () => {
  assert.match(RECEIPT_INSTRUCTIONS, /授权是上限，不是要做的事：目标和验收里没要求推送或开 PR，就不要请求/);
});

test("P1-29 远端不是 GitHub：开 PR 记为没执行，不问人；审核卡照常出，照实写明", async () => {
  const gh: Exec = async (cmd) => cmd === "gh"
    ? { code: 1, stdout: "", stderr: "none of the git remotes configured for this repository point to a known GitHub host." }
    : { code: 0, stdout: "", stderr: "" };
  const k = new Kernel(DEFAULTS, ":memory:");
  goal(k, "explainCube");
  round(k, { outcome: "done", summary: "好了", handoff: "见 math.mjs", effects: [{ kind: "open-pr", branch: "xj/T-1-explain", title: "explainCube" }] });
  const c = k.claimEffect(T0, sid())!;
  const out = await runEffect(c.effect, "/nowhere", c.goal_id, gh);
  assert.deepEqual([out.ok, out.skipped, out.detail], [false, true, "远端不是 GitHub，开不了 PR"]);
  k.ingest({ source: "worker", source_id: sid(), type: "effect.result", at: T0, payload: { effect_id: c.effect.id, ...out } });
  assert.equal(k.effect("X-1")!.status, "rejected");
  assert.equal(k.task("T-1")!.state, "awaiting_review");
  const cards = k.cards();
  assert.deepEqual(cards.map((x) => x.kind), ["review"], "没有对外动作卡");
  assert.match(cards[0]!.body, /^对外动作：开 PR xj\/T-1-explain → main：没执行（远端不是 GitHub，开不了 PR）/);
});

// ---- P1-28 ----
test("P1-28 解析 git worktree list：跳过主工作区；按任务编号挑出 Agent 建的（T-1 不算进 T-11）", async () => {
  const dir = repo();
  const a = join(dir, "..", `${dir.split("/").at(-1)}-xj-T-1-pow`);
  const b = join(dir, "..", `${dir.split("/").at(-1)}-xj-T-11-cube`);
  git(dir, "worktree", "add", "-q", "-b", "xj/T-1-pow", a);
  git(dir, "worktree", "add", "-q", "-b", "xj/T-11-cube", b);
  git(dir, "worktree", "add", "-q", "--detach", join(dir, "..", `${dir.split("/").at(-1)}-scratch`));
  assert.equal(parseWorktrees(git(dir, "worktree", "list", "--porcelain")).length, 3);
  assert.deepEqual(await taskWorktrees("T-1", dir), [{ path: a, branch: "xj/T-1-pow" }]);
  assert.deepEqual(await taskWorktrees("T-11", dir), [{ path: b, branch: "xj/T-11-cube" }]);
  assert.deepEqual(await taskWorktrees("T-1", tmpdir()), [], "不是 git 仓库就算了");
});

test("P1-28 回执带上 worktree：审核卡列出；任务结束后排清理，干净的删掉、分支留着；有没提交改动的不删，出知会卡", async () => {
  const dir = repo();
  const wt = (name: string) => join(dir, "..", `${dir.split("/").at(-1)}-${name}`);
  git(dir, "worktree", "add", "-q", "-b", "xj/T-1-pow", wt("xj-T-1-pow"));
  git(dir, "worktree", "add", "-q", "-b", "xj/T-2-cube", wt("xj-T-2-cube"));
  writeFileSync(join(wt("xj-T-2-cube"), "draft.txt"), "没提交");

  const k = new Kernel(DEFAULTS, ":memory:");
  goal(k, "pow");
  round(k, { outcome: "done", summary: "pow 好了", handoff: "见 math.mjs" }, await taskWorktrees("T-1", dir));
  const review = k.cards()[0]!;
  assert.match(review.body, new RegExp(`^工作区：${wt("xj-T-1-pow")}（xj/T-1-pow），任务结束后清理\\n见 math\\.mjs`));
  assert.equal(k.claimEffect(T0, sid()), null, "审核前不清理：人可能要进去看");

  k.ingest({ source: "cli", source_id: sid(), type: "card.answered", at: T0, payload: { card_id: review.id, choice: "accept" } });
  assert.equal(k.task("T-1")!.state, "done");
  const c = k.claimEffect(T0, sid())!;
  assert.deepEqual([c.effect.id, c.effect.kind, c.effect.params.path], ["X-1", "remove-worktree", wt("xj-T-1-pow")]);
  const out = await runEffect(c.effect, dir, c.goal_id);
  assert.equal(out.ok, true, out.detail);
  k.ingest({ source: "worker", source_id: sid(), type: "effect.result", at: T0, payload: { effect_id: "X-1", ...out } });
  assert.equal(existsSync(wt("xj-T-1-pow")), false);
  assert.match(git(dir, "branch", "--list", "xj/T-1-pow"), /xj\/T-1-pow/, "分支留着");
  assert.equal(k.effect("X-1")!.status, "done");
  assert.equal(k.cards().length, 0);
  // 再做一遍也没事（已经不在了算完成）。
  assert.equal((await runEffect(c.effect, dir, c.goal_id)).ok, true);

  // 有没提交改动的：任务被叫停后排清理，不删，出知会卡，不挡别的。
  goal(k, "cube");
  round(k, { outcome: "waiting", summary: "等 CI", later: [{ timeout: "1h", about: "CI" }] }, await taskWorktrees("T-2", dir));
  k.ingest({ source: "cli", source_id: sid(), type: "human.stop", at: T0, payload: { about: "T-2" } });
  const d = k.claimEffect(T0, sid())!;
  assert.equal(d.effect.kind, "remove-worktree", "叫停不作废清理");
  const dirty = await runEffect(d.effect, dir, d.goal_id);
  assert.deepEqual([dirty.ok, dirty.retryable], [false, false]);
  k.ingest({ source: "worker", source_id: sid(), type: "effect.result", at: T0, payload: { effect_id: d.effect.id, ...dirty } });
  assert.equal(existsSync(join(wt("xj-T-2-cube"), "draft.txt")), true, "人的东西不删");
  const [notice] = k.cards();
  assert.deepEqual([notice!.kind, notice!.title], ["notice", `没清掉工作区 ${wt("xj-T-2-cube")}`]);
  assert.match(notice!.body, /有没提交的改动，没删：\?\? draft\.txt/);
  assert.equal(k.task("T-2")!.state, "stopped");
});

test("P1-28 重放：从账本重建后清理动作的编号和状态不变", () => {
  const k = new Kernel(DEFAULTS, ":memory:");
  goal(k, "pow");
  round(k, { outcome: "nothing", summary: "没什么要做" }, [{ path: "/tmp/xj-T-1-pow", branch: "xj/T-1-pow" }]);
  const before = k.db.prepare(`SELECT id, kind, status, params FROM effects`).all();
  assert.equal(before.length, 1);
  k.rebuild();
  assert.deepEqual(k.db.prepare(`SELECT id, kind, status, params FROM effects`).all(), before);
});
