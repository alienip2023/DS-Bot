# 节点 Bot：环境感知、工具装配、文件脚本互调、记忆共享（§N / §P2 / §P3）

**状态**：设计草案 v1（架构师，2026-11-09，任务 a-node-env-tools-20261109）。只写文档，不含产品代码。
**分支**：`docs/node-env-tools`（基于 `8df3c273`，独立 worktree `/tmp/ds-bot-nenv`）。**未推送**，等司令许可。

## 基线声明（所有 file:line 以此为准）

| 对象 | 版本/来源 | 读法 |
|---|---|---|
| ds-bot 源码 | 0.3.1-fork.40（本分支 `ds-bot/src/host/*.js`）；节点实装 0.3.1-fork.41（`remote_task` 实读 `package.json`） | 行号取自 fork.40；fork.41 差异 **未核实** |
| dsh-remote-agent 源码 | 0.10.1-fork.53（`/tmp/ra-pkg53`）；节点实装 fork.56 | 行号取自 fork.53 |
| DSH 包 | 已装 DSH Desktop `app.asar` 解出的 `/tmp/dsh-asar/node_modules/@deepseek-ai/*`，各包 0.2.2-alpha.2；节点 DSH 同为 0.2.2-alpha.2（`/usr/lib/node_modules/@deepseek-ai/dsh/package.json`） | 不得用 dev/harness 源码作证据 |
| 节点 | dshtest-1：Linux `Ubuntu 24.04.4 LTS`，`6.8.0-138-generic x86_64`，hostname `VM-12-13-ubuntu`，worker 以 `User=root` 跑 `/usr/bin/dsh --profile web`（`systemctl show dsh-worker`），roots=`['/root/work']` | 2026-11-09 19:3x 只读探针，未改节点 |
| 节点会话日志 | `session-79e4fae7-…`（test5）355 行，`zstd` 解压后逐事件读 | 引用写作 `日志 seq N` |

---

# §N 环境感知 + 工具装配

## N.0 事实

### N.0.1 节点 Bot 的系统提示与每回合上下文由谁生成

| 内容 | 生成者 | 位置 | 含机器信息？ |
|---|---|---|---|
| 首行 `You are an AI agent powered by DeepSeek Harness.` + `You are a coding agent powered by the X model.` | DSH `dsh-system-prompt` 默认段 + persona | `dsh-system-prompt/lib/index.js:231`；节点日志 `system/message` | 否 |
| `## 远程 Agent（副机 worker）…本机状态见 GET /api/remote-agent/status` | dsh-remote-agent 注入的 section | 日志 seq 首条 system/message | 否（没有 OS/hostname） |
| `# Your identity / You are test5 … Bot` + `bot.instructions` | ds-bot | `ds-bot/src/host/prompt.js:40-65`（`promptFor`）、`:67-71`（`order: 640`） | 否；instructions 是 Bot 记录里的原文（test5 为 `你只回答一句话。`） |
| `Current runtime context` 快照（用户消息，`source.kind=runtime-context`） | DSH：`dsh-system-prompt` 拼 context；`dsh-agent-loop` 作为用户消息写入 | `dsh-system-prompt/lib/index.js:139`（`renderContext` 拼接）、`:44-51`（`CONTEXT_ORDERS`：工作目录 100、沙箱 110、审批 115、harness 源码 200、Web URL 210）；`dsh-agent-loop/lib/index.js:212-213` | 只有：cwd、文件策略、审批策略、DSH 实现路径（`dsh-harness-dev-context/lib/index.js:109`）、Web GUI URL。**无** hostname/OS/arch/内核 |
| `Current time: … (Asia/Shanghai)`，`source.kind=ds-bot-time-context` | ds-bot（DSH 自带时钟没加载时的兜底） | `ds-bot/src/host/time-context.js:18-45`（`ctx.on('agent/pre-step')`，文本 `:37`），时区取 `config.timeZone` 或本机 | 仅时间；节点 VM 时区是 Asia/Shanghai（日志 seq 12） |
| `[Handoff · part N]` | ds-bot 节点自己的分段交接 | `ds-bot/src/host/parts.js:769`（`kind: ..., form: 'relay', role: 'handoff', senderName: 'DS Bot'`） | 否（日志 seq 10 全文检索无 platform/Darwin/macOS/zsh） |

**结论 1**：节点会话里确实没有任何环境事实（日志 seq 99-100：用户问"机器配置"，模型只能照抄 runtime-context 里的 cwd/DSH 路径/Web URL）。ds-bot 没有任何 `ctx.systemPrompt.context(...)` 贡献（`grep -n "systemPrompt.context(" ds-bot/src/host/*.js` 零命中），所以没有挂点已经在用。

### N.0.2 「本机信息」是否从主控泄漏到节点（泄漏路径审计）

| 候选路径 | 实读结论 | 证据 |
|---|---|---|
| `bot/turn` 帧载荷 | **不带**环境、cwd、instructions；只有四个字段 | `ds-bot/src/host/joined-turn.js:91`：`{ nodeId, remoteBotId, exchangeId, text }` |
| `bot/create` 载荷 | 带 `modelRef/effort/workDir/instructions`，没有机器信息；`workDir` 在节点侧按 roots 校验，越界 `bot-create-workdir-denied` | `ds-bot/src/host/joined-create.js:121-129`、`:50-62`（`checkWorkDirRoots` 读 `remote-agent:node-policy`）、`:219`（`createBot`） |
| 主控 Bot 的 workDir/instructions/简介被带进节点 | 否：节点 Bot 是节点本地建的 Bot 记录（test5 `workDir:/root/work`），instructions 来自创建时用户输入 | 节点 `bot/state.json` 探针 |
| 主控模板里的 macOS 路径 | 节点会话日志里 `/Users/ /Library/ /Applications/ kjclaw arm64 darwin` 命中数全为 0；`macOS`/`Darwin` 只出现在**模型自己的 assistant 消息**（日志 seq 264、277），没有出现在任何输入侧事件 | 节点日志全文检索 |
| 主控 DSH 的 runtime-context | 不跨机：运行时快照由各自进程的 `dsh-system-prompt` 在本机生成 | `dsh-system-prompt/lib/index.js:139` |

**结论 2**：**未发现主控环境信息进入节点回合的代码路径。** 用户看到的"回答成 macOS"是模型在**没有任何环境输入**时的编造（日志 seq 264 自称"运行环境记录的平台是 macOS（Darwin 24.4.0，shell 为 zsh）"，而输入侧没有这些字样；seq 277 随后更正为猜 Linux）。根因是缺口本身（节点没给环境），不是泄漏。泄漏测试仍然要作为不变量固化（N.4 I2、I10），防止以后有人在 `bot/turn`/`bot/create` 里"顺手"带主控信息。

### N.0.3 节点 Bot 为什么只有 29 个团队工具

| 事实 | 证据 |
|---|---|
| 节点 `request/header.tools` 恰为 29 个团队工具：`ask_user … working_directory`，**没有** bash/读写/grep | 日志 seq 13（11 个 header 中最后一个同样） |
| 模型试调 `bash` 得到 `Error: unknown tool "bash"`，`ToolNotFoundError / UNKNOWN_TOOL` | 日志 turn 24 step 1 的 `tool/result` |
| 节点会话没有 `agent-preset/selected` 事件，只有 `permission/preset`、`sandbox/mode`、`approval/policy` | 日志事件类型统计 |
| 节点 `cordis.patch.yml` 里 `agent-preset-registry` 被 `disabled: true`（司令 2026-11-08 诊断：DSH 0.2.2-alpha.2 的 registry 与 cordis 4.0.6-alpha.2 不兼容，创建会话即抛 TypeError；**本文未复现**） | 节点 `cordis.patch.yml` 注释 |
| ds-bot 选 preset 的代码：registry 不存在就返回 `{}`，即**无 preset** | `ds-bot/src/host/roster.js:82-86`（`botPreset`）、`:101`（`sessionController.create({...place, ...await botPreset()})`） |
| 主控 Bot 走 `agentPreset: 'standard'`，所以有 bash/fs；`standard` preset 的 `plugins[]` 里才有 `tool-bash/tool-fs/tool-fs-search/tool-jobs/tool-web/tool-skill/persona/time-context` | `dsh-web-app/presets/standard.patch.yml`（`preset-standard`） |
| web-app bundle 把宿主层的 `tool-bash/tool-pwsh/tool-jobs/tool-fs/tool-fs-search/tool-todo/tool-web` 全部 `disabled: true`（"移到 preset 之后"） | `dsh-web-app/cordis.patch.yml:483-509` |
| 核心工具包在节点上**都已安装**，缺的只是"被谁装配" | 节点 `node_modules/@deepseek-ai/` 列表含 `dsh-tool-bash/-fs/-fs-search/-jobs/-web`、`dsh-bash-sandbox`、`dsh-fs-sandbox`、`dsh-sandbox-local` |
| 无 preset 时宿主层工具仍会出现：`working_directory`（宿主层 `tool-working-directory`，`dsh-base/cordis.patch.yml:169-170`）在 29 个里 | 日志 seq 13 |

**结论 3（根因）**：工具缺口 = 节点为绕 DSH 兼容问题关掉了 preset registry → ds-bot 创建 Bot 会话时拿不到 `standard` preset（`roster.js:82-86`）→ 核心工具原本只挂在 preset 里（web-app 把宿主层行禁用了）→ 节点 Bot 只剩 ds-bot 自己注册的团队工具。这不是 ds-bot 过滤出来的：`HIDDEN_TOOL_GROUPS`（`ds-bot/src/host/tools.js:22-26`）隐藏的是 `ask_user_question`、goal、subagent 等，不含 bash/fs。

### N.0.4 沙箱、审批、凭据的现状事实

| 事实 | 证据 |
|---|---|
| 默认权限 `workspace-write` + 审批 `ask`；预设表 `read-only / workspace-write / danger-full-access`（后者审批 `never`） | `dsh-base/cordis.patch.yml:240-268`；节点日志 `sandbox/mode`、`approval/policy:ask` |
| 节点 runtime-context 明说：审批提示已开，**没有可用 answerer 时请求 fail-closed** | 节点日志 runtime-context（见 N.0.1 表） |
| 审批 `never` 的实现是确定性 `rejected`（不弹、不挂） | `dsh-user-approval/lib/index.js:200`（`effectivePolicy(session) === "never"` → `"rejected"`） |
| **沙箱只限写不限读**：Linux bwrap 是 `--ro-bind / /`；Landlock 是 `readOnly: ["/"]`；工作区可写根才 `--bind` | `dsh-sandbox-local/lib/index.js:22-33`、`:45-50` |
| 沙箱后端链 Linux 先 bwrap 后 landlock；都不可用则 `confine()` fail-closed | `dsh-sandbox-local/lib/index.js:170-176`、`:81-84` |
| 节点没有 `bwrap`（`which` 无输出）；内核 LSM 含 `landlock`；`unprivileged_userns_clone=1` | 节点探针 |
| 凭据：`/root/.dsh/.credentials.yaml` 权限 `600 root`，worker 同样是 root，因此 Bot 的 bash 子进程与它**同 uid** | 节点 `stat`、`systemctl show` |
| ra 远程文件/任务的边界：`roots`（节点 `['/root/work']`）+ `denyPaths`；默认 `denyPaths` 只含配置值 + `stateDir`（`~/.dsh-remote-agent`），**不含** DSH home | `/tmp/ra-pkg53/lib/node/index.js:518-521` |
| ds-bot 已有"工具执行前拦路径"的先例 | `ds-bot/src/host/privacy.js:242`（`guardFiles`）、`:299`（`ctx.on('tools/execute')`）；密钥值回显脱敏 `ds-bot/src/host/secrets.js:493` |

---

## N.1 目标与非目标

**目标**
1. 节点 Bot 每回合都**知道自己在哪台机器上**：机器名/节点名、OS、架构、内核、CPU 核数、内存档位、Node/DSH 版本、可写根。回答"你在什么系统"时不再靠猜。
2. 节点 Bot 拥有**可用的核心工具**（shell、读写文件、搜索），限定在节点 roots 内，无人值守时不卡审批。
3. 两件事的证据都落在节点自己的会话日志里，可被独立复核。

**非目标**
- 不由主控代填任何环境字段；不把主控环境发给节点；不在 `bot/turn`/`bot/create` 增加环境字段。
- 不同步 agent preset 内容，不改 DSH 包；不修复 DSH preset registry 的兼容问题（只在 N.3 里给"修好后怎么收口"）。
- 不做硬件监控（负载、剩余内存、运行时长）——这类易变字段会打碎前缀缓存，也没有回答价值。

---

## N.2 方案 A：环境感知（执行端自己生成、每回合注入）

**位置**：ds-bot 新增 `ds-bot/src/host/host-context.js`，`install(rt)` 里只做一件事：

```js
ctx.effect(() => ctx.systemPrompt.context({
  name: 'ds-bot:host-environment',
  order: 205,                 // 位于 HARNESS_SOURCE(200) 与 WEB_SURFACE(210) 之间
  interpolate: false,
  text: () => renderHostContext(snapshotOnce())   // 纯文本，进程内一次采集，之后恒定
}), 'ds-bot: host environment')
```

挂点依据：`ctx.systemPrompt.context({name, order, text})`（`dsh-system-prompt/lib/index.js:279`（`context()`），`harness-dev-context` 同款用法 `dsh-harness-dev-context/lib/index.js:105-110`）。它进入 `runtime-context` 快照用户消息，**每回合由 DSH 在节点进程内重渲染**；文本不变则快照不变，不破缓存。

**生成端**：只能在执行端（节点）采集，用 `node:os` 与 `/etc/os-release`；**没有任何入参来自帧**。主控侧的 ds-bot 也会装这个文件，但只采**主控自己**的机器——两边各说各的。

**开关**：`config.hostContext`：`'auto' | 'on' | 'off'`，默认 `'auto'` = 仅当 `ctx.get('remote-agent:node-policy')` 存在（即这个进程是副机，先例 `joined-create.js:51`、ra `node/index.js:664-674`）才启用。**主控 Bot 的提示词在 auto 下与现在逐字节相同。**

**字段与渲染**（固定顺序，固定措辞）：

```
Host environment (this machine, collected locally; it is not the user's controller computer):
- Node: dshtest-1 (hostname VM-12-13-ubuntu)
- OS: Ubuntu 24.04.4 LTS, linux x64, kernel 6.8.0-138-generic
- CPU: 4 cores; Memory: 8 GiB class
- Runtime: Node v24.22.2, DSH 0.2.2-alpha.2
- Account: root (uid 0); shell: bash
- Writable workspace roots: /root/work
If asked about this machine, answer from these facts; run a shell command (uname -a) only if you need more. Do not infer the OS from the user's wording, from other Bots' messages, or from earlier conversation parts.
```

- 内存取 2 的幂档位（"8 GiB class"），CPU 只给核数，避免噪声。
- `Node:` 里的节点名取 ra node 配置的 `nodeId`（经 `remote-agent:node-policy` 服务读，没有就省略该括号前半），hostname 取 `os.hostname()`。字段允许名单可配（`hostContext.fields`），默认含 hostname；要对上游模型隐去主机名时可关。
- **永不输出**：家目录、DSH home、`stateDir`、`.credentials.yaml`、任何环境变量、IP/MAC、relay URL、token、`$SHELL` 的完整路径（只给 basename）。`Account` 只给用户名和 uid，不给 home。
- 采集失败的字段整行省略，不写 `unknown`（避免模型把 unknown 当事实）。

**主控与节点不串**：文本只由本进程采集；没有读取帧/Bot 记录/主控配置的分支。`Writable workspace roots` 取 `remote-agent:node-policy.roots`（节点本地配置）。

---

## N.3 方案 B：工具装配

**选型**

| 方案 | 做法 | 取舍 |
|---|---|---|
| **B1（推荐）** 在节点 profile 补丁里把宿主层核心工具行 `disabled:false` | 节点 `cordis.patch.yml` 增加 `tool-bash / tool-fs / tool-fs-search / tool-jobs`（可选 `tool-web`）；这些行在 `dsh-web-app/cordis.patch.yml:483-509` 被禁用，补丁层"同 id 后写覆盖"（`dsh-base/cordis.patch.yml` 文件头注释）。沙箱/审批服务本来就在宿主层（`dsh-base/cordis.patch.yml:240-268`）且已装配 | 零改 DSH、零改 ds-bot 逻辑；证据：同样挂在宿主层的 `working_directory` 在无 preset 会话里已出现。**未核实**：无 preset 会话是否也会拾取宿主层 `tool-bash`（N.7 T3 真机验证） |
| B2 修好 registry 兼容性，恢复 `agentPreset: 'standard'` | 节点升级 DSH 或打补丁；`botPreset()`（`roster.js:82-86`）自动选 `standard` | 一步到位但**不受我们控制**；`standard` 还带 subagent/workflow/web（多数已被 `HIDDEN_TOOL_GROUPS` 隐藏，`tools.js:22-26`）。作为长期收口，不作首片 |
| B3 ds-bot 自己再造 bash/fs 工具 | — | 重复造沙箱/审批/观察策略，**否决** |

**B1 的受控范围**
- 只开 `tool-bash`（Linux 的 `tool-pwsh` 本就按平台禁用）、`tool-fs`、`tool-fs-search`、`tool-jobs`；`fs-observation-policy` 宿主层已有。`tool-web`（联网抓取）单列为可选，默认不开。
- **权限预设**：新增节点专用预设 `node-unattended = { sandbox: workspace-write, approval: never }` 并设为默认预设。`permission` 行的 `config.presets` 是整体替换（`dsh-base/cordis.patch.yml` 文件头），所以补丁必须重述 `read-only / workspace-write / danger-full-access` 三项再加第四项；默认预设键为 `defaultPreset`（`dsh-permission-presets/lib/index.js:183-187` 的校验可见）。**未核实**：新会话默认取该键的路径（N.7 T5）。
- 效果：沙箱内命令直接跑；需要升级权限的请求被确定性 `rejected`（`dsh-user-approval/lib/index.js:200`），模型收到明确拒绝而不是挂起——符合"节点无人值守"。
- **工作目录边界**：Bot 会话 cwd 在创建时已被 `checkWorkDirRoots` 限在 roots 内（`joined-create.js:50-62`、`:212-214`）；沙箱可写根 = 会话工作区，故写入 ⊆ roots。**未核实**：`working_directory` 工具能否把 cwd 改到 roots 之外并因此扩大可写根（N.4 I9、N.7 T7）。
- **凭据边界**（N.0.4 的硬问题）：沙箱不限读，Bot 的 bash/read 可以读到同 uid 的 `/root/.dsh/.credentials.yaml`。分三层，不能只靠一层：
  1. **ds-bot 路径守卫**（best-effort）：新增 `ctx.on('tools/execute')` 守卫，沿 `privacy.js:242/:299` 的先例；对节点 Bot 会话，拒绝 `read/grep/glob/edit/write` 的路径以及 `bash.command` 中出现 `DSH_HOME` 实路径、`.credentials.yaml`、`config-sync.bak`、`.dsh-remote-agent` 的调用。命令文本匹配**挡不住有意绕过**（变量拼接、base64），只挡误触，必须如实写进风险。
  2. **ra 侧默认 denyPaths 补 DSH home 与 ra stateDir**（`ra node/index.js:518-521` 现只含 stateDir）：即使将来把 roots 放宽到 `/root`，`remote_read` 也读不到凭据。
  3. **残余风险与升级路径**：同 uid 无法在 OS 层隔离。要硬隔离需二选一——(a) 节点 worker 改用专用非 root 用户，且 DSH home 与 Bot 工作区分属不同 uid；(b) 让沙箱后端把 DSH home 用 `--tmpfs` 盖掉（`bwrapProfileArgs` 目前没有隐藏路径参数，`dsh-sandbox-local/lib/index.js:22-33`，需要上游支持，**未核实**）。首片之外，作为 N-4 评估项。

**B2 收口规则**：将来 registry 修好后，节点补丁里 B1 的宿主层行必须删掉，否则 preset 与宿主层重复注册 `bash`。刀见 N.4 I8。

---

## N.4 不变量（每条配刀）

| # | 不变量 | 刀（什么改动应让什么测试变红） |
|---|---|---|
| I1 | 环境上下文只在执行端进程内采集；`renderHostContext` 无任何来自帧/Bot 记录/配置帧的输入 | 让 `snapshotOnce` 读取 `rt.state.bots[*].worker` 或任一帧字段 → `host-context.purity.test` 红 |
| I2 | 主控与节点不串：用"主控夹具"（darwin / `/Users/x` / arm64）驱动节点路径，渲染结果不含任何夹具字符串 | 渲染里拼入 `process.env.HOME` 或 `rt.config` 中的主控路径 → `host-context.no-leak.test` 红 |
| I3 | 不含密钥/token/家目录/DSH home/凭据路径/IP/MAC/env | 往文本加 `os.homedir()` 或 `os.networkInterfaces()` → `host-context.denylist.test`（正则：`/\.credentials|\.dsh|token|apiKey|\b\d{1,3}(\.\d{1,3}){3}\b/` + 夹具里的家目录）红 |
| I4 | 文本稳定：同一进程内连续两次渲染逐字节相同；无时间/运行时长/内存余量/负载 | 往文本加 `os.uptime()` 或 `os.freemem()` → `host-context.stable.test` 红 |
| I5 | 主控 Bot 提示在 `auto` 下与现状逐字节相同 | 去掉 `node-policy` 判断（恒启用）→ `host-context.hub-unchanged.test` 红 |
| I6 | 帧不带环境：`bot/turn` 载荷键集恰为 `{nodeId, remoteBotId, exchangeId, text}`；`bot/create` 键集不含 `os/host/env/platform` | 在 `joined-turn.js:91` 增加任一字段 → `joined-turn.frame-keys.test` 红 |
| I7 | 节点 Bot 会话的 `request/header.tools` 含 `bash`（或 `exec` 等价名）、`read`、`edit`/`write`、`grep` | 删掉节点补丁里 B1 行 → `node-toolset.header.test`（集成测试读 header）红 |
| I8 | 同一工具名只注册一次（宿主层与 preset 不重复） | 在 registry 启用的夹具里保留 B1 行 → `node-toolset.no-dup.test` 红 |
| I9 | 无人值守确定性：升级权限请求立即 `rejected`，不挂起；沙箱外写入失败 | 把默认预设改回 `approval: ask` 且无 answerer → `node-unattended.approval.test`（带 5s 超时）红；改成 `danger-full-access` → `node-unattended.write-outside.test` 红 |
| I10 | 节点 Bot 工具不能读/写 DSH home 凭据（路径守卫）；`working_directory` 不得把 cwd 移出 roots | 删掉 `tools/execute` 守卫 → `node-guard.credentials.test` 红；放行 `cd /` → `node-guard.cwd.test` 红 |
| I11 | ra 默认 `denyPaths` 含 DSH home 与 stateDir | 从 `node/index.js:518-521` 删 DSH home → `ra: node-denypaths.test` 红 |
| I12 | 主控已有的行为不变：主控 Bot 仍用 `standard` preset 与现有工具 | 把 B1 行写进主控补丁 → 主控 `header.tools` 重复断言红 |

---

## N.5 分片（第一片最小可验）

| 片 | 内容 | 范围 | 完成判据 |
|---|---|---|---|
| **N-1（第一片）** | 环境感知：`host-context.js` + `config.hostContext` + I1-I6 测试 | **仅 ds-bot**，只读采集，零权限变化；无需 ra 改动 | 真机：test5 问"你在什么系统" → 答 Ubuntu 24.04 / Linux / VM-12-13-ubuntu；节点日志 runtime-context 含该段；主控 Bot 提示不变 |
| N-2 | 工具探针：不改代码，在 dshtest-1 补丁里加 B1 行与 `node-unattended` 预设，验证 header 工具、沙箱后端（无 bwrap，走 landlock）、审批确定性 | 仅节点配置，可回滚（`cordis.patch.yml.bak`） | N.7 T3-T6 全过；不过则落到 B2 或停下报告 |
| N-3 | 产品化：ra 节点配置 `botToolset: 'team-only' \| 'core'` 写补丁行；默认预设；ra 默认 `denyPaths` 补 DSH home；I7-I9、I11 | ra + 节点配置 | 回滚=切回 `team-only` |
| N-4 | 凭据硬隔离评估：非 root 专用用户或 tmpfs 盖 DSH home；ds-bot 路径守卫上线（I10） | ds-bot + 部署 | 守卫测试绿；硬隔离方案出结论 |

选 N-1 为首片的理由：直接对应用户抱怨、风险最小、可独立回滚；N-2 的最大未知（节点沙箱后端）要放在不碰产品代码的探针里先排雷。

---

## N.6 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 同 uid 凭据可被 Bot 的 bash 读取，路径守卫挡不住有意绕过 | 三层防护 + 如实标注残余；N-4 硬隔离；节点默认不开 `tool-web`，缩小外传面 |
| R2 | 节点没有 bwrap，landlock 启动器是否可用未验证；不可用则 bash fail-closed（安全但不可用） | N-2 探针第一项验证；备选装 `bubblewrap` |
| R3 | 开 B1 行后 header 增加数千 token，且每个节点 Bot 都付一次前缀 | 只开必要四个工具；N-2 记录前后 token |
| R4 | registry 将来修复后与 B1 行重复注册 | I8 刀 + N-3 在升级清单里加"删 B1 行" |
| R5 | hostname 进入上游模型的请求 | `hostContext.fields` 可裁剪；默认保留（对用户有用），写进隐私说明 |
| R6 | 节点 OS 升级后环境段过期 | 每个进程启动采集一次，重启即刷新；不做热更新 |
| R7 | 环境段让模型过度自信、拒绝运行 `uname` | 文本里明确允许"需要时跑命令" |

## N.7 真机验证清单（dshtest-1，Linux）

| T | 步骤 | 通过判据 |
|---|---|---|
| T1 | N-1 装机后，对 test5 问"你所在的机器是什么系统" | 回答含 Ubuntu 24.04、Linux、x86_64；不含 macOS/Darwin |
| T2 | 读节点会话日志最新 `runtime-context` | 含 `Host environment` 段，字段齐全；全文检索 `/root/.dsh`、`credentials`、IP 为 0 |
| T3 | N-2：新会话 `request/header.tools` | 含 bash/read/write/grep；仍含 29 个团队工具 |
| T4 | 让 test5 执行 `uname -a` | 成功，输出与节点一致 |
| T5 | 让 test5 `touch /etc/x`、`touch /root/work/ok` | 前者被沙箱拒绝，后者成功；会话事件 `permission/preset` 为 `node-unattended` |
| T6 | 让 test5 请求升级权限（`sandbox_permissions`） | 立即 `rejected`，无挂起 |
| T7 | 让 test5 `cat /root/.dsh/.credentials.yaml` 与 `working_directory cd /` | 被路径守卫拒绝（N-4 之前的现状：**预期能读到**，作为基线记录） |
| T8 | 主控 Bot 提示词前后逐字节对比 | 完全相同（I5） |

## N.8 未核实项

1. 无 preset 会话是否拾取宿主层 `tool-bash`（B1 的核心假设）。
2. 节点 landlock 启动器（`@deepseek-ai/node-addon-system/landlock-run`）是否可用；无 bwrap 时 bash 是否 fail-closed。
3. `permission` 预设的默认键 `defaultPreset` 对"新会话默认"的实际生效路径。
4. `working_directory` 工具改 cwd 是否扩大沙箱可写根。
5. fork.41 与 fork.40 在 `prompt.js/roster.js/tools.js` 的差异。
6. 节点 persona 行 `You are a coding agent powered by …` 在无 preset 下由谁产出（`dsh-system-prompt` 默认还是 ds-bot），本文未追到源。
7. 司令的 registry 兼容性诊断（`leakedServices` 读 `impl.fiber`）本文未复现。
8. 节点是否已装 `dsh-mneme`（§P3）；节点 Bot 现在用文件记忆还是无记忆，需 `ls`。


---

# §P2 文件与脚本互调（主控 ↔ 节点）

## P2.0 事实：remote-agent 已经有什么

| 能力 | 入口 | 实现与边界 | 证据（ra fork.53） |
|---|---|---|---|
| 整文件互传（主控→节点 `send` / 节点→主控 `fetch` / `stat`） | hub 工具 `remote_file` | 分块（256 KiB/块，单文件上限 512 MiB），完整 sha256 校验后原子落盘；roots + denyPaths 约束；`send` 要 `confirm:"yes"` | `lib/hub/advanced-tools.js:86-191`（`:108` stat、`:111` confirm、`:121` fileBegin、`:156` fileStat）；节点 `lib/node/file-transfer-service.js`（常量与 `roots/denyPaths` 约束 `:1-60`）；节点分发 `lib/node/index.js:1029-1035`（`fileStat/fileRead/fileBegin/fileWrite/fileCommit/fileAbort`） |
| 小文件读写 / 目录 / 搜索 | `remote_read/write/ls/grep/tree/mkdir/move/delete` | 走 `fs/req`；写类需 `confirm:"yes"`；单次内容有上限 | `lib/node/index.js:1013-1028`（`handleFsReq`）、`lib/node/fs-service.js:1-60`（只读四项上限：read 8MB/256KB、grep 2000 文件/200 命中/10s、tree 2000 条） |
| 进程/端口诊断 | `remote_ps/port/kill` | **不受 roots 约束**（进程无路径概念），护栏只有 kill 的 confirm 与"拒杀自身/父进程/系统进程" | `lib/node/index.js:1018-1024` 注释 |
| 在节点执行脚本 | `remote_task`（`mode:"exec"` 跑命令 / `mode:"agent"` 起独立 agent 会话） | exec 默认 `approval:"manual"`（hub 挂起等面板批准，超时拒绝，fail-closed）；产物按 `role: final/intermediate` 分类，只有 final 可 `remote_pull` | `lib/hub/tools.js:608-701`、`:623`（approval 枚举与默认）、`:856-864`（`pending_approval`）、`:1081`（remote_pull）；节点 `lib/node/exec.js`（roots 解析 + `isDenied`） |
| 传输加密 | 全部走 E2E 必选帧 | `FS_REQ`、`TASK_START`、`ARTIFACT_*`、`SHARE_REQ`、`BOT_TURN`、`BOT_CREATE` 无 E2E 会被拒 | `lib/node/transport.js:62-76`（`E2E_REQUIRED_TYPES`） |
| 审计 | hub 审计日志 | 记录工具调用 | `lib/hub/audit-log.js` |
| 默认路径白名单 | roots / denyPaths | 节点 `roots=['/root/work']`；`denyPaths` 默认只有配置值 + `stateDir`，**不含 DSH home** | `lib/node/index.js:511-521`、`:664-674`（`remote-agent:node-policy` 服务只暴露 `{roots}`） |

**缺口**
1. **节点→主控没有主动通道**：文件只能由主控 `fetch`/`remote_pull` 拉取；节点 Bot 做完一件事，主控不会被通知"有产物"（`bot/turn-result` 只带文本，`protocol.js:562` 的 `validateBotTurnResult`）。
2. **两个"执行面"护栏不同**：`remote_task exec` 在 ra 的 `exec.js` 里按 roots 跑、由 hub 审批；节点 Bot 的 `bash`（§N）在 DSH 沙箱里按会话工作区跑、`approval: never`。同一个节点上同一台机器，两套边界。
3. **roots 与 denyPaths 在两处各自配**：文档里已经写过的"同一个安全边界，两处入口"（`lib/node/index.js:68`、`:523` 注释）靠的是传同一对变量，但 §N 的 Bot 沙箱不读这对变量。
4. **hub 侧 ds-bot 的 Bot 会话是否拿得到 `remote_*` 工具** — 未核实（`remote_*` 注册在 hub 的 DSH 工具表，ds-bot 的 `HIDDEN_TOOL_GROUPS` 不含它们，`ds-bot/src/host/tools.js:22-26`，但工具是否对 Bot 会话可见要真机查）。
5. 传输中断后能否续传：`fileBegin/…/commit/abort` 有会话句柄，但跨断线续传未核实。

## P2.1 目标与非目标

**目标**：(a) 用户或主控 Bot 能把文件/脚本送到节点工作区，(b) 在节点上执行并取回产物，(c) 全程在 roots 白名单内，(d) 节点 Bot 与主控 Bot 都能用同一套语义。
**非目标**：不开放任意路径；不做目录同步/rsync；不做 NAT 穿透；不新增执行器——脚本执行复用 `remote_task`（ra 面）与节点 Bot 的 `bash`（§N 面）。

## P2.2 方案

### P2.2.1 v1：零新增帧（拉模型）

约定一个固定的**产物约定目录**：`<root>/outbox/<exchangeId>/`（`root` 取节点 roots 的第一项）。

| 步骤 | 谁 | 动作 | 复用 |
|---|---|---|---|
| 1 | 主控 | 把脚本/输入 `remote_file send` 到 `<root>/inbox/<taskId>/`，`confirm:"yes"` | `advanced-tools.js:111-121` |
| 2a | 主控 | 方式 A：`remote_task mode:"exec"` 在该目录跑脚本（hub 审批后派发） | `tools.js:608-701` |
| 2b | 主控 | 方式 B：`bot/turn` 让节点 Bot 用 §N 的 `bash` 跑 | `joined-turn.js:91` |
| 3 | 节点 | 产物写到 `outbox/<exchangeId>/`，并写一个 `MANIFEST.json`（文件名、大小、sha256、生成时间） | 无新代码；Bot 靠指令/技能约定 |
| 4 | 主控 | `remote_file stat/fetch` 或 `remote_task` 的 artifacts + `remote_pull` 取回 | `advanced-tools.js:156`、`tools.js:1081` |

方式 A 与 B 的区别要写清楚给用户：A 走 ra 的执行器（hub 审批，默认 manual）；B 走 Bot 工具（沙箱 + 无人值守 never）。**主控侧必须在 UI 上区分**，避免用户以为 B 也经过审批。

### P2.2.2 v2：节点→主控"产物通知"帧（可选，不是首片）

新增一个**只带元数据**的节点→hub 帧，不带内容：

```
file/offer  (NODE_TO_HUB, 必须 E2E)
{ nodeId, remoteBotId?, exchangeId?, taskId?,
  files: [{ path, size, sha256 }],        // path 必须落在 roots 内，且不在 denyPaths 内
  reason: 'bot-turn' | 'task' | 'manual' }
```

- hub 收到后只**记录并提示**，不自动拉取；是否 `fetch` 由用户/主控 Bot 决定。
- 帧名加入 `lib/protocol.js` 的节点→hub 常量；类型加入 `E2E_REQUIRED_TYPES`（`lib/node/transport.js:62-76`，路径是敏感信息）。
- 能力位：节点 hello 增加 `caps: ['file-offer/1']`；hub 看不到该位就不期待通知（旧节点退回 v1 轮询）。
- 节点侧发出前再次校验 `path ∈ roots` 且 `!isDenied`（复用 `file-transfer-service.js` 的 `isDenied` 引用），防止 Bot 提供越界路径。
- 为什么不直接让节点推内容：`fetch` 已有校验与限额，推送会绕开 hub 侧的 confirm 与审计。

### P2.2.3 路径与权限白名单（统一）

| 规则 | 说明 |
|---|---|
| 单一来源 | roots/denyPaths 只在 ra 节点配置里定义一次；§N 的 Bot 沙箱可写根、`checkWorkDirRoots`、`remote_*`、`file/offer` 全部从 `remote-agent:node-policy` 读取。当前该服务只暴露 `{roots}`（`node/index.js:674`），要扩成 `{roots, denyPaths}` |
| denyPaths 默认值 | 必须含：DSH home（`.dsh`）、ra `stateDir`、`.credentials.yaml`、`config-sync.bak`、`.ssh`、`/etc`、`/proc`、`/sys` |
| 约定子目录 | `inbox/`（主控→节点）、`outbox/`（节点→主控）；两者必须在 roots 内；节点按需创建，权限 `0700` |
| 上限 | 沿用 512 MiB/文件（`file-transfer-service.js:DEFAULT_TRANSFER_MAX_BYTES`）；`inbox`/`outbox` 单目录总量上限与保留期（建议 7 天，与 ra 任务记录保留期一致）在配置里可调——**数值待用户确认** |
| 脚本 | `inbox` 里的脚本落盘权限 `0600`、无执行位；执行方式显式写成 `bash <path>`，不依赖 shebang；`remote_file send` 不改变执行位 |
| 审批 | `remote_task exec` 保持 manual；节点 Bot 的 bash 保持 §N 的 `node-unattended`；二者不互相放宽 |

## P2.3 与 §N 的关系

- §N 的节点 Bot 工具集提供**节点侧读写与执行**；§P2 提供**跨机搬运与触发**。两者在 `inbox/outbox` 约定目录上会合，所以 N-3 的 roots 必须包含该目录（默认在 roots 内即可）。
- §N 的路径守卫（I10）对 Bot 的 `bash/read` 生效；§P2 的 `remote_*` 走 ra 自己的 roots/denyPaths，两套守卫的 deny 列表**由同一份默认值生成**（P2.2.3 单一来源），否则出现"remote_read 读不到、Bot 却读得到"的不一致。
- 节点 Bot 若要把产物交给主控，v1 只能让它写 `outbox/` 并在回答里写出路径；主控 Bot/用户据此 `fetch`。v2 的 `file/offer` 才让这一步自动被主控看到。

## P2.4 不变量（每条配刀）

| # | 不变量 | 刀 |
|---|---|---|
| F1 | `file/offer` 与 `inbox/outbox` 的任何路径必须 ∈ roots 且 ∉ denyPaths（含符号链接 realpath 后） | 把节点侧 `isDenied` 校验去掉 → `file-offer.path-guard.test`（含 `../`、符号链接逃逸夹具）红 |
| F2 | `file/offer` 属于 `E2E_REQUIRED_TYPES`；明文帧被拒 | 从 Set 删除该类型 → `isE2ERequired('file/offer')` 测试红 |
| F3 | `file/offer` 不带文件内容，帧大小有上限 | 往帧里塞 `content` → `file-offer.schema.test` 红 |
| F4 | hub 收到 offer 不自动 fetch | 在 hub 处理器里调用 `fetch` → `file-offer.no-autofetch.test` 红 |
| F5 | 默认 `denyPaths` 含 DSH home 与 stateDir；`node-policy` 暴露 `denyPaths` | 删掉默认项 → `node-policy.denypaths.test` 红 |
| F6 | `inbox` 脚本落盘无执行位、权限 0600 | `fileBegin` 后给脚本加 `chmod +x` → `inbox-perms.test` 红 |
| F7 | 旧节点（无 `file-offer/1` 能力）不被发 offer 期待，hub 不报错 | hub 无条件等待 offer → `file-offer.capability.test`（旧节点夹具）红 |
| F8 | `remote_task exec` 默认 manual 审批不被节点 Bot 路径绕过 | 让 `bot/turn` 触发 exec 而不经 `task/start` → `exec-approval.test` 红 |

## P2.5 分片

| 片 | 内容 | 判据 |
|---|---|---|
| **P2-1（第一片）** | **只写约定与技能，零代码**：`inbox/outbox` 目录约定 + 节点 Bot 技能说明（怎么落 `MANIFEST.json`）+ 主控侧用法文档；真机用现有 `remote_file send/fetch` 跑通一次往返 | T1-T3 过；证明 v1 零新增帧可用 |
| P2-2 | `node-policy` 暴露 `{roots, denyPaths}`，默认 `denyPaths` 补 DSH home（与 §N N-3 共用） | F5 绿 |
| P2-3 | `file/offer`（v2）+ 能力位 + hub UI 提示 | F1-F4、F7 绿；回滚=节点关能力位 |
| P2-4 | 主控 UI 区分"经审批执行"与"Bot 内执行" | 真机目视 |

## P2.6 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 脚本在节点 Bot 沙箱外被 `remote_task exec` 以 ra 进程身份运行（root） | exec 保持 manual 审批；`mode:"exec"` 的 `workspace` 强制在 roots 内；提示用户这是 root 执行 |
| R2 | `outbox` 里出现密钥（Bot 把凭据读出来写文件） | 凭据守卫（§N I10/N-4）；`fetch` 前 hub 展示文件清单；`MANIFEST` 不作安全依据 |
| R3 | 大文件占满节点磁盘 | 目录总量上限 + 保留期；`fileBegin` 已带 size/sha256 预声明 |
| R4 | 路径大小写/符号链接逃逸（Windows/macOS 节点） | 复用 `caseInsensitive` 与 realpath（`file-transfer-service.js` 构造参数）；F1 夹具含符号链接 |
| R5 | 通知帧被滥用来探测主控 | offer 只有元数据；hub 侧限速（例如每节点每分钟上限）——**数值待定** |

## P2.7 真机验证清单（dshtest-1 → 主控）

| T | 步骤 | 通过判据 |
|---|---|---|
| T1 | 主控 `remote_file send` 一个 `hello.sh` 到 `/root/work/inbox/t1/` | `stat` 的 sha256 一致；文件无执行位 |
| T2 | `remote_task exec` 在该目录运行 `bash hello.sh`，写产物到 `/root/work/outbox/t1/` | 面板出现 pending_approval；批准后成功 |
| T3 | `remote_file fetch` 取回 `outbox/t1/*` | sha256 与节点一致 |
| T4 | 让 test5（§N 的 bash）执行同样脚本 | 无审批提示，产物同样落 `outbox/` |
| T5 | 尝试 `remote_read /root/.dsh/.credentials.yaml` | 被 denyPaths 拒绝（P2-2 之前预期**能否读取取决于 roots**；roots 仅 `/root/work` 时被越界拒绝，作为基线记录） |
| T6 | 路径 `../` 与符号链接逃逸 | 全部被拒 |

## P2.8 未核实项

1. hub 侧 ds-bot 的 Bot 会话是否能调用 `remote_*`。
2. 传输中断续传。
3. `remote_task exec` 在节点上以什么身份与工作目录运行（`lib/node/exec.js` 只读了边界注释，没跑）。
4. `inbox/outbox` 保留期与目录上限的合适数值。
5. 节点 Windows/macOS 上的 `0600/0700` 语义。

---

# §P3 记忆共享（主控与各节点 Bot）

## P3.0 事实

| 事实 | 证据 |
|---|---|
| ds-bot 有两套记忆后端：**文件记忆**（Agent Memory Repo 格式）与 **dsh-mneme**（SQLite）；`auto` = 本机装了 dsh-mneme 就用它 | `ds-bot/src/host/memory.js:68-73`（`memoryBackendOf`）、`:47`（`isMnemeInstalled`）、`ds-bot/src/host/constants.js:108-110`（`MEMORY_BACKENDS = ['auto','mneme','file','none']`）、`memory.js:512-515`（`backendOfSession/fileMemoryFor`） |
| 文件记忆目录：`<home>/memory/bots/<botId>/`、`groups/<roomId>/`、`team/`，非私有变更进 `journal.jsonl`，私有 Bot 有自己的 journal；一条记忆 ≤300 字，MEMORY.md ≤4000 字 | `memory.js:1-30`、`:79`（`MEMORY_LIMITS`） |
| 写入串行"在持有 team 的进程里" | `memory.js` 头注释（`store.js`） |
| 节点的 ds-bot 有**自己的** `<home>/memory`（节点本地），与主控互不可见 | 同上：目录在各进程 `home` 下，没有任何跨机读取代码 |
| dsh-mneme 0.10.1：SQLite `~/.dsh/memory/memory.db`（WAL，多进程并发），scope 标注 `agent_scope/workspace_scope`（`scopeEnabled/strictScope` 默认关），敏感度标注，外部 API `127.0.0.1:8790` Bearer（无 per-bot ACL；daemon 与 DSH"外部访问"二选一）；**去重先查后写、库层无 UNIQUE，双进程并发有极小重复概率** | `.../@modusensus/dsh-mneme/README.md`（存储、`scopeEnabled`、`strictScope`、外部 API、已知限制各节，约 `:41-48`、`:505-506`、`:636-641`） |
| 分享包 `mneme.share/v1`：`dsh-mneme share / receive / undo-share`；只含活跃行，scope 与 home 前缀不进包，命中密钥/PII 的行整条不进；3 MiB 水位 → 413，按 `--type/--tag` 分批；入包一条不合格整包拒、干跑为默认、按 `share_external_id` 幂等、整包可物删；导入行受 `isImportedRow` 保护，本机巩固不得改写 | 同 README v0.9.5 条目（约 `:286`） |
| 主控 Bot 有 `private`（私有）标记：私有 Bot 的记忆与文件夹互不可见，不能进群 | `ds-bot/src/host/privacy.js:30`（`privateBots`）、`:242`（`guardFiles`）、`:322`（`checkChange`）、`memory.js` 头注释（"private Bot's own change log"） |
| 节点是否装了 dsh-mneme | **未核实**（节点 `node_modules` 清单未含 `@modusensus`，但未专门检查） |

## P3.1 目标与非目标

**目标**：让用户明确选择的一部分主控记忆（偏好、项目事实）能到达节点 Bot，且（可选）节点 Bot 学到的东西能回到主控；保持隐私边界、冲突可见、节点离线时行为确定。
**非目标**：不做实时双向同步；不共享私有 Bot 的记忆；不把 `memory.db` 或 `MEMORY.md` 整份拷过去；不开放 8790 外部 API 给节点。

## P3.2 读写模型（推荐）

**先定模型再谈实现：记忆是"各 Bot 本机拥有、按包单向分发"，不是"共享一个库"。**

| 方向 | 模型 | 理由 |
|---|---|---|
| 主控 → 节点 | **用户触发的单向分享包**：用户选 `--type/--tag`（如 `preference`、`project`）→ 主控出包并展示报告 → 经 §P2 的 `inbox/` 送到节点 → 节点 `receive`（先干跑，用户确认后落库） | 现成能力（`mneme.share/v1`）；密钥/PII 自动过滤；幂等；导入行受保护，节点本机巩固不会改写 |
| 节点 → 主控 | **默认关闭**，按 Bot 显式开启；开启后节点 Bot 的记忆"待上报包"落在 `outbox/`，主控 `fetch` 后**人工审阅**再 `receive` | 节点离线与不可信（节点 Bot 可能被注入）；不自动合并 |
| 节点之间 | 不直连，必须经主控中转 | 避免网状信任 |
| 实时读（查询主控记忆） | **不做**：不开放 `8790`，不加 `memory/query` 帧 | 外部 API 无 per-bot ACL，一旦开放节点可读全库 |

**两种后端的落地**

| 节点后端 | 做法 |
|---|---|
| 节点装了 dsh-mneme | 直接用分享包（上表） |
| 节点只有 ds-bot 文件记忆（默认情形，`memory.js:73` 回退 `file`） | 主控把分享包**转换**为目标 Bot 的 `team/` 或 `bots/<id>/` 下的 Markdown 条目，走 `remember` 同路径（受 300 字/4000 字限制与"不存密钥"约束，`memory.js:79`）。转换由节点侧 ds-bot 完成，**不由主控直接写节点文件**。**转换器未实现** |
| 节点 `none` | 不接收；UI 提示 |

## P3.3 冲突与隐私边界

**冲突**
- 同标题记忆：导入行与本机行并存，**导入行不可被本机巩固改写**（`isImportedRow`），本机行不被覆盖；用户可见两条并择一。不做自动合并。
- 重复投递：按 `share_external_id` 幂等；主控记录"已向节点 X 分发的包 id + 条数 + 时间"，重发不会产生重复。
- 节点→主控回流的冲突：回流包默认干跑，冲突按 mneme 的"冻结待人工裁决"处理（README 巩固一节）。
- 并发写：节点本机仍是单进程写；跨进程重复的"极小概率"在 mneme 已知限制里（P3.0），分享包导入走单进程 `receive`，不引入新并发源。

**隐私**
| 规则 | 说明 |
|---|---|
| 私有 Bot 永不出包 | 主控侧出包按 Bot 过滤；`bot.private===true`（`privacy.js:30`（`privateBots`）、`:322-323`（`checkChange`））一律拒绝，错误可见 |
| 密钥/PII | 沿用 mneme 出包过滤；ds-bot 文件记忆本来就禁存密钥；出包前再跑一次主控自己的 `secrets` 值扫描（`ds-bot/src/host/secrets.js:493` 的脱敏同源） |
| scope/路径 | 出包剥离 scope 与 home 前缀（mneme 已做）；文件记忆转换时不带绝对路径 |
| 群记忆 | 群聊记忆只给该群成员；分享默认**不含** `groups/`（`memory.js:1-30` 的"What is said in a group chat stays in that group"） |
| 用户可见 | 每次出包展示条数与类型/标签，用户确认才发；节点侧干跑再确认 |
| 撤回 | `undo-share`（mneme）整包物删；文件记忆转换需记录条目 id 以便撤回，**撤回器未实现** |
| 传输 | 包走 §P2 的 E2E 通道；只在 `inbox/outbox` 约定目录出现，不进 `config-push` |

## P3.4 节点离线时的行为

| 场景 | 行为 |
|---|---|
| 节点在线时用户发起分发 | 如 P3.2 |
| 节点离线时发起 | 主控把"待分发包"排队，记录目标节点与 `share_external_id`；节点上线（`node/hello`）后**提示用户**而不是自动灌入——避免离线期间用户已改主意 |
| 节点离线期间节点 Bot 无法被问（桥已断，`BRIDGE_DOWN_TEXT`，`joined-turn.js:7`） | 记忆行为与 Bot 对话一致：不可用即不可用，不假装 |
| 节点上线后 | 节点用**自己本机已导入的记忆**继续工作；不依赖主控在线（与"节点 Bot 在节点上自己跑"一致） |
| 节点永久丢失 | 节点记忆随机器丢失；主控只保留"已分发包"的清单，不保留节点自学内容（除非用户启用回流） |

## P3.5 不变量（每条配刀）

| # | 不变量 | 刀 |
|---|---|---|
| M1 | 私有 Bot 的记忆永不进入分享包 | 去掉出包的 `bot.private` 过滤 → `memory-share.private.test` 红 |
| M2 | 分享包不含密钥/PII/绝对路径/scope | 往包里加 `process.env.HOME` 或一条含 `sk-…` 的夹具记忆 → `memory-share.denylist.test` 红 |
| M3 | 节点本机巩固不得改写导入行（含文件记忆转换产生的行带来源标记） | 让转换器丢失来源标记 → `memory-import.protected.test` 红 |
| M4 | 同一 `share_external_id` 重复投递结果不变 | 去掉幂等判断 → `memory-share.idempotent.test` 红 |
| M5 | 不开放读主控记忆的实时接口：节点→主控的帧集合里无 `memory/*` 查询类型；`8790` 不绑定非回环 | 新增 `memory/query` 帧 → `frame-whitelist.test` 红 |
| M6 | 群聊记忆默认不出包 | 出包默认含 `groups/` → `memory-share.groups.test` 红 |
| M7 | 回流默认关闭，需按 Bot 显式开启 | 默认值改 true → `memory-share.default-off.test` 红 |
| M8 | 离线排队不自动灌入 | 节点上线即自动 `receive` → `memory-share.no-autoapply.test` 红 |
| M9 | 文件记忆转换遵守 300/4000 字与"不存密钥" | 转换跳过 `MEMORY_LIMITS` → `memory-convert.limits.test` 红 |

## P3.6 分片

| 片 | 内容 | 判据 |
|---|---|---|
| **P3-0（先决）** | **只读探针**：节点是否装 dsh-mneme；节点 Bot 当前记忆后端（`memoryBackendOf`）；`~/.dsh/memory` 与 `<home>/memory` 现状 | 把"未核实项 1、2"变成事实 |
| **P3-1（第一片）** | **手工往返**，零代码：主控 `dsh-mneme share --type preference --tag shared` → §P2 的 `remote_file send` 到节点 `inbox/` → 节点 `dsh-mneme receive`（干跑→确认）；验证过滤、幂等、`undo-share` | T1-T5 过。前提：节点装了 dsh-mneme（否则先装，或落到下一片） |
| P3-2 | 文件记忆后端的转换器（节点侧 ds-bot 实现）+ 撤回器 | M3、M9 绿 |
| P3-3 | 主控 UI：选包、预览、发送、查看已分发清单；离线队列 | M4、M6、M8 绿 |
| P3-4 | 回流（节点→主控，按 Bot 开启，人工审阅） | M7 绿 |

## P3.7 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 用户期待"自动同步"，实际是人工分发 | 产品文案明说；P3-3 提供"一键分发"但仍展示报告并需确认 |
| R2 | 节点没装 dsh-mneme，文件记忆转换成本高 | P3-1 先要求装；P3-2 再做转换 |
| R3 | 导入记忆含个人事实，被节点 Bot 转发给第三方 | 出包前用户确认；私有 Bot 拒绝；节点侧可 `undo-share` |
| R4 | 节点 Bot 被提示词注入后在回流包里夹带指令 | 回流默认关；回流包只经人工审阅后 `receive`；`isImportedRow` 保护使其不改写主控本机行 |
| R5 | `share_external_id` 与不同节点的撞车 | id 带 `nodeId` 前缀（建议，需 mneme 是否允许自定义前缀——**未核实**） |
| R6 | 3 MiB 水位对大库 413 | 按 `--type/--tag` 分批（mneme 已支持） |

## P3.8 真机验证清单

| T | 步骤 | 通过判据 |
|---|---|---|
| T1 | 节点 `ls node_modules/@modusensus` 与 `memoryBackendOf` 结果 | 记录事实 |
| T2 | 主控出包（`--tag shared`），检查报告 | 不含私有 Bot、密钥、绝对路径 |
| T3 | 送到节点 `inbox/`，节点 `receive` 干跑 | 干跑报告条数与主控一致，库未变 |
| T4 | 确认后落库，再次投递同包 | 第二次 0 条新增（幂等） |
| T5 | test5 问"我的偏好是什么" | 回答来自导入记忆 |
| T6 | `undo-share` | 导入行物删，test5 不再知道 |
| T7 | 节点离线期间发起分发 | 主控入队；上线后只提示，不自动导入 |

## P3.9 未核实项

1. 节点是否装 dsh-mneme；节点 Bot 现在的记忆后端。
2. `share_external_id` 是否允许自定义前缀（用于带节点名）。
3. 文件记忆转换/撤回的数据结构（条目 id 能否稳定回溯）。
4. mneme share 包在**无 DSH 面板**的节点上 CLI 是否可直接运行（README 说 CLI 与面板"同一批三件事"，节点 headless 未验证）。
5. 私有 Bot 的 `private` 标记在节点 Bot（非主控 Bot）上是否存在语义。
6. 节点 `dsh-mneme` 的 embedding/rerank 配置与主控是否需一致（导入后向量是否重算）。

---

# 附：跨章引用与总分片顺序

| 顺序 | 片 | 依赖 | 备注 |
|---|---|---|---|
| 1 | N-1 环境感知 | 无 | 对应用户第一条抱怨，最小可验 |
| 2 | N-2 工具探针（仅配置） | 无 | 排雷无 bwrap 的 landlock 与 B1 假设 |
| 3 | P2-1 约定与往返（零代码） | N-2 | 验证现有 `remote_file` 够用 |
| 4 | P3-0 记忆探针 | 无 | 可与 1-3 并行 |
| 5 | N-3 工具产品化 + denyPaths | N-2 | 与 P2-2 合并 |
| 6 | P3-1 手工分享往返 | P2-1、P3-0 | |
| 7 | N-4 凭据硬隔离 | N-3 | 残余风险收口 |
| 8 | P2-3 `file/offer` | P2-2 | 可选 |
| 9 | P3-2/3/4 转换器、UI、回流 | P3-1 | |
