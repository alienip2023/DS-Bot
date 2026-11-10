# ds-bot 对齐 OpenMausBot：P1 交付方案

> 状态：实施计划（不是设计稿）。设计细节见 `docs/thread-model.md`（分支 `docs/thread-model`，提交 `0b8def74`）。
> 基线：ds-bot `62251001`（0.3.2-fork.4）；ra `848a456`（0.10.1-fork.66）。
> 适用：本机 DSH Desktop 上的 ds-bot 插件 + 远程节点上的 dsh-remote-agent。

## 0. "做到 OpenMausBot 的功能"在本方案里的定义

不是把 OpenMausBot 整个搬过来，而是把它最核心的产品结构落到 ds-bot 上：

**Bot → Thread → turns**。一个 Bot 是身份（instructions、记忆、技能、工作目录默认值）；一条 Thread 是一次独立任务（独立会话、独立模型、独立运行状态、独立用量）。

P1 完成后，用户可以在主控上做到：

1. 打开任意 Bot，新建一条线程并给它起名。
2. 在同一个 Bot 下有多条线程，各自上下文互不串（线程 A 记住的事，线程 B 不知道）。
3. 在 Bot 面板头部切换线程，看到每条线程的未读和"正在跑"标记。
4. 每条线程可以单独选模型/推理等级/工作目录；不选则继承 Bot。
5. 远程 Bot（joined）同样支持以上四件事，模型在主控选、节点上真正生效。
6. 同一个 Bot 同时只有一条 turn 在跑，其余排队并显示"排队中"，可取消。
7. 旧数据无损迁移：每个旧 Bot 自动得到一条 `Main` 线程，历史还在。
8. 旧节点（ra fork.65 及更早）仍能工作，自动降级为单线程模式，不崩、不丢消息。

**P1 明确不做**：分支/回退/重放、消息表情、置顶、分享、审批、收件箱、语音、移动端、VM/云电脑、Folder 三级结构、线程级记忆隔离、真正的并行 turn。

## 1. P1 范围（逐项，可验收）

| # | 能力 | 用户可见结果 | 不做的部分 |
|---|---|---|---|
| 1 | Thread 数据模型 | 旧 state 升级后每个 Bot 有一条 Main 线程 | 线程级 segments（P1.5） |
| 2 | 新建/切换/改名/归档线程 | Bot 头部下拉 + 新建按钮；归档线程可恢复 | 拖拽排序、线程文件夹 |
| 3 | 线程级 model/effort/workDir | 每条线程可独立选，空=继承 Bot | 线程级 provider 配置（仍走 P1b） |
| 4 | joined 线程 | 远程 Bot 也能建/切线程，节点上真有独立会话 | 跨节点把线程迁到另一个节点 |
| 5 | 串行队列 | 第二条消息显示排队，可取消 | 并行执行（P1.5-P） |
| 6 | 迁移与兼容 | 旧数据、旧客户端、旧节点都不炸 | 向下兼容新 state 的旧版本恢复 |
| 7 | 每线程用量 | Bot 详情页看到每条线程 token | 费用/美元 |
| 8 | 工具 API | 无（P1.5） | start_thread/list_threads |

## 2. 数据与协议（精确到字段）

### 2.1 状态

```js
// store.js state 新增
state.version: 2
state.threads: {
  [threadId]: {
    id, botId, title, createdAt, updatedAt, archived,
    model: null|string, effort: null|string, workDir: null|string,
    sessionId: null|string, parentThreadId: null, parentTurn: null,
    lastSeq: 0, unread: 0, running: false, queued: 0
  }
}
// Bot 记录新增
bot.threadIds: string[]     // 至少一条（Main）
// bot.sessionId 语义：Main 线程的 sessionId（旧代码兼容）
```

迁移：`store.js migrate(state)`，`version < 2` 时对每个有 `sessionId` 的 Bot 建 Main 线程；写前备份 `state.json.bak-v1-<ts>`；幂等（已有 Main 线程不重复建）。

索引：`buildBySessionId` → `Map<sessionId, {botId, threadId}>`；保留 `bySessionId(sid)` 返回 `botId` 的旧签名，新增 `bySessionIdFull(sid)`。

### 2.2 协议（ra）

| 方向 | 帧 | 载荷 |
|---|---|---|
| HUB→NODE | `thread/create` | `{nodeId, remoteBotId, threadId, title, model?, effort?, workDir?}` |
| HUB→NODE | `thread/list` | `{nodeId, remoteBotId}` |
| HUB→NODE | `thread/update` | `{nodeId, remoteBotId, threadId, title?, archived?, model?, effort?, workDir?}` |
| NODE→HUB | `thread/create-result` | `{requestId, ok, threadId?, error?}` |
| NODE→HUB | `thread/list-result` | `{requestId, ok, threads:[...], error?}` |
| NODE→HUB | `thread/update-result` | `{requestId, ok, error?}` |
| 扩展 | `bot/turn` / `bot/turn-result` / `bot/history` | 增加可选 `threadId` |

兼容：旧节点对未知帧走 dispatch 的 `default` 分支忽略；旧节点收到带 `threadId` 的 `bot/turn` 按未知字段忽略；hub 侧根据节点版本/能力回退单线程。

### 2.3 镜像

`ensureMirrorSession(rt, bot, thread)`：每线程一份镜像 Session；`seenKeys` 键改为 `${botId}:${threadId}:${nodeSeq}`；重连时 `thread/list` 对齐线程，再按 `lastSeq` 拉增量。

## 3. 切片表（工程日按 1 名熟悉代码的工程师计）

| 片 | 内容 | 主要文件 | 依赖 | 验收 | 工程日 |
|---|---|---|---|---|---|
| T1 | state.threads + 迁移 + bySessionId/joined 路由 | `store.js`, `bot-store.js`, `joined-prompt.js`, `test/thread-migrate.test.js` | — | 迁移 3 刀 + 旧 state 副本实跑；`bySessionIdFull` 返回 `{botId,threadId}`，`joinedBotOfSession` 按 thread.sessionId 判定，旧 `bySessionId` 仍返回 botId | 1.0 |
| T2 | host API + 串行队列 | `channel.js`, `roster.js`, `turns.js`, `test/thread-api.test.js` | T1 | 创建/切换/队列/取消 API 测试 | 1.0 |
| T3a | 客户端切换器（P1 必做） | `sidebar.js`, `index.js`, `styles.js` | T2 | 真机点通：侧栏线程行、点击切换 Session、新建线程按钮 | 1.5 |
| T3b | 切换器打磨（P1.5） | `cells.js`, `styles.js`, `i18n.js` | T3a | 未读/运行/排队标记、右键菜单、composer 排队条幅 | — |
| T4 | 线程级 model/effort/workDir（含 joined 模型） | `roster.js`, `model-menu.js`, `node-models.js`, `joined-page.js` | T2 | 两条线程不同模型，节点 state 双份正确 | 1.0 |
| T5 | ra 协议 + 节点线程注册表 | `ra/lib/protocol.js`, `ra/lib/node/index.js`, `ra/lib/hub/index.js` | T2 | 3 刀 + 真 hub/node 建线程 | 2.0 |
| T6 | 镜像隔离 + 重连续读 | `mirror.js`, `joined-turn.js`, `executor.js`, `roster-join.js` | T5 | 两线程上下文隔离；断网 10s 后续读 | 1.5 |
| T7 | 迁移演练 + 旧节点/旧客户端降级 | 测试与兼容代码 | T5,T6 | 旧节点混跑、旧 state 迁移、回滚演练 | 0.5 |
| T8 | 收口：测试、刀、文档 | 全量 | 全部 | 红集合 diff 为空；P1 验收剧本全过 | 1.0 |

P1 合计 **9.5 工程日**（T3b 的改名/归档/标记/菜单移入 P1.5，不计入）；加上验收官/测试员各一轮（约 2 天）与返工缓冲，**单工程师日历按 12–14 个工作日算**。

若把 T3a 收窄成“只做头部下拉、不做侧栏线程行”，可省约 1 天、日历压到 10–11 天，但线程发现性明显变差；默认不这样做。

## 4. 验收剧本（可直接照做）

### 4.1 命令

```bash
cd /Users/kjclaw/dsh-dev/ds-bot-merge/ds-bot
DSH_HARNESS=/Users/kjclaw/dsh-dev/deepseek-harness node --import ./test/harness-resolve.mjs \
  --test --test-timeout=120000 --test-force-exit "test/thread-*.test.js"
```

```bash
cd /tmp/ra-p1b
node --test --test-timeout=120000 test/thread-*.test.js
```

### 4.2 真机（test5）

1. 建 Thread A，发「记住数字 41，只回复 OK」；建 Thread B，发「记住数字 42，只回复 OK」。
2. 回 Thread A 问「我让你记的数字是多少」→ 必须回 41；Thread B → 42。
3. 两条线程分别选不同模型，各发一句；节点 `state.json` 两条线程的 model 与主控一致，回复内容能区分模型。
4. 重启主控（⌘Q）→ 两条线程仍在，上下文不串。
5. 重启节点 `dsh-worker` → 自动重新对齐线程与历史，无重复消息。
6. 把节点换回 ra fork.65（旧版）→ 主控自动单线程模式，发消息仍通，日志无 fatal。

### 4.3 迁移

复制真实 `bot/state.json` 到临时目录 → 跑迁移 → 断言：Bot 数不变、每个 Bot 恰好 1 条 Main 线程、`thread.sessionId == bot.sessionId`、历史 Session 文件未动、备份文件存在。

## 5. 风险与回滚

| 风险 | 处理 |
|---|---|
| `state.version 2` 不可逆 | 迁移前强制备份；回滚只恢复 state.json，会话文件不动 |
| 同 Bot 多 Session 是否被 sessionController 允许 | **已核实：允许。** `dsh-api-session-controller` 的 `create(request)` 只按 workspaceId/cwd 建 Session，无 per-bot 约束，每次返回新 sessionId |
| `controller-wrap`/`mirror-guard` 是否按 Session 隔离 | **已核实：按 Session 隔离**，但 `joinedBotOfSession`（`joined-prompt.js:33-37`）当前只认 `bot.sessionId`，必须随 T1 的 `bySessionIdFull` 一起改，否则非 Main 线程的 joined 路由失效 |
| 多线程争用工作目录 | P1 明确串行；同 workDir 并发不做保证 |
| 旧节点收到新帧 | dispatch default 分支；真机混跑验证 |
| 线程数膨胀 | 每 Bot 上限 10 条（可调），归档不删历史 |

## 6. 当前状态与下一步

- **已完成**：设计文档（`docs/thread-model.md`）、s59 收口（fork.4/fork.66，只测试与改名，未装机）。
- **进行中**：P1b-1 的 ds-bot 测试重写（首版是内联自证，已退回）；线程模型文档 v3 已交（`7d1a59c7`），待一处措辞修正。
- **下一步**：P1b-1 验收 → 开 T1；T1/T2 完成后 T3a/T4 与 T5 并行。
- **未做**：tag/Release、并行线程、审批、收件箱、计算机、语音、移动端。

## 7. 后续阶段（范围，不给日期）

- **P1.5**：线程分叉/回退、消息编辑、表情、置顶、`start_thread`/`list_threads`/`read_thread`、并行线程（先补同 Bot 多 turn 队列测试）、线程级审批偏好。
- **P2**：工具级审批（危险命令/写目录/对外发送 Approve/Deny）+ 收件箱/通知。
- **P3**：远程节点桌面预览/接管；再评估 Local VM/云电脑。
- **P4**：语音、移动端、分享、Webhook、成本（美元）显示。
