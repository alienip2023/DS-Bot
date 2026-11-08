# 模型网关 P1 分片计划 v5 (Model Gateway P1 Slice Plan)

**状态**: 修订稿 v5（2026-11-08，架构师，司令 v4 审查 8 条修正后重写）
**分支**: feat/model-gateway-contract
**依赖契约**: docs/model-gateway-contract.md v3 (2396338c) — 已冻结
**代码基线**: dsh-remote-agent HEAD 14cb02f (0.10.1-fork.47) + ds-bot HEAD

---

## 环境事实

| 事实 | 值 |
|---|---|
| hub 私网地址 | 10.0.0.90（无 Tailscale，无公网入口） |
| 节点公网地址 | 118.89.29.49 |
| SSH 可用性 | hub→节点 SSH（dsh-ssh.json remote: 118.89.29.49:22, root, 密码认证） |
| sshd AllowTcpForwarding | 必须为 `yes` 或 `remote`（-R 用 remote forward，`local` 不允许） |

**通道定案：反向 SSH 隧道 + hub 本地网关**

```
节点 (118.89.29.49)                    hub (10.0.0.90)
┌──────────────┐                      ┌──────────────────────────┐
│ pi-ai adapter│                      │  网关 127.0.0.1:4387     │
│ baseURL =    │   HTTP request       │       ↑                  │
│ http://127.  │──→ 127.0.0.1:4387 ──→│ conn.on('tcp connection') │
│ 0.0.1:4387/  │    (本地 loopback)    │ accept() → net.connect   │
│ gw/{prov}/v1 │                      │ → pipe ↔ upstream        │
└──────────────┘                      └──────────────────────────┘
         ↑   SSH 反向隧道（hub ssh2 -R 4387:127.0.0.1:4387 node:22）  ↑
         └──────────────────────────────────────────────────────────┘
```

---

## v4→v5 8条修正对照

### 修正 1：forwardIn 完整闭环

**v4 缺失**：只调 `conn.forwardIn('127.0.0.1', 4387)`，未处理 `conn.on('tcp connection')`，节点连接被接受但永远无响应。
**v4 错误**：AllowTcpForwarding `local` 写为允许，实际 -R 需要 `yes` 或 `remote`。

**v5 方案**：完整隧道处理如下：

```js
// lib/hub/tunnel-supervisor.js
conn.forwardIn('127.0.0.1', gatewayPort, (err, boundPort) => {
  if (err) return onTunnelError(nodeId, err)
  if (boundPort !== gatewayPort) log('warn', 'tunnel bound to unexpected port', { boundPort, gatewayPort })
  log('info', 'tunnel established', { nodeId, boundPort })
})

conn.on('tcp connection', (info, accept, reject) => {
  const upstream = net.connect(gatewayPort, '127.0.0.1')
  upstream.on('error', () => { try { reject() } catch {} })
  upstream.on('connect', () => {
    const channel = accept()
    channel.pipe(upstream).pipe(channel)
    channel.on('error', () => upstream.destroy())
    upstream.on('close', () => channel.destroy())
  })
})
```

**sshd 修正**：`AllowTcpForwarding` 须为 `yes` 或 `remote`（not `local`）。Slice 0 探针加 `sshd -T | grep -i allowtcpforwarding` 并断言结果匹配 `/^allowtcpforwarding (yes|remote)$/i`。

### 修正 2：token ref 名合法化

**v4 错误**：`GATEWAY_TOKEN_dshtest-1`.slice(0,8) → `GATEWAY_TOKEN_dshtest-`，带连字符，过不了 `^[A-Za-z_][A-Za-z0-9_]*$`。

**v5 方案**：
```js
const refName = 'GATEWAY_TOKEN_' + nodeId.replace(/[^A-Za-z0-9]/g, '_')
```
同时处理碰撞：refName 若已被不同 nodeId 占用，加数字后缀（`_2`, `_3`），在 token-store.js 里管理 nodeId→refName 双向映射，确保同一 nodeId 始终得到同一 refName。

### 修正 3：上游凭据不递归

**v4 错误**：`gateway/upstream.js` 复用 `buildConfigPayload`，hub 模式下 apiKey 已置空，会拿空 key 请求自身。

**v5 方案**：新增 `readUpstreamProviders(rt)`，只读 direct 语义（settings + credentials，不应用 gatewayMode 分支），专供网关上游使用：

```js
// src/gateway/upstream.js
export function readUpstreamProviders(rt) {
  // 同 buildConfigPayload 的 provider 读取逻辑，但：
  // 1. 不应用 gatewayMode 分支（始终用真实 apiKey）
  // 2. 过滤 baseURL 不等于 127.0.0.1:* 的 provider（防止意外回环）
  return providers.filter(p => !p.baseURL?.includes('127.0.0.1'))
}
```

**测试断言**：`providers.every(p => !p.baseURL?.startsWith('http://127.0.0.1'))` — 上游 URL 不等于本地网关地址。

### 修正 4：baseURL 与路由对齐

**v4 错误**：`baseURL = …/gw/openai`，OpenAI SDK 拼出 `…/gw/openai/chat/completions`（无 `/v1`），与路由 `/gw/{id}/v1/chat/completions` 不匹配。

**v5 方案**：`baseURL = http://127.0.0.1:{port}/gw/{providerId}/v1`，路由保持 `/gw/{id}/v1/chat/completions`。加测试断言实际发出的请求路径为 `/gw/{id}/v1/chat/completions`（非 `/gw/{id}/chat/completions`）。

### 修正 5：gatewayMode 按 provider 开关

**v4 错误**：全局 `gatewayMode` 一刀切，hub 成单点且节点本地 provider 无法用。

**v5 方案**：每个 configurable provider 条目可带 `gateway: true`（默认 false）。`buildConfigPayload` 对 `gateway: true` 的 provider 应用 hub 模式（baseURL→网关，apiKey→空，apiKeyEnv→GATEWAY_TOKEN_*），其余保持 direct。

```js
// config-source.js buildConfigPayload 逻辑
const useGateway = profile.gateway === true && gatewayBase !== ''
providers.push({
  id: entry.provider,
  api: profile.api,
  baseURL: useGateway ? `${gatewayBase}/gw/${entry.provider}/v1` : (profile.baseURL || ''),
  apiKeyEnv: useGateway ? refName : apiKeyEnv,
  apiKey: useGateway ? '' : apiKey,
  models,
})
```

**补 mixed 测试**：一个 provider `gateway: true`（走网关），一个 `gateway: false`（直连）。断言：网关 provider baseURL 为 `127.0.0.1:...`，直连 provider baseURL 为原始值。

### 修正 6：请求体与超时可配

**v4 错误**：128KB body limit 太小（带历史对话 >1MB），30s 超时对长提示/推理太激进。

**v5 方案**：
- body limit：默认 8MB，可配 `cfg.gatewayBodyLimitMb`
- 超时：默认 120s，可配 `cfg.gatewayTimeoutMs`
- 测试断言：发 8.1MB body → 413（超限）；发 7.9MB → 200（在限）

### 修正 7：轮换与重启

**v4 缺失**：config-sync 只在 provider 集合变化时重启（config-sync.js:302 `shouldRestart`）；只改 baseURL/apiKeyEnv 不触发重启，节点继续用旧配置。

**v5 方案**：
- `shouldRestart` 判定扩展：任何 provider 字段变化（baseURL、apiKeyEnv 变化）也触发重启
  - 在 `config-sync.js:extractProviderIds` 中改为 `extractProviderFingerprints`（含 id+baseURL+apiKeyEnv 的 hash）
- token 轮换：新旧并存窗口（默认 5 分钟）
  - `token-store.js` 每个 nodeId 保留 `{current, previous, previousExpiresAt}`
  - `auth.js verifyToken` 接受 current 或未过期 previous
  - 新 config-push 推出后，previous 在窗口期内仍可用，窗口到期后吊销

**修改文件**：`lib/node/config-sync.js`（dsh-remote-agent）— `extractProviderFingerprints` 替代 `extractProviderIds`。

### 修正 8：探针真实 + 3D 刀修正 + ctx.provide

**v4 错误 1**：Slice 0 探针只在 hub 侧测，测不到节点→隧道→hub→上游的真实路径。
**v4 错误 2**：3D 断隧道后节点是 connection refused，不是 timeout；删 retry 不会让断言变红。
**v4 错误 3**：`ctx.services.set` 不存在，应用 `ctx.provide`（expose-registry.js:3 注释已说明 `ctx.provide` 是 cordis 4.0.2 的正确 API）。
**v4 错误 4**：只透传 429，缺 402（配额）。

**v5 方案**：
- Slice 0 探针：hub 侧起假上游 + ssh2 forwardIn 建隧道 + **ssh exec 在节点上跑 curl**，测「节点→loopback→隧道→hub 假上游」全链路
- 3D 测试：断言改为「3s 内 turn/end.reason.kind === "error" 可见」；刀改为「吞掉 tcp connection error / 不写 turn/end event」
- ctx.provide：`ctx.provide('ds-bot:gateway-port', port)`（露出端口），tunnel-supervisor 用 `ctx.get('ds-bot:gateway-port')`
- 429/402 都透传（含 Retry-After）：router.js 透传条件 `status === 429 || status === 402`

---

## 分片计划（含修正）

### Slice 0：反向隧道探针（门禁）

**目的**：量化全链路（节点→隧道→hub→上游）性能；验证 sshd forwarding；确认 forwardIn 闭环。

**测试环境**：hub macOS 10.0.0.90 + 节点 Linux 118.89.29.49（公网 SSH）。

**指标门禁**：
- TTFT ≤ 直连 + 300ms（n=10 中位数，节点侧 curl 测量）
- 200 tokens 总耗时 ≤ 直连 × 1.5
- 取消传播：abort() 后 ≤ 1s 停止发帧
- 隧道建立耗时 ≤ 3s（ssh2 connect + forwardIn + tcp connection 回调）
- boundPort === 4387（或接受随机端口时一致性验证）
- 断线重连后首个请求成功 ≤ 5s
- `sshd -T | grep -i allowtcpforwarding` 匹配 `/^allowtcpforwarding (yes|remote)$/i`

**探针方式**：hub 侧起假上游 + ssh2 forwardIn + `conn.on('tcp connection')` 完整处理 + ssh exec 在节点上跑 `curl http://127.0.0.1:4387/probe` 测全链路。

**退路**：sshd AllowTcpForwarding 不满足 → 注明为 P1.5，P1 暂不实施。

**Slice 0 刀**：
- `S0-red-a`：删 `conn.on('tcp connection')` 处理 → curl 挂起 → TTFT assert fails（非 connection refused）
- `S0-red-b`：删取消传播 → abort 2s 后仍收到帧 → assert 必红

---

### Slice 1：Hub 网关 HTTP 端点 + 反向隧道

#### 1A. 网关 HTTP 端点（ds-bot 仓库）

**新建文件**：
```
src/gateway/
  index.js         — 网关生命周期；ctx.provide('ds-bot:gateway-port', port)
  router.js        — 路由：token 校验 → provider 查找 → 上游代理；透传 429/402
  auth.js          — verifyToken（current + previous 并存窗口）
  proxy.js         — SSE 流式代理；取消传播；大文件/超时可配
  upstream.js      — readUpstreamProviders()（direct 语义，过滤 127.0.0.1）
  token-store.js   — nodeId→{current, previous, previousExpiresAt} + refName 双向映射
```

**修改文件**：
- `src/host/config-source.js` — per-provider `gateway: true` 分支；baseURL 含 `/v1`；apiKeyEnv = `GATEWAY_TOKEN_${nodeId.replace(/[^A-Za-z0-9]/g,'_')}`；extraRefs 含 32B token

**接口契约**：
```
POST /gw/{providerId}/v1/chat/completions
Authorization: Bearer <gatewayToken>

→ 200 text/event-stream  SSE pass-through
→ 401  { error: "gateway-token-invalid" }
→ 404  { error: "provider-not-found", providerId }
→ 402  透传（配额）
→ 429  透传（含 Retry-After）
→ 413  body 超限（默认 8MB）
→ 502  { error: "upstream-error", upstream: {status, code} }
→ 503  超时（默认 120s）
```

**Slice 1A 测试**（`test/gateway/`，node:test，ds-bot 仓库）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `1A` 无 token → 401 | `status === 401 && body.error === "gateway-token-invalid"` | 删 `auth.js:verifyToken` → `1A` 红 |
| `1B` 错误 provider → 404 | `status === 404 && body.error === "provider-not-found"` | 删 `router.js:providerLookup` → `1B` 红 |
| `1C` 有效请求 → SSE 流 | 收到 `data: {"choices":[...]}` 行，最后 `data: [DONE]` | 删 `proxy.js:pipeSSE` → `1C` 红 |
| `1D` 上游 502 → 透传 | `status === 502 && body.upstream.status === 500` | 删 `proxy.js:upstreamErrorMap` → `1D` 红 |
| `1E` abort() 传播 ≤1s | 上游 fake server 1s 内收到 abort | 删 `proxy.js:cancelPropagation` → `1E` 红 |
| `1F` 端口冲突降级 | host 正常启动，日志有 `EADDRINUSE` | 删 `index.js:eaddrinuseGuard` → 抛异常 → 1F 红 |
| `1G` baseURL + /v1 路径 | 实际请求路径为 `/gw/{id}/v1/chat/completions` | 删 `/v1` 拼接 → 路径变 → 1G 红 |
| `1H` 上游 URL ≠ 127.0.0.1 | `providers.every(p => !p.baseURL?.startsWith('http://127.0.0.1'))` | 让 upstream 复用 buildConfigPayload → 1H 红 |
| `1I` body > 8MB → 413 | `status === 413` | 删 body limit → 1I 红 |
| `1J` token 轮换：旧 token 并存窗口内仍可用 | `oldToken → 200`（窗口期内） | 删 previous token 检查 → `oldToken → 401` → 1J 红 |
| `1K` token 轮换：窗口到期后旧 token 失效 | `oldToken → 401`（窗口后） | 删 `previousExpiresAt` 检查 → 旧 token 永久有效 → 1K 红 |
| `1L` 429 透传 | `status === 429` + Retry-After 头 | 删 429 透传 → 1L 红 |
| `1M` 402 透传 | `status === 402` | 删 402 透传 → 1M 红 |
| `1N` mixed: 一走网关一直连 | 网关 provider baseURL 含 `127.0.0.1`；直连 provider baseURL 为原值 | 删 per-provider gateway 分支 → 1N 红 |

#### 1B. 反向隧道 Supervisor（dsh-remote-agent 仓库）

**新建文件**：
```
lib/hub/tunnel-supervisor.js
```

**完整隧道处理（代码设计）**：
```js
conn.forwardIn('127.0.0.1', gatewayPort, (err, boundPort) => {
  if (err) return onTunnelError(nodeId, err)
  if (boundPort !== gatewayPort)
    log('warn', 'tunnel bound to unexpected port', { nodeId, boundPort, gatewayPort })
  log('info', 'tunnel established', { nodeId, boundPort })
})

conn.on('tcp connection', (info, accept, reject) => {
  const upstream = net.connect(gatewayPort, '127.0.0.1')
  upstream.on('error', () => { try { reject() } catch {} })
  upstream.on('connect', () => {
    const channel = accept()
    channel.pipe(upstream).pipe(channel)
    channel.on('error', () => upstream.destroy())
    channel.on('close', () => upstream.destroy())
    upstream.on('close', () => { try { channel.destroy() } catch {} })
  })
})
```

**nodeId → SSH alias 映射**：hub config 新增 `gatewayTunnels: { "dshtest-1": "remote" }`（P1 硬配，不改 HELLO 协议）。

**修改文件**：
- `lib/hub/index.js` — 初始化 tunnel-supervisor；网关端口从 `ctx.get('ds-bot:gateway-port')` 读取

**Slice 1B 测试**（`test/tunnel/`，node:test，dsh-remote-agent 仓库）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `1O` tcp connection 闭环 | `accept()` 调用后 pipe 双向工作，数据通过隧道到达 hub | 删 `conn.on('tcp connection')` 处理 → `1O` 红 |
| `1P` 节点上线 → 隧道建立 | `conn.forwardIn` 被调用，boundPort 返回 | 删 `tunnel-supervisor:establishTunnel` → `1P` 红 |
| `1Q` 节点离线 → 隧道关闭 | `conn.end` 被调用 | 删 `tunnel-supervisor:closeTunnel` → `1Q` 红 |
| `1R` 断线重连 → 隧道重建 ≤5s | conn close 后 5s 内重新 forwardIn | 删 retry 逻辑 → `1R` 红 |
| `1S` AllowTcpForwarding 禁 → 降级 | 日志含 `tcp-forwarding-denied`，不重试 | 删 forwarding 检查 → `1S` 红 |

---

### Slice 2：Config-Push Payload 扩展

**不新增帧**（已有 CONFIG_PUSH + config-sync.js 全套）。

**修改文件**：
- `src/host/config-source.js`（ds-bot）— per-provider `gateway` 开关分支（见修正 5）
- `lib/node/config-sync.js`（dsh-remote-agent）— `mergeCredentials` 增 `payload.extraRefs` 支持
- `lib/node/config-sync.js`（dsh-remote-agent）— `extractProviderFingerprints`（含 baseURL+apiKeyEnv）替代 `extractProviderIds`，触发重启条件扩展

**Slice 2 测试**（dsh-remote-agent `test/config-sync/` + ds-bot `test/`，node:test）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `2A` hub provider apiKey = '' | `p.apiKey === ''` | 删 hub 分支 → `2A` 红 |
| `2B` baseURL 含 /v1 | `p.baseURL.endsWith('/v1')` | 删 `/v1` → `2B` 红 |
| `2C` apiKeyEnv = GATEWAY_TOKEN_* | `p.apiKeyEnv.startsWith('GATEWAY_TOKEN_')` | 删 → `2C` 红 |
| `2D` extraRefs 写进 credentials | credentials.yaml 含 `GATEWAY_TOKEN_*:` | 删 extraRefs 支持 → `2D` 红 |
| `2E` direct provider 不变 | 与原 buildConfigPayload 一致 | 破坏 direct 分支 → `2E` 红 |
| `2F` stale revision 静默丢弃 | `result.stale === true` | 删 revision 检查 → `2F` 红 |
| `2G` apiKeyEnv 合法 ref 名 | `CRED_REF.test(p.apiKeyEnv)` （`/^[A-Za-z_][A-Za-z0-9_]*$/`） | 用带连字符 nodeId → `2G` 红 |
| `2H` baseURL/apiKeyEnv 变化触发重启 | 只改 baseURL，`shouldRestart === true` | 删 fingerprint 扩展 → `shouldRestart === false` → `2H` 红 |

**待验证项 G1（Slice 2 门禁前）**：在 dshtest-1 节点：config-push → 节点重启 dsh-worker → `GATEWAY_TOKEN_*` ref 解析 → pi-ai adapter 发 Bearer token 到 `http://127.0.0.1:4387/...` → hub auth.js 校验通过。不通过则改为直写 `profile.headers["Authorization"]`。

---

### Slice 3：端到端验证（P1 出口）

**测试环境**：hub macOS 10.0.0.90 + 节点 Linux 118.89.29.49（公网 SSH）。

| 标准 | 具体断言 | 必红刀 |
|---|---|---|
| Test 1：无凭据 → AUTH | `turn/end.reason.kind === "error"` && `reason.error.code === "AUTH"` | 吞掉 turn/end 写入 → turn/end 不出现 → 必红 |
| Test 2：任意模型可跑 | 对话页收到 `assistant/message` | 删 router.js:providerLookup → 404 → 无 assistant/message → 必红 |
| Test 3：停网关进程/断隧道 → TRANSPORT | `turn/end.reason.kind === "error"` && `reason.error.code === "TRANSPORT"` | 吞掉 tcp connection error / 不写 turn/end → error 不可见 → 必红 |
| `3D`：隧道断线 3s 内 turn/end error | ssh kill tunnel → 3s 内 `turn/end.reason.kind === "error"` | 吞掉 tcp connection error / 不写 turn/end → 请求挂起 → 必红 |

---

## 变更文件总表

| 文件 | 仓库 | 类型 | Slice |
|---|---|---|---|
| `src/gateway/index.js` | ds-bot | 新建 | S1A |
| `src/gateway/router.js` | ds-bot | 新建 | S1A |
| `src/gateway/auth.js` | ds-bot | 新建 | S1A |
| `src/gateway/proxy.js` | ds-bot | 新建 | S1A |
| `src/gateway/upstream.js` | ds-bot | 新建 | S1A |
| `src/gateway/token-store.js` | ds-bot | 新建 | S1A |
| `src/host/config-source.js` | ds-bot | 修改 | S1A+S2 |
| `lib/hub/tunnel-supervisor.js` | dsh-remote-agent | 新建 | S1B |
| `lib/hub/index.js` | dsh-remote-agent | 修改 | S1B |
| `lib/node/config-sync.js` | dsh-remote-agent | 修改 | S2 |
| `test/gateway/*.test.mjs` | ds-bot | 新建 | S1A |
| `test/tunnel/*.test.mjs` | dsh-remote-agent | 新建 | S1B |
| `test/config-sync/*.test.mjs` | dsh-remote-agent | 新建 | S2 |
| `test/perf/tunnel-probe.mjs` | dsh-remote-agent | 新建 | S0 |

---

## 开工前检查清单

- [ ] S1 (feat/mirror-session) 门禁通过
- [ ] Slice 0 探针跑完，数字达标（全链路节点侧 curl 测量）
- [ ] sshd `AllowTcpForwarding yes|remote` 已确认
- [ ] 待验证项 G1 结论出（节点重启后 GATEWAY_TOKEN ref 可解析）
- [ ] hub config `gatewayTunnels` 配置就绪（`{ "dshtest-1": "remote" }`）
