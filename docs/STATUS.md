# 当前状态

更新于 2026-11-11（晚，S1 通过）。每次收工时整份改写，不要追加。

## 现在在哪

三项开工前实测全部通过。一期代码框架已在 `main`（`5e1b86d`），飞书点击解析、原地更新和录制测试已随后提交。`npm test` 11 个通过，`npm run typecheck` 通过。各进程仍是骨架，尚未跑通真实的一轮。

- 前次实测确认这台机器就是 Mac mini（`hw.model` = Mac16,10，Node v24.19.0，Claude Code 2.1.322，lark-cli 1.0.100，Codex 0.167.0）；本次复核 Node 为 v24.19.0。
- **S2 通过**：前次以 `claude -p --output-format stream-json --verbose` 取到 `result.result` 和 `session_id`，并成功 `--resume <id>`；录制输出在 `test/fixtures/`，本次解析测试通过。
- **S3 已验证**：前次实测无界面时状态栏脚本不会被调用，改从 `rate_limit_event` 读取周用量和重置时间；设计文档已同步，本次解析测试通过。
- **S1 通过**：你在开发者后台订阅 `card.action.trigger` 后，点击经 lark-cli 长连接收到（`operator_id`、`message_id`、`action_value` 是 JSON 字符串、30 分钟 token），并用 token 调 `/open-apis/interactive/v1/card/update` 把探针卡原地改成了结论。事件录在 `test/fixtures/feishu-card-click.json`，`parseCardClick` 有测试。
- **代码范围**：`src/kernel`、`src/worker`、`src/channels`、定时器来源、三个 launchd plist、备份脚本。前次手工跑通 `xj goal` 立项与重启重建账本；本次仅运行离线测试及类型检查。

## 下一步

1. 修复接单骨架中 `run_id` 和目标查询的 TODO，再串起内核、worker 和 `xj goal` 跑真实一轮，核对回执入账与审核卡生成。
2. 继续完成 P1-05 到 P1-09 的接单、适配、回执、挂起续接与卡片功能。

## 卡在哪

- Codex 订阅额度已用尽，11 月 14 日恢复；在那之前 GUI 操作做不了（约定不许用别的工具代替）。
- `xj why <编号>` 查不到立项事件；归并签发编号后尚未建立事件关联表，已记录为 P1-18。
- 尚未配置 Git 远端，提交只在本地。

## 接手须知

- Node 24 直接跑 `.ts`，strip-only 模式不能用构造器参数属性、enum、namespace；`erasableSyntaxOnly` 会在类型检查时拦住。
- 内核只听 `127.0.0.1:7331`，来源、接单程序、通道通过 HTTP 访问；事件 `source_id` 由客户端生成以去重。
- 真实配置使用 `xuanji.config.json`，已加入忽略规则；样例 `xuanji.config.example.json` 入库。本人 `owner_open_id` 沿用前次记录的 `ou_00000000000000000000000000000001`。
- 迟到回执只记轮次、不改任务状态、不出卡，相关取舍见 `docs/DECISIONS.md`。
- `.firecrawl/` 只读且不入库；设计文档三张图的源在在线文档中。
