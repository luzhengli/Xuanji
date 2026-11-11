// 接单程序入口。由 launchd 拉起；重启后先清理上个实例的 Agent 进程，再报到，内核把旧实例的轮次带恢复说明重新派发。
// 环境变量：XJ_WORK_ROOT 任务的工作目录（一期所有任务共用，二期改每任务一个 worktree）；
//           XJ_RECORD_DIR 设了就把每轮原始输出存下来，用作测试的录制输出；
//           XJ_WORKER_NAME 接单程序名（默认 local），同名的新实例启动即接管旧实例的轮次。
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../shared/config.ts";
import { Worker } from "./worker.ts";
import { kernelClient } from "./http-client.ts";
import { ClaudeCodeAdapter, reapOrphans } from "./adapters/claude-code.ts";

const cfg = loadConfig();
const identity = { worker: process.env.XJ_WORKER_NAME ?? "local", instance: `${process.pid}-${new Date().toISOString()}` };
const pidDir = join(dirname(resolve(cfg.db)), "worker-pids", identity.worker);
const client = kernelClient(`http://127.0.0.1:${cfg.port}`, "worker", { worker: identity });
const workRoot = process.env.XJ_WORK_ROOT ?? process.cwd();
const worker = new Worker(client, { claude: new ClaudeCodeAdapter({ recordDir: process.env.XJ_RECORD_DIR, pidDir }) }, workRoot,
  { profiles: cfg.agents, identity, reap: () => reapOrphans(pidDir) });
const POLL_MS = 5_000;
const JUDGE_POLL_MS = 2_000;   // 主理人是人刚说的话，领得勤一些
console.log(`[worker] ${identity.worker}（${identity.instance}）工作目录 ${workRoot}，档案 ${Object.entries(cfg.agents).map(([k, v]) => `${k}${v.model ? `(${v.model})` : ""}`).join(", ")}`);

// 执行和判断点各一个循环，互不等待：执行一轮可能跑两小时，人这时说一句话，主理人照样马上整理。
async function poll(name: string, once: (agent: string) => Promise<boolean>, idleMs: number): Promise<never> {
  for (;;) {
    let did = false;
    for (const agent of Object.keys(cfg.agents)) {
      try { did = (await once(agent)) || did; } catch (e) { console.error(`[worker] ${name}`, (e as Error).message); }
    }
    if (!did) await new Promise((r) => setTimeout(r, idleMs));
  }
}

async function main() {
  for (;;) {   // 内核可能比接单程序晚起：报到不成功就等一会儿再试，不能跳过报到直接领活
    try { await worker.start(); break; } catch (e) { console.error("[worker] 报到失败，5 秒后重试：", (e as Error).message); await new Promise((r) => setTimeout(r, POLL_MS)); }
  }
  await Promise.all([poll("执行", (a) => worker.once(a), POLL_MS), poll("判断点", (a) => worker.judgeOnce(a), JUDGE_POLL_MS)]);
}
main();
