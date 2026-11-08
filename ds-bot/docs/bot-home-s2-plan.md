# ds-bot S2 计划：Bot Home

**文档路径**: `ds-bot/docs/bot-home-s2-plan.md`
**分支**: `feat/bot-home-s2`
**基线**: `389fb9cf`（ds-bot `0.3.1-fork.40` + ra `0.10.1-fork.52`）
**状态**: 已冻结 v3（2026-11-09，司令）

---

## 实读文件清单（本版）

| 文件 | 实读内容 |
|------|----------|
| `ra-fork40/lib/protocol.js:562` | `validateBotTurnResult` 完整签名和返回形状 `{ok:true,result:{...}}` |
| `ra-fork40/lib/bot-turn.js:22` | `reply()` 函数及 `bot/turn-result` 发送路径 |
| `ds-bot/src/host/joined-turn.js` | 完整读，210L |
| `ds-bot/src/host/joined-page.js` | 完整读，231L |
| `ds-bot/src/host/mirror.js` | 完整读，82L（seenKeys/seenSteps 去重已实现） |
| `ds-bot/src/host/turn-tracker.js` | 完整读，68L |
| `ds-bot/src/host/executor.js` | 完整读，172L |
| `ds-bot/src/host/bot-store.js` | 完整读（bySessionId 逻辑） |
| `ds-bot/src/host/joined-create.js:64–175` | createBotOnNode 完整读（sessionId 未在此创建） |
| `ds-bot/src/client/joined-chat-dialog.js` | 完整读（弹窗结构） |
| `ds-bot/src/client/overlays.js:60,72` | JoinedChatDialog portal 挂载点 |
| `ds-bot/docs/mirror-contract.md` | 结论表（Q1–Q7）+ 幂等性约束 |
| `ds-bot/test/` 目录 | 确认 `executor-integration.test.js`（无 `executor.test.js`） |

---

## 1. 范围与出口

S2 的终点是**「远程 Bot 的对话长在 Bot 页面里」**。

用户行为路径：打开侧边栏 Bot 列表 → 点击远程 Bot → 看到真实对话历史 → 输入消息 → 收到回复 → 刷新后仍在 → 断网后重连恢复。

**出口判据**（全部通过才算完成）：

1. Bot 在本地有真实 `sessionId`（`state.bots[id].sessionId` 非空），打开 Bot 页加载的是该 `sessionId` 的原生 session，而非弹窗 iframe。
2. 发送消息走 `executor.deliverTurn`，mirror session 用同一个 `sessionId`，历史连续。
3. `seq` 幂等键生效：重传同一条 `(botId, seq)` 不重复写 session；`seq <= watermark` 静默跳过。
4. 历史导入幂等（`importHistory`）：重跑不重复；游标缺口（`seq > watermark+1`）记 warn，不报错。
5. 旧 `joined:` shadow bot 迁移可回滚（备份 `state.bots` 快照，迁移幂等，单条失败不中断）。
6. `JoinedChatDialog` 弹窗退场（真机三项通过后、灰度开关置 `true`、删 portal）。
7. 重启 ds-bot 后，对话历史完整，`sessionId` 不变（session 已存盘）。
8. 真机三项 + 断网演练通过（详见 S2-4）。

---

## 2. seq 契约（新增，本文档冻结）

### 2.1 定义

`seq` 是每条 `bot/turn-result` 帧携带的单调递增整数，标识 **(nodeId, remoteBotId)** 域内该 Bot 的第几轮推理结果。

**冻结规则**：

| 规则 | 内容 |
|------|------|
| 类型 | 非负整数（`number`，整数，≥ 0） |
| 单调性 | per (nodeId, remoteBotId)，单调递增；跨重启不回退，不复用 |
| 帧字段名 | `seq`（`bot/turn-result` 帧） |
| 缺失处理 | `seq` 不存在 / 不是 number / 非整数 → `{ ok: false, error: 'bot-turn-result-seq-missing' }` |
| 非法值处理 | `seq` 是整数但 `< 0` → `{ ok: false, error: 'bot-turn-result-seq-invalid' }` |
| hub 幂等键 | `seenKeys` Set 存 `botId + ':' + String(seq)` |
| Cursor / watermark | `seq <= watermark`：静默 skipped，不写盘，不 warn；`seq > watermark+1`：warn「gap」（仅历史导入场景）；`seq === watermark+1`：正常写入 |

### 2.2 JSON 例子

```json
{
  "ok": true,
  "exchangeId": "abc-123",
  "text": "回复内容",
  "seq": 7
}
```

### 2.3 校验规则（伪代码，与 ra/lib/protocol.js 现有形状一致）

**测试用例（随 2.3 冻结）**：

| 输入 | 预期错误 |
|------|----------|
| `seq` 字段缺失 | `bot-turn-result-seq-missing` |
| `seq: "7"` （字符串） | `bot-turn-result-seq-missing` |
| `seq: 3.5` （非整数） | `bot-turn-result-seq-missing` |
| `seq: -1` （负整数） | `bot-turn-result-seq-invalid` |
| `seq: 0` （合法） | 通过（不报错） |



```js
// ra/lib/protocol.js（扩展现有 validateBotTurnResult:562）
export function validateBotTurnResult(d) {
  // ... 现有校验 ...
  if (d.seq === undefined || typeof d.seq !== 'number' || !Number.isInteger(d.seq))
    return { ok: false, error: 'bot-turn-result-seq-missing' }
  if (d.seq < 0)
    return { ok: false, error: 'bot-turn-result-seq-invalid' }
  return {
    ok: true,
    result: {
      nodeId: ...,
      remoteBotId: ...,
      exchangeId: ...,
      text: ...,
      ok: d.ok !== false,
      seq: d.seq,   // 新增
      ...(d.error ? { error: d.error } : {}),
    },
  }
}
```

---

## 3. 不变量（v3 冻结，沿用编号）与失败矩阵

### 不变量（来自 mirror-contract.md + 架构 v3）

| ID | 内容 | 收口切片 |
|----|------|----------|
| I1 | 每个远程 Bot 有一个真实本地 Session（`SessionController.create`），Session ID 本地生成，不复用远端 id | S2-2（ensureSession） |
| I2 | 镜像写入不触发本地模型：只用 `session.append`，不调 `followup`/`steer`；inbox 长度不增 | S2-1（验证已有 mirror.js） |
| I3 | `(bot.id, seq)` 幂等：同一对最多写一次（`seenKeys`） | S2-1（seq 接入后生效） |
| I4 | 失败可见、120s：超时后 `turn-tracker.sweep` 标 `E_TIMEOUT`，UI 显示错误 | S2-2（turn-tracker 接线） |
| I5 | 删 Bot 时归档对应 mirror Session（`SessionController.archive(mirrorSessionId)`），Session 只读不可恢复运行 | S2-3（迁移 + 清理） |
| I6 | 唯一写入口是 `mirrorTurn`（`mirror.js`）；禁止任何其他路径向 mirror session 写 `user/message` 或 `assistant/message` | S2-2（路径收口） |

### 失败矩阵

| # | 触发条件 | 预期行为 | 收口 |
|---|----------|----------|------|
| F1 | `bot/turn-result` 缺 `seq` | `validateBotTurnResult` 返回 `bot-turn-result-seq-missing`，帧拒绝 | S2-1 |
| F2 | `seq` 重传（已在 seenKeys） | `mirrorTurn` 返回 `{skipped:true,reason:'already-written:nodeSeq'}` | S2-1 |
| F3 | `(turn, step)` 重传 | `mirrorTurn` 返回 `{skipped:true,reason:'already-written:step'}` | S2-1（已有） |
| F4 | 节点离线时发送 | `executor.send` 抛 `E_OFFLINE`，UI 显示「副机离线」 | S2-2 |
| F5 | 120s 无响应 | `executor.send` 抛 `E_TIMEOUT`，`turn-tracker.sweep` 标 timeout | S2-2 |
| F6 | `E_REJECTED`（节点显式拒绝） | UI 显示节点返回的 error code | S2-2 |
| F7 | 新建 Bot 首条消息时 session 未创建 | `ensureSession` 创建后写入，失败则抛 `E_NOT_FOUND` | S2-2（见 §4-S2-2） |
| F8 | `importHistory` 游标缺口 | warn「gap: seq=N watermark=M」，跳过，不报错 | S2-3 |
| F9 | 迁移某条 joined Bot 失败 | warn + skip，继续下一条 | S2-3 |
| F10 | 弹窗遗留（ui.joinedChat 非空） | 灰度开关置 true 后 portal 已删，旧值被忽略 | S2-3 |

延后（P2+）：冷启动 session 恢复开销优化、cursor 增量同步。

---

## 4. 切片详情

### S2-1：清 S1 三条欠账

**目标**：补齐 S1 遗留的三项 TODO，使后续切片依赖的契约完整。

**涉及文件**：

| 文件 | 仓库 | 改动 |
|------|------|------|
| `ra/lib/protocol.js:562` | ra | `validateBotTurnResult` 增 `seq` 字段校验（`bot-turn-result-seq-missing|invalid`） |
| `ra/lib/bot-turn.js:22` | ra | `reply()` 的 `bot/turn-result` payload 增 `seq` 字段（从 `turn-seq.js` 取单调递增值） |
| `ra/lib/node/turn-seq.js`（新） | ra | per (remoteBotId) 单调 seq 生成器；持久化 `<stateDir>/turn-seq.json`（0600） |
| `ds-bot/src/host/executor.js:166` | ds-bot | `nodeSeq: null` → `nodeSeq: result.seq`（`result` 来自 `validateBotTurnResult` 的 `.result`） |
| `ds-bot/src/host/executor.js` | ds-bot | `send()` 新增 `E_INVALID` 入参校验（缺 `botId`、`text` 非字符串/空、`worker` 配置形状错） |
| `ds-bot/test/executor-integration.test.js` | ds-bot | 四把刀（补充 seq + E_INVALID 断言） |
| `ra/test/turn-seq.test.js`（新） | ra | 单调递增 + 跨重启不回退 |

> **注**：`mirror.js` 的 `seenKeys`/`seenSteps` 去重已在 `mirror.js:10-57` 实现；S2-1 只需**把 `seq` 接进来**（`nodeSeq: result.seq`），不新增去重逻辑。

**executor.js 中的错误码区分**：

```
E_INVALID    — send() 入参非法：缺 botId、text 非字符串/为空、worker 配置形状错（S2-1 新增）；与 E_NOT_FOUND 严格区分
E_NOT_FOUND  — bot 未注册或 worker 配置缺失（executor.js 已有）
E_OFFLINE    — 节点不可达（executor.js 已有）
E_TIMEOUT    — 120s 无结果（executor.js 已有）
E_REJECTED   — 节点显式返回 ok:false（executor.js 已有）

bot-turn-result-seq-missing  — validateBotTurnResult 帧校验：seq 缺失或类型错（ra/lib/protocol.js:562 新增）
bot-turn-result-seq-invalid  — validateBotTurnResult 帧校验：seq < 0（ra/lib/protocol.js:562 新增）
```

**`turn-seq.js` 接口签名**：

```js
// ra/lib/node/turn-seq.js
export function createTurnSeq(stateDir)
// → { next(remoteBotId): number,   // 单调递增，写 stateDir/turn-seq.json
//     reset(remoteBotId): void,     // 仅测试用
//   }
```

**测试刀**：

| 刀 ID | 切哪行 | 断言 |
|--------|--------|------|
| S21-seq-missing-unit | `protocol.js:562` seq 检查行删掉（单元测试）| `validateBotTurnResult({...无seq...})` 直接返回 `{ok:false,error:'bot-turn-result-seq-missing'}`（红：不再返回 ok） |
| S21-seq-missing-e2e | `protocol.js:562` seq 检查行删掉（集成测试）| 坏帧到达 listener 后 mirror session 无新写入，错误对 UI 可见（E_REJECTED 或 bot-turn-result-seq-missing） |
| S21-E_INVALID | `executor.js` 入参校验逻辑 → 删掉 | 空 `botId` 的 `send()` 调用穿透到 `registry.send`，而非抛 `E_INVALID`（红） |
| S21-seq-dedup | `mirrorTurn` 中 `seenKeys.has(nodeKey)` → 删掉（`mirror.js:14`） | 同一 `(botId,seq)` 第二次调用 `mirrorTurn` 不返回 `skipped:true` |
| S21-seq-monotone | `turn-seq.next` 递增逻辑 → 改返回常数 0 | 第二轮 seq=0，与第一轮重复，`seenKeys` 检出 skipped |

**验收**：`node:test ds-bot/test/executor-integration.test.js ra/test/turn-seq.test.js` 全绿（含 S21-E_INVALID、S21-seq-missing-unit、S21-seq-missing-e2e、S21-seq-dedup、S21-seq-monotone）。

---

### S2-2：接 channel/UI + ensureSession

**目标**：发送走 `executor.deliverTurn`；Bot 页打开真实本地 session；`bySessionId` 拦截生效；超时与离线可见；新建 Bot 首条消息时按需创建 mirror session。

**谁给 Bot 建 sessionId（新建 Bot 落点）**：

`createBotOnNode`（`joined-create.js:64`）在 Bot 创建成功后写入 `state.bots[shadowBotId]`，但**不设 `sessionId`**（`joined-create.js:153` 的 upsert 无 sessionId 字段）。因此：

- **时机**：首条消息时（`channel.js:772 sendUser` 入口），由 `ensureMirrorSession(rt, bot)` 按需创建。
- **失败退路**：`ensureMirrorSession` 失败 → 抛 `E_NOT_FOUND('no-session')`，UI 显示「无法建立本地对话」，不发送消息。
- **历史导入**：`ensureMirrorSession` 成功后立即调 `importHistory`，从节点拉历史（`joinedChatPage`）填入 mirror session。

**涉及文件**：

| 文件 | 仓库 | 改动 |
|------|------|------|
| `ds-bot/src/host/channel.js:772` | ds-bot | `sendUser` 入口：joined shadow 走 `ensureMirrorSession` + `executor.deliverTurn`；非 joined 走原路径 |
| `ds-bot/src/host/channel.js:275` | ds-bot | `chatPage` 入口：joined shadow 读本地 `rt.chatOf(bot.id)` session，不再发 `bot/history` 帧 |
| `ds-bot/src/host/mirror.js` | ds-bot | 新增 `ensureMirrorSession(rt, bot)` → 创建 session + 更新 `bot.sessionId` + 调 `importHistory` |
| `ds-bot/src/host/executor.js` | ds-bot | `deliverTurn` 调用前确保 `session` 已由 `ensureMirrorSession` 提供 |
| `ds-bot/src/host/joined-turn.js:wrapSendUser` | ds-bot | 标记 `@deprecated`（S2-2 收口后 joined shadow 不再经此路径） |
| `ds-bot/src/host/bot-store.js:66` | ds-bot | `updateBySessionId` 在 `ensureMirrorSession` 赋值后调用，更新 index |
| `ds-bot/src/host/turn-tracker.js` | ds-bot | 接入 `channel.js`（`rt.turnTracker = createTurnTracker()`），扫描超时 120s（`sweep`） |
| `ds-bot/test/executor-integration.test.js` | ds-bot | 四把刀 |

**关键路径**：

```
旧: sendUser → wrapSendUser(joined-turn.js) → handleJoinedTurn → bot/turn → bot/turn-result
新: sendUser(channel.js:772) → joined? → ensureMirrorSession → executor.deliverTurn
                                                                 ↓         ↓
                                                           registry.send  mirrorTurn
                                                           (bot/turn)     (session.append)
```

**`ensureMirrorSession` 签名**：

```js
// ds-bot/src/host/mirror.js（新增）
export async function ensureMirrorSession(rt, bot) {
  // 若 bot.sessionId 已存在 → 直接返回 rt.sessionOf(bot.sessionId)
  // 否则：
  //   1. session = await rt.createMirrorSession(bot.id)
  //   2. bot.sessionId = session.sessionId
  //   3. updateBySessionId(rt.bySessionIdIndex, bot.id, null, session.sessionId)
  //   4. await rt.save()
  //   5. await importHistory(session, await rt.joinedChatPage(bot.id))（幂等）
  // 失败 → 抛 Error({ code: 'no-session' })
  // @returns {Session}  store-owned Session
}
```

**测试刀**：

| 刀 ID | 切哪行 | 断言 |
|--------|--------|------|
| S22-path | `executor.deliverTurn` 调用 → 替换成直接 `handleJoinedTurn` | mirror session 中出现重复 `user/message`（双路径） |
| S22-offline | `registry.send` 返回 false | `sendUser` 返回含 `E_OFFLINE` 错误，UI 收到「副机离线」 |
| S22-timeout | `listenBotTurnResult` timeout 提前触发 | `executor.send` 抛 `E_TIMEOUT`，`turn-tracker` sweep 标 timeout |
| S22-no-session | `ensureMirrorSession` → 模拟 `createMirrorSession` 抛错 | `sendUser` 抛 `E_NOT_FOUND('no-session')`，不发 bot/turn |

**待验证项**：
- V1：`rt.createMirrorSession(botId)` 的精确调用形式（`rt.createSession` or `SessionController.create`），需工程师在 S2-2 开干前对照 channel.js 当前 `rt` 对象确认。

---

### S2-3：历史导入 + 迁移 + 弹窗退场 + 灰度开关

**目标**：`importHistory`；旧 `joined:` Bot 迁移；弹窗退场（按开关顺序）；灰度开关。

**涉及文件**：

| 文件 | 仓库 | 改动 |
|------|------|------|
| `ds-bot/src/host/mirror.js` | ds-bot | 新增 `importHistory(session, items, opts)` |
| `ds-bot/src/host/roster-join.js` | ds-bot | 新增 `migrateLegacyJoined(rt, opts)` |
| `ds-bot/src/client/overlays.js:72` | ds-bot | 删除 `JoinedChatDialog` portal（仅在灰度开关置 true 后执行） |
| `ds-bot/src/client/cells.js:384`、`row-actions.js:5` | ds-bot | 调用点分流：`if (botHomeEnabled) actions.openAgent(bot.id)` else `actions.openJoinedChat(bot.id)`；`team-actions.js:172` 保持原样不动 |
| `ds-bot/src/host/channel.js` | ds-bot | 灰度开关 `rt.botHomeEnabled`（boolean，由 `apply(ctx, config)` 读 `config.features?.botHome === true` 挂到 `rt`，在 `channel.install(rt)` 之前赋值；配置写 `cordis.patch.yml` 插件 config） |
| `ds-bot/test/mirror-import.test.js`（新） | ds-bot | 导入测试 |
| `ds-bot/test/migration.test.js`（新） | ds-bot | 迁移测试 |

**灰度开关切换顺序**：

```
1. S2-1 + S2-2 + S2-3 装机（rt.botHomeEnabled = false）
   → 旧弹窗仍在；新路径不激活；观察 session 创建和 mirror 是否正常
2. 真机三项（T1/T2/T3）通过
   → 将 rt.botHomeEnabled = true（更新 cordis.patch.yml 插件 config 的 features.botHome: true）
3. 弹窗退场：删 overlays.js:72 portal，清除 cells.js:384 / row-actions.js:5 的调用点分流（或 botHomeEnabled 恒 true）；team-actions.js:172 保持原样
4. 回滚一步：将 rt.botHomeEnabled = false + 设 botHomeEnabled=false（调用点自然回弹窗，无需还原 team-actions.js:172）
```

**`importHistory` 签名**：

```js
// ds-bot/src/host/mirror.js（新增）
export async function importHistory(session, items, opts = {}) {
  // items: [{userText, botText, turn, step, seq?, time?}]
  // opts: { seenKeys: Set, closedKeys: Set, seenSteps: Set, watermark?: number }
  // seq <= watermark → 静默 skipped（不写，不 warn）
  // seq > watermark+1 → warn 'gap: seq=N watermark=M'（仅导入场景）
  // 返回: { imported: number, skipped: number, warnings: string[] }
}
```

**`migrateLegacyJoined` 签名**：

```js
// ds-bot/src/host/roster-join.js（新增）
export async function migrateLegacyJoined(rt, opts = {}) {
  // 把 state.bots 中 origin==='joined' && !bot.sessionId 的每一条：
  //   1. 调 ensureMirrorSession（创建 session + 导入历史）
  //   2. 更新 bot.sessionId，保存 state
  //   单条失败 → warn + skip，继续下一条（I6 不中断）
  // opts: { dryRun?: boolean }
  // 返回: { migrated: number, skipped: number, failed: number, errors: object[] }
}
```

**迁移回滚**：

1. `migrateLegacyJoined` 执行前：`JSON.stringify(state.bots)` 快照写 `<dshHome>/bot-home-s2-backup.json`。
2. 回滚：将快照粘回 `state.bots`，删除新建 mirror session 目录（`<dshHome>/sessions/<sessionId>/`）。

**测试刀**：

| 刀 ID | 切哪行 | 断言 |
|--------|--------|------|
| S23-import-dedup | `importHistory` 中 `seenKeys` 检查 → 删掉 | 重跑 `importHistory` 产生重复 `user/message` |
| S23-import-gap | `seq > watermark+1` warn 逻辑 → 删掉 | 缺口时无 warning，静默跳过（不符合合同） |
| S23-migrate-fail | `migrateLegacyJoined` 中单条失败改为不 catch | 一条失败中断所有迁移（I6 违反） |
| S23-modal-gone | 恢复 `overlays.js:72` portal 后检查 | `document.querySelector('[aria-modal="true"]')` 存在（回归） |

---

### S2-4：真机验收

**前置**：S2-1 + S2-2 + S2-3 装机完成，`rt.botHomeEnabled = true`，弹窗已退场。

**T1：创建远程 Bot 并打开 Bot 页**
```bash
# 1. 从 UI 创建远程 Bot（节点 dshtest-1）
# 2. 观察 state.bots[id].sessionId 非空（ensureMirrorSession 在首次打开时创建）
# 3. 打开 Bot 页，断言渲染的是原生 session（不是弹窗），items 来自 rt.chatOf
```

**T2：发送消息 → 收到回复 → mirror 落盘**
```bash
# 1. 发送「ping」→ 等待回复（≤120s）
# 2. 断言：mirror session 中有 user/message{text:ping} + assistant/message
# 3. 断言：session 事件有 seq 字段，seenKeys 中有 botId:seq
```

**T3：重启后历史仍在**
```bash
# ⌘Q 重启 ds-bot
# 打开同一 Bot 页，断言历史条数不减少（session 存盘）
```

**T4：断网 → 恢复**
```bash
# 1. 断开 dshtest-1 节点网络
# 2. 发送消息，断言 UI 显示「副机离线」（E_OFFLINE），不写 mirror session
# 3. 恢复网络，重试发送，断言成功
# 4. 历史无重复（seq 幂等）
```

---

## 5. 不变量与失败矩阵 → 切片映射

| 不变量 | 收口 | P2+ 延后 |
|--------|------|----------|
| I1 真实本地 Session | S2-2（ensureMirrorSession） | — |
| I2 不触发本地模型 | S2-1（验证已有路径） + S2-2（路径收口） | — |
| I3 (bot,seq) 幂等 | S2-1（seq 接入） | — |
| I4 失败可见 120s | S2-2（turn-tracker 接线） | — |
| I5 删 Bot 归档 Session | S2-3（迁移清理） | — |
| I6 唯一写入口 mirror | S2-2（wrapSendUser deprecated） | — |

| 失败矩阵 | 收口 |
|----------|------|
| F1–F3 | S2-1 |
| F4–F7 | S2-2 |
| F8–F9 | S2-3 |
| F10 | S2-3（开关切换后） |

---

## 6. 依赖

| 切片 | 前置 |
|------|------|
| S2-1 | S1 a23f6758 |
| S2-2 | S2-1 |
| S2-3 | S2-2 |
| S2-4 | S2-3 装机 + botHomeEnabled=true |

---

## 7. 风险与退路

### R1：mirror session append 触发 inbox（I2 违反）

**触发**：`session.append('user/message', ...)` 误用 `agent.followup` 路径（mirror.js 调用者错误）。
**证据**：mirror-contract.md Q3：`followup`/`steer` 才进 inbox；`session.append` 不进。
**退路**：S2-1 测试 S21-seq-dedup 覆盖 mirror.js append 路径；S2-2 测试 S22-path 抓住双路径写入。

### R2：`channel.js:780 sessionController.prompt` 直接入口绕过 executor（I6 违反）

**触发**：`channel.js:780` 有独立 `sessionController.prompt` 包装，在 joined shadow 情况下直接触发本地模型（mirror-contract.md §Q5 已记录）。
**退路**：S2-2 在 `channel.js:780` 增加 joined shadow 拦截（同 wrapSendUser 逻辑），抛 `bot/joined` 错误。测试 S22-path 用刀覆盖。

### R3：冷启动 session 恢复开销（I1 实现代价）

**触发**：Hub 进程重启后首次 `resolveAgent(mirrorSessionId)` 走 `resume()` 路径，读磁盘，可能 >5s。
**退路**：
- P1：接受开销（mirror-contract Q5 结论：正常持有 `agent.session`，冷启动 `resolveAgent` 可能走 resume，接受开销）。
- P2：进程启动后批量 warm-up joined shadow sessions。

---

## 8. 版本号映射（目标，待工程师确认）

| 切片 | ds-bot | dsh-remote-agent |
|------|--------|-----------------|
| S2-1 | 0.3.2-fork.41 | 0.10.2-fork.53 |
| S2-2 | 0.3.2-fork.42 | — |
| S2-3 | 0.3.2-fork.43 | — |
| S2-4 | — | — |

> 版本号为建议值，工程师开干前对齐 package.json 确认。


---

## 附录：切片拆分记录（S2-3a/b/c）

**拆分原因**：冻结计划 §4 S2-3 把「importHistory + 迁移 + 灰度开关 + 删弹窗 portal」放在一片里。但 §4 灰度顺序本身写的是「全部装机(flag=false) → 真机三项 → 才删 portal」，删 portal 本来就不是跟 import 同一批上线。另外 `team-actions.js:172` 的 `openJoinedChat` 是用户**唯一**能聊天的入口（`cells.js:384`、`row-actions.js:5` 都走它），一旦切到 `openAgent` 又恰好有 bug，用户就完全没有可用的对话入口了。因此客户端和 host 不同批动。

### S2-3a（进行中）：host only

- **范围**：只改 host。`importHistory` + `migrateLegacyJoined` + 持久化 `bot.mirrorWatermark` + 备份/回滚快照 + 测试与 4 把刀。
- **客户端改动**：零。装上去对现有交互没有任何行为变化，可以安全观察。
- **出口**：`importHistory` 幂等测试通过；`migrateLegacyJoined` 单条失败不中断；备份快照生成。

### S2-3b（S2-3a 装完验过再派）：灰度开关

- **范围**：`apply(ctx, config)` 里读 `config.features?.botHome === true` 落到 `rt.botHomeEnabled`（默认 false），并把该值下发到团队视图。
- **客户端分流**：在**调用点**分流，不修改 `team-actions.js:172` 的 `openJoinedChat` 本身：
  - `cells.js:384`：`bot.origin === 'joined' && bot.worker?.home === 'remote'` → `if (botHomeEnabled) actions.openAgent(bot.id)` else `actions.openJoinedChat(bot.id)`
  - `row-actions.js:5`：`if (joined) { if (botHomeEnabled) actions.openAgent(id); else actions.openJoinedChat(id); return }`
- **安全接法说明**：`openAgent` 定义在 `client/index.js:495`，在 `actions` 对象上；`cells.js` 和 `row-actions.js` 的调用点已持有 `actions` 引用，可直接调 `actions.openAgent(bot.id)`。不修改 `team-actions.js:172` 的 `openJoinedChat`，保留为回滚路径（flag=false 时行为不变）。
- **portal**：先不删，留作回滚路径。
- **出口**：flag=false 时行为与 S2-3a 完全一致；flag=true 时打开原生 Bot 页。

### S2-3c（真机 T1/T2/T3 通过后）：删 portal + 死代码清理

- **范围**：删 `overlays.js:72` 的 `JoinedChatDialog` portal 与 `joined-chat-dialog` 相关死代码。
- **出口**：`document.querySelector('[aria-modal="true"]')` 不再出现；flag 永久置 true。

### 与 §1 出口判据 6 的关系

出口判据 6 要求「弹窗退场」。S2-3a 不退场（安全观察），S2-3b 不退场（portal 保留为回滚），S2-3c 退场（真机通过后）。拆分不与出口判据冲突，而是**严格执行**灰度顺序：先安全 → 再切换 → 最后清理。

### 与 §4 灰度顺序的关系

§4 灰度顺序：「S2-3 装机后先 false 观察，真机三项过了再 true 并删弹窗」。拆分后 S2-3a = 装机（false），S2-3b = 切 true（portal 保留），S2-3c = 删弹窗。完全一致，无冲突。


---

## S2-3 契约修正：migrateLegacyJoined 重建语义

**真机事实（2026-11-09）**：
- 节点本地 `test5`：session-79e4fae7-b624-4407-a4b4-d447693ec7b3，213 行，turn 1–18。
- 主机侧镜像：session-a880bdcb-...，26 行，turn 1–3（最近三轮）。
- 两者命名空间不同：节点 `state.json` 是节点本地 Bot；主机 `bot/state.json` 才是 joined Bot 的 `sessionId`。

**冻结 §4 的问题**：§4 `migrateLegacyJoined` 只覆盖 `origin==='joined' && !bot.sessionId`。但 `test5`/`123`/`Chief` 已有 sessionId，且镜像只有最近几轮；节点还有 15 轮更早历史。会话是 append-only，把更早轮次追加到后面会顺序错乱；用 `seq <= watermark` 跳过则把更早历史整段丢掉。

**修正：重建语义**

对已有镜像的 Bot，迁移策略改为**重建**：

1. 翻完节点历史（`joinedChatPage` 全量）
2. `rt.createSession` 建新会话
3. 按时间顺序全量 `importHistory`（turn 由 `allocateTurn` 从 1 起）
4. 换 `bot.sessionId` 为新会话 id；旧 id 存 `bot.legacyMirrorSessionId` 留回滚
5. `mirrorWatermark = maxSeq`

**适用条件修正**：

| 旧条件 | 新条件 |
|--------|--------|
| `origin==='joined' && !bot.sessionId` | `origin==='joined' && (!bot.sessionId \|\| bot.mirrorWatermark < nodeMaxSeq)` |

**`migrateLegacyJoined` 签名更新（覆盖 §4 S2-3 原文）**：

```js
export async function migrateLegacyJoined(rt, opts = {}) {
  // 适用：origin==='joined' && (!bot.sessionId || bot.mirrorWatermark < nodeMaxSeq)
  // 1. 翻节点历史（joinedChatPage 全量）
  // 2. createSession 建新会话
  // 3. importHistory 全量（turn 从 1 起）
  // 4. bot.sessionId = newSessionId; bot.legacyMirrorSessionId = oldSessionId; bot.mirrorWatermark = maxSeq
  // 5. save(); 单条失败 → warn + skip，继续下一条
  // opts: { dryRun?: boolean }
  // 返回: { migrated, skipped, failed, errors }
}
```

**回滚**：将 `bot.sessionId = bot.legacyMirrorSessionId`，删除新建会话目录。

**离线边界**：节点离线或 `joinedChatPage` 翻页失败时，**不许建会话、不许拿离线占位 item 当历史**。正确行为：该 Bot 记 `failed`、warn、继续下一个，`sessionId` 保持原值不变。否则会留下「sessionId 指向空会话、watermark=0」的半截状态，下次又要重建。

**空历史定义**：新 join 且节点确实没有历史的 Bot：建会话、导入 0 轮、`mirrorWatermark = 0`、`legacyMirrorSessionId = null`，不算失败。

**seq 字段实证**（2026-11-09 真机核实）：`seq` 在事件顶层（`{type, data, seq, time}`），不是 `data.seq`。`parts.js:1413-1415` 的 `stamp()` 把 `event.seq` 写到 chatPage item 上，迁移水位用 `item.seq` 可行。节点 `test5` 会话 212 事件、顶层 seq 0..211、turn 1..18；主机镜像 26 行、seq 0..24。

**注**：此处「重建」指重建镜像 Session，不重写 DSH 事件格式（与此前「改而不重写」不冲突）。工程师已按重建口径追单。
