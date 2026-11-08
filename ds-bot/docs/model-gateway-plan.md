# 模型网关 P1 分片计划 v4 (Model Gateway P1 Slice Plan)

**状态**: 修订稿 v4（2026-11-08，架构师，司令 v3 审查后通道定案重写）
**分支**: feat/model-gateway-contract
**依赖契约**: docs/model-gateway-contract.md v3 (2396338c) — 已冻结
**代码基线**: dsh-remote-agent HEAD 14cb02f (0.10.1-fork.47) + ds-bot HEAD

---

## 基准说明

HEAD 14cb02f 真实现状（文件:行号均已验证）：

| 已有能力 | 文件:行号 |
|---|---|
| `HUB_TO_NODE.CONFIG_PUSH = 'hub/config-push'` | lib/protocol.js:73 |
| E2E_REQUIRED_TYPES 含 CONFIG_PUSH | lib/node/transport.js:81 |
| 节点 dispatch case CONFIG_PUSH | lib/node/index.js:981 |
| `mergePatch` 写 llm-pi-ai.providers → cordis.patch.yml | lib/node/config-sync.js:186–207 |
| apiKey → `.credentials.yaml`（ref 写法） | lib/node/config-sync.js:370–380 |
| revision 落盘 config-sync.json | lib/node/config-sync.js:341 |
| provider 集合变化 → systemctl restart dsh-worker | lib/node/config-sync.js:295–302 |
| hub 侧 `sendPush` / `handleSyncRequest` | lib/hub/config-sync.js:55–92 |
| hub E2E gate：无 session 拒绝推送 | lib/hub/config-sync.js:52 |
| ds-bot `buildConfigPayload` 推 {id, api, baseURL, apiKeyEnv, apiKey, models} | src/host/config-source.js:53–97 |
| ssh2 ^1.16.0 依赖（Client.connect/forwardIn） | dsh-remote-agent/package.json:85 |
| ssh-onboard `connect(host)` 工厂 | lib/hub/ssh-onboard.js:83–108 |
| `findRawHost(alias)` 读 dsh-ssh.json | lib/hub/ssh-onboard.js:183 |
| `startDeploy({ alias, nodeId, ... })` alias→nodeId 关系 | lib/hub/ssh-onboard.js:268 |

---

## 环境事实（通道定案依据）

| 事实 | 值 |
|---|---|
| hub 私网地址 | 10.0.0.90（无 Tailscale，无公网入口） |
| 节点公网地址 | 118.89.29.49 |
| SSH 可用性 | hub→节点 SSH 可用（dsh-ssh.json remote: 118.89.29.49:22, root, 密码认证） |
| 节点→hub 直连 | 不可用（节点无法路由到 10.x） |
| relay 传 SSE | 未验证开销，不作为 P1 通道 |

**通道定案：反向 SSH 隧道 + hub 本地网关**

```
节点 (118.89.29.49)                    hub (10.0.0.90)
┌──────────────┐                      ┌──────────────────────────┐
│ pi-ai adapter│                      │  网关 127.0.0.1:4387     │
│ baseURL =    │   HTTP request       │  ↓                       │
│ http://127.  │──→ 127.0.0.1:4387 ──→│ SSH tunnel (forwardIn)   │
│ 0.0.1:4387/  │    (本地 loopback)    │  ↓                       │
│ gw/{prov}    │                      │  上游 provider (apiKey)   │
└──────────────┘                      └──────────────────────────┘
         ↑                                      ↑
         │  SSH 反向隧道（hub ssh2 → node:22）    │
         └──────────────────────────────────────┘
```

- hub 网关只绑 `127.0.0.1:4387`（可配），不暴露
- hub 用 ssh2 连节点 22 端口，`conn.forwardIn('127.0.0.1', 4387)` 把节点本地 4387 转发回 hub
- 节点 baseURL = `http://127.0.0.1:4387/gw/{providerId}`，pi-ai 原样发 HTTP，不需要 node shim
- 认证：每节点 gateway token（32B 随机值），Bearer header
- SSH 负责加密与可达；隧道 supervisor 管理生命周期
- 退路：仅在 sshd 禁 forwarding 时启用 relay 帧 + 节点本地 shim（注明多一层代码）

---

## 问题修正对照（v3→v4）

### 修正 1：通道自相矛盾

**v3 错误**：Slice 0 测 relay SSE，Slice 1/3 按 HTTP 端点写，互相矛盾。

**v4 方案**：通道统一为反向 SSH 隧道 + hub 本地网关。Slice 0 测隧道性能，Slice 1 建网关 + 隧道，Slice 3 测端到端（含隧道断线）。

### 修正 2：apiKeyEnv 指向

**v3 错误**：hub 模式 payload 的 `apiKeyEnv` 仍写 `OPENAI_API_KEY`，节点拿上游 key/空值请求网关。

**v4 方案**：hub 模式下 `apiKeyEnv` 改为 `GATEWAY_TOKEN_{nodeId.slice(0,8)}`，对应 credentials.yaml 里的 gateway token ref。节点 pi-ai adapter 用该 ref 作 Bearer token 发 HTTP 请求到 hub 网关。

### 修正 3：上游凭据来源

**v3 错误**：只写「复用 pi-ai」，未说明刷新时机。

**v4 方案**：网关从 config-source 同一份 provider 快照读 `{id, baseURL, apiKey, api}`，刷新时机与 config-push 同 revision。config-source.js `buildConfigPayload` 已读 settings + credentials（L53–97），网关上游模块复用该函数的 provider 快照，不另起 settings 读取路径。

### 修正 4：token 简化

**v3 方案**：HMAC-SHA256 签名 token。

**v4 方案**：32B 随机值（`crypto.randomBytes(32).toString('base64url')`），hub 存 SHA-256 hash + 吊销表。HMAC 没有收益（无中间人可篡改，SSH 加密通道已保证完整性），去掉。重签靠 config-push 新 revision 触发。

### 修正 5：测试归属

**v3 错误**：节点 config-sync 测试放 `ds-bot/test/config-source`。

**v4 方案**：节点 config-sync 的测试放 dsh-remote-agent 仓库 `test/config-sync/`。ds-bot 仓库只放 config-source.js 和 gateway 的测试。

### 修正 6：Slice 3 网关不可达

**v3 错误**：「hub 监听停」不现实。

**v4 方案**：「停网关进程」或「断 SSH 隧道」。加 tunnel drop 后 `turn/end.reason.kind === "error"` 断言。

### 修正 7：隧道归属

**v4 方案**：隧道 supervisor 放 dsh-remote-agent hub 侧（lib/hub/tunnel-supervisor.js），因为 ssh2 依赖和 dsh-ssh.json 已在此仓库。ds-bot 只出网关 HTTP 端点 + config-source 配置。端口共享：网关端口由 ds-bot 读 `ctx.get('remote-agent:gateway-port')` 服务获取（或 config-source 把端口写进 payload.extraRefs）。

---

## 分片计划

### Slice 0：反向隧道探针（门禁：Slice 1 前必须通过）

**目的**：量化反向 SSH 隧道传 HTTP+SSE 的开销；验证 sshd `AllowTcpForwarding`；测量隧道建立与断线重连。

**测试环境**：hub macOS 10.0.0.90 + 节点 Linux 118.89.29.49（公网 SSH）。

**指标门禁**：
- TTFT ≤ 直连 + 300ms（同 model，n=10 次中位数）
- 200 tokens 总耗时 ≤ 直连 × 1.5
- 取消传播：abort() 后 ≤ 1s 节点停止发帧
- 隧道建立耗时 ≤ 3s（ssh2 connect + forwardIn）
- 断线重连后首个请求成功 ≤ 5s
- sshd `AllowTcpForwarding` 检查：`sshd -T | grep -i allowtcpforwarding` 返回 `yes` 或 `local`（remote 不需要）

**探针文件**（新建，不合入主线）：
- `test/perf/tunnel-probe.mjs`（dsh-remote-agent 仓库）— hub 侧起假上游 + ssh2 forwardIn + 测量每帧时间戳

**退路（探针不达标时）**：
- 方案 B：relay 帧 + 节点本地 shim（多一层代码，注明为 P1.5）
- 方案 C：30ms 批量帧（牺牲 TTFT 换吞吐，需重测）

**Slice 0 刀**：
- `S0-red-a`：删 forwardIn 调用 → 隧道不建立 → TTFT assert fails（not connection refused，而是 timeout）
- `S0-red-b`：删取消传播 → abort() 后 2s 仍收到帧 → assert 必红

---

### Slice 1：Hub 网关 HTTP 端点 + 反向隧道

**目标**：hub 启一个 OpenAI 兼容本地 HTTP 服务 + 反向 SSH 隧道 supervisor。

**平台**：hub macOS only（P1 范围）。

#### 1A. 网关 HTTP 端点（ds-bot 仓库）

**新建文件**（ds-bot/ds-bot）：
```
src/gateway/
  index.js         — 网关服务器生命周期（随 host 启停，绑 127.0.0.1）
  router.js        — 路由：token 校验 → provider 查找 → 上游代理
  auth.js          — 每节点 gateway token 校验（SHA-256 比对 + 吊销表查询）
  proxy.js         — SSE 流式代理（透传 + 取消传播 + 429/402 透传）
  upstream.js      — 上游 provider 连接（从 config-source 快照读 baseURL/apiKey/api）
  token-store.js   — nodeId → token（SHA-256 hash）+ 吊销表（内存 + 落盘）
```

**修改文件**：
- `src/host/config-source.js` — `buildConfigPayload` 新增 hub 模式分支：
  - `provider.apiKeyEnv` = `GATEWAY_TOKEN_{nodeId.slice(0,8)}`
  - `provider.apiKey` = `''`（不推上游 key）
  - `provider.baseURL` = `http://127.0.0.1:{gatewayPort}/gw/{providerId}`
  - `payload.extraRefs` = `{ GATEWAY_TOKEN_xxx: <32B random token> }`
  - `payload.gatewayPort` = 网关监听端口

**接口契约（src/gateway/router.js）**：
```
POST /gw/{providerId}/v1/chat/completions
Authorization: Bearer <gatewayToken>
body: OpenAI chat completions request

→ 200 text/event-stream  SSE pass-through
→ 401  { error: "gateway-token-invalid" }
→ 404  { error: "provider-not-found", providerId }
→ 429  透传上游 429（含 Retry-After）
→ 502  { error: "upstream-error", upstream: {status, code} }
```

**网关生命周期**：
- 随 host.install() 启动（ctx.hook('ready')），随 ctx dispose 关闭
- 绑定 `127.0.0.1`，端口：读 cfg.gatewayPort（默认 4387）；0 = 系统分配随机端口（测试用）
- 端口共享：网关启动后把端口写入 `ctx.services.set('ds-bot:gateway-port', port)`，dsh-remote-agent tunnel-supervisor 通过 `ctx.get('ds-bot:gateway-port')` 读取
- body 大小限制：128KB
- 超时：30s 无响应 → 503；取消传播：request.signal abort → 上游 fetch abort
- 日志脱敏：baseURL 保留，apiKey/token 只记 `***`
- 上游凭据来源：复用 `buildConfigPayload` 的 provider 快照逻辑（config-source.js:53–97），网关 upstream.js 调用同一函数读取 `{id, baseURL, apiKey, api}`，刷新时机 = config-push revision 变化时

**Slice 1A 测试**（`test/gateway/`，node:test，ds-bot 仓库）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `1A` 无 token → 401 | `status === 401 && body.error === "gateway-token-invalid"` | 删 `auth.js:verifyToken` → `1A` 红 |
| `1B` 错误 provider → 404 | `status === 404 && body.error === "provider-not-found"` | 删 `router.js:providerLookup` → `1B` 红 |
| `1C` 有效请求 → SSE 流 | 收到 `data: {"choices":[...]}` 行，最后 `data: [DONE]` | 删 `proxy.js:pipeSSE` → `1C` 红 |
| `1D` 上游 502 → 透传 | `status === 502 && body.upstream.status === 500` | 删 `proxy.js:upstreamErrorMap` → `1D` 红 |
| `1E` abort() 传播 | 上游 fake server 在 1s 内收到 abort | 删 `proxy.js:cancelPropagation` → `1E` 红 |
| `1F` 端口冲突降级 | host 正常启动，日志有 `EADDRINUSE` | 删 `index.js:eaddrinuseGuard` → 抛异常 → 1F 红 |

#### 1B. 反向隧道 Supervisor（dsh-remote-agent 仓库）

**新建文件**（dsh-remote-agent）：
```
lib/hub/tunnel-supervisor.js  — 隧道生命周期管理
```

**职责**：
- 监听 node online 事件（registry 'node-online'）
- 按 nodeId → SSH alias 映射查找 dsh-ssh.json
- 用 ssh-onboard.js `connect(host)` 建立 SSH 连接
- 调 `conn.forwardIn('127.0.0.1', gatewayPort)` 建立反向隧道
- 监听 conn 'close'/'error' → 断线重试（指数退避，上限 30s）
- 监听 node offline → 关闭对应隧道
- 网关端口来源：`ctx.get('ds-bot:gateway-port')` 或 config-source payload.gatewayPort

**nodeId → SSH alias 映射**：
- 当前 registry 不追踪 sshAlias（node-registry.js 无 sshAlias 字段）
- **新增**：node 注册时可选携带 `sshAlias` 字段（HELLO 帧扩展）；或 hub 配置里写 `nodeTunnels: { nodeId: sshAlias }`
- P1 用 hub 配置方式（不改动 HELLO 协议）：在 dsh-remote-agent 的 hub config 里新增 `gatewayTunnels: { "dshtest-1": "remote" }`

**修改文件**：
- `lib/hub/index.js` — 初始化 tunnel-supervisor，注册 'node-online'/'node-offline' 事件监听

**Slice 1B 测试**（`test/tunnel/`，node:test，dsh-remote-agent 仓库）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `1G` 节点上线 → 隧道建立 | `conn.forwardIn` 被调用，返回端口 | 删 `tunnel-supervisor.js:establishTunnel` → `1G` 红 |
| `1H` 节点离线 → 隧道关闭 | `conn.end` 被调用 | 删 `tunnel-supervisor.js:closeTunnel` → `1H` 红 |
| `1I` 断线重连 → 隧道重建 | conn close 后 5s 内重新 forwardIn | 删 `tunnel-supervisor.js:retry` → `1I` 红 |
| `1J` AllowTcpForwarding 禁用 → 降级 | 日志含 `tcp-forwarding-denied`，不重试 | 删 `tunnel-supervisor.js:checkForwarding` → `1J` 红 |

**Slice 1 门禁**：1A–1J 全绿；`node --check` 通过；不合入 main。

**Slice 1 回滚**：删 `src/gateway/` + 删 `lib/hub/tunnel-supervisor.js` + revert config-source.js；节点回 direct 模式。

---

### Slice 2：Config-Push Payload 扩展（hub 模式）

**目标**：在现有 config-push 机制上，hub 模式下推 `gatewayURL + gateway token ref`，不推上游 apiKey。

**不新增任何帧，不新建 settings API**（已有 CONFIG_PUSH + config-sync.js 全套）。

**现有写路径**（已验证 HEAD 14cb02f）：
```
hub/config-sync.js:57   sendPush → registry.send(nodeId, 'hub/config-push', payload)
node/index.js:981       case HUB_TO_NODE.CONFIG_PUSH → handleConfigPushFrame
node/config-sync.js:186 mergePatch → cordis.patch.yml (llm-pi-ai.providers)
node/config-sync.js:374 apiKey → .credentials.yaml (ref 写法)
node/config-sync.js:341 revision 落盘
node/config-sync.js:302 provider 集合变化 → systemctl restart dsh-worker
```

**修改文件**：
- `src/host/config-source.js`（ds-bot）— `buildConfigPayload` 新增 hub 模式分支（见 Slice 1A）
- `lib/node/config-sync.js`（dsh-remote-agent）— `mergeCredentials` 增加 `payload.extraRefs` 支持（写额外 ref 到 credentials.yaml）
- `lib/node/config-sync.js`（dsh-remote-agent）— `mergePatch` 中 hub 模式 provider 的 `apiKeyEnv` 写为 `GATEWAY_TOKEN_*`（无需改 mergePatch 本身，payload 已带正确 apiKeyEnv）

**payload 扩展结构**（hub 模式）：
```json
{
  "revision": 12,
  "providers": [
    {
      "id": "openai",
      "api": "openai-completions",
      "baseURL": "http://127.0.0.1:4387/gw/openai",
      "apiKeyEnv": "GATEWAY_TOKEN_abc12345",
      "apiKey": "",
      "models": [{"id": "gpt-4o", "name": "GPT-4o"}]
    }
  ],
  "defaultModel": "openai/gpt-4o",
  "gatewayPort": 4387,
  "extraRefs": {
    "GATEWAY_TOKEN_abc12345": "A3fK9x...32B_base64url..."
  }
}
```

**节点侧处理**（config-sync.js 现有逻辑 + 小改）：
- `apiKey = ''` → `mergeCredentials` 跳过写该 ref（config-sync.js:376 `if (p.apiKey && ...)`)
- `baseURL = "http://127.0.0.1:4387/gw/openai"` → 写进 cordis.patch.yml（config-sync.js:196）
- `extraRefs` → **新增**：`mergeCredentials` 遍历 `payload.extraRefs`，每个 ref 写进 `.credentials.yaml`
- pi-ai adapter 用 `apiKeyEnv: "GATEWAY_TOKEN_abc12345"` 作 Bearer header 访问 hub 网关

**config-sync.js 最小改动**：
```js
// mergeCredentials 增加：
if (data.extraRefs && typeof data.extraRefs === 'object') {
  for (const [refName, refValue] of Object.entries(data.extraRefs)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(refName) && typeof refValue === 'string') {
      newRefs[refName] = refValue
    }
  }
}
```

**Slice 2 测试**（dsh-remote-agent 仓库 `test/config-sync/`，node:test）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `2A` hub 模式 provider.apiKey 不出现在 payload | `payload.providers.every(p => p.apiKey === '')` | 删 hub 模式分支 → `2A` 红 |
| `2B` hub 模式 baseURL = 127.0.0.1:port/gw/provId | `p.baseURL === 'http://127.0.0.1:4387/gw/' + p.id` | 删 baseURL 替换 → `2B` 红 |
| `2C` apiKeyEnv = GATEWAY_TOKEN_xxx | `p.apiKeyEnv.startsWith('GATEWAY_TOKEN_')` | 删 token ref 写入 → `2C` 红 |
| `2D` extraRefs 写进 credentials | credentials.yaml 含 `GATEWAY_TOKEN_xxx:` 行 | 删 `mergeCredentials` extraRefs 支持 → `2D` 红 |
| `2E` direct 模式 payload 不变 | 与现有 buildConfigPayload 输出完全一致 | 改 direct 分支 → `2E` 红 |
| `2F` stale revision 静默丢弃 | `result.stale === true`，文件未变 | 删 revision 检查 → `2F` 红 |

**config-source.js 测试**（ds-bot 仓库 `test/`，node:test）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `2G` hub 模式 apiKeyEnv 指向 GATEWAY_TOKEN | `p.apiKeyEnv === 'GATEWAY_TOKEN_' + nodeId.slice(0,8)` | 删 hub 分支 apiKeyEnv 替换 → `2G` 红 |
| `2H` hub 模式 extraRefs 含 32B token | `payload.extraRefs['GATEWAY_TOKEN_...'].length >= 32` | 删 token 生成 → `2H` 红 |

**待验证项 G1（Slice 2 门禁前）**：在 dshtest-1 节点上验证：config-push 后，节点重启 dsh-worker，`GATEWAY_TOKEN_*` ref 仍可解析，pi-ai adapter 用该 ref 发出 Bearer token 请求到 `http://127.0.0.1:4387/gw/...`。不通过则改为直写 `profile.headers["Authorization"]` 绕过 credential ref。

**Slice 2 门禁**：G1 验证通过 + 全部测试绿；`node --check` 通过；不合入 main。

**Slice 2 回滚**：revert `config-source.js` hub 分支 + revert `node/config-sync.js` extraRefs；hub 切回 `gatewayMode: "direct"` 重推一次 config-push（revision 递增触发节点重启）。

---

### Slice 3：端到端验证（P1 出口）

**目标**：Slice 1 + 2 集成，验证 3 条 P1 出口标准 + 隧道断线。

**测试环境**：hub macOS 10.0.0.90 + 节点 Linux 118.89.29.49（公网 SSH）。

**P1 出口标准**：

| 标准 | 具体断言 | 必红刀 |
|---|---|---|
| Test 1：无凭据 → AUTH 错误可见 | 节点 gateway token 置空，发模型请求，对话页 `turn/end.reason.kind === "error"` 且 `reason.error.code === "AUTH"` | 删 auth.js:verifyToken → hub 返 401 → code 变 → 必红 |
| Test 2：任意配置模型可跑 | hub 模式下 node 能用 `openai/gpt-4o` 完成一次推理，对话页收到 `assistant/message` | 删 router.js:providerLookup → 404 → 无 assistant/message → 必红 |
| Test 3：网关不可达 → TRANSPORT 错误可见 | 停网关进程或断 SSH 隧道，节点发请求，`turn/end.reason.kind === "error"` 且 `reason.error.code === "TRANSPORT"` | 删 proxy.js:upstreamErrorMap TRANSPORT 分支 → code 变为默认值 → 必红 |

**补充测试**：
- `3D` 隧道断线 → turn/end error：SSH 隧道连接被 kill，节点发请求，3s 内 `turn/end.reason.kind === "error"`（不挂起）。刀：删 tunnel-supervisor.js:retry → 隧道不重建 → 请求超时 → 必红

**Slice 3 门禁**：Test 1/2/3 + 3D 全绿；Slice 0 指标在真机上重测仍达标；P1 验收报告提交 task-board/。

---

## 平台范围

| 平台 | 角色 | P1 验收 |
|---|---|---|
| macOS (hub 10.0.0.90) | hub 网关 + SSH 隧道发起端 | ✅ 纳入 P1 |
| Linux (dshtest-1, 118.89.29.49) | 节点（公网 SSH 被隧道端） | ✅ 纳入 P1 |
| Windows | 节点（兼容性） | ❌ P1 不验收；config-sync.js scheduleRestart 用 systemctl，Windows 需改为 sc.exe，P2 处理 |

---

## 变更文件总表

| 文件 | 仓库 | 改动类型 | Slice |
|---|---|---|---|
| `src/gateway/index.js` | ds-bot | 新建 | S1A |
| `src/gateway/router.js` | ds-bot | 新建 | S1A |
| `src/gateway/auth.js` | ds-bot | 新建 | S1A |
| `src/gateway/proxy.js` | ds-bot | 新建 | S1A |
| `src/gateway/upstream.js` | ds-bot | 新建 | S1A |
| `src/gateway/token-store.js` | ds-bot | 新建 | S1A |
| `src/host/config-source.js` | ds-bot | 修改（hub 模式分支） | S1A+S2 |
| `lib/hub/tunnel-supervisor.js` | dsh-remote-agent | 新建 | S1B |
| `lib/hub/index.js` | dsh-remote-agent | 修改（初始化 tunnel-supervisor） | S1B |
| `lib/node/config-sync.js` | dsh-remote-agent | 修改（extraRefs 支持） | S2 |
| `test/gateway/*.test.mjs` | ds-bot | 新建 | S1A |
| `test/tunnel/*.test.mjs` | dsh-remote-agent | 新建 | S1B |
| `test/config-sync/*.test.mjs` | dsh-remote-agent | 新建 | S2 |
| `test/perf/tunnel-probe.mjs` | dsh-remote-agent | 新建 | S0 |

---

## 仓库归属

| 职责 | 仓库 | 理由 |
|---|---|---|
| 网关 HTTP 端点 | ds-bot | 网关是 ds-bot host 的扩展 |
| 上游凭据读取 | ds-bot | config-source.js 已有该逻辑 |
| config-source hub 模式分支 | ds-bot | buildConfigPayload 在 ds-bot |
| 反向隧道 supervisor | dsh-remote-agent | ssh2 依赖 + dsh-ssh.json 在此仓库 |
| config-sync extraRefs | dsh-remote-agent | 节点接收器在此仓库 |
| 节点 config-sync 测试 | dsh-remote-agent | 测试被测代码所在仓库 |
| 网关测试 | ds-bot | 测试被测代码所在仓库 |
| 隧道测试 | dsh-remote-agent | 测试被测代码所在仓库 |

---

## 开工前检查清单

- [ ] S1 (feat/mirror-session) 门禁通过
- [ ] Slice 0 探针跑完，数字达标（或退路已选定）
- [ ] 待验证项 G1 结论出（节点重启后 GATEWAY_TOKEN ref 可解析）
- [ ] P1 平台 hub macOS + 节点 Linux 环境就绪（dshtest-1 SSH 可达 + sshd AllowTcpForwarding）
- [ ] nodeId → SSH alias 映射配置就绪（hub config gatewayTunnels）
