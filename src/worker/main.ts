// 接单程序入口。由 launchd 拉起；中断的轮次由内核带恢复说明重新派发。
// 环境变量：XJ_WORK_ROOT 任务的工作目录（一期所有任务共用，二期改每任务一个 worktree）；
//           XJ_RECORD_DIR 设了就把每轮原始输出存下来，用作测试的录制输出。
import { loadConfig } from "../shared/config.ts";
import { Worker } from "./worker.ts";
import { kernelClient } from "./http-client.ts";
import { ClaudeCodeAdapter } from "./adapters/claude-code.ts";

const cfg = loadConfig();
const client = kernelClient(`http://127.0.0.1:${cfg.port}`, "worker");
const workRoot = process.env.XJ_WORK_ROOT ?? process.cwd();
const worker = new Worker(client, { claude: new ClaudeCodeAdapter({ recordDir: process.env.XJ_RECORD_DIR }) }, workRoot, { profiles: cfg.agents });
const POLL_MS = 5_000;
console.log(`[worker] 工作目录 ${workRoot}，档案 ${Object.entries(cfg.agents).map(([k, v]) => `${k}${v.model ? `(${v.model})` : ""}`).join(", ")}`);

async function loop() {
  for (;;) {
    let did = false;
    for (const agent of Object.keys(cfg.agents)) {
      try { did = (await worker.once(agent)) || did; } catch (e) { console.error("[worker]", (e as Error).message); }
    }
    if (!did) await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
loop();
