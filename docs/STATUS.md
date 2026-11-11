# 当前状态

更新于 2026-11-12（飞书真实一轮通过）。每次收工时整份改写，不要追加。

## 现在在哪

一期闭环已经经 `xj`（`5548993`）和飞书各真实跑通一轮，重启恢复与看门狗已做（`975c302`）。这次的飞书通道改动已按人的确认提交到本地 `main`。`npm test` 48 个通过，`npm run typecheck` 通过。

- **飞书通道（P1-09、P1-11）**：私聊一句话直接立项（人定，P1-10 主理人之前的过渡），回“已立项 G-x · T-x”。`/card`（卡片、待办）发来待处理的决策卡和审核卡，知会卡只列标题；`/status`（状态、进度）看全局；`/help`、`/goal`。决策卡主动推一次，审核卡不推。卡片整张是表单：文字框，决策卡另有适用范围和“用上面这句话回答”；回答后按账本原地改成结论。
- **飞书真实一轮（人操作）**：div 走审核路径（G-6/T-6，C-12 接受）；greet2 走决策路径（G-7/T-7，C-13 推来后点“中文”，RN-12 以 `--resume` 接上 RN-11 的会话，C-14 接受）；`/status` 显示都 done。周用量 55%。
- **录制件**：`test/fixtures/feishu-real-messages.ndjson`、`feishu-real-clicks.ndjson`（token 已打码）。真实事件证实：私聊文字的 `content` 是纯文本；表单按钮回调带 `action_name` 和 `form_value`（JSON 字符串），没有 `action_value`。

## 下一步

1. P1-10 主理人：把一句话整理成目标卡请人确认（替换现在的直接立项）；P1-13 预算。
2. P1-22 知会卡收起；P1-15 备份、P1-16 部署、P1-17 简报；最后 P1-21 对外动作先落账（人定留在一期，排在这些之后）。

## 卡在哪

- 文字框写了字再交的情形没在真实环境走过（机制已由真实事件证实，下次用到时顺带看一眼）。
- Codex 订阅额度已用尽，11 月 14 日恢复；在那之前 GUI 操作做不了。
- 尚未配置 Git 远端，提交只在本地。

## 接手须知

- Node 24 直接跑 `.ts`，strip-only 模式不能用构造器参数属性、enum、namespace。
- 三个进程：`npm run kernel`、`npm run worker`（`XJ_WORK_ROOT` 工作目录，`XJ_WORKER_NAME` 默认 `local`）、`npm run feishu`。`XJ_RECORD_DIR` 设了就录原始输出：接单程序录 Claude Code 的 stream-json，飞书通道录收到的事件。停飞书通道用 SIGTERM，lark-cli 提示 `kill -9` 可能在服务端留下订阅。
- 内核只听 `127.0.0.1:7331`；`POST /events` 返回 `seq`、`duplicate`、`refs`（这条事件挂上的编号）；`GET /goals|tasks|runs|cards/:id`。领活要带 `agent`、`at`、`source_id`（接单程序再带 `worker`、`instance`）。
- 飞书事件的来源编号：消息 `msg:<message_id>`，点击 `click:<event_id>`，送达 `delivered:<message_id>`；重投时内核去重。飞书卡片按钮名 `xj_C_<n>_o<序号>` / `xj_C_<n>_text`。
- 看门狗阈值是归并里的常量（`HEARTBEAT_TIMEOUT_MS`、`RUN_GRACE_MS`），不在配置里。
- 本机配置 `xuanji.config.json` 不入库，`claude` 档案写了 `model: claude-haiku-5-5`、`capacity: 1`；权限模式沿用本机 Claude Code 的 `auto`。
- 一期所有任务共用沙盒工作目录 `/tmp/xj-real/work`，Agent 在分支 `feat/greet` 上提交。T-7 的目标没要求提交，所以 greet2 还是未提交的改动。
- 内核启动时对账本跑 `rebuild()` 是人认可的行为（2026-11-12 定）；事件表只追加。
