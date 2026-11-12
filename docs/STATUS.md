# 当前状态

更新于 2026-11-12 深夜（二期第二批做完，真实一轮通过出口）。每次收工时整份改写，不要追加。

## 现在在哪

二期第二批“验证”做完了：P2-04 Codex 适配器、P2-05 验证在人之前。

- `npm test` 168 个全过。账本快照重放比对一致：只有定时器自增编号的老差异，以及 T-12、T-13 的新列 `base_commit` 被补上（预期）。
- 真实配置 `xuanji.config.json` 加了 `codex` 档案：`kinds: ["review"]`、`gpt-6.1-sol`、`effort: max`、`capacity` 1。
- 内核、接单程序已按顺序重启，跑的是新代码。
- 代码已在本地提交，**没推送**。推送前按“接手须知”查一遍隐私。

做了什么：

- **Codex 适配器（P2-04）**：`worker/adapters/codex.ts`。
  - `--ignore-user-config`，审批 never，`web_search="disabled"`，`--disable` 关掉桌面、浏览器、插件、记忆、子 Agent、hooks。
  - 续接用 `exec resume`，沙箱走 `-c sandbox_mode=`。
  - 每轮读会话文件报 `quota.observed`。`xj status` 现在有“额度 codex”。
- **验证在人之前（P2-05）**：
  - done 回执落账时，内核按配置选验证者写进事件。
  - 有对外动作的先等它们做完。
  - 接单程序在 worktree 里跑检查命令（Bash 禁用规则照用），没过就不请验证者。
  - 过了再起只读 Codex，结论落成 `run.verdict`。
  - 通过出审核卡，验证结论和残余风险写在最前面；没通过带意见开下一轮；三轮不过出决策卡（人定的三个选项）。
  - 验证者没跑成留在验证中重派，连续 3 次出卡。
- **检查命令**：主理人可以提议（目标卡上有“检查命令”一段），人确认才进契约；直接立项的不带。`xj goal --direct "<话>" --check "<命令>"` 可以自己带。
- 取舍都记在 DECISIONS“二期第二批（验证）实现中的取舍”，规则写进了设计文档“验证在人之前”。

**真实一轮通过出口**（G-16/T-14）：

- 目标故意让第一轮写错：先写占位 `Math.floor(a / 2)`，验收要求 `half(3)` 返回 1.5，检查命令 `node --check math.mjs`。
- RN-23 执行（Haiku）→ RN-24 Codex 验证没通过（“half(3) 实测返回 1”）→ RN-25 接上原会话带着意见改正 → RN-26 验证通过 → 审核卡 C-39。
- 两轮验证各约 1 分钟。卡上有验证结论、检查命令结果和残余风险（“未验证非数值输入及 NaN、Infinity”）。
- **C-39 还开着，等人审核**。接受后 worktree `~/xj-worktrees/xj-work/T-14` 清掉，分支 `xj/T-14-math-half-floor` 留着。

## 下一步：第三批 定论与拆分（P2-07、P2-08、P2-09、P2-10）

流程照旧：先问人（一件一件问，每件至少 3 个选项、标推荐项），再写代码和离线用例，重放比对，按顺序重启，真实一轮，收工四件套。

范围（详见 BACKLOG）：

- **定论簿（P2-07）**：按范围注入，可一键作废，不适用必须出卡。
- **规划判断点与任务图（P2-08）**：三个条件都满足才拆，最多 4 个；`awaiting_deps → queued`。
- **合并任务（P2-09）**。
- **目标验收（P2-10）**：可以复用这批的验证者，对整个目标跑一次。

开工前可能要问人的：

- 规划用哪个模型。
- 拆分计划要不要每次都先出卡。
- 目标验收是否复用 Codex 验证者。

## 卡在哪

- **额度**：
  - Claude 周用量 74%（13 日 07:00 重置）。过了降档线，执行只有 1 个、不起子 Agent；再到 80% 只跑人亲自提的目标。
  - Codex 29%（18 日 22:00 重置）。
- **没在真实环境走过的**：
  - 降档（P2-13）。
  - 残余进程检查（P2-14）。
  - 验证者限流（P2-15）。
  - 主理人提议检查命令（P2-16）。
- **真实 GitHub PR 没测**：对外动作，要人指定一个能用的仓库。不挡二期。
- **“等审核时补充”没在真实环境走成**：只有离线用例。
- **整机重启后的登录拉起没验证**：人说以后再说。

## 接手须知

- **真实一轮的目标不要写 sleep**：Claude Code 拦前台 `sleep 30`，Haiku 会改成后台加忙等，可能永远等不到。
- **要故意让验证不通过**：像 T-14 那样在目标里写“第一轮先写占位实现”，比写互相矛盾的验收稳。
- **验证者**：
  - 只在 `verifying` 状态、`verify_due` 等于它的档案名、没有在跑的轮次、对外动作做完时才领得到。
  - 验证轮不占任务的轮数和时长预算，单轮 30 分钟。
  - 验证结论在 `runs.verdict`，`xj why T-x` 能看到 `run.verdict`。
- **Codex 会话文件**：在 `~/.codex/sessions/<年>/<月>/<日>/rollout-*-<会话编号>.jsonl`，只往回找 7 天的目录。
- **每任务 worktree**：
  - 在 `~/xj-worktrees/xj-work/T-x`。
  - 只给新任务建；账本里记的 worktree 被删了，下一轮在原分支上重建。
  - 验证时工作区不在了直接报错，不退回人的工作目录。
- Node 24 直接跑 `.ts`，strip-only 模式不能用构造器参数属性、enum、namespace。
- **三个服务归 launchd 管**：
  - 改代码后重启：先 `launchctl kickstart -k gui/$(id -u)/com.xuanji.kernel`，再 worker。
  - 飞书通道别用 `kill -9`。
- 内核只听 `127.0.0.1:7331`。接口：
  - `POST /events`、`POST /runs/claim`、`POST /judgments/claim`、`POST /effects/claim`
  - `GET /overview|cards|cards/stale|backups`
  - `GET /goals|tasks|runs|cards|judgments|effects/:id`、`GET /why/:ref`
- **归并里的固定阈值**：
  - 心跳超时 3 分钟，单轮宽限 5 分钟，判断点 5 分钟，验证轮 30 分钟。
  - 备份超时 3 小时；对外动作退避 1 分钟、5 分钟。
- **改归并逻辑前后，用账本快照跑 `rebuild()` 比对投影**：
  - 做法：`sqlite3 data/xuanji.db ".backup /tmp/x/live.db"`，复制一份，先用 `openStore` 打开在线副本补上新列，再用新代码 `rebuild()` 另一份，逐表比对。
  - 不能让历史事件少签发或多签发编号。
- 测试和临时账本起内核时设 `XJ_BACKUP_MS=0`。
- **仓库已公开**：
  - 新录制件入库前，先把 open_id、chat_id、本机路径换成占位符。
  - 推送前用 `git diff origin/main..HEAD | grep` 查一遍。
- **`~/xj-work`**：
  - 远端 `origin` = `~/xj-remote/work.git`（本地裸仓库），上面没有 `main`。
  - 当前分支 `feat/greet`，`math.mjs` 有未提交的 greet2、pow 改动（人的，不要动）。
  - 分支 `xj/T-9-cube`、`xj/T-11-explain-cube`、`xj/T-12-bash-sleep-30`、`xj/T-13-bash-sleep-30`、`xj/T-14-math-half-floor` 都在。
