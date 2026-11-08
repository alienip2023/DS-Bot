# Mirror Session 运行时契约

**任务**: T-20261108-bot-home-mirror  
**状态**: 修订稿 v2（2026-11-08，司令复核 spike 矛盾点 + resume 悬挂 turn + 幂等约束后放行）  
**用途**: 为「给每个远程 Bot 建本地镜像 Session」方案钉死运行时事实，供工程师照此实现，无需再猜 API。

---

## Q1 `session.append` 的准确签名、返回值、并发语义

**文件**: `app.asar/node_modules/@deepseek-ai/dsh-session/lib/index.js:1524`

```js
// Session 类上的方法
append(type: string, data: object, opts?: { sourceEventSeqs?: number[], surfaceOp?: 'append' | 'replace' }): SessionEvent
```

- `type`：事件类型字符串，必须是 `KNOWN_SESSION_EVENT_TYPES` 成员，否则被拒（除非带 `ignorable` 标记的插件记录）。
- `data`：JSON 可序列化对象；不可序列化则抛出，**日志不变**。
- `opts.surfaceOp`：`'append'` 表示追加到模型可见面；`'replace'` 表示覆盖已有范围。不传则不进 Surface。
- `opts.sourceEventSeqs`：关联的来源事件 seq 列表（用于 replace 时标注覆盖范围）。
- **返回值**：`deepFreeze`过的 `SessionEvent = { type, seq: number, time: number, data, ...surfaceMetadata }`。
- **并发语义**：`append` 在内部调用 `publicationEntry()` 做单次重入检查（见 L1525、L1535）。如果当前已在一个 `append` 的 publication 边界内再次调用，**抛出**；日志不变。它本身不是 async，也没有外部锁。`inOrder(sessionId, op)` 是 SessionController 层的串行化机制（L355–364），用 Promise 链确保同一 sessionId 的操作顺序执行，但那是在 controller 层，不在 `session.append` 内部。
- **seq 冲突**：seq = `this.log.length`，单调递增，不会冲突；没有 revision/seq 传入参数。
- **`agent.session.append`**：用法完全相同，`agent.session` 就是 `Session` 实例。

### 补充：`createSession` 后如何拿到 Session 对象

**文件**: `dsh-api-session-controller/lib/index.js`

- `createSession`（SC:252）调用 `inOrder(named, async () => this.created(await this.claim(named, request)))`，先 `claim` 再 `created`。
- `create()`（SC:703）解析 workspace/cwd → 调 `agents.createSession()` → 选模型 → 触发事件 → 返回 `{ sessionId, title?, workspace? }`。
- `createAgent()`（SC:461）调 `ctx.agents.create(...)`，用 `retainHandle(handle)`（SC:195–197）把 agent 注册到 handles map。
- **结论**：`createSession` 完成后，agent 已 live；`liveAgent(sessionId)` 立即可用，`resolveAgent(sessionId)` → `resolve()`（SC:209）先查 `liveAgent`，直接返回，无需额外 `resume`。
- **镜像拿 Session 对象的路径**：`createSession` 返回 `sessionId` → `resolveAgent(sessionId)` 返回 live agent → `agent.session` 即 Session 实例 → `agent.session.append(...)` 即可写入。
- **store-owned Session 的 append 前置条件**：`publicationEntry()`（dsh-session:1525,1535）做重入检查，不检查 Session 是否「entered」或「announcement 完成」。只要不在另一个 append 的 publication 边界内，append 就能执行。没有「未 entered 会抛」的前置条件。

### resume 对悬挂 turn/start 的处理

**文件**: `dsh-agent-loop/lib/index.js:1739–1740` + `dsh-session/lib/index.js` `openTurnClosers`

- `resumeWith` 读取持久化事件后立即调用 `interruptedTurnClosers(persisted)`（dsh-agent-loop:1739）。
- `interruptedTurnClosers` → `openTurnClosers(events, { kind: "interrupted" })`（dsh-session）：扫描日志，若发现有 `turn/start` 但无对应 `turn/end`，生成合成 `turn/end`（`reason: { kind: 'interrupted' }`），以及 `step/end`（若有悬挂 step）。
- 这些 closer 事件被 `await handle.append(closers)` **写回持久化**（dsh-agent-loop:1740），并并入 Session seed。
- **结论**：resume 会自动关闭悬挂 turn，不需要镜像层在 resume 前手动检查。但镜像写完一轮后应主动写 `turn/end`（避免 reason 被标 interrupted），`finally` 块保证写入是最佳实践。
- **resume 不调模型**：`initializeAgent`（dsh-agent-loop:1759）只初始化 agent 对象（模型、工具、scope），不写 inbox、不触发 `nextTurn`/`nextStep`。模型仅在 `agent.followup()` 或 `agent.steer()` 被调用时才运行。

### 冷启动探针（DEFER）

**需量**：`createSession` → 丢弃 handle → `resolveAgent`，观察是否走 `resume` 路径及其开销。

**代码级推断**（未实测，标 defer）：
- `liveAgent`（SC:306）查 `ctx.agents.get(sessionId)` — 若 agent 已从 `ctx.agents` 移除（handle dispose），返回 undefined。
- `resolveAgent` 落到 `resume()`（SC:216），调 `ctx.sessionQuery.observeSession(sessionId)` 从 persistence 读取，再 `ctx.agents.resume(...)` 重建 agent 对象。**不调模型。**
- **风险**：若 mirror 层每次写入前都 `resolveAgent`（而非持有 session 句柄），冷启动会有一次 persistence 读取开销。建议：`createSession` 完成后持有 `agent.session` 引用，不在每次 append 前 resolveAgent。
- **实验方法**：`createSession` → `agents.disposeOwned(sessionId)` → `resolveAgent(sessionId)` → 在 `observeSession` / `ctx.agents.resume` 处加断点，计时。标 S1 第一个实验。

---

## Q2 `turn`/`step` 生成规则

**文件**: `app.asar/node_modules/@deepseek-ai/dsh-session/lib/index.js` + `dsh-api-session-controller/lib/index.js`

- `turn/start`、`turn/end`、`step/start`、`step/end` 均是 `KNOWN_SESSION_EVENT_TYPES` 的成员（L137, L117–118），通过 `session.append(type, data)` 写入。
- **外部能否指定 turn**：可以。`session.append('turn/start', {...})` 合法，类型在 KNOWN 列表里。但渲染器拿 `turn/start` 作为 **「此 Session 已有 turn，不可复用」** 的信号（SC L393: `reusable = request.reusable(sessionId) && !observed.events.some(e => e.type === 'turn/start')`）。镜像 Session 一旦写入 `turn/start`，SessionController 就不会把它当空白 Session 复用。
- **重复 turn**：`turn/end` 前再次写 `turn/start` 不会被框架阻止，但 paginate 逻辑（L1389）按 `turn/start` 事件计数 `turns`，会影响分页结果。**建议镜像写真实 turn 边界，不重叠。**
- **页面轮次来源**：前端 `events` API（L1976）调用 `paginate(events, beforeSeq, maxMessages, throughSeq, turnWindow)`（L1382），轮次来自事件日志里 `turn/start` 的数量；渲染器根据此页内容重建轮次，没有独立计数器。
- **内部计数器**：`seq` 是唯一的序号，单调递增，等于 `log.length`；不存在单独的 turnId 字段。

---

## Q3 `createUserMessage` / `createAssistantMessage` 必需字段与 `source` 语义

**文件**: `app.asar/node_modules/@deepseek-ai/dsh-llm/lib/index.js:59–79`

```js
// createUserMessage
createUserMessage(input: {
  content: MessageContent[],  // 必需
  source: {
    kind: 'user',             // 必需
    rpcId: string,            // 必需（来自 requestId）
    clientTimeZone?: string,
    principal?: string,
  }
}): FrozenMessage

// createAssistantMessage
createAssistantMessage(input: {
  content: MessageContent[],  // 必需
  source: {                   // 内部强制 kind:'model'，以下字段透传
    provider: string,         // 必需
    model: string,            // 必需
    reasoningEffort?: string,
    // ...其他 provider 字段
  }
}): FrozenMessage
```

- `createMessage` 内部：`deepFreeze(structuredClone({ ...input, id: randomUUID() }))`。不可变，带新 UUID。
- **`source.kind` 枚举**（SC L1009, L1080, L2842, L4420）：
  - `'user'`：来自用户 RPC，带 `rpcId`；这是 `prompt()` 调用链写入的类型。
  - `'model'`：来自模型生成，`createAssistantMessage` 强制设此值。
  - `'system-prompt'`：`createSystemMessage` 内部使用。
  - `'tool'`：`createToolResultMessage` 使用。
  - `'subagent-settled'`：子 agent 完成时由框架写入（SC L2590 有检测）。
- **写入会不会进 inbox**：`createUserMessage` 只是构造消息对象；真正进 inbox 是 `agent.followup(message)` 或 `agent.steer(message)`（SC L923–924）。`followup` → `inbox.nextTurn`（下一轮），`steer` → `inbox.nextStep`（当前轮插队）。镜像 Session **不能调用 followup/steer**，否则会触发本地模型。`session.append('user/message', message, { surfaceOp: 'append' })` 才是只写日志的正确路径。

---

## 事件形状（硬约束）

**文件**: `app.asar/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`

镜像写入时，data 字段的形状必须与框架实际写法一致，否则渲染器气泡不出。

### `user/message` 事件

**源码**（dsh-agent-loop:865）:
```js
this.session.append("user/message", message, { surfaceOp: "append" });
```

`message` 是 `createUserMessage` 的返回值本体，即：
```js
{
  id: string,         // randomUUID()
  role: 'user',
  content: MessageContent[],
  source: {
    kind: 'user',
    rpcId: string,
    clientTimeZone?: string,
    principal?: string,
  }
}
```
**注意**：data 就是消息对象本身，**不是** `{ turn, message }` 包装结构。

### `assistant/message` 事件

**源码**（dsh-agent-loop:891–895 interrupted / 949–955 successful）:
```js
this.session.append("assistant/message", { turn, step, message, usage?, stream }, { surfaceOp: "append" });
```

```js
{
  turn: number,       // 本地 agent 循环计数器
  step: number,       // 本地 step 计数器
  message: FrozenAssistantMessage,  // createAssistantMessage 返回值
  usage?: { inputTokens, outputTokens, ... },
  stream?: ...,
  interrupted?: true, // 仅中断时
}
```

### 镜像写法约束

- **user/message**：data = `createUserMessage({ content, source })` 的返回值，带 `surfaceOp: 'append'`。
- **assistant/message**：data = `{ turn, step, message: createAssistantMessage({content, source}), usage?, stream? }`，带 `surfaceOp: 'append'`。`turn`/`step` 可从 0 起单调递增（镜像专用计数器，不与本地 agent 共用）。
- **错误提示**：`assistant/message` + 纯文本 content，`source: { kind: 'model', provider: 'mirror', model: 'relay' }`，带 `surfaceOp: 'append'`。

---

## Q4 渲染器认识的 event type；未知类型处理；系统条目类型

**文件**: `dsh-session/lib/index.js:157–163` (SURFACE_EVENT_TYPES) + L79–142 (KNOWN_SESSION_EVENT_TYPES)

**Surface（模型可见 + 渲染器显示）**:
```
system/message, developer/message, user/message, assistant/message, tool/result
```

`surfaceOp: 'append'` 对两条路径的约束不同：

- **ds-bot 对话页渲染**（`ds-bot/src/host/parts.js:1483–1489`）：直接读原始 log 的 `event.data.content` 和 `event.data.source`，过滤条件是 `event.type === 'user/message'`，再检查 `source?.kind === 'user'`。**不检查 `surfaceOp`**，因此 `surfaceOp:'append'` 对 ds-bot 自身渲染**不是必要条件**。
- **持久化重放**（`dsh-session/lib/index.js:298–309` `planSurfaceEvent` 路径）：如果 type 是 surface-eligible（user/message、assistant/message 等）但未传 `surfaceOp`，会抛出 `"session event ... requires a surfaceOp marker"`。`surfaceOp:'append'` 对持久化重放**是必需的**。

**结论**：镜像写 `user/message` / `assistant/message` 时**必须**带 `surfaceOp: 'append'`，原因是持久化必需；ds-bot 渲染不强制要求，但带上无害。

**KNOWN_SESSION_EVENT_TYPES 全量**（共 ~55 种，含 plugin/project/approval/tool/compaction 等）：渲染器对已知类型有具体解析；未知类型（未在 KNOWN 集合里）如果带 `ignorable: true` 则被跳过，如果不带 `ignorable` 则持久化读取时会拒绝加载整条日志（L68–74 注释明确说明）。

**未知类型处理**：
- Live session（内存中）：`session.append` 调用 `validateSessionEventData`（L1543），不认识的 type 视具体 schema 校验结果而定；实际上框架只拒绝格式非法的 data，不拒绝未知 type 名。
- 持久化读取（反序列化）：`KNOWN_SESSION_EVENT_TYPES` 以外的类型**必须带** `ignorable` 标记，否则新版 DSH 读旧日志会中止（保护语义完整性）。

**可渲染的「系统条目」类型（失败提示用）**：
- `assistant/message` 配合纯文本 content 是最安全的选择；渲染器完整支持。
- `user/message` 亦可，但 `source.kind='user'` 会触发「用户输入」样式。
- **没有** 专门的 `system-notice` 或 `error/message` 类型。推荐：用 `assistant/message` + `source: { kind: 'model', provider: 'mirror', model: 'relay' }` 写错误提示，带 `surfaceOp: 'append'`。

---

## 幂等性约束（应用层必须实现）

**文件证据**: `dsh-session/lib/index.js:1479` + mirror-spike P3/P4 实测

Session 不提供任何去重保障：

### (botId, nodeSeq) 去重
Spike P3 实测（`dsh-session:1479`：`get seq() { return SessionLogOffset(this.log.length) }`）：Session 对 `(botId, nodeSeq)` 完全透明，重复写入只会产生更多事件，seq 继续递增。

**约束**：ds-bot mirror 层必须在应用层维护 `(botId, nodeSeq) → 已写` 映射；重连重放前检查，已写的跳过不再 append，否则消息重复。

### (turn, step) 去重
Spike P4 实测：Session 允许重复 `(turn, step)` 对，不报错，不拦截，渲染器会产生两个相同 bot 气泡（`dupError: null`）。

**约束**：mirror 层必须跟踪已写 `(turn, step)` 对，跳过重复写入。

---

**文件**: `ds-bot/src/host/channel.js` + `ds-bot/src/host/joined-turn.js:175–197`

原生路径（本地 Bot）：
```
用户在 Composer 输入
  → Web GUI 调 SessionController.prompt(request, signal)  [SC L4413]
  → source = { kind:'user', rpcId: request.requestId, ... }  [SC L4419–4424]
  → commands.prompt(request, source)  [SC L4425]
  → createUserMessage({ content, source })  [SC L917]
  → agent.followup(message) 或 agent.steer(message)  [SC L923–924]
  → model 调用
```

`rt.sendUser`（channel.js）是 ds-bot 内部 API：
```js
async function sendUser({ sessionId, content, requestId = randomUUID() }) {
  // 直接调 SessionController.prompt
}
```

`wrapSendUser`（joined-turn.js L175–197）**拦截 sendUser**：
- 检查目标 Bot 是否为 `joinedShadow`（`origin==='joined' && worker.home==='remote'`）。
- 是 joined shadow：转发到 `rt.handleJoinedTurn` → 走 `registry.send(nodeId, 'bot/turn', ...)` 远程路径，不调本地模型。
- 不是：走原始 `orig(args)` 本地路径。

**已知缺陷**（mirror-spike P7 实测）：`wrapSendUser`（joined-turn.js:176–180）调 `rt.botOf?.(args?.sessionId)` 按 `bot.id` 反查 Bot。镜像 Session 的 `mirrorSessionId ≠ bot.id`，`rt.botOf(mirrorSessionId) = undefined`，`joinedShadow(undefined) = false`，**实际落到 `orig(args)` = `sessionController.prompt`，本地模型被触发**。这不是设计意图，是实现缺陷——S1 必须修。

**第二拦截点**（mirror-spike P7 补出）：`channel.js:780` 有独立的 `sessionController.prompt` 包装，是唯一绕过 `agent.followup` 的直接 prompt 入口。除 `wrapSendUser` 外，所有 13 条本地模型写入路径都走 `agent.followup` 或 `deliver`，由 `resolveAgent` 守护。

**「生成中」由什么收口**：
- 本地路径：SessionController 的 `observeEvent` 流（L1997）推 `turn/end` 事件，前端收到后关闭生成 spinner。
- joined-shadow 路径：`handleJoinedTurn` 返回前 await `wait.pending`（L97）—— 同步等远端 `botTurnResult`；前端在这期间展示等待态，`replyToSender` 写回文本后 spinner 收口。镜像 Session 无生成，页面靠观察 `turn/end` 事件收口。

---

## Q6 Session 归档/删除 API 及恢复语义

**文件**: `dsh-api-session-controller/lib/index.js`

**删除**（L787 `async delete(request)`）：
- 检查 session 存在 → 检查无 subagent owner → 调 `agents.disposeOwned` 停止 live agent → 调 `workspaceRegistry.forgetSession` 移除元数据 → 调 `persistence.delete`。
- **不可逆**：持久化层彻底删除，无恢复。
- 如果 session 处于活跃 agent 且被另一 capability 拥有：抛 `session/agent-busy`。

**归档**（ArchivedSessionGate L3603–3612）：
- `agent/pre-step` hook：如果 session 或其 lineage 祖先被归档，直接 `reject` 下一步，不执行模型调用。
- 归档状态由 `workspaceRegistry.archivedSessionIds` 维护。
- 归档后 session **可读**（`events` / `state` API 仍可用），但**无法恢复 agent 运行**（pre-step hook 永久拒绝）。
- Fork 是例外：`fork()` 从归档 Session 创建新独立 Session，fork 出来的子 Session **不受**祖先归档影响（L3614–3619 注释：「a fork of an archived Session is an independent conversation」）。

**镜像 Session 恢复语义**：镜像 Session 用 `session.append` 只写事件，不 resume agent；它不受归档 gate 影响（gate 只拦截 `agent/pre-step`，纯 append 不触发 step）。删除后无法恢复——需重建并重放远端事件。

---

## Q7 一个 Session 是否允许多个并发 turn；镜像写入约束

**设计前提**（司令确认）：每个远程 Bot 对应一个**独立新建的本地 Session**，Session ID 不复用远端 Bot 的 ID；远端 Bot ID 记录在 `bot.worker` 字段中。

**文件**: `dsh-session/lib/index.js:1524–1545` + `dsh-api-session-controller/lib/index.js:355–364`

**并发 turn**：
- `session.append` 本身是同步的，没有 async 锁。多个调用者可以并发调用；seq 严格单调（= log.length），不会产生 seq 冲突，但事件交错顺序取决于 JS 事件循环调用顺序。
- `inOrder(sessionId, op)`（SC L355–364）是 SessionController 层的串行化——同一 sessionId 的多个 `prompt` 调用排队执行，确保 turn 不交叠。它对镜像写入**无约束**，镜像侧直接调 `session.append` 绕过了这个队列。
- 镜像 Session 是独立 Session，不与任何本地 agent 共用，因此 **seq 不交错**，turn 边界由镜像写入侧自行维护。

**约束与风险**：
- **约束 1**：镜像 Session 必须是独立新建的 Session（`SessionController.create`），不复用任何已有 Session，也不用于 agent 运行。
- **约束 2**：镜像 Session 的 `turn/step` 计数器（写入 `turn/start` 的 data）由 ds-bot mirror 层自维护，与远端无需同步（渲染器只按日志顺序展示）。
- **约束 3**：`turn/start` 写入后，该 Session 不再被 SC 标记为「可复用空白 Session」（SC:393），但这对镜像场景无影响——镜像 Session 本来就不被 SC 复用。
- **风险 1**：镜像 Session 删除后无法恢复，需重建并从远端重放事件历史。
- **风险 2**：镜像 Session 与远端 Bot 的事件顺序依赖网络到达时序；如果远端 Bot 并发多轮，镜像侧 append 顺序决定 seq 顺序，与远端实际 seq 可能不同——对话历史是「重播」而非「镜像副本」。

---

## 结论表（10 行以内）

| 问题 | 实测结果 | 对镜像方案的影响 |
|------|----------|-----------------|
| Q1 `session.append` 签名 | `append(type, data, opts?)` 同步，返回 event；seq = log.length 自增 | ✅ 支持：直接 append，无 seq 冲突 |
| Q1 并发语义 | 单次 publication 重入检查，无 async 锁 | ⚠️ 镜像与本地 turn 并发时 seq 交错；需独立 Session |
| Q2 turn 生成 | 外部可写 `turn/start`；有 turn 的 Session 不被 SC 复用 | ✅ 支持写 turn 边界，但独立 Session 更安全 |
| Q3 `source.kind` | 镜像用 assistant/message 要传 `kind:'model'` 字段 | ✅ 可行；不要传 `kind:'user'` 免得触发 inbox |
| Q3 inbox 触发 | `followup`/`steer` 才进 inbox；`session.append` 不进 inbox | ✅ 关键：只能用 `session.append`，绝不调 followup/steer |
| Q4 渲染器 | 仅 5 种 Surface type 有对话气泡；未知 type 需 `ignorable` | ✅ 镜像写 `user/message` + `assistant/message` 带 `surfaceOp:'append'` |
| Q4 失败提示 | 无专用 error type；用 `assistant/message` 写错误文本 | ✅ 可行 |
| Q5 `wrapSendUser` | 拦截发往 joined shadow 的 sendUser，转走远端路由 | ✅ 已实现；镜像 Session 不在此路径里 |
| Q6 删除 | 不可逆；归档允许只读、禁止 agent 运行 | ✅ 镜像 Session 只 append，不跑 agent，归档 gate 不拦 |
| Q7 独立 Session | 每个远程 Bot 建独立本地 Session，不复用远端 id；远端 id 放 `bot.worker` | ✅ seq 不交错；turn 边界由镜像层自维护 |

---

## 总判定

**镜像方案可行，须走「独立镜像 Session」路径**：

- 每个远程 Bot 对应一个独立新建的本地 Session（`SessionController.create`），Session ID 由本地生成，不复用远端 Bot ID；远端 Bot ID 记录在 `bot.worker`。
- 镜像 Session 不用于 agent 运行（不调 followup/steer/resume），只追加 `user/message` 和 `assistant/message` 事件，均带 `surfaceOp: 'append'`。
- `user/message` data 是消息本体（`createUserMessage` 返回值），`assistant/message` data 是 `{ turn, step, message, usage?, stream? }`——turn/step 由镜像层自维护，从 0 起单调递增。
- 远端消息到达后，ds-bot mirror 层调 `resolveAgent(mirrorSessionId).session.append(...)` 写入；`createSession` 完成即可获得 live agent，`resolveAgent` 直接返回，无需额外操作。

**待验证项**：
1. **（DEFER → S1 第一个实验）** resolveAgent 冷启动探针：`createSession` → 丢弃 handle → `resolveAgent`，观察是否走 `resume` 路径及开销。代码级推断：会走 resume（从 persistence 读取，不调模型），但未实测。建议生产路径持有 `agent.session` 引用，不每次 resolveAgent。
2. **（DEFER → S2 真机）** 前端路由对纯 append 镜像 Session 的点开行为是否与 fork.30/45 test5 一致。S0 不展开。
