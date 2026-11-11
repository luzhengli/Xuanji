# 工作日志

只追加，新的写在最上面。每次工作一条，三到五行：做了什么、结果、留下什么没做。细节不写在这里，写进代码、设计文档或 `DECISIONS.md`。

---

## 2026-11-12 一期闭环经 xj 跑通真实一轮

- 填了四个坑：领活时由内核签发 `run_id`、`GET /goals/:id`、`waiting` 相对时长换算成 `due_at`、`failed` 退避重试与转受阻；另做了 P1-18 关联表、心跳与叫停、续接提示词、限流最小版，`xj` 输出改为可读。
- 真实跑了三轮 `claude-haiku-5-5`（沙盒仓库 `/tmp/xj-real/work`）：T-1 一轮 `done` → C-1 接受 → 任务和目标 done；T-2 先 `ask` → 决策卡 C-3 → 回答后 RN-3 `--resume` 同一会话完成 → C-4 接受。周用量读数 52%。
- 三轮原始输出录成 `test/fixtures/real-*.ndjson`；新增 `test/loop.test.ts`（真 HTTP 接口 + 真 `xj` 子进程 + 回放适配器）和 `test/followup.test.ts`。`npm test` 24 个全过，类型检查通过。
- 没做：飞书真实一轮、主理人、预算、重启恢复、看门狗（心跳已入账但没人读）。人确认启动时重建投影不算先问，并要求提交，已提交到本地 `main`。

## 2026-11-11 S1 通过：卡片点击经长连接收到并原地更新

- 人在开发者后台订阅 `card.action.trigger` 回调后，重跑监听，点击 20 秒内到达；用事件里的 token 把探针卡原地改成结论，接口返回 ok。三项开工前实测至此全部通过。
- 飞书通道补了 `parseCardClick`（只认本人、解析 `action_value`）和 `updateInPlace`；录制事件作 fixture，测试 11 个通过。设计文档“尚待确认”和 BACKLOG 的 S1、P1-11 已更新。
- 中途试过让 Codex 代点订阅页面，其额度已用尽（至 11-14），按约定停止改由人手动完成。
- 没做：真实一轮未跑。本次改动已按人的要求提交到本地 `main`。

## 2026-11-11 提交一期代码框架

- 按人的要求，将一期代码框架、测试、配置样例、部署模板及配套设计与进展文档纳入 `feat(core)` 约定式提交。
- 提交前复跑 `npm test`（10 个通过）和 `npm run typecheck`（通过），补充真实配置 `xuanji.config.json` 的忽略规则。
- 同步交接状态与待办；S1 卡片点击、真实进程闭环及已有 TODO 仍待完成，尚未配置远端。

## 2026-11-11 实测 S1–S3，搭起代码框架

- 确认当前机器就是 Mac mini。S2 通过：无界面一轮拿到回执和会话编号，`--resume` 续接成功。S3 结论反转：状态栏脚本无界面时不被调用，但 `stream-json` 里的 `rate_limit_event` 直接给周用量，设计文档改为这条路。
- S1 一半：消息接收经长连接已通；卡片点击需在开发者后台订阅 `card.action.trigger`（lark-cli 给的订阅链接：`https://open.feishu.cn/page/launcher?clientID=cli_0000000000000000&addons=H4sIAAAAAAAA_6pWSk7MyUlKTM4uVrKqVsosSc0tVrKKVkpOLErRS0wuyczP0yspykxPTy1Siq2tBQQAAP__he-Iai8AAAA`）。探针卡已发到私聊。
- 代码框架：`src/{kernel,worker,channels,sources}`、`test/`（10 个通过）、`deploy/`、`scripts/backup.ts`，零运行时依赖，`tsc` 干净。`xj goal` 立项、重启重建账本手工跑通。
- 没做：三个进程没有串起来跑真实一轮；S1 点击未收到；未提交。

## 2026-11-11 初始化 Git 并创建约定式提交

- 初始化本地 Git 仓库，默认分支为 `main`，首次提交采用 `chore(repo): ...` 格式。
- 纳入现有设计文档、协作约定、进展记录、图片及 `CLAUDE.md` 符号链接；保留原有忽略规则，补充环境变量文件忽略规则。
- 同步状态和待办；尚未配置远端，三项开工前实测及代码实现仍未开展。

## 2026-11-11 设计定稿，建立进展文件

- 设计文档按人的十二条决定定稿，含部署、备份与恢复、额度与计费、飞书通道。
- 核实了三处事实：飞书通道靠 lark-cli 长连接、Claude Code 订阅的用途说明、周用量可从状态栏数据读到。
- 新建 `docs/` 下的状态、待办、决定、日志四个文件；在已有的 `AGENTS.md` 里加了分层阅读顺序、章节索引和收工规则，原有的多 Agent 协作约定原样保留。
- 没做：代码一行没写；三项开工前的实测没做；仓库没初始化 git。

## 2026-11-10 设计起草

- 读了两个参考仓库和两篇文章，写出设计文档初稿和三张图。
