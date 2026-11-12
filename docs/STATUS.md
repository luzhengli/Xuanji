# 当前状态

更新于 2026-11-12（结束一期，做完 Codex 实测和 P1-33 权限隔离）。每次收工时整份改写，不要追加。

## 现在在哪

人定结束一期，P1-12 转成二期的观察项。现在是二期 · 并行，已拆成 P2-00 至 P2-12，还没开工写代码。

Codex 实测（BACKLOG S4）四项都通过，录制件在 `test/fixtures/codex-*.jsonl`：
- 无界面跑一轮，`-o` 取到回执。
- `exec resume` 接上原会话。
- 只读沙箱下检查命令能跑、写文件被拦，可以做验证者。
- 周用量从会话文件 `~/.codex/sessions/.../rollout-*.jsonl` 的 `token_count.rate_limits` 读，当前 29%，11-18 重置。

接入时注意：
- 关掉 stdin。
- 续接不认 `-C`，进程 cwd 要设成工作目录。
- 用 `-c notify=[]` 关掉人配置里的桌面通知。

结束一期后补了 P1-33（安全补漏）：
- 系统起的 Claude Code 进程按角色给最小权限：执行轮用工具允许清单，Bash 禁掉推送、改 PR、lark-cli、claude、codex、crontab、launchctl、at、osascript。
- 所有进程不加载人的用户级设置和 MCP，执行轮权限模式显式用 auto。
- 真实实测通过。

一期的内容见 BACKLOG 和 LOG。`npm test` 132 个全过。

Codex 用量读法人已确认：桌面版显示“剩余 71%”，即已用 29%。

## 下一步

1. 二期已拆成 P2-00 至 P2-12（BACKLOG）。人定的三件事（并发、worktree、背压）都在 DECISIONS 和设计文档里。
2. 从 P2-01（并发进配置）和 P2-02（每任务 worktree）开工，再做 P2-03 租约。
3. 然后做 P2-04 Codex 适配器和 P2-05 验证者。Codex 周用量 29%，可以用。

## 卡在哪

- **真实 GitHub PR 没测**：这是对外动作，要人指定一个能用的仓库。
- **“等审核时补充”没在真实环境走成**：只有离线用例。
- **整机重启后的登录拉起没验证**：人说以后再说。
- 周用量：Claude Code 67%，Codex 29%；上限 80%。

## 接手须知

- Node 24 直接跑 `.ts`，strip-only 模式不能用构造器参数属性、enum、namespace。
- 三个服务归 launchd 管：不要再手动 `npm run kernel` 等。
  - 改代码后重启用 `launchctl kickstart -k gui/$(id -u)/com.xuanji.kernel`（worker 同理）。
  - 先重启内核再重启接单程序，否则旧接单程序可能抢先领走刚回队列的任务（实测 RN-17，被重启恢复接住了）。
  - 飞书通道别用 `kill -9`。
- 内核只听 `127.0.0.1:7331`。接口：
  - `POST /events`、`POST /runs/claim`、`POST /judgments/claim`、`POST /effects/claim`
  - `GET /overview|cards|cards/stale|backups`
  - `GET /goals|tasks|runs|cards|judgments|effects/:id`、`GET /why/:ref`
- 归并里的固定阈值：
  - 心跳超时 3 分钟，单轮宽限 5 分钟，判断点 5 分钟。
  - 备份超时 3 小时。
  - 对外动作退避 1 分钟、5 分钟。
- 改归并逻辑前后，用账本快照跑一遍 `rebuild()` 比对投影。内核启动时会重建，规则改了，历史投影跟着变。
  - 不能让历史事件少签发或多签发编号（卡片、任务、对外动作），否则后面引用编号的事件会对不上。
- 测试和临时账本起内核时设 `XJ_BACKUP_MS=0`。
- Claude Code 即使 `--tools ""`，也把工作目录的 git 状态放进系统提示词。
- 仓库已公开。新录制件入库前，先把 open_id、chat_id、本机路径换成占位符，格式照 `test/feishu.test.ts` 的 `OWNER`。
- `~/xj-work`：
  - 有远端 `origin` = `~/xj-remote/work.git`（本地裸仓库，不是 GitHub）。
  - 当前分支 `feat/greet`，`math.mjs` 有未提交的 greet2、pow 改动。
  - 分支 `xj/T-9-cube`、`xj/T-11-explain-cube` 还在，它们的 worktree 已删。
