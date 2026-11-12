// 对外动作的执行（P1-21）。内核已经落账，这里只负责做，并且做之前先查远端：做过的直接算完成（幂等），
// 所以接单程序中途崩了、内核判超时重派，都不会推两次、开两个 PR。
// 只推不强推：远端拒绝（non-fast-forward 等）不重试，交给人。
import { execFile } from "node:child_process";
import type { Effect, Worktree } from "../kernel/types.ts";

export interface ExecResult { code: number; stdout: string; stderr: string; }
export type Exec = (cmd: string, args: string[], cwd: string) => Promise<ExecResult>;

export const execReal: Exec = (cmd, args, cwd) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : "")) });
  });
});

// skipped：做不了、但也不必问人（远端不是 GitHub 就开不了 PR），内核记为没执行，照常往下走。
export interface EffectOutcome { ok: boolean; ref?: string; detail: string; retryable?: boolean; skipped?: boolean; }

// 这个仓库登记的 worktree，第一个是主工作区（不算）。git worktree list --porcelain 的格式：空行分隔，每段 worktree / HEAD / branch。
export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (path) out.push(branch ? { path, branch } : { path });
  }
  return out.slice(1);
}

// Agent 在这个任务里建的 worktree（P1-28）：路径或分支名里带任务编号（T-9 不算进 T-91）。
export async function taskWorktrees(taskId: string, cwd: string, exec: Exec = execReal): Promise<Worktree[]> {
  const r = await exec("git", ["worktree", "list", "--porcelain"], cwd).catch(() => null);
  if (!r || r.code) return [];
  const mark = new RegExp(`(^|[^0-9A-Za-z])${taskId.replace("-", "-?")}($|[^0-9])`, "i");
  return parseWorktrees(r.stdout).filter((w) => mark.test(w.path.split("/").at(-1) ?? "") || (w.branch && mark.test(w.branch)));
}

// 出身标记：PR 描述末尾写上任务、目标、轮次编号（设计“出身标记”）。已经写过就不重复。
export function provenance(x: Pick<Effect, "task_id" | "run_id">, goalId: string): string {
  return `璇玑任务 ${x.task_id}（目标 ${goalId}，轮次 ${x.run_id}）`;
}

// 网络、超时一类的失败值得重试；认证、找不到、被拒绝这类重试也没用。
const NOT_GITHUB = /known GitHub host|not a GitHub repository|none of the git remotes/i;
const TRANSIENT = /timed? ?out|timeout|could not resolve|connection|network|temporarily|503|502|504|ECONNRESET|EAI_AGAIN/i;

export async function runEffect(x: Effect, cwd: string, goalId: string, exec: Exec = execReal): Promise<EffectOutcome> {
  const { branch, remote } = x.params;
  const fail = (what: string, r: ExecResult): EffectOutcome => ({ ok: false, detail: `${what}：${(r.stderr || r.stdout).trim().slice(-300)}`, retryable: TRANSIENT.test(r.stderr) });
  if (x.kind === "push-branch") {
    const local = await exec("git", ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], cwd);
    if (local.code) return { ok: false, detail: `本地没有分支 ${branch}`, retryable: false };
    const sha = local.stdout.trim();
    const url = await exec("git", ["remote", "get-url", remote], cwd);
    if (url.code) return { ok: false, detail: `仓库没有远端 ${remote}`, retryable: false };
    const ls = await exec("git", ["ls-remote", remote, `refs/heads/${branch}`], cwd);
    if (ls.code) return fail("查远端失败", ls);
    if (ls.stdout.split(/\s/)[0] === sha) return { ok: true, ref: `${remote}/${branch}@${sha.slice(0, 7)}`, detail: "远端已经是这个提交（之前推过）" };
    const push = await exec("git", ["push", remote, `refs/heads/${branch}:refs/heads/${branch}`], cwd);
    if (push.code) return { ...fail("推送失败", push), retryable: !/rejected|non-fast-forward|denied|protected/i.test(push.stderr) && TRANSIENT.test(push.stderr) };
    return { ok: true, ref: `${remote}/${branch}@${sha.slice(0, 7)}`, detail: `推到 ${url.stdout.trim()}` };
  }
  if (x.kind === "open-pr") {
    const found = await exec("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "url", "--limit", "1"], cwd);
    // 远端不是 GitHub：开不了 PR，重试和问人都没用（实测 T-11），记为没执行，分支照样推了。
    if (found.code && NOT_GITHUB.test(found.stderr)) return { ok: false, skipped: true, detail: "远端不是 GitHub，开不了 PR", retryable: false };
    if (found.code) return fail("查 PR 失败", found);
    const existing = (JSON.parse(found.stdout || "[]") as { url: string }[])[0];
    if (existing) return { ok: true, ref: existing.url, detail: "这个分支已经有 PR（之前开过）" };
    const mark = provenance(x, goalId);
    const body = (x.params.body ?? "").includes(mark) ? x.params.body! : `${x.params.body ?? ""}\n\n---\n${mark}`.trim();
    const pr = await exec("gh", ["pr", "create", "--head", branch, "--base", x.params.base ?? "main", "--title", x.params.title ?? branch, "--body", body], cwd);
    if (pr.code) return fail("开 PR 失败", pr);
    return { ok: true, ref: pr.stdout.trim().split("\n").at(-1)!, detail: "已开 PR" };
  }
  if (x.kind === "remove-worktree") {
    // 只删这个仓库登记过的 worktree，有没提交的改动就不删（不 --force），分支留着，提交不会丢。
    const path = x.params.path ?? "";
    const list = await exec("git", ["worktree", "list", "--porcelain"], cwd);
    if (list.code) return fail("查 worktree 失败", list);
    if (!parseWorktrees(list.stdout).some((w) => w.path === path)) return { ok: true, detail: `${path} 已经不在了` };
    const dirty = await exec("git", ["status", "--porcelain"], path);
    if (dirty.code) return fail("查工作区状态失败", dirty);
    if (dirty.stdout.trim()) return { ok: false, detail: `${path} 有没提交的改动，没删：${dirty.stdout.trim().split("\n").slice(0, 3).join("；")}`, retryable: false };
    const rm = await exec("git", ["worktree", "remove", path], cwd);
    if (rm.code) return fail("删 worktree 失败", rm);
    return { ok: true, detail: `已删 ${path}${x.params.branch ? `，分支 ${x.params.branch} 留着` : ""}` };
  }
  return { ok: false, detail: `不认识的对外动作 ${x.kind}`, retryable: false };
}
