// 每任务一个 worktree（P2-02，2026-11-12 人定）。接单程序在任务第一轮之前建好，路径和基底提交先报给内核落账，
// 再把 Agent 的工作目录设成它。人的工作目录是人自己在做的事，不从人当前检出的分支拉，也不带人没提交的改动。
//   位置：<worktree_root>/<仓库名>/T-x，默认 ~/xj-worktrees（不放 /tmp 会被清，不放仓库里会被测试扫进去）
//   基底：先 fetch，从 origin/main 拉；没有远端、或远端没有主干（2026-11-12 人定），用本地 main。目标写明基底的从那里拉。
//   分支：xj/T-x-<简述>
import { mkdirSync, realpathSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseWorktrees, type Exec } from "./effects.ts";
import type { Task } from "../kernel/types.ts";

export interface Workspace {
  path: string;
  branch: string;
  base: string;         // 拉分支的地方，例如 origin/main、main、feat/greet；接着用已有工作区时写“已有”
  base_commit: string;
  repo: string;         // 仓库的主工作区，清理时在那里执行
}

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

// 分支名里的简述：先取目标里的文件名和函数名（math.mjs、half(a)），没有再取英文单词，最多 3 个；都没有就只用任务编号。
// （实测 T-12：只取英文单词时，“先用 Bash 运行 sleep 30 … half(a)”成了 bash-sleep-30。）
export function branchFor(task: Pick<Task, "id" | "contract">): string {
  const text = task.contract.objective;
  const code = [...text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)(?=\(|\.(?:mjs|cjs|js|ts|tsx|jsx|py|go|rs|md|json)\b)/g)].map((m) => m[1]!.toLowerCase());
  const words = (text.toLowerCase().match(/[a-z][a-z0-9]*|\d+/g) ?? []).filter((w) => !["js", "ts", "mjs", "py", "md", "json"].includes(w));
  const slug = [...new Set(code.length ? code : words)].slice(0, 3).join("-").slice(0, 24).replace(/-+$/, "");
  return `xj/${task.id}${slug ? `-${slug}` : ""}`;
}

// 仓库的主工作区：git worktree list 的第一项。workRoot 本身是个 worktree 也能找回主仓库。不是 git 仓库返回 null。
async function mainWorktree(workRoot: string, exec: Exec): Promise<string | null> {
  const r = await exec("git", ["worktree", "list", "--porcelain"], workRoot).catch(() => null);
  if (!r || r.code) return null;
  return /^worktree (.+)$/m.exec(r.stdout)?.[1] ?? null;
}

async function commitOf(ref: string, cwd: string, exec: Exec): Promise<string | null> {
  const r = await exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  return r.code ? null : r.stdout.trim();
}

// 建（或找回）任务的 worktree。workRoot 不是 git 仓库时返回 null，任务照旧在 workRoot 里做。
export async function prepareWorkspace(task: Pick<Task, "id" | "contract">, workRoot: string, root: string, exec: Exec,
  log: (s: string) => void = () => {}): Promise<Workspace | null> {
  const repo = await mainWorktree(workRoot, exec);
  if (!repo) return null;
  const dir = join(expandHome(root), basename(repo));
  mkdirSync(dir, { recursive: true });
  const path = join(realpathSync(dir), task.id);   // git 记的是真实路径（/tmp 在 macOS 上是 /private/tmp）

  // 已经建过（上次建好了还没来得及落账就断了）：接着用。
  const list = await exec("git", ["worktree", "list", "--porcelain"], repo);
  const existing = parseWorktrees(list.stdout).find((w) => w.path === path);
  if (existing && existsSync(path)) {
    const head = await commitOf("HEAD", path, exec);
    return { path, branch: existing.branch ?? "", base: "已有", base_commit: head ?? "", repo };
  }
  if (existing) await exec("git", ["worktree", "prune"], repo);   // 目录被删了但还登记着：先清掉登记

  const branch = branchFor(task);
  const hasOrigin = !(await exec("git", ["remote", "get-url", "origin"], repo)).code;
  if (hasOrigin) {
    const f = await exec("git", ["fetch", "--quiet", "origin"], repo);
    if (f.code) log(`fetch origin 失败，用本地已有的远端引用：${(f.stderr || f.stdout).trim().slice(-200)}`);
  }
  const want = task.contract.base;
  const candidates: [ref: string, name: string][] = want
    ? [[`refs/remotes/origin/${want}`, `origin/${want}`], [`refs/heads/${want}`, want], [want, want]]
    : [[`refs/remotes/origin/main`, "origin/main"], [`refs/heads/main`, "main"]];
  let base: [string, string] | null = null, baseCommit: string | null = null;
  for (const [ref, name] of candidates) {
    if (!hasOrigin && ref.startsWith("refs/remotes/")) continue;
    baseCommit = await commitOf(ref, repo, exec);
    if (baseCommit) { base = [ref, name]; break; }
  }
  if (!base || !baseCommit) throw new Error(`找不到基底：${want ? `${want}（远端和本地都没有）` : "远端和本地都没有 main"}`);

  // 分支已经有了（工作区被删过又要接着做）：在原分支上重建，不另起，提交不会丢。
  const branchCommit = await commitOf(`refs/heads/${branch}`, repo, exec);
  const add = branchCommit
    ? await exec("git", ["worktree", "add", path, branch], repo)
    : await exec("git", ["worktree", "add", "--no-track", "-b", branch, path, baseCommit], repo);
  if (add.code) throw new Error(`建 worktree 失败：${(add.stderr || add.stdout).trim().slice(-300)}`);
  return branchCommit
    ? { path, branch, base: `已有分支 ${branch}`, base_commit: branchCommit, repo }
    : { path, branch, base: base[1], base_commit: baseCommit, repo };
}

// 工作区里还有没有别的进程在跑（P2-03 演练所见）：接单程序被冻住、轮次被判中断重派后，旧接单程序起的 Agent 可能还在改这个目录。
// 起新一轮之前查一遍，有就不起。macOS 上用 lsof 列各进程的当前目录。
export async function staleProcesses(path: string, exec: Exec, self = process.pid): Promise<number[]> {
  const r = await exec("lsof", ["-d", "cwd", "-F", "pn"], "/").catch(() => null);
  if (!r?.stdout) return [];
  const pids: number[] = [];
  let pid = 0;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid && pid !== self) {
      const cwd = line.slice(1);
      if (cwd === path || cwd.startsWith(`${path}/`)) pids.push(pid);
    }
  }
  return [...new Set(pids)];
}
