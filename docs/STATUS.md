# 当前状态

更新于 2026-11-11（晚，提交代码框架）。每次收工时整份改写，不要追加。

## 现在在哪

一期代码框架已纳入 `main` 分支的约定式提交。本次复跑 `npm test`，10 个测试全部通过；`npm run typecheck` 通过。各进程仍是骨架，尚未跑通真实的一轮。

- 前次实测确认这台机器就是 Mac mini（`hw.model` = Mac16,10，Node v24.19.0，Claude Code 2.1.322，lark-cli 1.0.100，Codex 0.167.0）；本次复核 Node 为 v24.19.0。
- **S2 通过**：前次以 `claude -p --output-format stream-json --verbose` 取到 `result.result` 和 `session_id`，并成功 `--resume <id>`；录制输出在 `test/fixtures/`，本次解析测试通过。
- **S3 已验证**：前次实测无界面时状态栏脚本不会被调用，改从 `rate_limit_event` 读取周用量和重置时间；设计文档已同步，本次解析测试通过。
- **S1 待补完**：前次长连接已收到消息；`card.action.trigger` 因开发者后台未订阅回调而被拒绝。探针卡已发到私聊（message_id `om_x100b60726c3194a0ce30e02526d5b24`），仍需订阅并点击验证。
- **代码范围**：`src/kernel`、`src/worker`、`src/channels`、定时器来源、三个 launchd plist、备份脚本。前次手工跑通 `xj goal` 立项与重启重建账本；本次仅运行离线测试及类型检查。

## 下一步

1. 在开发者后台订阅 `card.action.trigger`（链接见 `docs/LOG.md`），重跑 `lark-cli event consume card.action.trigger --as bot --max-events 1 --timeout 600s` 并点击探针卡，完成 S1。
2. 修复接单骨架中 `run_id` 和目标查询的 TODO，再串起内核、worker 和 `xj goal` 跑真实一轮，核对回执入账与审核卡生成。
3. 继续完成 P1-05 到 P1-09 的接单、适配、回执、挂起续接与卡片功能。

## 卡在哪

- S1 等本人扫码订阅飞书回调。
- `xj why <编号>` 查不到立项事件；归并签发编号后尚未建立事件关联表，已记录为 P1-18。
- 尚未配置 Git 远端，本次仅提交到本地。

## 接手须知

- Node 24 直接跑 `.ts`，strip-only 模式不能用构造器参数属性、enum、namespace；`erasableSyntaxOnly` 会在类型检查时拦住。
- 内核只听 `127.0.0.1:7331`，来源、接单程序、通道通过 HTTP 访问；事件 `source_id` 由客户端生成以去重。
- 真实配置使用 `xuanji.config.json`，已加入忽略规则；样例 `xuanji.config.example.json` 入库。本人 `owner_open_id` 沿用前次记录的 `ou_00000000000000000000000000000001`。
- 迟到回执只记轮次、不改任务状态、不出卡，相关取舍见 `docs/DECISIONS.md`。
- `.firecrawl/` 只读且不入库；设计文档三张图的源在在线文档中。
