// 对外动作的执行（P1-21）。内核已经落账，这里只负责做，并且做之前先查远端：做过的直接算完成（幂等），
// 所以接单程序中途崩了、内核判超时重派，都不会推两次、开两个 PR。
// 只推不强推：远端拒绝（non-fast-forward 等）不重试，交给人。
import { execFile } from "node:child_process";
import type { Effect } from "../kernel/types.ts";

export interface ExecResult { code: number; stdout: string; stderr: string; }
export type Exec = (cmd: string, args: string[], cwd: string) => Promise<ExecResult>;

export const execReal: Exec = (cmd, args, cwd) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : "")) });
  });
});

export interface EffectOutcome { ok: boolean; ref?: string; detail: string; retryable?: boolean; }

// 出身标记：PR 描述末尾写上任务、目标、轮次编号（设计“出身标记”）。已经写过就不重复。
export function provenance(x: Pick<Effect, "task_id" | "run_id">, goalId: string): string {
  return `璇玑任务 ${x.task_id}（目标 ${goalId}，轮次 ${x.run_id}）`;
}

// 网络、超时一类的失败值得重试；认证、找不到、被拒绝这类重试也没用。
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
    if (found.code) return fail("查 PR 失败", found);
    const existing = (JSON.parse(found.stdout || "[]") as { url: string }[])[0];
    if (existing) return { ok: true, ref: existing.url, detail: "这个分支已经有 PR（之前开过）" };
    const mark = provenance(x, goalId);
    const body = (x.params.body ?? "").includes(mark) ? x.params.body! : `${x.params.body ?? ""}\n\n---\n${mark}`.trim();
    const pr = await exec("gh", ["pr", "create", "--head", branch, "--base", x.params.base ?? "main", "--title", x.params.title ?? branch, "--body", body], cwd);
    if (pr.code) return fail("开 PR 失败", pr);
    return { ok: true, ref: pr.stdout.trim().split("\n").at(-1)!, detail: "已开 PR" };
  }
  return { ok: false, detail: `不认识的对外动作 ${x.kind}`, retryable: false };
}
