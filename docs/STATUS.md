# 当前状态

更新于 2026-11-12（一期收尾）。每次收工时整份改写，不要追加。

## 现在在哪

一期收尾了，只剩 P1-12：真实限流还没遇到，等遇到时核对。出口标准“一件事从提出到验收，人不打开任何 Agent 会话”已经多次做到。`npm test` 130 个全过，`npm run typecheck` 通过。三个服务已用新代码重启。

这次做的：

- **P1-27 飞书卡片主动改成现状**
  - 卡片新增 `shown` 列，记飞书上最后显示的状态。
  - `GET /cards/stale` 列出已送达、账本里已关闭、飞书上还没改的卡片。
  - 通道每 10 秒用 `lark-cli im messages patch` 把它们改成结论，再报 `card.refreshed`。每个状态只改一次，改不成也只记下。
  - 上线时 18 张旧卡片都改成功了。
- **P1-28 Agent 建的 worktree**
  - 接单程序每轮结束跑 `git worktree list`，名字带任务编号的随回执上报。
  - 审核卡第二行列出这些 worktree。
  - 任务结束后排 `remove-worktree`（借 effects 表），有未提交改动的不删，出知会卡，分支始终保留。
  - 只有离线用例。T-9、T-11 遗留的两个已手动删掉。
- **P1-29**：回执约定写明“授权是上限”。远端不是 GitHub 时开 PR 记为没执行，不出卡。
- **P1-30**：同名“发现”跨任务时，建卡后立即收起。不能干脆不建，否则重放时卡片编号会变。
- **P1-32 开源清理**（人定：MIT、脱敏并改写历史、docs 公开）
  - 加了 LICENSE。
  - open_id、chat_id、应用编号和本机用户目录都换成占位符。
  - 改写全部提交后强推 `main`。
  - 原样打包在本机 `~/xj-pre-scrub-20261112.bundle`。确认 GitHub 上没问题后可以删。
- 真实账本重放（1474 条）：差异只有 C-35 变成收起，外加定时器自增编号一处，这一处以前就有。

## 下一步

1. 和人商量二期 · 并行开工。二期的条目见 BACKLOG：
   - 规划与任务契约。
   - 上下文包与定论簿。
   - 每任务一个 worktree 和租约。
   - 接入 Codex 做验证者。
   - 背压。
   - 运行途中的新输入。
   Codex 订阅额度 11 月 14 日恢复。
2. 二期开工前，可以先在真实环境走一轮 P1-28：让 Agent 建一个 worktree，看审核卡和清理。
3. 真实遇到限流时核对 P1-12。

## 卡在哪

- **真实 GitHub PR 没测**：这是对外动作，要人指定一个能用的仓库。
- **“等审核时补充”没在真实环境走成**：只有离线用例。
- **整机重启后的登录拉起没验证**：人说以后再说。
- 周用量读数 63%，上限 80%。

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
