# 全队目录：节点上的 Bot 看得到整个团队和所有机器（重写 R1）

- 日期：2026-11-24
- 相关：重写方案 `ds-bot-cluster/REWRITE-PLAN-2026-11-24.md` §2.1、§2.5；配套 AC（dsh-ai-cluster）`rewrite/r1` 分支

## 为什么

用户要求节点上的 Bot 能主动和任何机器上的 Bot 协作、看到全队成员。实测（2026-11-24）节点上：

- `list_machines` 报 "No nodes connected yet"——它读的是 hub 才有的节点注册表；
- 其他节点的 Bot 只显示 "read-only, on another machine"——目录条目不带机器名、在线状态；
- node011 发给 node010 的消息永远收不到回复——hub 拿节点本地 id（`e11`）当发送方，hub 上同一个 Bot 叫 `joined:node011:e11`，回复找不到人被静默丢掉。

取舍：复用已经两端接通的 `bot/directory`（hub → 节点，全量快照），扩充字段，不另起一套 `directory/snapshot|delta` 帧——一个团队最多几百个 Bot，全量快照足够，少一套机制就少一处不一致。

## 已定的行为

- **全局身份**：目录里每个 Bot 都带 `identityId`（16 位 hex）。节点 Bot 的来自节点 AC 的身份簿（随名册上报）；hub 自己的 Bot 由 AC 在 hub 上的身份簿发放（服务 `remote-agent:bot-identity`，`identityOf(localBotId, { name, role })`）。
- **目录条目**：`{ id, name, role, nodeId, identityId?, hostname?, online, state, model? }`；`state` 只取 `available | working | waiting | offline`，由 `statusOf` 那一行归类而来（等用户批准/回答 = waiting，节点离线 = offline）。
- **机器列表**：目录帧带 `machines`：hub 自己（`nodeId: 'hub'`，`role: 'hub'`）加注册表里的每个节点，**离线的也列出**，带 `hostname / os / online / acVersion / lastSeen`。节点收到后存在内存 `rt.hubMachines`（不落盘），并标出哪一台是自己（`self`）。
- **`list_machines`**：hub 上读注册表，节点上读 `rt.hubMachines`；每台机器下列出在它上面的 Bot 及状态。目录还没到时如实说"目录还没从 hub 来"，不再说"没有节点"。
- **`list_bots`**：别的机器上的 Bot 显示 `on <机器名>`、是否离线、`now: idle | working | waiting for the user`，不再标 read-only（它们可以被发消息；能否被管理见 R4）。
- **一种影子行**：节点上 hub Bot 只由目录生成一行；federation（`peer/roster`）遇到目录里已有的同一 Bot 不再生成第二行，旧的重复行按原规则约 60 秒后过期。federation 仍负责技能共享。
- **发送方对得上**：节点 AC 发 `bot/message` 时由节点身份簿给 `from` 盖上 `identityId`（宿主自报的一律丢弃）；hub 收到后先按 `identityId`、再按"节点 + 节点本地 id"找到发送方的 joined 影子，用影子 id 作为发送方。找不到时记一条 warn（不再静默）。

## 不做什么（留给后续阶段）

- 回复送回节点 Bot、多轮往返、往来不进会话框：R2/R3（Assignment）。
- 节点 Bot 的管理工具（建 Bot、建群）：R4（经 hub `team/act`）。
- 不保留与 fork.112 及更早节点的兼容：6 台机器一起升级（用户 2026-11-24 决定）。旧 AC 节点收到带新字段的目录时，其校验器会丢弃新字段，节点照旧工作但看不到机器列表。

## 已知限制

- `state` 来自 `statusOf` 文本归类；`statusOf` 措辞变化时要同步 `botStateOf`（`src/host/bot-network.js`）。
- 目录重发的时机：团队保存后内容有变（1 秒去抖）、任一节点上报名册（约每 5 秒，1 秒去抖）、节点上线、每 60 秒定时。Bot 开始/结束干活不一定触发保存，所以节点上看到的 `state` 通常滞后数秒，最坏 60 秒。
