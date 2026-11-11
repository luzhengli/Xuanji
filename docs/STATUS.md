# 当前状态

更新于 2026-11-12（凌晨，一期闭环经 `xj` 真实跑通）。每次收工时整份改写，不要追加。

## 现在在哪

一期出口标准“一件事从提出到验收，人不打开任何 Agent 会话”已经经 `xj` 真实跑通，已按人的确认提交到本地 `main`。`npm test` 24 个通过，`npm run typecheck` 通过。

- **真实一轮（2026-11-12）**：`npm run kernel` + `npm run worker`（`XJ_WORK_ROOT=/tmp/xj-real/work`，模型 `claude-haiku-5-5`）。
  - T-1：`xj goal` → RN-1 无界面执行，交 `done` → 审核卡 C-1 → `xj answer C-1 accept` → T-1、G-1 都是 `done`。`xj why T-1` 列出立项、领活、回执、验收四条事件。
  - T-2（问人路径）：RN-2 交 `ask` → 决策卡 C-3 → `xj answer C-3 中文 …` → RN-3 以 `--resume` 接上同一会话（两轮 `session_id` 都是 `9b5d5284-…`），按回答实现 → C-4 接受 → done。
  - 周用量读数 52%（上限 60%）。账本在 `data/xuanji.db`（不入库），沙盒仓库在 `/tmp/xj-real/work`。
- **这次补的**：领活时由内核签发 `run_id`（`/runs/claim` 一个事务挑任务并落 `run.claimed`）；`GET /goals|tasks|runs/:id`；`waiting` 的相对时长换算成 `due_at`，`timer.tick` 到点放回队列；`failed` 退避 1 分钟、5 分钟，连续第 3 次转受阻；P1-18 关联表 `event_refs`；心跳与叫停（结束进程组）；续接提示词带人的回答；限流最小版；`xj` 可读输出。
- **测试**：`test/loop.test.ts` 起真的本机接口和真的 `xj` 子进程，用回放适配器喂真实一轮录下的 `test/fixtures/real-*.ndjson`，覆盖验收 1–3、叫停、适配器出错、回执重写；`test/followup.test.ts` 覆盖 waiting、failed 退避、退回反馈、限流、重复领活。

## 下一步

1. P1-14 重启恢复 + P1-19 看门狗：心跳已入账但没有规则读它；内核重启后“执行中”的轮次还不会被发现。
2. 飞书真实一轮（P1-09/P1-11 的文字框、适用范围、原地更新取账本正文），然后 P1-10 主理人、P1-13 预算。

## 卡在哪

- Codex 订阅额度已用尽，11 月 14 日恢复；在那之前 GUI 操作做不了。
- 尚未配置 Git 远端，提交只在本地。

## 接手须知

- Node 24 直接跑 `.ts`，strip-only 模式不能用构造器参数属性、enum、namespace。
- 内核只听 `127.0.0.1:7331`；领活要带 `agent`、`at`、`source_id`，返回 `run_id`、`feedback`、`previous`。接单程序不再自己发 `run.claimed`。
- 接单程序的环境变量：`XJ_WORK_ROOT` 工作目录，`XJ_RECORD_DIR` 录下每轮原始 stream-json（用来做新的录制用例）。内核的 `XJ_TICK_MS` 调定时器间隔。
- 本机配置 `xuanji.config.json` 不入库，`claude` 档案写了 `model: claude-haiku-5-5`、`capacity: 1`；权限模式没写，沿用本机 Claude Code 的 `auto`。
- 一期所有任务共用一个工作目录（二期才每任务一个 worktree）。真实一轮里 Agent 在沙盒仓库自建了分支 `feat/greet`，说明共用目录时任务会互相影响。
- 内核启动时对账本跑 `rebuild()` 是人认可的行为（2026-11-12 定），不需要先问；事件表仍然只追加。
- 迟到回执（轮次已不在 running）只记在轮次上；被叫停的轮次不交回执。取舍见 `docs/DECISIONS.md` 2026-11-12 一节。
