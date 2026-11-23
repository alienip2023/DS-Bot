# dsh + ds-bot 与 Grok Bot 的能力对比

## 已实现、与 Grok Bot 对齐的部分

- **长期身份**：每个 Bot 是独立的 dsh session，有名字、角色、指令、模型和外观，跨会话持久。
- **Bot 间能派活**：`message_bot` / `create_bot` / `update_bot`；权限层级清晰（用户 → Main Bot → Group admin → Member）。
- **群聊**：一次一人发言，`@` 传棒，无话可说回 `[PASS]`；每个成员在群里另有隐藏 session，群聊读不到它的私聊。
- **上下文管家**：不走 dsh 自身 compaction。过 `checkRatio` 后由一次小模型调用判断——工作未完就原地压成 checkpoint，已到停顿点就交接 session 并开新 part。长对话不断片，旧 part 进 FTS5 全文索引可搜。
- **三层记忆**：Bot / 群 / 团队。
- **IM 接入**：飞书、钉钉、企业微信、微信、QQ、Telegram、Discord、Slack 共 8 个平台，消息可从手机/PC IM 进入 Bot，Bot 可回复到 IM 频道，这是真实的移动端推送入口。
- **移动端 API**：`mobile.js` 实现了专用的移动 Web API（增量通知 `notices`、群聊作为 display items、profile 图片引用、历史翻页），移动 Web 客户端可全功能接入。
- **定时任务（有限的 routine）**：`bot-routines.js` 实现 Bot 级定时执行——用 `schedule_create` 给 Bot 设好定时提示，Bot 按时在自己的 session 里跑，不需要用户在场。
- **受限的主动唤醒**：`waker.js` 实现事件驱动的唤醒路由——群目标空闲（`goal/idle`）时自动催群 admin；`handoffs.js` 记录超时未回应的委托（`abandonedWorks`）；goal relay 在无人跑时自动 nudge。

## 仍有差距的四项

| 能力 | Grok Bot | dsh + ds-bot 现状 | 准确描述 |
|---|---|---|---|
| **常驻执行** | 每个 Bot 有自己的云端电脑，24/7 跑，人走开任务不停 | Bot 生命周期绑在本地 dsh 进程上，合盖即停。**节点 Bot**（Linux 节点上的 Bot）的任务可在主控关闭后继续在节点执行，任务状态由节点持有，主控重连后自动同步 | 通用常驻未实现；节点 Bot 任务是唯一的离线执行路径 |
| **多端同线程** | 手机/桌面同一 thread，消息无缝衔接 | 本地 Web + Desktop 共享 session，8 个 IM 平台接入（消息可进出 IM），移动 Web API 存在。**缺的是**：原生推送（APNS/FCM）和原生手机 App；IM 接入需手动配置，不是开箱即用 | 有 IM 和移动 Web 入口，缺原生 App 和推送 |
| **跟做一次 → routine 自己跑** | 看你演示一遍，固化成 routine 自己跑 | 有 `schedule_create` 可手动建定时任务，`ralph` / subagent 可委托子任务，`bot-routines.js` 执行定时 Bot 任务。**缺的是**：「演示一次 → 自动学习 → 生成 routine」这条 pipeline；目前需要用户手动配置定时任务 | 有定时执行基础，缺录制—抽象—固化流程 |
| **主动性** | 自己捡起冷掉的 thread、催 stalled handoff | `waker.js` 在目标空闲时自动催群 admin；`handoffs.js` 超时后标 abandoned 并通知上游。**缺的是**：Bot 主动去捡已冷却的个人 thread（非群目标），以及 Bot 主动推进 stalled 委托而不等用户触发 | 群目标有主动唤醒，个人 thread 冷却后仍需用户推 |

## 小结

Grok Bot 比较表里说的「只有本地 Web / Desktop，无 IM 或移动入口」是低估了现有实现——8 个 IM 平台和移动 Web API 已实现。真正的差距是：通用 Bot 常驻（非节点路径）、原生手机 App、录制→routine pipeline、以及个人 thread 的主动唤醒。
