# Bot routines

Routine 的归属是 Bot，执行位置由触发时 Bot 的当前主聊天决定；joined Bot 的主聊天在节点上，主控的 Session 只是镜像。

## 目标和兼容边界

- `schedule-create` 接受新的 `target: {kind:'bot', botId}`。UI 对 Bot 使用此目标，对群聊继续传群 ID。
- 原字符串目标、DSH 保存的 Session 任务、群任务和换 part 的迁移逻辑保持原有路径。
- API 列表合并两类记录；routine 带明确的 Bot target、`botId`、当前 `sessionId`、`lastRun` 和最近 20 次 `runs`。
- 任务界面仍沿用 Scheduled tasks，无需新增导航或设置入口。创建入口继续要求启用 DSH Automation tasks。

## 为什么放在插件里

DSH 的公开 schedule 服务只接受 `session/new_once/new`，触发时直接调用 Agent.followup；它不经过 controller.prompt，也没有 Bot 自定义目标投递 API。不能向 DSH 塞入未知 target 或模拟一个 Agent。

插件把 routine 放入自己的团队状态 `state.routines`，通过现有 `rt.save()` 原子保存。时间验证、每日/每周时区计算、周期推进和遗漏 occurrence 的合并全部使用 `@deepseek-ai/dsh-schedule` 包根公开导出的函数。一个可销毁的 timer 只负责唤醒最近的任务；Host 启动时恢复，无常驻轮询，无第二套 Agent 运行时。写入失败后延迟重试。

## 投递与结果

1. 先持久保存这次 occurrence 的 `queued` 记录及下一触发时间，再向 Bot 串行门入队。
2. 真正执行时重新查 Bot 和当前主聊天。joined 正在写镜像时等待，不打断已有页面回合。
3. 复用 `sendUser`：本地使用 DSH controller.prompt；joined 使用现有 `ensureMirrorSession → startPageTurn → bot/turn`，节点按 remoteBotId 投递到真实主聊天。
4. 节点接收 bot/turn 时也进入自身 Bot 串行门，避免绕过节点跨线程排队。
5. 本地等待自己的 `turn/start` 和 `turn/end`，joined 等待已有远端 done；控制器接受消息不等于运行成功。错误、停止、输出截断、离线均记录失败。接受后 60 秒仍未开始也记录失败。
6. 删除/停止导致的队列取消通过可选 `onCancel` 回调落入失败记录，已有队列调用者无需改变。

界面显示 Bot 名字、上次执行状态和错误；展开可看最近五次，API 保存最近二十次。joined 的答案或执行中失败仍显示在镜像聊天；发送前的拒绝也显示在 routine 的失败记录里。

## 恢复及约束

- 重启发现 queued/running 时记录 interrupted/failed，不自动重发不确定是否已执行的工作。下次周期仍继续；遗漏的多次周期只执行最近一次。
- Host 必须运行；本地模型内容保留在其真实聊天里，routine 记录保留状态及错误。
- joined 的超时和迟到回复沿用页面投递语义：超时记录失败，之后节点的迟到答案仍可补回聊天。
- Peer shadow 尚无可用执行路径，明确拒绝。Bot 消失时保留执行失败供 API 查询。
- 不改 DSH、协议格式、版本号或用户的 DSH 数据。
