# 当前状态

更新于 2026-11-12 深夜（二期第一批做完，第二批要问的三件事已定）。每次收工时整份改写，不要追加。

## 现在在哪

二期第一批“调度与隔离”做完了：P2-01、P2-06、P2-02、P2-03。

- `npm test` 148 个全过。账本快照重放比对一致（只有定时器自增编号的老差异）。
- 内核、接单程序已重启，跑的是新代码。
- 代码已在本地提交，**没推送**。推送前按“接手须知”查一遍隐私。

做了什么：

- **并发和降档（P2-01）**
  - 执行同时 2 个，每目标 1 个，全部放配置。真实配置 `xuanji.config.json` 已改：`capacity` 2，`worktree_root`，新的 `limits`。
  - 周用量过 60% 执行降为 1，领活结果带 `subagents: false`，接单程序去掉 `Task`/`Agent` 并改提示词。
  - 过 80% 只跑人亲自提的目标（立项事件来自 human、feishu、cli）。
- **背压（P2-06）**
  - 软上限 5 不开新任务的第一轮，硬上限 8 只放行带人回答的。
  - 领活顺序：带人回答的 > 验证 > 在做的 > 新任务。
  - 简报和 `/status` 写“队列满了，N 件新活在排队”。
- **每任务一个 worktree（P2-02）**
  - 接单程序在第一轮前建 `~/xj-worktrees/<仓库名>/T-x`，发 `workspace.prepared` 落账。
  - 接受后照 P1-28 清理，在主仓库里执行。
  - 主理人目标卡支持 `base`。
- **租约（P2-03）**
  - 领活时登记、轮次结束释放；`**` 只在同一目标内比；具名资源用 `scope.exclusive`。
  - 起新一轮前用 `lsof` 查工作区里的残留进程。
- 接单程序改成并行领活：`Worker.begin`，`main.ts` 的 `executions()`。

**真实一轮通过。** 人同意把降档线临时调到 0.7，跑完已改回 0.6。

- G-14/T-12、G-15/T-13 同时在跑，各在自己的 worktree，从本地 `main` 拉（远端没有主干）。
- 都出审核卡；接受后 worktree 清掉，分支 `xj/T-12-bash-sleep-30`、`xj/T-13-bash-sleep-30` 留着。
- 分支简述已改成优先取文件名和函数名，下次会是 `math-half` 这样。

## 下一步：第二批 验证（P2-04、P2-05）

流程和第一批一样：先问人，再写代码和离线用例，重放比对，按顺序重启，真实一轮，收工四件套。

范围：

- **Codex 适配器（P2-04）**
  - `--ignore-user-config`；验证轮 `-s read-only -c approval_policy="never"`，关 web search（配置项要实测核对）。
  - 每轮读会话文件，报 `quota.observed`。
  - 录制件 `test/fixtures/codex-*.jsonl`。
- **验证在人之前（P2-05）**
  - 检查命令由接单程序在任务的 worktree 里跑。
  - Codex 只读审查，对照验收标准，列残余风险；不通过带意见开下一轮，最多 3 轮。
  - 通过才出审核卡，卡上原样展示残余风险。
- 调度这边已经留好位置：领活顺序里有 verify 道，配置有 `verify_concurrency`。验证轮要从 `verifying` 状态领，现在 `pickNext` 只领 `queued`。

**开工前的三件事已经定了**（2026-11-12，原话见 DECISIONS，规则写进了设计文档“验证在人之前”）：

1. 验证者用 Codex `gpt-6.1-sol`，强度 `max`，放配置。
2. 检查命令由主理人提议、写在目标卡上，人确认目标卡才跑；直接立项的不带命令。命令只在任务 worktree 里跑。
3. 验证三轮不过，出决策卡“再给 3 轮 / 按现状审核 / 放弃”，推荐按现状审核。

新会话可以直接开工，不用再问这三件。以后要问人时，一件一件问，每件至少 3 个选项，并标出推荐项（人要求）。

出口：真实一轮里故意给一个不满足验收的目标，看验证者退回、下一轮修好、再出审核卡。

## 卡在哪

- **额度**：
  - Claude 周用量 70%（13 日 07:00 重置）。现在过了降档线，执行只有 1 个、不起子 Agent。
  - Codex 29%（18 日 22:00 重置）。
- **降档、残余进程检查都没在真实环境走过**：见 BACKLOG P2-13、P2-14。
- **真实 GitHub PR 没测**：对外动作，要人指定一个能用的仓库。不挡二期。
- **“等审核时补充”没在真实环境走成**：只有离线用例。
- **整机重启后的登录拉起没验证**：人说以后再说。

## 接手须知

- **真实一轮的目标不要写 sleep。** Claude Code 现在拦前台 `sleep 30`。Haiku 会改用后台运行，再写个忙等循环等输出文件，sleep 没输出就永远等不到（实测 T-12 卡了 4 分钟，结束那个 zsh 忙等进程才交回执）。
- 每任务 worktree：
  - 在 `~/xj-worktrees/xj-work/T-x`。
  - 只给新任务建（没有会话、没有上一轮回执）；二期前开始的任务照旧在 `XJ_WORK_ROOT`。
  - 账本里记的 worktree 被删了，下一轮在原分支上重建。
- 背压和降档的上限都在配置里，只影响调度。简报里的背压一行用的上限，在 `brief.due` 落账时写进事件，重放不变。
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
  - 做法：`sqlite3 data/xuanji.db ".backup /tmp/x/live.db"`，复制一份，用新代码 `rebuild()`，逐表比对。定时器自增编号的差异以前就有，不算。
  - 不能让历史事件少签发或多签发编号（卡片、任务、对外动作），否则后面引用编号的事件会对不上。需要“不建”时，改成建了立即收起（见 P1-30）。
- 测试和临时账本起内核时设 `XJ_BACKUP_MS=0`。
- Claude Code 即使 `--tools ""`，也把工作目录的 git 状态放进系统提示词。
- 仓库已公开。新录制件入库前，先把 open_id、chat_id、本机路径换成占位符，格式照 `test/feishu.test.ts` 的 `OWNER`；推送前用 `git diff origin/main..HEAD | grep` 查一遍。
- `~/xj-work`：
  - 有远端 `origin` = `~/xj-remote/work.git`（本地裸仓库，不是 GitHub），上面没有 `main`。
  - 当前分支 `feat/greet`，`math.mjs` 有未提交的 greet2、pow 改动（人的，不要动）。
  - 分支 `xj/T-9-cube`、`xj/T-11-explain-cube`、`xj/T-12-bash-sleep-30`、`xj/T-13-bash-sleep-30` 还在，它们的 worktree 都已删。
