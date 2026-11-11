# 当前状态

更新于 2026-11-12（第二批备份、部署做完，三个服务已由 launchd 托管）。每次收工时整份改写，不要追加。

## 现在在哪

一期除 P1-21 外的主线都做完了。第一批（主理人、预算、简报、知会卡收起、心跳折叠）已提交为 `8fbf25a`，第二批（P1-15 备份、P1-16 部署）随后提交。`npm test` 97 个通过，`npm run typecheck` 通过（现在也查 `scripts/`）。

- **备份（P1-15）**：`src/ops/backup.ts` 作为来源跑在内核进程里。启动 1 分钟后备份一次，之后每小时一次，快照放在 `data/backups/`，保留 48 份。快照之后，如果上次演练通过已超过 7 天就再演练一次：在临时副本上跑完整性检查，从事件日志重建投影，逐表比对。结果报成 `backup.done`、`backup.failed`、`backup.drilled`。快照失败、超过 3 小时没有成功、演练没通过，都出推送的异常卡，恢复正常后撤回。`xj status` 和简报里有备份一行。手动备份用 `npm run backup [-- --drill]`；`npm run restore [快照]` 列出或换上快照，内核在跑时拒绝动手。
- **部署（P1-16）**：`com.xuanji.kernel`、`com.xuanji.worker`、`com.xuanji.feishu` 已装进 `~/Library/LaunchAgents`，人点过头。接单程序名 `local`，工作目录 `~/xj-work`，是人定的，从 `/tmp/xj-real/work` 连 git 历史拷来。日志在 `data/logs/`。`node scripts/launchd.ts status` 看状态，`uninstall` 整套撤掉。
- **真实验证**：真实账本第一次备份和演练通过，213 条事件，投影一致。`kill -9` 内核和接单程序后，launchd 在 15 秒内重新拉起，账本记下 `kernel.restarted` 和 `worker.started`。人在飞书里发 `/status`，launchd 下的飞书通道收发正常，回复里带着备份一行。
- **人新定的**：以后用中文交流，技术词汇可用英文，已写进 AGENTS.md。

## 下一步

1. **第三批：P1-21 对外动作先落账后执行**，排在最后、无人值守之前。要让 push、开 PR 改由接单程序代为执行，先落账再做，带幂等键重试。
2. 小项：P1-23 目标卡待确认时的补充被当成新目标；P1-24 任务停掉或接管后目标一直 active；P1-25 内核停机时飞书消息会丢；P1-26 日志不轮转。

## 卡在哪

- **整机重启后登录拉起还没验证。** 人说以后再说。到时登录后跑 `node scripts/launchd.ts status` 和 `xj status`。
- **09:00 的自动简报还没在真实环境见过。** 今天 09:00 应收到“简报 2026-11-12”；没收到就查 `data/logs/kernel.log`。
- 周用量读数 58%，上限 80%。Codex 订阅额度 11 月 14 日恢复。尚未配置 Git 远端。

## 接手须知

- Node 24 直接跑 `.ts`，strip-only 模式不能用构造器参数属性、enum、namespace。
- 三个服务归 launchd 管：不要再手动 `npm run kernel` 等，否则端口冲突，接单程序也会重名。要改代码后重启，用 `launchctl kickstart -k gui/$(id -u)/com.xuanji.kernel`（worker、feishu 同理），或重跑 `node scripts/launchd.ts install --work-root ~/xj-work`。飞书通道别用 `kill -9`。
- 内核只听 `127.0.0.1:7331`。接口：`POST /events`、`POST /runs/claim`、`POST /judgments/claim`、`GET /overview|cards|backups`、`GET /goals|tasks|runs|cards|judgments/:id`、`GET /why/:ref`。
- 归并里的固定阈值：心跳超时 3 分钟、单轮宽限 5 分钟、判断点 5 分钟、备份超时 3 小时（`BACKUP_STALE_MS`）。
- 测试和临时账本起内核时设 `XJ_BACKUP_MS=0` 关掉备份来源，免得往配置里的备份目录写快照。
- Claude Code 即使 `--tools ""`，也把工作目录的 git 状态放进系统提示词。
- `~/xj-work` 里 `math.mjs` 有未提交的 greet2 和 pow 改动（T-7、T-8 的目标都没要求提交）。
- 内核启动时对账本跑 `rebuild()` 是人认可的行为；事件表只追加。
