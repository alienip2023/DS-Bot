# 合并上游 DS-Bot v0.3.2 的方案（merge/upstream-v0.3.2）

**状态**：设计草案 v1（架构师，2026-11-10，任务 a-upstream-merge-plan-20261110）。只读分析，**未改任何产品代码**，未动 `/tmp/ds-bot` 工作区。
**分支**：`docs/upstream-v032-merge`（基于 `fa93fd30`，worktree `/private/tmp/ds-bot-um`）。**未推送**，推前先问司令。

## 0. 基线与方法

| 项 | 值 | 说明 |
|---|---|---|
| 我们的 tip | `fa93fd30`（`feat/bot-home-s2-slice3`，ds-bot `0.3.1-fork.76`） | 相对共同祖先：158 个提交、136 个文件、+22609/−2975 |
| 上游 | `84c3cb86`（tag `v0.3.2`，`Merge pull request #1043 … release-0.3.2`），remote 名 `upstream` = `Fei2411/DS-Bot` | 相对共同祖先：232 个提交、190 个文件、+25098/−11394（其中 `ds-bot/` 子树 142 个文件、+23224/−11075） |
| 共同祖先 | `6559c9e7`（上游 v0.3.1，`Merge pull request #1032`） | `git merge-base fa93fd30 84c3cb86` |
| remote | `fork`（我们的特性分支，带令牌，本文不贴 URL）、`origin`、`upstream` | `git remote -v` 实查，令牌已脱敏 |
| dry-run | 临时 worktree `/private/tmp/ds-bot-um-dry`（detached `fa93fd30`），`git merge --no-commit --no-ff 84c3cb86`，exit 1，**未提交** | 冲突 18 个文件，见 §2 |
| 测试基线 | 干净 worktree 各跑一遍全量测试，命令见 §4.3 | 见 §4.3；`node v24.21.0`；dev harness 检出 `/Users/kjclaw/dsh-dev/deepseek-harness` |

**证据口径**：行号取自上面两个提交的真实文件；「未核实」表示没有跑到。dry-run 的冲突块规模是 `git merge` 实际写出的 `<<<<<<<` 块数。

---

## 1. 上游 v0.3.2 相对共同祖先的变更清单（按模块）

上游 CHANGELOG `[0.3.2] 2026-11-09` 的主题：侧栏分区（#836）、一个运行时选择器（#916，HDS 模型或本机 agent CLI）、记忆分层与整理、等待可放弃（#919）、设置弹窗两栏（#1038）、macOS 毛玻璃（#1230）、Office 富文本块、Windows computer-use 修复（#1025）、macOS 签名 helper。

下表「与我们重叠」一列：**冲突** = dry-run 有标记；**自动合并** = 双方都改了同一文件但 git 能合，仍需语义复核；**无** = 只有上游改。

### 1.1 `ds-bot/src/host/`（宿主）

| 上游变更 | 规模/文件 | 与我们重叠 | 说明 |
|---|---|---|---|
| 本机 agent 路由加前缀 `local-`：`engines.js` 的 `ROUTE_PREFIX='local-'`，`ENGINES` 键改成 `local-claude-code`、`local-codex-cli`…，`CUSTOM_PREFIX='local-acp-'`，新增 `legacyRoute()`、`AMBIGUOUS_OLD_ROUTES=new Set(['opencode'])`；`store.js` 新增 `migrateLocalRoutes(state)`，把已存的 `claude-code/..` 改写成 `local-claude-code/..` | `local-agents/` 8 个文件（acp/adapter/claude/codex/discover/engines/index/jsonrpc，+539/−111）、`store.js`（+77） | **有实质影响**：`config-source.js:134`（`LOCAL_CLI_PREFIX = /^(claude-code\|codex-cli)(\/\|$)/`）、`:239`（`CLI_PREFIX`）、`client/node-models.js:11`（`CLI_PROVIDER`）都只认旧名；客户端 `agent-logos.js:6,47`、`agent-routes.js:10-11` 按旧名索引 | 见 §3 R1 |
| 记忆拆分：新增 `memory-copy.js`、`memory-entries.js`、`memory-review.js`、`memory-search.js`、`memory-tidy.js`，`memory.js` 大幅重构；`MEMORY_LIMITS` 搬到 `memory-entries.js` | 新文件 5 个 + `memory.js` | **冲突 4 块**（`memory.js`）；我们的 dsh-mneme 后端选择（`isMnemeInstalled`、`memoryBackendOf`、`backendOf(bot)` 守卫，提交 `15a0fd1`）夹在里面 | 见 §2 memory.js |
| 新增 `group-log.js`（群聊日志），`MODULES` 在 `groups` 之后插 `groupLog` | 新文件 1 个 | `index.js` 冲突 1 块 | 见 §2 index.js |
| `delivery.js`：`deliver` 签名增 `fromName: senderName`、`abandoned = false`、`recordExchange = true`；`headerFor` 支持 abandoned | +少量 | **冲突 2 块**；我们在同一位置加了 `joinedTurn=false` 与 `refuseJoinedDispatch/handleJoinedTurn/handleRemoteTurn` 拦截 | 见 §2 |
| `handoffs.js`：`closeWork(id, name, text, extra = {})`、`LATE_ANSWER` | 小 | **冲突 2 块**（我们带 `DELEGATE_TIMEOUT_MS`、`clearDelegateTimer`） | 见 §2 |
| `turns.js`（+102/−9）：`adoptLiveWork` 并入 `Object.assign(rt, …)`；迟到/放弃标记；CJK 工具调用标签正则；`RECOVERED_TURN = -1`；`cutOffText`（max-tokens） | 中 | **冲突 1 块**（我们 39 行的 remote-worker `rt.deliver` 包装与 `settleJoinForTurn` 导出） | 见 §2 |
| `resume.js`（+25）：读 `turn/end` 的 `reason.kind === 'max-tokens'`，调用 `rt.noteCutOffTurn`、`rt.noteFailure` | 小 | 自动合并（我们没改 resume.js）；**但会读到我们 `turn-end.js` 写出的 turn/end**，见 §3 R4 | |
| `parts.js`（+167/−34）：`notePlan/noteThrough/writeNote/handoffPackage/startSwitch/offEngine/holdStep`。`startSwitch(joined…)` 的 `joined` 是**上游自己的「joined 历史行」概念，不是我们的 joined shadow** | 中 | 无重叠文件；**术语撞车**，评审时别混淆 | |
| `roster.js`（分区：`resolveSectionInput`、`sectionId`、`state.sections`）、`tools.js`（`section` 参数）、`channel.js`（+46/−5：`MEMORY_LIMIT_SCOPES`、`abandon-work` 端点）、`constants.js`（`LATE_ANSWER`、`SECTION_NAME_MAX=32`、`SECTION_COLORS`） | 各中小 | roster/tools/channel **冲突**（3/3/2 块）；constants 自动合并 | 见 §2 |
| `models.js`（`resolveLocalModel`）、`diagnostics.js`（导出 `dshVersion`）、`images`、`browser`、`session.js` | 小 | `diagnostics.js` 自动合并；其余只有上游改 | |
| `computer/index.js` + 新 `computer/mac-helper.js`；`im/platforms/` 7 个文件 + 新 `retry.js`；`office/{docx,pptx,xlsx}.js` | 中 | 无 | 只需确认依赖（`ws`、`playwright-core`）装上 |

### 1.2 `ds-bot/src/client/`（界面）

| 上游变更 | 与我们重叠 |
|---|---|
| 新文件 `agent-cards.js`（`RunModeCard`、`CliList`）、`settings-shell.js`（设置弹窗两栏） | 无 |
| 侧栏分区：拖放、`SectionBlock`、`SectionMenu`；`state.sections:[{id,name,collapsed?,color?}]`（设计文档 `docs/plans/2026-11-04-sidebar-sections.md`） | **设计撞车**，见 §2 末尾「设计决策 D1」。`sidebar.js` 冲突 3 块、`context-menu.js` 1 块、`team-actions.js` 1 块 |
| 一个运行时选择器：创建 Bot 时选 HDS 模型或本机 CLI | `create-bot.js` 冲突 4 块；`model-menu.js` 冲突 2 块；`bot-settings.js` 冲突 1 块 |
| `cells.js`、`i18n.js`、`index.js`、`styles.js` 大量改动 | 双方都改，**自动合并**（无标记），要语义复核（§2.3） |
| **生成物** `ds-bot/client.js`（≈36k 行）、`ds-bot/office.js` | `client.js` 冲突 283 块 → 不手合，见 §4.4 |

### 1.3 其余

| 范围 | 变更 | 与我们重叠 |
|---|---|---|
| 测试 | 上游 58 个文件，删 `ds-bot/test/models-step.test.js`；新增 `settings-shell`、`run-mode` 等 | `install.test.js`、`memory.test.js` 双方都改（自动合并，需复核） |
| `package` | `ds-bot/package.json` 版本 `0.3.2`，新增依赖 `playwright-core 1.64.1`、`ws 8.18.3`（`package-lock.json` 同改）；`ds-bot/cordis.patch.yml` 新增 `- id: ui-settings-general disabled: true` | `package.json` 冲突 1 块（只有版本号），`package-lock.json` 冲突 2 块 |
| `app/`（Electron 外壳） | 22 个文件：`macos.css`、`material.css` 新增，`mica.css` 删除，`main.mjs`、窗口框架、签名校验脚本等 | 无（我们没改 `app/`） |
| `docs/` | 10 个文件，新增 `docs/plans/2026-11-04-sidebar-sections.md`、`2026-11-09-memory-layers.md` | 无（我们的设计文档在 `ds-bot/docs/`） |
| `docker/`、`.github/`、根 README/CHANGELOG/NOTICE | docker 7 个文件、`.github` 3 个 | 无 |

### 1.4 上游**没有**的东西（我们的全部保留）

在上游 `ds-bot/src` 里 grep 以下关键字均为空：`remote-agent`、joined shadow、remote-worker、`node-policy`、`config-sync`、mirror、`allocateTurn`、`ReactLoopAgent`、`interruptedTurnClosers`。因此以下功能**没有上游等价物，全部以我们为准**：

| 我们的功能 | 文件 |
|---|---|
| 远程 Bot 并入名单、joined 影子、远程对话 | `host/roster-join.js`、`joined-create.js`、`joined-page.js`、`joined-turn.js`、`joined-prompt.js`、`joined-running.js`、`worker-bridge.js`、`bot-store.js`、`executor.js`、`turn-tracker.js` |
| 镜像会话 | `host/mirror.js`、`turn-end.js`、`mirror-guard.js`、`controller-wrap.js` |
| 模型同步与网关 | `host/config-source.js`、`config-v2.js`、`gateway/*`（auth/index/models/proxy/router/token-store/upstream） |
| 节点环境感知 | `host/host-context.js`、`path-guard.js` |
| 客户端 | `client/node-models.js`、`joined-chat-*`、`row-actions.js`、`pick-targets.js`、`host-session.js`、`joined-errors.js` |

上游**部分相似**的只有两处，且不等价：
- 「运行时选择器」选的是**本机** CLI/模型；我们的 `node-model-menu` 是**为节点 Bot 选节点已同步的模型**。两者并存，见 §2 `model-menu.js`/`create-bot.js`。
- 「记忆分层/整理」与我们的 `memoryBackend`（mneme 或文件）不是同一件事，见 §2 `memory.js`。

---

## 2. dry-run 冲突清单与处理原则

### 2.1 冲突文件总表

18 个文件有冲突标记（`git status` 的 `UU`）；`client.js` 与 `package-lock.json` 是生成物。**块数为 `<<<<<<<` 实际数。**

| 文件 | 块数 | 规模（ours / theirs） | 处理 | 理由 |
|---|---|---|---|---|
| `ds-bot/client.js` | 283 | 36k 行生成物 | **不手合**：任取一边，解决所有源文件后 `npm run build` 重建 | 生成物，唯一正确来源是源码 |
| `ds-bot/package-lock.json` | 2 | — | **不手合**：`npm install` 重新生成 | 同上；要保留 `ws`、`playwright-core` |
| `ds-bot/package.json` | 1 | 仅版本号 | 手工：版本取 §4.5 方案；保留我们的 `files[]` 里的 `"src/gateway/"` 与 homepage/repo | 非冲突部分已自动合并 |
| `ds-bot/index.js` | 1（@71） | ours 53 项 `MODULES`；theirs 45 项 | **手工**：取我们的数组，在 `groups` 之后插入 `groupLog`；保留 `export const MODULES` | 上游行 `…tools, chatIndex, groups, groupLog, goals…`；我们要 `export`（测试读它） |
| `host/turns.js` | 1（@1258） | ours 39 行 / theirs 1 行 | **手工**：保留我们的 `rt.deliver` 包装块与 `settleJoinForTurn` 导出；`Object.assign(rt, {…})` 行取上游（带 `adoptLiveWork`） | 两边加的是不同东西，互不依赖 |
| `host/delivery.js` | 2（@61、@112） | ours 24 / theirs 5 | **手工**：签名取并集（`joinedTurn=false` + `abandoned=false` + `recordExchange=true` + `fromName: senderName`）；我们的 `refuseJoinedDispatch/handleJoinedTurn/handleRemoteTurn` 拦截**放在 `const fromName = senderName ?? from?.name ?? 'You'` 之前**；@112 两个展开都保留：`...(joinedTurn ? { joinedTurn: true } : {})`、`...(abandoned ? { abandoned: true } : {})` | 拦截必须早于任何会写本机会话的代码（I7） |
| `host/handoffs.js` | 2 | 小 | **手工**：import 取并集（`LATE_ANSWER, TEXT_KEPT, DELEGATE_TIMEOUT_MS`）；`closeWork(id, name, text, extra = {})` 内保留 `clearDelegateTimer(id)` | 两个参数互不冲突 |
| `host/roster.js` | 3 | 小 | **手工**：import 并集（`MEMORY_BACKENDS, splitRef` + `SECTION_COLORS, SECTION_NAME_MAX, unquote`）；`buildBot` 签名并集（`type, worker, memoryConfig` + `section, sectionId`）；@217 `cleanMemoryConfig(memoryConfig)` 与上游 section 解析**两行都留** | 纯并集 |
| `host/channel.js` | 2（@427、@460） | 小 | **手工**：@427 `create-bot` 取参并集（`type: body.type, worker…` + `section: body.section…`）；@460 取上游新增 `case 'abandon-work'`，注意括号平衡 | |
| `host/store.js` | 1 | import | **手工**：并集（`updateBySessionId` + `AMBIGUOUS_OLD_ROUTES, legacyRoute`） | |
| `host/tools.js` | 3 | 小 | **手工**：`update_bot` schema、解构、`updateBot` 调用三处都取并集（`type, worker` + `section`） | |
| `host/memory.js` | 4（@47、@845、@961、@1863） | 最大 2211 行 | **手工，三步**：① @47 取上游的 `export { MEMORY_LIMITS, … } from './memory-entries.js'` / `export { writtenIn } from './memory-copy.js'`，保留我们的 `isMnemeInstalled`、`memoryBackendOf`（`MEMORY_LIMITS` 已搬走，不要重复声明）；② @845、@961 取上游去缩进后的主体（含 `noteWindow(bot)`），再**套回我们的 `const useMneme = backendOf(bot) !== 'file'; if (!useMneme) {…}` 守卫**；③ @1863 取上游（审阅/整理代码已迁到 `memory-review.js`/`memory-tidy.js`，上游只剩 `memoryTidyUndo` 6 行），**把我们的两处 `backendOf(...) !== 'file'` 早退守卫重新加到 `memory-review.js` 对应位置** | 我们对 `memory.js` 的改动共 11 个 hunk（+136/−48）：`memoryBackendOf`、`backendOf`、`backendOfSession`、`rt.fileMemoryFor`、工具注册守卫（约 `:165`）、审阅守卫。丢任何一处，mneme 后端 Bot 会重新写文件记忆（I10） |
| `client/bot-settings.js` | 1 | import | **手工**：保留 `BotModelMenu`（`./node-models.js`），并加入上游 `ModelMenu` 与 `RunModeCard`（`./agent-cards.js`） | 远程 Bot 用 `BotModelMenu`，本机 Bot 用上游的 |
| `client/context-menu.js` | 1（@50） | 小 | **手工**：两个分支都留：我们的 `kind === 'group'`（`GroupMenu`）+ 上游的 `section \| section-add`（`SectionMenu`） | 见设计决策 D1 |
| `client/team-actions.js` | 1（@165） | 小 | **手工**：`updateBot` 保留我们的 `joinedUpdateError` 包装；加上游的 `abandonWork: id => after(call('abandon-work', { id }))` | |
| `client/model-menu.js` | 2（@46、@408） | 中 | **手工合成**：@46 名称/provider 解析取上游的 `nameOf(served)`，再保留我们 `known?.name…` 对节点目录的回退；@408 `ModelChoices` **保留我们的 `unavailable`/`notice`（「Not synced to the node yet」灰显组，`model-menu.js:226-228`）**，同时吸收上游 `ModelRows` 的 `reading`/`opening` 状态 | 两边改的是同一个组件的不同能力 |
| `client/create-bot.js` | 4 | **最大的界面冲突**（ours 52 行） | **手工重做**：保留我们的 Machine 下拉与 `isRemoteNode` 分支、远程 worker 表单、`memoryBackend` 下拉；本机路径改用上游运行时选择器（`CliList`、`RunModeCard`）；提交体里保留我们的 `memoryConfig` | 否则远程 Bot 创建流程（§S2、`bot/create` v2）会回退 |
| `client/sidebar.js` | 3（@96、@252、@1003） | 最大：ours 99 行 | **手工 + 决策 D1**：@96 我们的 `GroupHeaderRow`/`NewGroupRow`；@252 `BotRow` 保留我们的 `botRowClick(joined, id, actions)`，同时接上游的 draggable/`onContextMenu`；@1003 渲染入口见 D1 | |

### 2.2 自动合并但必须语义复核（无冲突标记）

| 文件 | 为什么要看 |
|---|---|
| `client/cells.js` | 我们的 joined 行点击/`row-actions`；上游改单元格结构。看 `botRowClick` 仍被调用 |
| `client/i18n.js` | 我们的 zh 条目（`i18n.test.js:18` 已有 3 条缺失：`create-bot.js` 'Please select a model'、`joined-chat-dialog.js` 'Failed to send'/'Message…'）；上游新增大量串。别让合并再丢 |
| `client/index.js`、`client/styles.js` | `style-debt.test.js:28` 已有 1 个 `#fff` 债；`styles.js` 合并后可能再增 |
| `host/constants.js`、`host/diagnostics.js` | 上游新增常量/导出，核对没有重名 |
| `test/install.test.js`、`test/memory.test.js` | 期望的安装顺序、记忆守卫用例，见 §5 |
| `host/im/index.js`、`host/update.js` | 只有我们改（上游 im 只改了 `platforms/`），**未核实**上游 `platforms/*` 是否依赖我们没动的 `im/index.js` 签名；烟雾测试覆盖 |

### 2.3 设计决策 D1：`state.groups`（我们）与 `state.sections`（上游）撞车 —— **需司令/用户裁决**

| | 我们 | 上游 |
|---|---|---|
| 数据 | `state.groups`，Bot 群组/车队 | `state.sections:[{id,name,collapsed?,color?}]`，Bot 有 `sectionId` |
| 界面 | `GroupHeaderRow`/`NewGroupRow`（`sidebar.js`）、`GroupMenu`（`context-menu.js`）、`toggleBotGroup/createBotGroup/deleteBotGroup/renameGroup`（`team-actions.js`） | `SectionBlock`、`SectionMenu`、拖放 |
| 后端 | `channel.js` 的 `toggle-bot-group`、`create-bot-group`、`delete-bot-group`（约 `:549-575`） | `roster.js`/`tools.js`/`channel.js` 的 `section` 参数 |
| 来源提交 | `bdf24a33`、`f0562c5f`、`82a803e5` | #836 |

**建议（待裁决）**：以上游 `sections` 为侧栏的**唯一**分组模型；我们的 `groups` 数据**原样保留**，在首轮合并里仍按旧方式渲染在「未分区」区域（不删除、不迁移），避免第一次合并就改用户数据；是否把 `groups` 迁移进 `sections` 单列一片（§7 S6），迁移前先做 `state.json` 备份。**三种选项**：A 上游 sections 为准 + 我们的 groups 暂留旧渲染（推荐）；B 立即把 groups 迁成 sections；C 保留我们的、禁用上游 sections。选 C 会留下长期分叉，不推荐。

---

## 3. 上游新行为对我们不变量的风险

| # | 风险 | 触发路径 | 判断 |
|---|---|---|---|
| **R1** | **`local-` 路由前缀**让我们的 CLI 过滤失效。上游把 `claude-code/..` 改名为 `local-claude-code/..`；我们 `config-source.js:134/:239` 与 `node-models.js:11` 的正则只认旧名。后果：主控把本机 CLI 当成普通 provider 推给节点（旧版 v1 载荷字节会变）；节点菜单把 CLI 模型当作「可同步的普通 provider」而不是「节点需自装 CLI」 | 上游 `engines.js` | **高**。修法：三处正则改成 `/^(local-)?(claude-code\|codex-cli)(\/\|$)/` 并加 `|local-` 通配（上游还有 opencode/cursor-cli/gemini-cli/grok-cli/cline/qwen-code/goose 等引擎，名字都变成 `local-<id>`）；**混版本**：主控新、节点旧时节点仍报旧名，所以必须**两种前缀都识别** |
| **R2** | `migrateLocalRoutes(state)` 改写**已存的** `claude-code/..` 为 `local-claude-code/..`。若它也遍历我们的 joined 影子 Bot 的 `model`，会把节点侧的 modelRef 改成节点上不存在的名字 | `store.js`（上游） | **中，未核实**。需读 `migrateLocalRoutes` 是否过滤 `bot.worker`/`joined:` 影子；合并后加测试（§5 I9） |
| **R3** | **mirror 会话写入形状**：我们的 `mirror.js` 写 `stream: []`（`:82`、`:145`、`:346`；`dsh-session` 的 `assertAssistantSettlementShape` 要求）、用 `allocateTurn(session)`（`:17`）分配回合、`turn/end` 统一经 `turn-end.js` 的 `turnEnd` 构造器。上游新 `RECOVERED_TURN = -1`（`turns.js`）用于「插件加载前已在运行的回合」，若与 `allocateTurn` 的回合号域相交（负号）会写出异常回合 | `turns.js` | **中，未核实** 交互。读 `RECOVERED_TURN` 的使用点，确认只用于本机 Bot；我们影子/镜像会话不经它 |
| **R4** | 上游 `resume.js` 新读 `turn/end` 的 `reason.kind === 'max-tokens'` 并写诊断。我们 `turn-end.js` 写的 `completed / aborted{reason:{kind:'user'\|…}} / error{message,code} / interrupted` 形状**不含** `max-tokens`，所以**不会被误判**；但 `resume.js` 读的是 `reason.reason.kind` 这一层，必须与我们的构造器一致 | `resume.js` | **低**；加一条测试固化（§5 I2 刀） |
| **R5** | **mirror-guard**（包 `ReactLoopAgent.send`（`mirror-guard.js:13` 注释 `:565`）与 `wakeDriver`（`:618`））。上游新增调用 `agent.followup/steer` 的路径：`adoptLiveWork`、`abandon-work`（经 `deliver` 发「已放弃」消息）。若对**远程等待**触发放弃，且消息落到 joined 镜像会话，守卫必须丢弃而不启动本机回合 | `turns.js`、`channel.js` `abandon-work`、`delivery.js` | **中**。要加一条端到端测试：对 joined 影子 `abandon-work` 不产生本机回合、不写镜像会话（§5 I3） |
| **R6** | **controller-wrap**（`controller-wrap.js:19` `ORIGINAL = Symbol.for('cordis.original')`，`rawService(view)`，包 `prompt/cancel/list`）。上游**没有新增** `sessionController` 调用点（实测 base/upstream 都是 `page:4 create:2 selectModel:1 resolveAgent:1 prompt:1 projections:1 list:1`），`channel.js:719` 的 `prompt` 在双方都有。风险转移到：合并后**不要**新增未包装的调用。`groupLog` 监听会话事件，只对安装顺序敏感 | — | **低**；固化一条「调用点计数」测试 |
| **R7** | **v1 载荷字节不变**：我们的 `config-v2.js` 对旧节点（无 `config-sync/2` 能力，`:26`）发的仍是 v1 字节。R1 若不修，v1 载荷会多出 `local-*` provider | `config-source.js` | **高（与 R1 同源）** |
| **R8** | **`MODULES` 顺序**：我们是 53 项、导出；上游 45 项、不导出。我们要求 `rosterJoin` 在 `roster` 之前、`mirrorGuard` 在 `joinedPrompt` 之后…（见 `assembly.test.js:85-91`、`:159-160`）。`groupLog` 插在 `groups` 与 `goals` 之间对这些关系无影响，但 `install.test.js` 期望序列（`ctx.calls`）要同步更新，`assembly.test.js` 的相对顺序断言（`:85` joinedPrompt 在 turns 与 channel 之后、`:159` mirrorGuard 恰好一次）应保持绿 | `index.js` | **低**，测试里更新 |
| **R9** | `deliver()` 签名变化：我们的拦截（`refuseJoinedDispatch/handleJoinedTurn/handleRemoteTurn`）要在上游 `fromName: senderName` 逻辑之前执行；顺序反了会让远程投递先写本机交换记录 | `delivery.js` | **中**；§2 已规定顺序，刀见 §5 I7 |
| **R10** | **client.js 重建**：必须用**真实** `npm ci` 的 `node_modules` 重建。用符号链接 `node_modules` 时重建结果只多出路径注释 `// ../../ds-bot/ds-bot/node_modules/deep-view/...`（已实测，我们 tip 上 `client-bundle.test.js:9` 红即因此），属环境产物 | `scripts/build-client.mjs` | **中**，见 §4.4 |
| **R11** | **混版本**：主控 0.3.2-based、节点仍 `0.3.1-fork.N` 时，节点报告的模型 ref 用旧路由名；`bot/create`/`bot/update` 的 `modelRef` 校验（`joined-create.js`、`joined-page.js:202`）需两种名字都认 | — | **中**；要求主控与节点同升（两个包本来就必须成对安装），但合并后要有一条混版本测试 |
| **R12** | 依赖：`ws`、`playwright-core`。第一次在上游干净 worktree 跑测试时，缺 `ws` 导致 `Cannot find package 'ws' imported from …/im/platforms/wecom.js`，整批失败 | `package.json` | **低**；§4.2 先 `npm ci` |
| **R13** | 上游的 `ui-settings-general disabled: true`（`cordis.patch.yml`）与我们补丁无关，但 `settings-shell.js` 的两栏设置会改变我们给 Bot 设置里加的入口位置（如记忆后端选择、远程 Bot 的 workDir/模型） | 客户端 | **未核实**，真机目视 |

---

## 4. 合并执行步骤

### 4.1 分支与备份

| 项 | 做法 |
|---|---|
| 新分支 | `merge/upstream-v0.3.2`，从 `fa93fd30` 起；**不要在已有 worktree 里 checkout**，新建 `/private/tmp/ds-bot-merge`（`git worktree add -b merge/upstream-v0.3.2 /private/tmp/ds-bot-merge fa93fd30`） |
| 保底 | 给 `fa93fd30` 打标签 `pre-upstream-0.3.2`（本地）；保留 `fork.76` 的包文件；开 `git config rerere.enabled true` |
| 方式 | **真合并**（`git merge 84c3cb86`），不 rebase：保留我们 158 个提交的身份，也让以后继续合上游时有新的共同祖先 |
| 不动 | `/tmp/ds-bot`（有 23 项未提交改动，归属不明）；任何已存在的 worktree |

### 4.2 步骤（分片执行，先易后难）

每一步的**通过条件**：该步测试集相对 §4.3 基线**无新增红**。

| 步 | 内容 | 验证 |
|---|---|---|
| **M0** | `npm ci`（在 `ds-bot/`，真实 `node_modules`，**不用符号链接**）；确认 `ws`、`playwright-core` 在 | `node -e "require.resolve('ws')"` |
| **M1** | `git merge --no-commit --no-ff 84c3cb86`；先解决**无需判断**的并集冲突：`package.json`、`index.js`、`store.js`、`handoffs.js`、`roster.js`、`tools.js`、`channel.js`、`constants.js` | `node --check` 每个改动的 `.js`；跑 `assembly.test.js`（读 `MODULES`）、`install.test.js`（固定安装序列 `ctx.calls`）、`roster-install.test.js` |
| **M2** | `delivery.js`、`turns.js`（§2 规定的顺序） | 跑 `joined-*`、`mirror-*`、`turn-end-core`、`controller-*`、`joined-running` 全部 |
| **M3** | `memory.js` + `memory-review.js`（守卫补回） | 跑 `memory.test.js`、`memory-*.test.js`；新增守卫测试（§5 I10） |
| **M4** | **R1/R7 修复**：三处正则改为同时认 `local-` 与旧名；加测试 | `config-source.test.js`、`config-source-v2.test.js`、`node-model-menu.test.js`（新增 `local-claude-code` 用例） |
| **M5** | 客户端手合：`bot-settings.js`、`context-menu.js`、`team-actions.js`、`model-menu.js`、`create-bot.js`、`sidebar.js`（D1 裁决后） | `node --check`；`roster-join-sidebar.test.js`、`node-model-menu.test.js`、`switch-keeps-input.test.js`、`i18n.test.js`、`style-debt.test.js` |
| **M6** | `npm run build` 重建 `client.js`/`office.js`；`npm install` 重生成 `package-lock.json`；提交合并 | `client-bundle.test.js` 绿；`git diff --stat` 看 `client.js` 差异只来自源码改动 |
| **M7** | 全量测试对照 §4.3；新增 §5 的刀测试 | 无新增红 |
| **M8** | 版本号、打包（§4.5）；交验收官按固定提交独立验收 | `npm pack --dry-run` 含 `src/gateway/` |

**可选的并行化（拆成「合并提交」+「客户端跟进提交」）**：若客户端手合工作量过大，可在 M1–M4 之后先用 `git checkout --ours` 处理客户端冲突文件，提交合并（此时界面保留我们的版本，不含上游界面改动），再用「逐文件跟进提交」把上游的界面改动一个文件一个文件地拉进来（`git diff 6559c9e7 84c3cb86 -- <file> | git apply -3`）。**代价**：这些客户端文件在以后再合上游时仍会冲突。**未核实**这样是否更快。

### 4.3 测试基线（实测，干净 worktree）

命令（在 `ds-bot/` 目录下）：

```
DSH_HARNESS=/Users/kjclaw/dsh-dev/deepseek-harness \
node --import ./test/harness-resolve.mjs --test --test-timeout=120000 --test-force-exit "test/*.test.js"
```

| 对象 | 总数/通过/失败 | 红集合 |
|---|---|---|
| **我们 `fa93fd30`**（`/private/tmp/ds-bot-um`） | 2282 / 2243 / **37** / 跳过 2 / 65.6s | 文件级：`archived-parts.test.js`（`ERR_MODULE_NOT_FOUND '@deepseek-ai/dsh-session-reference'`，dev harness 环境）、`at-menu.test.js`、`styles.test.js`。用例级：`by-session-id.test.js:17`（`bySessionId routes to handleJoinedTurn` 实得 0 期望 1）；`client-bundle.test.js:9`（仅符号链接路径注释，环境产物）；`i18n.test.js:18`（3 条 zh 缺失）；`install.test.js:34`（安装顺序）；`joined-page.test.js:211`；`local-agents-loop.test.js:61,74,93,107`；`local-agents.test.js:77,93,102,114,126,141,149,157,195,203,213`；`mirror-gate1.test.js:21,110`；`office-skills.test.js:37,59,64`；`roster-join-sidebar.test.js:203`（`open is not a function`）；`roster-join-step2.test.js:147,172`；`style-debt.test.js:28`（`styles.js` 1 个 `#fff`）；`switch-keeps-input.test.js:197,217`；`usage.test.js:305,326,341` |
| **上游 `84c3cb86`**（`/private/tmp/ds-bot-um-up`，装好 `ws`、`playwright-core` 后） | 2072 / 2017 / **51** / 取消 1 / 跳过 3 / 124.6s | 文件级：`archived-parts`、`at-menu`、`settings-shell`、`styles`。用例级：`local-agents-loop.test.js:61,74,93,107`；`local-agents.test.js` 约 35 例；`office-skills.test.js:37,59,64`；`run-mode.test.js:449,534,547,562,571,582,596` |

**怎么读这个基线**
- 双方共有的红：`archived-parts`、`at-menu`、`styles`、`local-agents*`、`office-skills`——大概率是 dev harness 版本与测试不匹配（环境），**不是我们的回归**。
- 许多失败的报错是 `TypeError: ctx.sessionController.list is not a function`、`defaults.saveSelection is not a function`：harness 版本噪声。**哪些是真回归、哪些是环境，我没有逐条归因 → 未核实**。
- **合并门槛的定义**：合并后的红集合 ⊆ (我们的红 ∪ 上游的红)，且**不得**出现 `run-mode`/`settings-shell` 以外的新红；`by-session-id`、`mirror-gate1`、`roster-join-*`、`joined-page` 这类**我们自己的**红合并前后必须**完全一致**（不能因合并多红或少红而不解释）。
- 已知干扰：用符号链接 `node_modules` 跑会让 `client-bundle.test.js` 红（路径注释）；M0 用真 `npm ci` 就应变绿。

### 4.4 `client.js` / `office.js` 的重建与核对

| 步 | 做法 |
|---|---|
| 解决所有 `src/client/*.js` 冲突后 | `cd ds-bot && npm run build`（即 `node scripts/build-client.mjs`，`package.json:46`） |
| 前提 | 真实 `node_modules`（`npm ci`），**不要**符号链接 |
| 核对 | ① `client-bundle.test.js` 绿；② `git diff --stat ds-bot/client.js ds-bot/office.js` 只出现与源码改动相应的差异；③ `grep -c "<<<<<<<\|>>>>>>>" ds-bot/client.js` 为 0；④ `grep -n "BotModelMenu\|GroupHeaderRow\|joinedUpdateError" ds-bot/client.js` 都有命中（我们的客户端功能确实在包里）；⑤ `grep -n "SectionBlock\|RunModeCard" ds-bot/client.js` 有命中（上游的也在） |
| 不做 | 不手改 `client.js`；不提交含符号链接路径注释的重建结果 |

### 4.5 版本号过渡

| 项 | 建议 |
|---|---|
| ds-bot | `0.3.2-fork.1`（延续 `0.3.1-fork.N` 的命名；在 npm semver 里 `0.3.2-fork.1` > `0.3.1-fork.76`，且 < `0.3.2`），以后每次我们自己的发版 +1。**不要**直接用 `0.3.2`（会与上游同名难以区分） |
| 与 ra 配套 | 两个包必须成对安装（项目既有约束）；ra 当前是 `0.10.1-fork.61`（`3f27a18`，等验收），**合并不改 ra**；R11 混版本要求主控与节点同升 |
| `package.json` | `files[]` 必须仍含 `"src/gateway/"`；homepage/repo 保持 `alienip2023` |
| 发布 | 团队规则：代码改动完成后必须推 fork 并发 Release；DEV → QA（验收官）→ 安装 → 通知用户重启，**不得**跳过验收官 |

### 4.6 回滚

| 层级 | 做法 |
|---|---|
| 合并未提交 | `git merge --abort` |
| 已提交但未推送 | 删除 `merge/upstream-v0.3.2` 分支；`feat/bot-home-s2-slice3` 从未被动过（`fa93fd30`） |
| 已推送未安装 | 不合到 `feat/bot-home-s2-slice3`；保留特性分支继续作为发版源 |
| 已安装 | 重装 `ds-bot-0.3.1-fork.76.tgz`（保留）；节点同回退；用户需重启（⌘Q） |
| 数据 | M5 之前对 `state.json` 做备份；`migrateLocalRoutes` 会改写已存 modelRef，回滚时**先还原备份**再装旧包（旧包不认 `local-` 名字）—— **这是回滚的唯一不可逆点，必须在升级说明里写清** |

---

## 5. 合并后必须成立的不变量（每条至少 2 把刀）

「刀」= 故意做的错误改动，应让**指定测试变红**；没有对应测试的写「新增」。

| # | 不变量 | 刀 A | 刀 B |
|---|---|---|---|
| **I1** | `MODULES` 顺序：我们的 53 项相对顺序不变，`groupLog` 仅插在 `groups` 之后，`export const MODULES` 仍在 | 把 `groupLog` 挪到 `workerBridge` 之前 → `install.test.js`（`ctx.calls` 序列）红 | 去掉 `export` → `assembly.test.js`、`host-context.test.js`（`import { MODULES }`）红 |
| **I2** | mirror 会话写入形状不变：`stream: []`、`allocateTurn`、`turn/end` 只经 `turnEnd` 构造器；且 `resume.js` 读 `reason.reason.kind` 与之一致 | 删掉 `mirror.js:82` 的 `stream: []` → `mirror-session.test.js`/`turn-end-core.test.js` 红 | 在 `mirror.js` 里手写一个 `turn/end` 字面量绕过构造器 → `turn-end-core.test.js` 红；再新增：把 `max-tokens` 写进 mirror `turn/end` → 新增 `resume-shape.test` 红 |
| **I3** | mirror-guard 在合并后仍拦住所有进入 joined 镜像会话的 `send/wakeDriver`，含上游新增的 `adoptLiveWork`、`abandon-work`、迟到回复 | 把 `agent/created` 钩子从 prepend 改成 append → `mirror-guard.test.js` 红 | 对 joined 影子触发 `abandon-work`，放行本机 `followup` → **新增** `joined-abandon.test.js` 红（必须新写） |
| **I4** | controller-wrap：`prompt/cancel/list` 仍被包装；`sessionController` 调用点计数不变（`page:4 create:2 selectModel:1 resolveAgent:1 prompt:1 projections:1 list:1` 加上我们自己的 `prompt:4 cancel:1`） | 去掉 `rawService` 解包（`controller-wrap.js:23`）→ `controller-restore-real.test.js` 红 | 新增一处未包装的 `ctx.sessionController.prompt(` → **新增** `controller-callsites.test.js`（grep 计数）红 |
| **I5** | v1 载荷字节不变：对无 `config-sync/2` 能力的节点，`buildConfigPayload` 输出与合并前逐字节相同，且不含任何 `local-*`/`claude-code`/`codex-cli` provider | 把 `config-source.js:134` 的正则退回只认旧名 → 新增 `local-claude-code` 用例，`config-source.test.js` 红 | 改 v1 序列化的键顺序 → `config-source.test.js` 的字节金样红 |
| **I6** | v2 载荷仍只对认 `config-sync/2` 的节点发送，且同样过滤 CLI（两种前缀） | 去掉 `config-v2.js:26` 的 `config-sync/2` 精确匹配 → `config-source-v2.test.js` 红 | 把 `local-codex-cli` 当普通 provider 放进 v2 → `config-source-v2.test.js` 红 |
| **I7** | joined 影子的投递不会写本机交换/会话：`deliver()` 里我们的拦截先于 `fromName = senderName ?? …` | 在 `delivery.js` 里把拦截挪到 `recordExchange` 之后 → `joined-turn*.test.js`/`by-session-id.test.js` 红 | 丢掉 `...(joinedTurn ? { joinedTurn: true } : {})` 展开 → `joined-turn*.test.js` 红 |
| **I8** | 节点菜单（`node-model-menu`）对 `local-*` 与旧名都标「节点需自装 CLI」，不当成可同步 provider | `node-models.js:11` 改回旧正则 → `node-model-menu.test.js`（新增 `local-codex-cli` 用例）红 | 把 CLI 模型塞进「已同步」组 → `node-model-menu.test.js` 红 |
| **I9** | `migrateLocalRoutes` 不改写 joined 影子 Bot 的 `model` | 让它对影子也改写 → **新增** `store-migrate-joined.test.js` 红 | 对本机 Bot，旧名 `claude-code/x` 仍被改成 `local-claude-code/x`（确保上游行为没被我们顶掉）→ 新增同文件第二例红 |
| **I10** | 记忆后端守卫：`backendOf(bot) !== 'file'` 的 Bot（mneme/none）不写文件记忆、不跑文件审阅/整理 | 去掉 `memory-review.js` 里补回的守卫 → `memory.test.js`（mneme 后端用例）红 | 去掉 `memory.js:165` 附近的工具注册守卫 → `memory.test.js` 红 |
| **I11** | 远程 Bot 创建流程仍可用：`create-bot.js` 的 Machine 下拉、`isRemoteNode` 分支、`bot/create` v2 提交体（`modelRef/effort/workDir/instructions`）保留 | 把 Machine 下拉删掉 → `roster-join-sidebar.test.js`/`create-bot.test.js` 红 | 提交体里去掉 `memoryConfig` → 新增 `create-bot-payload.test.js` 红 |
| **I12** | `state.groups` 数据在合并与分区引入后不丢（D1 方案 A） | 让分区初始化清空 `groups` → **新增** `groups-survive-sections.test.js` 红 | `channel.js` 的 `toggle-bot-group` 被上游 `section` 分支吞掉 → 同文件第二例红 |
| **I13** | `client.js` 是源码的可复现产物，且含我们的功能与上游的功能 | 手改 `client.js` 一行 → `client-bundle.test.js` 红 | 保留冲突标记 → `client-bundle.test.js` 红（并且 `grep` 步骤失败） |
| **I14** | 包内容完整：`files[]` 含 `src/gateway/`；`npm pack` 清单含 `src/gateway/*.js` | 从 `files[]` 删 `src/gateway/` → 新增 `pack-files.test.js`（`npm pack --dry-run --json`）红 | 合并版本号时误改 `name`/`repository` → 同测试红 |
| **I15** | 不泄密：合并不引入把凭据写进日志/提交的路径 | 往 `host-context.js` 文本里加家目录 → `host-context.test.js` 红 | 在 `config-source.js` 日志里打印 apiKey → `config-source.test.js`（脱敏断言）红 |

---

## 6. 真机 / 烟雾测试清单

| T | 步骤 | 通过判据 | 能自动证明吗 |
|---|---|---|---|
| T1 | 装 `0.3.2-fork.1`（主控）+ 同版节点，重启（⌘Q），看主控日志启动无报错 | 日志无 `Cannot find package`、无 `MODULES` 安装错误 | 部分（日志要人看） |
| T2 | 旧 `state.json`（含 `groups`、本机 `claude-code/…` 引用、远程 joined 影子）启动 | `groups` 仍在；本机 Bot 引用被迁成 `local-…`；影子 Bot 的 `model` 未被改 | 迁移逻辑可单测；**真数据**必须真机 |
| T3 | 创建本机 Bot（HDS 模型）、再创建本机 Bot（本机 CLI） | 两种都能创建并对话（上游新选择器） | 否（UI） |
| T4 | 创建远程 Bot（选 Machine=dshtest-1，选一个节点已同步模型） | 创建成功；`bot/create` 载荷含 `modelRef` | 部分（载荷可测，创建需真机） |
| T5 | 远程 Bot 对话：发一句，看回复与镜像历史 | 回复正常；刷新后历史仍在；本机无模型调用 | 否 |
| T6 | 对**正在等待远程回复**的 Bot 点「放弃等待」（上游 `abandon-work`） | 不启动本机回合；不写镜像；界面提示合理 | 否（I3 的真机侧） |
| T7 | 点停止/中断远程回合，再刷新 | 历史保留；`turn/end` 为 `aborted` 且 `reason.kind`=`user` | 部分 |
| T8 | 模型菜单：远程 Bot 的「Not synced to the node yet」灰显组仍在；CLI 模型标「节点需自装」 | 同左 | 部分（`node-model-menu.test.js` 可测数据，渲染需目视） |
| T9 | 侧栏：创建分区、拖 Bot、我们的 Bot 群组仍显示、折叠状态 | D1 方案 A 的预期渲染 | 否 |
| T10 | 记忆：mneme 后端 Bot 不写文件记忆；文件后端 Bot 能用上游的记忆整理 | 同左 | 部分（I10） |
| T11 | 设置弹窗：Bot 设置里记忆后端、远程 Bot 的 workDir/模型入口仍在 | 入口可达 | 否（R13） |
| T12 | 主控→旧节点（`0.3.1-fork.N`）混版本：config-push 与 `bot/create` | 旧节点收到 v1 字节不变的载荷；`modelRef` 双名都认 | 部分（载荷可测） |
| T13 | 节点离线/重连后 config 补推、`appliedRevision` 前进 | 与合并前一致 | 否（与合并无直接因果，作回归） |
| T14 | 打包：`npm pack`，清单含 `src/gateway/` | 同左 | 是 |

**不能自动证明的项**：T3、T5、T6、T9、T11、T13（真机 UI/网络）；R2/R3/R13 的「未核实」交互；上游 `computer`、`im` 平台改动在我们打包里的行为（本机平台相关，我们没有改，也没有测）。

---

## 7. 估时与分片

估时是**经验值，没有实测**（标「估」），按一个熟悉本代码的工程师计。

| 片 | 内容 | 估 | 依赖 | 能否并行 |
|---|---|---|---|---|
| **S0** | 准备：`npm ci`、worktree、基线复跑、`rerere` | 0.5h | — | 与 S1 并行 |
| **S1** | **写新刀测试**（§5 标「新增」的 6 个：`joined-abandon`、`controller-callsites`、`store-migrate-joined`、`groups-survive-sections`、`create-bot-payload`、`pack-files`，外加 `resume-shape`）。**在合并之前**先在 `fa93fd30` 上写，应当在合并前全绿 | 4–6h | — | **与 S2 并行**（独立分支，合并后 rebase） |
| **S2** | M1+M2：并集冲突（package/index/store/handoffs/roster/tools/channel/constants）+ `delivery.js`/`turns.js` | 3–4h | S0 | 单人串行（同一合并状态） |
| **S3** | M3：`memory.js` + `memory-review.js` 守卫 | 3–4h | S2 | 与 S4 并行（改不同文件） |
| **S4** | M4：R1/R7 正则 + 测试 | 1–2h | S2 | 与 S3 并行 |
| **S5** | M5：客户端手合（bot-settings、context-menu、team-actions、model-menu、**create-bot**、**sidebar**） | 8–12h | S2、D1 裁决 | 按文件并行（见 §4.2「可选并行化」） |
| **S6** | （可选，D1 后续）把 `groups` 迁到 `sections` + `state.json` 备份与回滚 | 4–6h | S5、用户确认 | 独立，合并后再做 |
| **S7** | M6–M8：重建 `client.js`、全量测试对照、版本号、打包 | 3–4h | S3、S4、S5 | 串行 |
| **S8** | 验收官独立复核 + 真机 T1–T14（用户配合重启） | 4–6h | S7 | 串行 |

**合计**（不含 S6）：约 **3–4 个工作日**（估）；**并行**时关键路径 = S0→S2→(S3∥S4∥S5)→S7→S8，约 **2–3 个工作日**。

**风险最大的片放最前**：S5 里的 `create-bot.js`、`sidebar.js` 是最大的界面冲突，但**不是**最危险的；最危险的是 R1/R7（v1 载荷字节）、R5（abandon-work 越过 mirror-guard）、I10（mneme 守卫丢失），它们在 S1、S3、S4 里处理，所以**建议顺序是先写刀测试（S1）再合并**，让合并时每一把刀立刻能量出来。

---

## 8. 需要司令/用户确认的事项

1. **D1**：`groups` 与 `sections` 的取舍（建议 A：上游 sections 为准，我们的 groups 暂按旧样式保留，迁移单列一片）。
2. 版本号 `0.3.2-fork.1` 是否接受。
3. 客户端是否采用「先合并+保留我们的客户端，再逐文件跟进上游界面」的两段式（§4.2 末尾），还是一次性手合。
4. 合并后是否把上游的「运行时选择器」与我们的 `BotModelMenu` 并存（本文假设并存：本机 Bot 用上游、远程 Bot 用我们的）。
5. `/tmp/ds-bot` 的 23 项未提交改动归属——合并前需要有人认领或确认可丢弃，否则工程师不能在那里干活（本文已避开）。

## 9. 未核实项

1. `migrateLocalRoutes(state)` 是否会遍历 joined 影子 Bot 的 `model`（R2）。
2. 上游 `RECOVERED_TURN = -1` 与我们 `allocateTurn` 回合号域的关系（R3）。
3. 上游 `abandon-work` 对 joined 影子的实际行为（R5，要读 `channel.js` 新增 case 的实现）。
4. 基线里每个红是环境噪声还是真回归（只确认了「双方共有的 ≈ 环境」这个大类，没有逐条归因）。
5. 上游新增的 `local-<engine>` 全集（本文只确认 `claude-code`、`codex-cli`、`opencode` 与 `local-acp-` 自定义前缀；其余名字按 `ENGINES` 的键推断）。
6. 上游 `settings-shell.js` 对我们设置入口位置的影响（R13）。
7. `im/platforms/*` 与我们 `im/index.js` 的耦合（§2.2）。
8. 两段式合并是否真的比一次性手合更省时（§4.2）。
9. 各片估时均为经验值，没有实测。
10. 工作树里的 dry-run 状态：`/private/tmp/ds-bot-um-dry` 仍是未提交的合并进行中，完成文档后应 `git merge --abort` 并移除。
