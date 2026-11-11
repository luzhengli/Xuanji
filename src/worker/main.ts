// 接单程序入口。由 launchd 拉起；中断的轮次由内核带恢复说明重新派发。
import { loadConfig } from "../shared/config.ts";
import { Worker } from "./worker.ts";
import { kernelClient } from "./http-client.ts";
import { ClaudeCodeAdapter } from "./adapters/claude-code.ts";

const cfg = loadConfig();
const client = kernelClient(`http://127.0.0.1:${cfg.port}`, "worker");
const worker = new Worker(client, { claude: new ClaudeCodeAdapter() }, process.env.XJ_WORK_ROOT ?? process.cwd());
const POLL_MS = 5_000;

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
