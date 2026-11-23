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

能力位与功能的对应（`src/host/node-compat.js` 的 `NODE_FEATURES`）：

| 能力 | 功能 |
| --- | --- |
| `bot-turn-mode/1` | 插话并入进行中的回合 |
| `bot-action/1` | 在主控回答卡片、操作任务 |
| `roster-cards/1` | 节点卡片（审批、提问、技能提议、表单） |
| `bot-trace/1` | 思考过程与工具步骤 |
| `bot-attach/1` | 图片和文件附件 |
| `config-models/1` | 模型能力（图片、思考档位）落到节点 |

升级顺序：先装 AC（主控、再节点），再装 ds-bot；两者可以分开升级，缺能力时 ds-bot 会提示而不会出错。
