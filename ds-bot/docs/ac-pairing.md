# ds-bot 与 AC（dsh-ai-cluster）的配套版本

主控和每个节点都要装配套的两个插件。ds-bot 读取节点 hello 里的能力（`caps`）和 `acVersion`（AC 0.4.28 起上报）：AC 不够新的节点会在 Bot 列表里被标出「需要升级」（`nodeCompat`），并带上它报告的版本和需要的版本；缺哪项能力，对应功能就退回到节点能做的事，并如实告诉用户，不会悄悄只做一半。

| ds-bot | 需要的 AC（主控和节点） | 这一版新增的依赖 |
| --- | --- | --- |
| 0.3.10-fork.99～100 | 0.4.19 | 节点 Bot 与主控 Bot 一致所需的帧（`bot/action`、`bot/turn` 的 `mode`、名册卡片） |
| 0.3.10-fork.101～102 | 0.4.21 | `bot/trace`（思考过程与工具步骤） |
| 0.3.10-fork.103～106 | 0.4.26 | `bot/attach`（图片和文件）；0.4.26 起附件不加密不发、不被后面的回合反超、旧 ds-bot 不会悄悄丢附件 |
| 0.3.10-fork.107 | 0.4.27 | 节点模型能力落盘（节点上的模型能读图片）；节点没有主 Bot |
| 0.3.10-fork.108 | 0.4.28 | `acVersion` 和 `config-models/1`：主控据此精确判断哪台节点的 AC 不够新 |
| 0.3.10-fork.109 | 0.4.29 | 安全加固：@路径附件拒绝符号链接遍历（`lstat` 替代 `stat`）、扩充受保护目录名单（`.npm`/`.gitconfig`/`.cursor` 等）、TOCTOU 安全读取（同一 fd 的 open+fstat+read）、bot/attach 大附件背压、roster Bot id 上限 80→200、D2 lsof/ps 改异步防事件循环阻塞、node-team 首次检查 500ms→100ms |
| 0.3.10-fork.110 | 0.4.30 | `bot/stream`（`bot-stream/1`）：节点 Bot 回答逐字流式到主控页面；`record_routine` 工具：一句话把当前任务固化为定时 routine；stalled handoff 双阶段定时器（25分钟 nudge delegatee，30分钟通知 sender）；`mirrorTurnStream` 增量写入镜像回合 |
| 0.3.10-fork.111 | 0.4.31 | 持久机器身份（`machine-identity/1`）、LAN 自动发现（`lan-discovery/1`）、配对码（`pairing/1`）；节点 E2E 未就绪时 `bot/turn` 立即失败而不是等到超时 |
| 0.3.10-fork.112 | 0.4.33 | `bot-locate/1`：节点为每个 Bot 配发可迁移的 ed25519 身份（名册带 `identityId`），主控用 `locate_bot` 定位 Bot 并以 Bot 自己的签名验证；AC 每回合写步骤日志（`bot_journal` 可读）；`dshbot1://` 配对串格式（统一三种配对码格式）；目录下发帧（`directory/snapshot`、`directory/delta`，E2E 加密），节点缓存团队机器与 Bot 目录；Phase 0–7 全部功能（Team Directory、执行租约 epoch、Sentinel 巡检、三平台自启说明、工作账本 away 状态与崩溃重跑规则） |
| 0.3.10-fork.113 | 0.4.34 | 重写 R1–R4：全队目录带 `identityId`/机器/状态/模型与整张机器列表（`bot/directory` 扩充）；跨机 Bot 间投递 `bot/assign`（ack/重发/away/补发，主控转发或退回）；跨机请求在接收方后台任务里答、不进会话框；节点 Bot 的管理工具经 `team/act` 由主控执行；集群工具每机 ACL（有 `acl.json` 才拦）；修 `bot/stream` 预览写进已关闭 step 导致镜像会话损坏。**主控与全部节点须同时升级**，不兼容 fork.112/0.4.33 及更早 |
| 0.3.10-fork.114 | 0.4.34 | 修：队友的回复在发问方正在跑回合时插进当前回合（不再进用户队列）；跨机回复回到发问的那个后台任务并接上它的工作（不再只到主对话、链条单向中断）。AC 不变；主控与节点的 ds-bot 都须升到 .114 |
| 0.3.10-fork.115 | 0.4.35 | 主控上看得到节点之间的对话（主控转发的每帧记进两个节点 Bot 的往来账本，AC 0.4.35 写审计 `bot.assign`）；主控镜像页默认不再写流式预览（DSH 日志只能追加，预览会变成多余的气泡：一条消息回两条），`prefs.mirrorStreamPreview: true` 可恢复。只需升级主控，节点保持 fork.114 / AC 0.4.34 可用 |
| 0.3.10-fork.116 | 0.4.35 | 主控上节点 Bot 的页面：每收到一条队友消息显示一行「Message from X」，每收到一条回复显示一行「Reply from X」（回多少条显示多少条，点开是往来对话）；节点 Bot 收到回复后在自己对话里接着做的回合也回报到主控页面（按普通回答显示）。主控与节点都须升到 .116，AC 不变 |
| 0.3.10-fork.117 | 0.4.35 | 修：跨机第 2/3 轮「已送达、无回复」——联邦名册帧（联邦关闭）会把全队目录生成的替身行一并清掉，接收方答完后找不到发问方而丢弃回复；现在名册只清自己的行，且回复在替身行暂缺时按请求来时的地址照样送回。主控与节点都须升到 .117，AC 不变 |
| 0.3.10-fork.118 | 0.4.36 | Bot 协作改为 work 模型（`docs/plans/2026-11-24-work-model.md` W0–W5）：交出去的事等全部交回后只续跑一次、结果不插话、不进排队区、不再有 30 分钟超时；每对 Bot 一条固定工作线程「@发问方 · 工作」；跨机改用 AC 0.4.36 可靠通道上的 work 帧（删除 bot/assign、Bot 间 bot/message 与 bot/turn）；主控上节点 Bot 的页面是节点对话的副本（只有副本写入）。主控与所有节点都须同时升级 |
| 0.3.10-fork.119 | 0.4.36 | 修 fork.118 实机验收的两处：主控上节点 Bot 页面的工具结果（`tool/result`）带上 DSH 要求的 surface 标记，`message_bot` 不再显示成「没能给…发消息」；节点 Bot 的工作线程与后台任务也抄一份到主控（只读副本），在该 Bot 的任务列表里列出（含「待命」），可打开查看。主控与节点都须升级 |
| 0.3.10-fork.120 | 0.4.36 | 修 fork.119 实机验收的两处：主控上节点 Bot 页面里一步的工具调用在步结束前一定有结果（副本丢了的补一条说明），不再因「step/end leaves unresolved tool call」整页打不开；工作线程副本不再写 DSH 存不下的开头，真正落盘（fork.119 的副本重建）。不再自动把节点历史重建成新页面（W4 后页面就是副本），不再每 5 秒重试刷屏。只需主控升级 |

能力位与功能的对应（`src/host/node-compat.js` 的 `NODE_FEATURES`）：

| 能力 | 功能 |
| --- | --- |
| `bot-turn-mode/1` | 插话并入进行中的回合 |
| `bot-action/1` | 在主控回答卡片、操作任务 |
| `roster-cards/1` | 节点卡片（审批、提问、技能提议、表单） |
| `bot-trace/1` | 思考过程与工具步骤 |
| `bot-attach/1` | 图片和文件附件 |
| `config-models/1` | 模型能力（图片、思考档位）落到节点 |
| `lan-discovery/1` | LAN 自动发现 |
| `pairing/1` | 配对码零配置接入 |
| `machine-identity/1` | 持久机器身份 |
| `bot-locate/1` | Bot 定位（签名证明 Bot 在哪台节点上） |
| `bot-move/1` | Bot 迁移（`move_bot` 工具，epoch+1 执行租约切换） |

升级顺序：先装 AC（主控、再节点），再装 ds-bot；两者可以分开升级，缺能力时 ds-bot 会提示而不会出错。
