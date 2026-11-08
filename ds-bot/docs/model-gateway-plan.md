# 模型网关 P1 分片计划 v3 (Model Gateway P1 Slice Plan)

**状态**: 修订稿 v3（2026-11-08，架构师，基于 HEAD 14cb02f 真实代码重写）
**分支**: feat/model-gateway-contract
**依赖契约**: docs/model-gateway-contract.md v3 (2396338c) — 已冻结
**代码基线**: dsh-remote-agent HEAD 14cb02f (0.10.1-fork.47) + ds-bot HEAD

---

## 基准说明

v2 使用 ra-fork40 旧快照为证据，CONFIG_PUSH 帧和节点接收器均标为"不存在"。**该前提错误。**

HEAD 14cb02f 真实现状（文件:行号均已验证）：

| 已有能力 | 文件:行号 |
|---|---|
| `HUB_TO_NODE.CONFIG_PUSH = 'hub/config-push'` | lib/protocol.js:73 |
| E2E_REQUIRED_TYPES 含 CONFIG_PUSH | lib/node/transport.js:81 |
| 节点 dispatch case CONFIG_PUSH | lib/node/index.js:981 |
| `mergePatch` 写 llm-pi-ai.providers → cordis.patch.yml | lib/node/config-sync.js:186–207 |
| apiKey → `.credentials.yaml` | lib/node/config-sync.js:370–380 |
| revision 落盘 config-sync.json | lib/node/config-sync.js:341 |
| provider 集合变化时 `systemctl restart dsh-worker` | lib/node/config-sync.js:295–302 |
| hub 侧 `sendPush` / `handleSyncRequest` | lib/hub/config-sync.js:55–92 |
| hub E2E gate：无 session 拒绝推送 | lib/hub/config-sync.js:52 |
| ds-bot `buildConfigPayload` 推 {id, api, baseURL, apiKeyEnv, apiKey, models} | src/host/config-source.js:53–97 |
| MAX_CONTROL_FRAME_BYTES = 4 MB | lib/protocol.js:240 |
| RELAY_QUEUE_BUDGET = 16 MB | lib/relay.js:78 |

**v3 不新增帧，不新建 settings API，在现有 config-sync 上扩展。**

---

## P1 目标重述

让节点使用 hub 网关代理上游模型调用：节点不持有上游 apiKey，只持有按节点签发的 gateway token；hub 对外提供 OpenAI 兼容端点，对节点鉴权后用本地 apiKey 代理请求。

P1 编码前置条件：S1 (feat/mirror-session) 门禁通过。

---

## 问题修正对照

### 修正 1：远程可达性

**v2 错误**：`gatewayURL: http://127.0.0.1:${port}/v1` 在节点侧指向节点自身。

**v3 方案**：hub 网关作为独立 HTTP 端点，绑定 hub 机器的可路由地址（Tailscale IP / 私网 IP，与 listen-server.js 同策略，不绑 loopback）。gatewayURL 在 config-push payload 里按 nodeId 下发，值为 hub 机器的外部可达地址。

但 relay 路径传 SSE 的开销未经测量，**必须先跑 Slice 0 探针**，数字达标才定通道方案；不达标的退路见 Slice 0。

### 修正 2：多 provider 区分

**v2 错误**：所有 provider 同一 gatewayURL，网关无法路由。

**v3 方案**：config-push payload 中每个 provider 的 `baseURL` 写为 `{gatewayBase}/{providerId}`（如 `http://hub:4387/gw/openai`）。节点 config-sync.js:196 直接把 `p.baseURL` 写进 cordis.patch.yml。网关按 URL path 分流，`/gw/{providerId}/*` → 对应上游。节点模型引用仍是 `provider/model`，不破坏现有目录格式。

### 修正 3：token 安全

**v2 错误**：`HUB_NODE_TOKEN` 单值，任一节点可冒充其他节点。

**真实现状**：`cfg.nodeToken`（hub/index.js:534）是 hub 健康检查的共享口令，**不用于网关鉴权**。

**v3 方案**：入网（pairing）时 hub 按 nodeId 生成独立 gateway token，HMAC-SHA256 签名，payload = `{ nodeId, scope: [providerId,...], issuedAt, expiresAt }`。随 config-push 第一帧以 credential ref 形式下发（写进 `.credentials.yaml`，ref name = `GATEWAY_TOKEN_{NODEID}`）。hub 侧维护 nodeId → token 吊销表；重签/吊销通过再次 config-push 触发。

**待验证项 G1**：节点重启后 dsh-worker 能从 `.credentials.yaml` 解析 `GATEWAY_TOKEN_*` ref，pi-ai adapter 用它作 Bearer token 发出请求。验证路径：节点 dsh 实例加载后用 `GATEWAY_TOKEN_xxx` ref 发一次真实请求，检查 hub 侧收到 Bearer 头。

### 修正 4：灰度切换（保留 direct 模式）

**v2 错误**：直接删 apiKey 推送会让在线节点断模型。

**v3 方案**：config-push payload 新增字段 `gatewayMode: "direct" | "hub"`（默认 "direct"）。`direct` 模式保持现有行为（推 apiKey）；`hub` 模式将 provider.baseURL 替换为 `{gatewayBase}/{providerId}`，apiKey 字段留空，gateway token 作为 GATEWAY_TOKEN_* ref 写进 credentials。`buildConfigPayload` 按 `gatewayMode` 分支构建。P1 验收时节点切 "hub"，不删 "direct" 分支。

### 修正 5：测试改为真刀

`node:test` + 内存假上游（每个测试起真实 HTTP server，随机端口），全部 assert 确定性（不允许 "connection refused = red"）。每把刀的刀口定义见各 Slice 测试节。

### 修正 6：credential ref 已支持，换阻塞项

**v2 阻塞项 B 已有答案**：node/config-sync.js:193 `apiKeyEnv` 写法 + config-sync.js:228 `buildPatchEntry` 已写进 cordis.patch.yml，节点 dsh-llm-pi-ai 读 ref 跑模型——在线节点已验证支持。从阻塞项删除。

**新待验证项 G1** 见修正 3（gateway token ref 重启后解析）。

---

## 分片计划

### Slice 0：relay 传 SSE 性能探针（门禁：Slice 1 前必须通过）

**目的**：量化 relay E2E 通道传 SSE 帧的开销；数字不达标则切 loopback+SSH 隧道方案，不进 Slice 1。

**测试节点**：hub macOS dshtest-local ↔ 节点 Linux dshtest-1（公网 relay）。

**指标门禁**：
- TTFT ≤ 直连 + 300ms（同 model，n=10 次中位数）
- 200 tokens 总耗时 ≤ 直连 × 1.5
- 取消传播：abort() 后 ≤ 1s 节点停止发帧
- 帧开销：每 token 帧大小 ≤ MAX_CONTROL_FRAME_BYTES / 100（即单帧携带 ≥ 40KB 内容仍不分帧）

**探针文件**（新建，不合入主线）：
- `test/perf/relay-sse-probe.mjs` — 在 hub 侧起假上游 + 截获 relay 通道，模拟节点发 LLM_PROXY_REQ，测量每帧时间戳

**退路（探针不达标时）**：
- 方案 B：节点 loopback HTTP（127.0.0.1 自用）+ SSH 端口转发到 hub（`hub_gateway_port`），配对时写 SSH 隧道配置
- 方案 C：relay 帧批量（每 30ms 攒一批 token），牺牲 TTFT 换吞吐，需重测

**Slice 0 刀**：
- `S0-red-a`：删 relay 连接建立代码 → TTFT assert fails（not connection refused）
- `S0-red-b`：删取消传播 → abort() 后 2s 仍收到帧 → assert 必红

---

### Slice 1：Hub 网关 HTTP 端点

**目标**：hub 启一个 OpenAI 兼容 HTTP 服务，节点持 gateway token 可请求任意 provider。

**平台**：hub macOS only（P1 范围）。

**新建文件**（ds-bot/ds-bot）：
```
src/gateway/
  index.js         — 网关服务器生命周期（随 host 启停）
  router.js        — 路由：token 校验 → provider 查找 → 上游代理
  auth.js          — 每节点 gateway token 签发/校验/吊销
  proxy.js         — SSE 流式代理（透传 + 取消传播 + 29/402 透传）
  upstream.js      — 上游 provider 连接（复用 dsh-llm-pi-ai 的 baseURL/apiKey）
  token-store.js   — nodeId → token 吊销表（内存 + 落盘 <stateDir>/gateway-tokens.json）
```

**修改文件**：
- `src/host/config-source.js` — `buildConfigPayload` 新增 `gatewayMode` 分支：`hub` 模式下 provider.baseURL = `{gatewayBase}/{providerId}`，apiKey = `''`，gateway token 作为 `GATEWAY_TOKEN_{nodeId.slice(0,8)}` ref

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
- 端口：读 cfg.gatewayPort（默认 4387）；0 = 系统分配随机端口（测试用）
- 端口冲突：EADDRINUSE → 降级日志，不抛，host 仍可用（不封锁主流程）
- body 大小限制：128KB（防大文件上传误入网关）
- 超时：30s 无响应 → 503；取消传播：request.signal abort → 上游 fetch abort
- 日志脱敏：baseURL 保留，apiKey/token 只记 `***`

**Slice 1 测试**（`test/gateway/`，node:test）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `1A` 无 token → 401 | `status === 401 && body.error === "gateway-token-invalid"` | 删 `auth.js:verifyToken` → `1A` 红 |
| `1B` 错误 provider → 404 | `status === 404 && body.error === "provider-not-found"` | 删 `router.js:providerLookup` → `1B` 红 |
| `1C` 有效请求 → SSE 流 | 收到 `data: {"choices":[...]}` 行，最后 `data: [DONE]` | 删 `proxy.js:pipeSSE` → `1C` 红 |
| `1D` 上游 502 → 透传 | `status === 502 && body.upstream.status === 500` | 删 `proxy.js:upstreamErrorMap` → `1D` 红 |
| `1E` abort() 传播 | 上游 fake server 在 1s 内收到 abort，不再推帧 | 删 `proxy.js:cancelPropagation` → `1E` 红 |
| `1F` 端口冲突降级 | host 正常启动，`listenRuntime.ok === false`，日志有 `EADDRINUSE` | 删 `index.js:eaddrinuseGuard` → 抛异常 → 1F 红 |

**Slice 1 门禁**：全部测试绿；node --check src/gateway/*.js exit 0；不合入 main。

**Slice 1 回滚**：删 `src/gateway/`，revert `src/host/config-source.js`，节点回 direct 模式（config-sync 重推）。

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
- `src/host/config-source.js` — `buildConfigPayload` 新增 hub 模式分支（provider.apiKey = `''`，provider.baseURL = `{gatewayBase}/{providerId}`，extra credential entry `GATEWAY_TOKEN_{nodeId.slice(0,8)}: <gatewayToken>`）
- 注：node/config-sync.js 无需改动，它已按 payload.providers[].apiKey 写 credentials.yaml（apiKey = '' → 跳过写，apiKeyEnv 仍写进 patch）；gateway token 以独立 extra ref 写入

**payload 扩展结构**（hub 模式）**：
```json
{
  "revision": 12,
  "providers": [
    {
      "id": "openai",
      "api": "openai-completions",
      "baseURL": "http://192.168.1.10:4387/gw/openai",
      "apiKeyEnv": "OPENAI_API_KEY",
      "apiKey": "",
      "models": [{"id": "gpt-4o", "name": "GPT-4o"}]
    }
  ],
  "defaultModel": "openai/gpt-4o",
  "gatewayToken": "<per-node-hmac-token>",
  "gatewayTokenRef": "GATEWAY_TOKEN_abc12345"
}
```

**节点侧处理**（config-sync.js 现有逻辑）：
- `apiKey = ''` → `mergeCredentials` 跳过写该 ref（config-sync.js:376 `if (p.apiKey && typeof p.apiKey === 'string')`）
- `baseURL = "http://hub:4387/gw/openai"` → 写进 cordis.patch.yml（config-sync.js:196）
- `gatewayToken` → config-source 将其包装为 extra ref `GATEWAY_TOKEN_abc12345: <token>`，写进 credentials（需 config-sync.js 小改：支持 payload.extraRefs 字段）
- pi-ai adapter 用 `apiKeyEnv: "GATEWAY_TOKEN_abc12345"` 作 Bearer header 访问 hub

**需要对 config-sync.js 的最小改动**：
- node/config-sync.js `mergeCredentials`：增加 `payload.extraRefs`（dict）支持，将额外 ref 写进 `.credentials.yaml`
- node/config-sync.js `mergePatch`：无改动（apiKeyEnv 字段已支持任意 ref 名）

**Slice 2 测试**（`test/config-source/`，node:test）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `2A` hub 模式 provider.apiKey 不出现在 payload | `payload.providers.every(p => p.apiKey === '')` | 删 hub 模式分支 → `2A` 红（apiKey 非空） |
| `2B` hub 模式 baseURL = gatewayBase/providerId | `p.baseURL === 'http://gw:4387/gw/' + p.id` | 删 baseURL 替换逻辑 → `2B` 红 |
| `2C` gateway token 写进 extraRefs | `payload.extraRefs['GATEWAY_TOKEN_...']` 非空 | 删 token 写入 → `2C` 红 |
| `2D` node config-sync extraRefs 写进 credentials | credentials.yaml 含 `GATEWAY_TOKEN_xxx:` 行 | 删 `mergeCredentials` extraRefs 支持 → `2D` 红 |
| `2E` direct 模式 payload 不变 | 与现有 buildConfigPayload 输出完全一致 | 改 direct 分支 → `2E` 红 |
| `2F` stale revision 静默丢弃 | `result.stale === true`，文件未变 | 删 revision 检查 → `2F` 红 |

**待验证项 G1（Slice 2 门禁前）**：在 dshtest-1 节点上验证：config-push 后，节点重启，`GATEWAY_TOKEN_*` ref 仍可解析，pi-ai adapter 用该 ref 发出 Bearer token 请求到 hub 网关（不需要上游真实响应，hub 侧 auth.js 校验通过即可）。不通过则改为直写 `profile.headers["Authorization"]` 绕过 credential ref。

**Slice 2 门禁**：G1 验证通过 + 全部测试绿；`node --check` 通过；不合入 main。

**Slice 2 回滚**：revert `config-source.js` hub 模式分支 + revert `node/config-sync.js` extraRefs；hub 切回 `gatewayMode: "direct"` 重推一次 config-push，节点收到后回直连模式（revision 递增触发重启）。

---

### Slice 3：端到端验证（P1 出口）

**目标**：Slice 1 + 2 集成，验证 3 条 P1 出口标准。

**测试环境**：hub macOS dshtest-local + 节点 Linux dshtest-1（公网 relay）。

**P1 出口标准（来自 model-gateway-contract.md §6）**：

| 标准 | 具体断言 | 必红刀 |
|---|---|---|
| Test 1：无凭据 → AUTH 错误可见 | 节点 gateway token 置空，发模型请求，对话页出现 `turn/end.reason.kind === "error"` 且 `reason.error.code === "AUTH"` | 删 auth.js:verifyToken → hub 返 401 → 节点 turn/end.error.code 变为其他值 → 必红 |
| Test 2：任意配置模型可跑 | hub 模式下 node 能用 `openai/gpt-4o` 完成一次推理，对话页收到 `assistant/message` | 删 router.js:providerLookup → 404 → 无 assistant/message → 必红 |
| Test 3：网关不可达 → TRANSPORT 错误可见 | hub 网关停止监听，节点发请求，turn/end.reason.kind === "error" && reason.error.code === "TRANSPORT" | 删 proxy.js:upstreamErrorMap TRANSPORT 分支 → code 变为默认值 → 必红 |

**补充测试**（relay 帧路径）：
- `3D` relay SSE 中断测试：hub 在推流中途关闭 relay 连接，节点侧 turn/end 在 3s 内出现 reason.kind === "error"（不挂起）

**Slice 3 门禁**：Test 1/2/3 + 3D 全绿；Slice 0 指标在真机上重测仍达标；最终 P1 验收报告提交 task-board/。

---

## 平台范围

| 平台 | 角色 | P1 验收 |
|---|---|---|
| macOS (hub) | hub 网关运行平台 | ✅ 纳入 P1 |
| Linux (dshtest-1) | 节点 | ✅ 纳入 P1 |
| Windows | 节点（兼容性） | ❌ P1 不验收；config-sync.js scheduleRestart 用 systemctl，Windows 需改为 sc.exe，P2 处理 |

---

## 变更文件总表

| 文件 | 改动类型 | Slice |
|---|---|---|
| `src/gateway/index.js` | 新建 | S1 |
| `src/gateway/router.js` | 新建 | S1 |
| `src/gateway/auth.js` | 新建 | S1 |
| `src/gateway/proxy.js` | 新建 | S1 |
| `src/gateway/upstream.js` | 新建 | S1 |
| `src/gateway/token-store.js` | 新建 | S1 |
| `src/host/config-source.js` | 修改（hub 模式分支） | S1+S2 |
| `lib/node/config-sync.js` (dsh-remote-agent) | 修改（extraRefs 支持） | S2 |
| `test/gateway/*.test.mjs` | 新建 | S1 |
| `test/config-source/*.test.mjs` | 修改 | S2 |
| `test/perf/relay-sse-probe.mjs` | 新建 | S0 |

---

## 开工前检查清单

- [ ] S1 (feat/mirror-session) 门禁通过
- [ ] Slice 0 探针跑完，数字达标（或退路已选定）
- [ ] 待验证项 G1 结论出（节点重启后 gateway token ref 可解析）
- [ ] P1 平台 hub macOS + 节点 Linux 环境就绪（dshtest-1 可 systemctl restart dsh-worker）
