# M4 实施切片：记忆 team / node / bot 三层

> 任务：T-20261109-bot-home-s2 / M4 第 2 段前置设计。
> 输入：`/tmp/ds-bot-cross/ds-bot/docs/memory-scope-brief.md`（172 行，已冻结，提交 `0047647e`）。
> 代码基线：ds-bot `eea52b53`（0.3.6-fork.31，`/tmp/m3effort-wt`）、ra `0a9a601`（0.10.1-fork.75，`/tmp/ra-p1b`）。
> 本文只做实施切片，不改代码。`task-board` 不是 git 仓；契约文档本体提交在本仓 `ds-bot/docs/memory-scope-slices.md`。

## 0. 结论

切成 **6 片**，按「数据层 → 传输 → 主控服务 → 节点适配 → 面板 → 真机」排序，前 5 片都能单独合入、单独回滚；只有 **S6（远端 Bot 默认后端切换与真机验收）必须等 M3 的远端 Bot 创建/配置面冻结**。

- S1 数据层与 scope 扩展：目录、state 字段、迁移、回滚；不联网。
- S2 ra 记忆通道：`mem/*` 协议、caps、E2E、身份、双端分派。
- S3 主控记忆服务：快照、seq、inbox 去重、读写落盘。
- S4 节点适配：`federation` 后端、缓存、outbox、注入、工具路由。
- S5 主控面板：Team / 机器 / Bot 三层查看与编辑。
- S6 默认切换与真机：远端 Bot 建时带 `memoryConfig`，删除传播与离线验收；等 M3。

## 1. 数据模型与迁移

### 1.1 现有存储（已核实）

- 根目录 `<home>/memory`，`memory.js:137`。
- 目录规则 `dirOf` `memory.js:155`：`team/`、`groups/<safeRoomId>/`、`bots/<safeBotId>/`；`scopeKey` `:156` 产出 `team`、`group:<roomId>`、`bot:<botId>`。
- 作用域只有三种：`TEAM`、`ownScope(botId)`、`groupScope(roomId)`（`memory.js:146-148`）。
- 文件格式：每个 scope 一个 `MEMORY.md` + 若干 `<topic>.md`，条目是 Markdown 列表行带 `[key: value; …]`；`loadScope` `:203` 读。
- 变更日志 `journal.jsonl`（team 与非私有 Bot 共用）与私有 Bot 自己的 `journal.jsonl`；快照 `snapshots/<sessionId>.md`；总结 `summaries/`；归档 `archive/`。
- 写路径：`addEntryNow` `:567`、`removeEntryNow` `:648`，先写 pending 记录再落文件，`recoverPending` 启动时补完。
- 权限：`writeDenied` `:460`；team 只允许 `writesTeam`（Main 或群管理员）`memory.js:444`。
- 单条上限 `MEMORY_LIMITS.entry=300`；整卷上限 `team=4_000`、`bot=8_000`、`group=12_000`（`memory-entries.js:9`）。

### 1.2 新增 scope

| kind | 结构 | 目录 | key |
|---|---|---|---|
| `team` | `{kind:'team'}` | `memory/team/`（不变） | `team` |
| `node` | `{kind:'node', nodeId}` | `memory/nodes/<safeNodeId>/` | `node:<nodeId>` |
| `bot`（本机） | `{kind:'bot', botId}` | `memory/bots/<safeBotId>/`（不变） | `bot:<botId>` |
| `bot`（远端） | `{kind:'bot', nodeId, botId}` | `memory/nodes/<safeNodeId>/bots/<safeBotId>/` | `joined:<nodeId>:<remoteBotId>` |

- 远端 Bot 的 `botId` 直接用主控的 joined 影子 id（`joined:<nodeId>:<remoteBotId>`），与 roster 行一一对应；不再引入第二种远端行 id。
- `scopeKey` 只负责本机既有三值；远端新增 `remoteBotKey`/`nodeKey` 两个纯函数，不把带冒号的组合塞进 `scopeKey`，避免 journal/UI 解析歧义。
- `dirOf` 三分支扩成四分支；`journalFor` 对远端 Bot 走 `memory/nodes/<nodeId>/journal.jsonl`，不写 team 日志。
- 本机 Bot 目录**不迁移**：它已经有历史，移动会打断快照和 journal。

### 1.3 state 字段

```js
// hub
state.memoryFederation = {
  version: 1,
  seq: 0,                     // 全局单调，任何成功写/删 +1
  nodes: {                    // 每次 hello/ack 更新
    [nodeId]: { lastSeq, sentSeq, lastSeen, hostname }
  },
  inbox: {},                  // '<nodeId>:<requestId>' -> {status, result, at}
}
// node
state.memoryCache = {
  seq: 0,                     // 已应用快照的 seq
  team: '', node: '',
  bots: { [remoteBotId]: { text: '', truncated: false } },
  at: 0,
}
state.memoryOutbox = []       // FIFO，≤200
```

- `EMPTY`（`store.js:25`）加默认值；`state.version` 仍为 2，未知字段旧版本忽略。
- **快照按 Bot 分段**：同一节点可挂多个 Bot，`bots` 必须是映射；单段 `bot` 字符串会把同节点 Bot 的记忆互相覆盖。
- **seq 是全局失效信号**：写/删成功即 `seq+1`；hub 对受影响节点去抖 500ms 推一次 `mem/snapshot`，节点 `ack` 后更新 `lastSeq`；`sentSeq` 用于重连时判断是否需要补发。
- `migrateMemoryFederation(state)`：补默认、清过期 inbox（7 天 / 1000 条）、把 `seq` 归一到非负整数；幂等。

### 1.4 迁移与回滚

- 老数据：不动。team / 本机 bot / group 的文件与 journal 原样；远端 scope 从空开始。
- 不自动导入节点本地旧记忆；需要的话另做一次性导入脚本（不在 M4）。
- 回滚：`prefs.memoryFederation=false` → 停止同步、清 node 缓存与 outbox、保留 hub 文件；再删 `state.memoryFederation/memoryCache/memoryOutbox` 即回到纯文件记忆。旧版本读新 state 不崩（未知字段），但旧版本不会读 `memory/nodes/`。
- 回滚安全点：S1–S3 只新增目录与字段；S4 才让远端 Bot 真正走新后端，因此 S4 之后必须按「先关开关、再降版本」的顺序。

## 2. 读写规则与注入点

### 2.1 谁能读谁（v1 已拍板）

| scope | 读 | 写 |
|---|---|---|
| `team` | 所有机器上的所有 Bot | **仅 hub Main / 群管理员**；节点 Bot 只读 |
| `node:<n>` | 该节点上的 Bot、hub Main | 该节点上的 Bot |
| `bot:<b>`（本机） | 该 Bot、hub Main | 该 Bot、hub Main |
| `bot:<b>`（远端） | 该 Bot、hub Main | 该 Bot；hub Main 可删改 |
| `group` | 群成员（本机） | 群成员（本机），不进联邦 |

- team 追加 v1 **不开放给节点**：team 会进入所有 Bot 的系统提示，单台节点被攻陷即可对所有 Bot 做提示注入，限流+审计挡不住一条精心构造的条目。节点收到 `mem/write` 且 `scope.kind==='team'` 时由 hub 返回 `memory/team-read-only`，节点 UI 也隐藏该入口；后续若要放开，另加每节点 `teamAppend` 开关并单独成片。
- 权限在 **hub 侧**判定（`writeDenied` 的联邦分支），节点只发 `source`，不能自证；读越权在 hub 侧过滤，节点拿到的快照只含它可见的 section。
- 远端 Bot 只能读写自己的 `bot` scope 与本节点 `node` scope；不能指定任意 `nodeId`。

### 2.2 注入过滤点（文件/函数）

| 位置 | 现状 | M4 改法 |
|---|---|---|
| `src/host/memory.js:906` | `ctx.systemPrompt.section` 注册 `bot-memory` | 不变，仍走 `sectionFor` |
| `src/host/memory.js:844` `sectionFor` | `backendOf(bot)!=='file'` 直接返回 `''`（`:848`） | 增 `federation` 分支：从 `state.memoryCache` 取该 Bot 的 team/node/bot 三段，按 Session 冻结（复用 `frozen` Map，`memory.js:817`），不读文件、不发网络 |
| `src/host/memory.js:776` `memorySection` | 拼 own + team | 新增 `federationSection(bot)`：拼三段，段首标 `(memory last synced … ago)` |
| `src/host/memory.js:1213` `readScopes` | own/group/team | 联邦后端时读 `memoryCache`；`scope:'team'` 仍可单读；`group` 返回不可用 |
| `src/host/memory.js:446` `namedScope` | own/group/team/Bot 名 | 联邦后端下 `own` 指向 `joined:<nodeId>:<botId>`；不接受任意 node 名 |
| `src/host/memory.js:460` `writeDenied` | Main/群管理员 | hub 侧联邦分支：team 维持 Main/管理员；node/bot 按 §2.1；节点侧只做本地预检，最终以 hub 返回为准 |
| `src/host/memory.js:1145/1186/1225` | `remember/forget/recall` | 联邦后端转调 adapter（同一组工具名，不改用户体验）；team 写在节点侧先被 `memory/team-read-only` 拒绝 |
| `src/host/tools.js:908` | 非 file 后端不注册三工具 | file 与 federation 都注册 |
| `src/host/memory-review.js:236/257` | 只 review file 后端 | **federation v1 不启用自动 review**（已拍板）；门保持只认 file |
| `src/host/memory-tidy.js` | 文件记忆整理 | 联邦后端禁用 tidy（面板置灰），M4 不做远端整理 |
| `src/host/memory.js:1414` `panelOf` / `:1449` `memoryView` | 只认本机 bot/room | 新增 hub 面板端点（§3），不改旧端点 |

### 2.3 关键用例

- 同节点共享：节点 A 上的 Bot1 写 `node:A`，Bot2 下一轮能读到；Bot2 不能改 Bot1 的 bot scope。
- 跨节点隔离：节点 A 的 Bot 读 `node:B` 返回空/拒绝，不能靠 `scope.nodeId` 自证。
- 匿名伪造：载荷 `nodeId` 与连接不符整帧丢弃（`registry-ingest.js:333` 口径）。
- 私有 Bot：`private===true` 不参与联邦（不上报、不建 scope、节点不缓存），与 `memory.js` 的 private 规则一致。
- team 只读：节点 Bot 调 `remember(scope:'team')` 得到 `memory/team-read-only`，条目不被 hub 接受。

## 3. 接口与 UI

### 3.1 帧（复用冻结交底的 `mem/*`）

| 方向 | 类型 | 载荷 | 应答 |
|---|---|---|---|
| node→hub | `mem/hello` | `{appliedSeq}` | `mem/snapshot` |
| hub→node | `mem/snapshot` | `{seq, team, node, bots:{<remoteBotId>:{text,truncated?}}, truncated?}`（渲染后的 markdown，总 ≤32KB） | — |
| node→hub | `mem/read` | `{requestId, remoteBotId, scope, query?, topic?, limit?}` | `mem/read-result` |
| hub→node | `mem/read-result` | `{requestId, ok, seq, entries?, topic?, text?, error?}` | — |
| node→hub | `mem/write` | `{requestId, remoteBotId, op（add / replace / forget）, scope, text?, replace?, topic?, until?, pin?, always?}` | `mem/write-result` |
| hub→node | `mem/write-result` | `{requestId, ok, seq, id?, changed?, error?}` | — |
| node→hub | `mem/ack` | `{seq}` | — |

- 通道选择：**独立 `mem/*`，不复用 config-sync**。config-sync 是 hub→node 的配置面（providers/defaultModel/plugins），有 revision/apply/rollback 语义；记忆是 node→hub 的用户内容，方向和生命周期都不同。传输复用现有 registry/relay 与 `remote-agent:peer-link` 的连接事件，但帧、校验、state 都独立。
- **快照带渲染后的正文**，不是条目 JSON：节点直接用这段文本注入，格式化、预算、密钥过滤都只在 hub 做一次；`mem/read` 才返回条目，供 recall 与面板。
- caps：`memory-sync/1`；无此 cap 的节点不显示联邦入口、不发帧。
- E2E：`mem/*` 全部进 `E2E_REQUIRED_TYPES`（含正文）。
- 身份：`nodeId` 取连接；`remoteBotId` 必须在该节点最近一次 roster 的 joined 行里，否则 `memory/not-on-roster`。
- 只读模式（`rt.readOnly() !== undefined`）拒绝写，返回 `memory/read-only`。

### 3.2 主控 UI

- 复用 `src/client/memory-panel.js` 的列表能力，新增 owner 维度：`team`、`node:<hostname>`、`bot:<name>`。
- 新端点族（`channel.js` 的 memory 段，现有 `:949-980`）：
  - `memory-hub-scopes`：返回 team、各节点、各远端 Bot 及条目数；
  - `memory-hub-view`：`{scope}`，返回 entries/sizes/limits（形状同 `memoryView`）；
  - `memory-hub-add` / `memory-hub-forget`：`{scope, text, topic?, match?}`，权限在 hub 判。
- 旧 `memory-view`（本机 bot/room）不变，避免回归。
- **远端 scope 不生成模型摘要**（已拍板）：面板只显示条目数、上限占用和原文；不触发节点或 hub 的模型调用。本机 scope 的摘要保持现状。
- 节点侧 UI：本机 Bot 面板仍读本地文件；当该 Bot 后端是 `federation` 时显示「由主控管理」并只读，编辑入口跳主控（M4 只做提示，不做跨机编辑跳转）。

## 4. 切片计划

| 片 | 一句话 | 依赖 | 可独立验收 |
|---|---|---|---|
| S1 | 数据层：scope/目录/state/迁移/回滚 | 无 | 是 |
| S2 | ra 通道：`mem/*` 协议与双端分派 | 无 | 是（假 provider） |
| S3 | hub 服务：快照/seq/inbox/读写落盘 | S1 | 是（假节点） |
| S4 | 节点适配：federation 后端/缓存/outbox/注入 | S1–S3 | 是（假 hub） |
| S5 | 面板：三层查看与编辑 | S3 | 是（手工） |
| S6 | 默认切换与真机：远端 Bot 用联邦记忆 | S4–S5、M3 冻结 | 是 |

### S1 数据层（ds-bot）

- 文件：`src/host/memory.js`（`dirOf`/`scopeKey`/`journalFor`/`loadScope`）、`src/host/store.js`（EMPTY、migrate）、`src/host/constants.js`（`MEMORY_BACKENDS` 加 `federation`）。
- 测试：`test/memory-scopes.test.js` —— 四种 scope 的路径、旧 state 载入、迁移幂等、私有 Bot 不进 node 目录。
- 验收：现有单机记忆回归全绿；新目录不产生文件；删除新字段可回滚。
- 风险：`safeId` 哈希会让排障路径不可读，日志必须打印原始 id 与 scopeKey。

### S2 ra 通道

- 文件：`lib/protocol.js`（常量 + 4 个 validator）、`lib/node/memory-link.js`（新，send/on/online）、`lib/node/dispatch.js`（snapshot/read-result/write-result）、`lib/node/index.js`（caps、绑定、hello）、`lib/node/transport.js`（E2E 集合）、`lib/hub/registry-ingest.js`（四类 node→hub 事件 + 连接 nodeId 校验）。
- 测试：`test/memory-protocol.test.js`、`test/memory-ingest-auth.test.js`。
- 验收：坏帧丢弃不抛；冒充帧整帧丢；无 cap 不发；E2E 未建立拒收正文帧。
- 风险：新增三条 node→hub 帧都要经过 relay 的 `to/from` 语义，需在集成测试里确认 `from` 被连接绑定覆盖。

### S3 主控服务（ds-bot）

- 文件：新增 `src/host/memory-federation.js`（hub 部分）；`memory.js` 需导出 `loadScope/addEntry/replaceEntry/removeEntry` 供复用；`channel.js` 新端点；`index.js` 模块顺序放 `memory` 之后。
- 测试：`test/memory-hub.test.js`、`test/memory-hub-dedupe.test.js` —— 快照生成、seq 递增、`<nodeId>:<requestId>` 去重、replace 多匹配 `memory/ambiguous`、团队只读、权限拒绝、save 失败回滚。
- 验收：用假节点发 `mem/write`，hub 文件出现条目、seq+1、重复 requestId 只写一次；`mem/read` 只返回该 Bot 可见 scope；改 team 后 500ms 内有 snapshot 推送。
- 风险：hub 写路径必须继续走 `queued`（`memory.js:214`）单写者，不能在 adapter 里另开写队列。

### S4 节点适配（ds-bot）

- 文件：`memory-federation.js`（节点部分：cache/outbox/adapter）、`memory.js`（`sectionFor`/`readScopes`/`writeDenied` 分支、三工具路由）、`joined-create.js`（`bot/create` 带 `memoryConfig`）、客户端后端设置项。
- 测试：`test/memory-node-cache.test.js`、`test/memory-outbox.test.js`、`test/memory-injection.test.js` —— 缓存注入、stale 标记、离线队列、重连只落一次、team 写被拒、mneme Bot 拒绝。
- 验收：节点断网写两条 → 队列；重连后 hub 出现两条且各一次；`sectionFor` 输出含 team/node/bot 三段（多 Bot 节点互不串）；本地 Bot 不受影响。
- 风险：`sectionFor` 每轮渲染都会跑，缓存读取必须是内存读，不能触发网络；冻结语义要保住 provider 前缀缓存。

### S5 面板（ds-bot client）

- 文件：`src/client/memory-panel.js`（owner 维度）或新增 `memory-hub-panel.js`；`src/client/team-actions.js:298`（新 action）；`channel.js` 端点已在 S3。
- 测试：纯函数单测（scope 树/条目计数），界面手工验收；`build-client --check`。
- 验收：主控能看 team、每台机器、每个远端 Bot；编辑/删除后条目即时更新；越权操作显示明确文案；远端 scope 无摘要、无模型调用。
- 风险：panel 现有的摘要路径只应按本机 scope 触发；远端 scope 若误触模型调用会产生不在预算内的费用。

### S6 默认切换与真机（等 M3）

- 文件：`joined-create.js`（新建 joined 远端 Bot 默认 `memoryConfig.backend:'federation'`）；不涉及其他行类型。
- 测试/验收：真机三机 —— team 共享、node 隔离、bot 私有、删除传播、离线排队、旧节点降级。
- 依赖：M3 的远端 Bot 创建/配置面已冻结；roster 的 joined 影子行可用。
- 风险：把默认后端切到 federation 会影响所有新建远端 Bot，必须保留逐 Bot 切回 `file` 的开关。

## 5. 与 roster / config-sync 的边界

| 数据 | 走哪 | 是否出主控 |
|---|---|---|
| provider / key / defaultModel / plugins | config-sync（hub→node） | 只下发给节点，不回传 |
| Bot 身份（id/name/role/model/在线） | roster 的 joined 影子行 | 是，面板展示与路由用 |
| team 记忆 | `mem/*`（hub→node 快照） | 是，所有节点可见；节点只读 |
| node 记忆 | `mem/*` | 只发给该节点；其他节点看不到 |
| bot 记忆（远端） | `mem/*` | 只发给该 Bot 所在节点 |
| bot 记忆（本机） | 本地文件 | 不出主控 |
| group 记忆 | 本地文件 | 不出机器 |
| 私有 Bot 记忆 | 本地文件 | 完全不出，不进快照 |
| mneme 记忆 | mneme 本地 | 完全不出，不迁移、不改 mneme |
| works / exchanges | 本机 state | 不因记忆同步而传输 |

- 本轮只覆盖 **roster 上报的 joined 影子行**；其他行类型不在 M4 v1 范围。
- 记忆条目里如果出现 key/token，沿用 `secretEntry`（`memory.js:466`）拒绝；hub 落盘前再跑一次 `rt.redactSecrets`。
- 快照只带渲染后的 markdown，不带 journal、路径、其他 scope 的条目；单段 32KB 上限，超出置 `truncated`。

## 6. 最大风险

**hub 是单点，而且记忆是明文。** 所有节点的 team/node 读写都经过主控：主控进程不在线时，节点只能读旧快照、写进本地 outbox；outbox 上限 200 条 / 7 天，超了只能报错丢弃。落盘是明文 markdown，任何能读 `memory/` 的进程都能看全量 team 与各节点记忆；`secretEntry` 只挡明显的 key 形态，不挡用户自己写进去的敏感事实。v1 的 team 只读显著降低了提示注入面，但不改变“主控可读所有节点记忆”这一事实，需要在文档和 UI 里明说。

## 7. 已拍板（v1）

1. **team 追加不开放给节点**。节点读 team、写 node/bot；team 写仍限 hub Main 与群管理员。理由：team 进入所有 Bot 的系统提示，单台节点被攻陷即可对全队做提示注入。后续若放开，需加每节点 `teamAppend` 开关，单独成片，不混进 M4。
2. **联邦写关闭自动 review**。只走显式 `remember`，写入由 hub 侧 `writeDenied` 判定并过 `rt.redactSecrets`。理由：远端 review 会在用户不知情时把节点模型的总结写进 hub，既增加不可控写入，也让来源审计失真。
3. **远端 scope 不生成模型摘要**。面板只显示条目数、上限占用与原文；摘要能力保留给本机 scope。理由：避免面板浏览触发远端模型调用与费用，也避免摘要成为第二份未审计的记忆副本。
