# 模型网关 P1 分片计划 v8 (Model Gateway P1 Slice Plan)

**状态**: 修订稿 v8（2026-11-08，架构师，/v1/models P1 实现 + 开工清单 tailnet 确认）
**分支**: feat/model-gateway-contract
**依赖契约**: docs/model-gateway-contract.md v3 (2396338c) — 已冻结
**代码基线**: dsh-remote-agent HEAD 14cb02f (0.10.1-fork.47) + ds-bot HEAD

---

## 环境事实（已更新 2026-11-08）

| 事实 | 值 |
|---|---|
| hub tailnet 地址 | 100.64.0.3（Headscale 今日入网） |
| hub 私网地址 | 10.0.0.90 |
| 节点 dshtest-1 | 118.89.29.49（tailnet 内，直连 16ms） |
| hk-vps | tailnet 内，直连 19ms |
| DERP hk | 18.5ms；UDP 打洞成功 |
| 三节点 tailnet | ✅ hub + dshtest-1 + hk-vps 全在 tailnet 内 |
| SSH 可用性 | hub→节点 SSH 仍可用（兜底通道） |
| sshd AllowTcpForwarding | 兜底时须为 `yes` 或 `remote` |

**通道 v2（tailnet 优先）**：

```
节点 (100.64.x.x)                        hub (100.64.0.3)
┌──────────────────┐                    ┌─────────────────────────┐
│ pi-ai adapter    │    HTTP request     │  网关 100.64.0.3:4387   │
│ baseURL =        │──→ 100.64.0.3:4387 →│  ↓                      │
│ http://100.64.   │    (tailnet 路由)    │  上游 provider (apiKey) │
│ 0.3:4387/gw/{p}  │                    └─────────────────────────┘
└──────────────────┘
```

- `gatewayHost` 可配，默认 `127.0.0.1`，tailnet 下配 `100.64.0.3`
- 网关绑 `gatewayHost:4387`（当 tailnet 可用时 gatewayHost = 100.64.0.3）
- 节点 `baseURL = http://{gatewayHost}:{gatewayPort}/gw/{providerId}/v1`
- 反向 SSH 隧道降为**兜底通道**（节点不在 tailnet 时启用），不作默认
- 代码结构不变（地址已可配），只改默认路径和验收命令

> **注**：原 df704ae1 计划中的反向 SSH 隧道 supervisor 实现不废除，仍保留为自动兜底。

---

## v5→v6 3条修正对照

### 修正 1：token 轮换后节点不会重载（必现）

**v5 问题**：fingerprint = `id + baseURL + apiKeyEnv`，轮换时 `refName` 不变，只换 `.credentials.yaml` 的值 → fingerprint 不变 → `shouldRestart` 不触发 → 节点持旧 token → previous 5min 到期后全 401。

**v6 方案**：轮换时改变 refName，使 fingerprint 变化触发重启。

```js
// token-store.js：轮换时生成新 refName
const refName = 'GATEWAY_TOKEN_' + nodeId.replace(/[^A-Za-z0-9]/g, '_')
             + '_' + Date.now().toString(36)  // epoch 后缀，每次轮换唯一
// 双向映射仍维护 nodeId → {currentRefName, previousRefName, previousExpiresAt}
```

- `fingerprint` 含 `apiKeyEnv`（refName），refName 变化 → fingerprint 变化 → `shouldRestart === true`
- previous 保留窗口：**到「节点首次用新 token 成功」或至少 10 分钟**（不固定 5 分钟盲关）
  - hub 侧 auth.js 收到新 token 请求成功后，设置 `previousExpiresAt = Math.min(now + 10min, firstNewTokenSuccessAt + grace)`
  - 窗口到期后旧 refName 从 token-store 移除

**补测试**：
- `1K-rotate`：config-push 后 apiKeyEnv 变化（含新 epoch 后缀）且 `shouldRestart === true`（刀：删 epoch 后缀 → refName 不变 → shouldRestart 不变 → 红）
- `1L-expire`：窗口到期后旧 token → 401（刀：删 previousExpiresAt 检查 → 旧 token 永久有效 → 红）

---

### 修正 2：上游过滤精确匹配

**v5 问题**：`p.baseURL?.includes('127.0.0.1')` 会误杀 `127.0.0.1:11434`（ollama 等本地 direct provider）。

**v6 方案**：只排除网关自身 origin（host + port 精确匹配）：

```js
// src/gateway/upstream.js readUpstreamProviders()
const gatewayOrigin = `http://${gatewayHost}:${gatewayPort}`
return providers.filter(p => {
  if (!p.baseURL) return true
  try {
    const u = new URL(p.baseURL)
    return u.origin !== gatewayOrigin  // 精确排除网关，保留 ollama 等
  } catch { return true }
})
```

**补测试**：
- `1H-ollama`：`baseURL = 'http://127.0.0.1:11434'` 的 provider 通过过滤，不被误删（刀：改为 `includes('127.0.0.1')` → ollama provider 消失 → 红）

---

### 修正 3：forwardIn 竞态修正

**v5 问题**：先 `net.connect` 再 `accept()`；上游在 accept 前报错走 `reject()` 合法，但 accept 后报错再 `reject()` 非法，且 channel 可能泄漏。

**v6 方案**：先 `accept()`，失败立即 `reject()`；accept 成功后 upstream 错误只 `channel.destroy()`：

```js
conn.on('tcp connection', (info, accept, reject) => {
  let channel
  try { channel = accept() } catch { try { reject() } catch {}; return }
  const upstream = net.connect(gatewayPort, gatewayHost)
  channel.pipe(upstream).pipe(channel)
  upstream.on('error', (e) => channel.destroy(e))
  channel.on('error', () => upstream.destroy())
  channel.on('close', () => upstream.destroy())
})
```

`reject` 只在 accept 之前调用，accept 之后不再用。

---

### 附：Slice 0 探针命令兜底

节点不一定有 `curl`，探针命令改为：
```
curl http://${GATEWAY_HOST:-127.0.0.1}:4387/probe 2>/dev/null || node -e "fetch('http://'+process.env.GATEWAY_HOST+':4387/probe').then(r=>r.text()).then(console.log)"
```
两者都失败才判探针失败。

---

## 完整分片计划

### Slice 0：反向隧道探针（门禁）

**测试环境**：hub macOS 10.0.0.90 + 节点 Linux 118.89.29.49（公网 SSH）。

**指标门禁**：
- TTFT ≤ 直连 + 300ms（n=10 中位数，节点侧测量）
- 200 tokens 总耗时 ≤ 直连 × 1.5
- 取消传播：abort() 后 ≤ 1s 停止发帧
- 隧道建立耗时 ≤ 3s（ssh2 connect + forwardIn + tcp connection 回调）
- `sshd -T | grep -i allowtcpforwarding` 匹配 `/^allowtcpforwarding (yes|remote)$/i`
- 断线重连后首个请求成功 ≤ 5s

**探针方式**：hub 侧起假上游 + ssh2 forwardIn（完整 tcp connection 处理）+ `ssh exec curl || node -e fetch(...)` 在节点上测全链路。

**探针文件**：`test/perf/tunnel-probe.mjs`（dsh-remote-agent 仓库）。

**退路**：sshd AllowTcpForwarding 不满足 → 注明为 P1.5，P1 暂不实施。

**Slice 0 刀**：
- `S0-red-a`：删 `conn.on('tcp connection')` 处理 → curl 挂起 → TTFT assert fails
- `S0-red-b`：删取消传播 → abort 2s 后仍收到帧 → assert 必红

---

### Slice 1：Hub 网关 HTTP 端点 + 反向隧道

#### 1A. 网关 HTTP 端点（ds-bot 仓库）

**新建文件**：
```
src/gateway/
  index.js         — 生命周期；ctx.provide('ds-bot:gateway-port', port)
  router.js        — 路由：token 校验 → provider 查找 → 上游代理；透传 429/402
  models.js        — GET /gw/:providerId/v1/models，读 profile.models 返回静态列表
  auth.js          — verifyToken（current + previous 并存，到首次新 token 成功或 10min）
  proxy.js         — SSE 代理；取消传播；body 8MB 可配；超时 120s 可配
  upstream.js      — readUpstreamProviders()（精确排除网关 origin，保留 ollama）
  token-store.js   — nodeId → {currentRefName, previousRefName, previousExpiresAt} + 双向映射
```

**修改文件**：
- `src/host/config-source.js` — per-provider `gateway: true` 分支；baseURL = `.../gw/{id}/v1`；refName 含 epoch 后缀；extraRefs；mixed 支持

**接口契约**：
```
POST /gw/{providerId}/v1/chat/completions
Authorization: Bearer <gatewayToken>
→ 200 text/event-stream
→ 401  { error: "gateway-token-invalid" }
→ 404  { error: "provider-not-found" }
→ 402  透传（配额）
→ 413  body 超限（默认 8MB）
→ 429  透传（含 Retry-After）
→ 502  { error: "upstream-error" }
→ 503  超时（默认 120s）
```

**Slice 1A 测试**（`test/gateway/`，node:test）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `1A` 无 token → 401 | `status === 401` | 删 verifyToken → 红 |
| `1B` 错误 provider → 404 | `status === 404` | 删 providerLookup → 红 |
| `1C` 有效请求 → SSE 流 | `data: [DONE]` 收到 | 删 pipeSSE → 红 |
| `1D` 上游 502 → 透传 | `status === 502` | 删 upstreamErrorMap → 红 |
| `1E` abort() 传播 ≤1s | 假上游 1s 内收到 abort | 删 cancelPropagation → 红 |
| `1F` 端口冲突降级 | 日志含 EADDRINUSE，host 正常启动 | 删 eaddrinuseGuard → 抛 → 红 |
| `1G` baseURL /v1 路径 | 实际请求路径含 `/v1/chat/completions` | 删 /v1 → 路径变 → 红 |
| `1H` 上游 URL ≠ 网关 origin | `new URL(p.baseURL).origin !== gatewayOrigin`（gatewayHost:port 精确比较） | 改为 `includes('127.0.0.1')` → tailnet 环境假红 → 红 |
| `1H-ollama` ollama 不被误删 | `127.0.0.1:11434` provider 仍在 upstream | 同上刀，11434 消失 → 红 |
| `1I` body > 8MB → 413 | `status === 413` | 删 body limit → 红 |
| `1J` 旧 token 并存窗口内可用 | `oldToken → 200` | 删 previous 检查 → `oldToken → 401` → 红 |
| `1K-rotate` 轮换后 apiKeyEnv 变化触发重启 | refName 含新 epoch，`shouldRestart === true` | 删 epoch 后缀 → refName 不变 → shouldRestart false → 红 |
| `1L-expire` 窗口后旧 token → 401 | `previousExpiresAt` 到期后 oldToken 被拒 | 删 previousExpiresAt 检查 → 旧 token 永久有效 → 红 |
| `1M` 429 透传 | `status === 429` + Retry-After | 删 → 红 |
| `1N` 402 透传 | `status === 402` | 删 → 红 |
| `1P` GET /v1/models 返回 profile.models | `data[0].id === profile.models[0].id`，HTTP 200 | 删 models.js handler → 404 → 红 |
| `1O` mixed: 一走网关一直连 | 网关 provider baseURL origin = `http://${gatewayHost}:${gatewayPort}`，直连含原值 | 删 per-provider 分支 → 红 |

#### 1B. 反向隧道 Supervisor（dsh-remote-agent 仓库）

**新建文件**：`lib/hub/tunnel-supervisor.js`

**完整 tcp connection 处理**（v6 修正版）：
```js
conn.on('tcp connection', (info, accept, reject) => {
  let channel
  try { channel = accept() } catch { try { reject() } catch {}; return }
  const upstream = net.connect(gatewayPort, gatewayHost)
  channel.pipe(upstream).pipe(channel)
  upstream.on('error', (e) => channel.destroy(e))
  channel.on('error', () => upstream.destroy())
  channel.on('close', () => upstream.destroy())
})
```

**修改文件**：`lib/hub/index.js` — 初始化 tunnel-supervisor；端口从 `ctx.get('ds-bot:gateway-port')` 读取

**nodeId → SSH alias 映射**：hub config `gatewayTunnels: { "dshtest-1": "remote" }`

**Slice 1B 测试**（`test/tunnel/`，node:test）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `1P` tcp connection 闭环 | accept() + pipe 双向工作 | 删 tcp connection handler → 红 |
| `1Q` 节点上线 → 隧道建立 | forwardIn 调用，boundPort 返回 | 删 establishTunnel → 红 |
| `1R` 节点离线 → 隧道关闭 | conn.end 调用 | 删 closeTunnel → 红 |
| `1S` 断线重连 ≤5s | conn close 后 5s 内重新 forwardIn | 删 retry → 红 |
| `1T` AllowTcpForwarding 禁 → 降级 | 日志含 tcp-forwarding-denied | 删 forwarding 检查 → 红 |

---

### Slice 2：Config-Push Payload 扩展

**修改文件**：
- `src/host/config-source.js`（ds-bot）— per-provider gateway 开关 + epoch refName
- `lib/node/config-sync.js`（dsh-remote-agent）— extraRefs 支持
- `lib/node/config-sync.js`（dsh-remote-agent）— `extractProviderFingerprints`（id + baseURL + apiKeyEnv）替代 `extractProviderIds`

**Slice 2 测试**（dsh-remote-agent `test/config-sync/` + ds-bot `test/`，node:test）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `2A` hub provider apiKey = '' | `p.apiKey === ''` | 删 hub 分支 → 红 |
| `2B` baseURL 含 /v1 | `p.baseURL.endsWith('/v1')` | 删 /v1 → 红 |
| `2C` apiKeyEnv = GATEWAY_TOKEN_* | `p.apiKeyEnv.startsWith('GATEWAY_TOKEN_')` | 删 → 红 |
| `2D` extraRefs 写进 credentials | credentials.yaml 含 `GATEWAY_TOKEN_*:` | 删 extraRefs 支持 → 红 |
| `2E` direct provider 不变 | 与原 buildConfigPayload 一致 | 破坏 direct 分支 → 红 |
| `2F` stale revision 静默丢弃 | `result.stale === true` | 删 revision 检查 → 红 |
| `2G` apiKeyEnv 合法 ref 名 | `/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.apiKeyEnv)` | 用含连字符 nodeId → 红 |
| `2H` baseURL/apiKeyEnv 变化触发重启 | 改 baseURL，`shouldRestart === true` | 删 fingerprint 扩展 → false → 红 |

**待验证项 G1（Slice 2 门禁前）**：dshtest-1 节点上验证 `GATEWAY_TOKEN_*` ref 重启后可解析，pi-ai 发 Bearer token 到 `http://{gatewayHost}:4387/...`（tailnet 模式下为 `100.64.0.3:4387`），hub auth.js 校验通过。

---

### Slice 3：端到端验证（P1 出口）

| 标准 | 具体断言 | 必红刀 |
|---|---|---|
| Test 1：无凭据 → AUTH | `turn/end.reason.kind === "error"` && `reason.error.code === "AUTH"` | 吞掉 turn/end 写入 → 不出现 → 红 |
| Test 2：任意模型可跑 | 对话页收到 `assistant/message` | 删 providerLookup → 404 → 无 assistant/message → 红 |
| Test 3：停网关/断隧道 → TRANSPORT | `turn/end.reason.kind === "error"` && `reason.error.code === "TRANSPORT"` | 吞掉 tcp error / 不写 turn/end → 红 |
| `3D` 隧道断线 3s 内 error | `turn/end.reason.kind === "error"` 在 3s 内可见 | 吞掉 tcp connection error / 不写 turn/end → 请求挂起 → 红 |

---

## 变更文件总表

| 文件 | 仓库 | 类型 | Slice |
|---|---|---|---|
| `src/gateway/index.js` | ds-bot | 新建 | S1A |
| `src/gateway/router.js` | ds-bot | 新建 | S1A |
| `src/gateway/models.js` | ds-bot | 新建 | S1A |
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

## 通道 v2 验收命令（tailnet 模式）

以下命令在 dshtest-1 节点上执行，经 `100.64.0.3:4387` 验证网关通路。

### T1：/v1/models 可达
```bash
# 在 dshtest-1 上执行
curl -s -H "Authorization: Bearer $GATEWAY_TOKEN" \
  http://100.64.0.3:4387/gw/openai/v1/models | jq '.data[].id'
# 断言：返回 JSON，包含至少一个 model id，HTTP 200
```

### T2：流式请求（一次推理）
```bash
curl -s -N -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"ping"}],"stream":true}' \
  http://100.64.0.3:4387/gw/openai/v1/chat/completions
# 断言：收到至少一行 data: {...}，最后收到 data: [DONE]
```

### T3：abort 传播（≤1s）
```bash
# 在 dshtest-1 上执行（--max-time 0.5 触发客户端 abort）
curl -s -N --max-time 0.5 -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -d '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"count to 1000"}],"stream":true}' \
  http://100.64.0.3:4387/gw/openai/v1/chat/completions || true
# 断言：hub 网关日志出现 upstream aborted，1s 内上游 fetch 终止
```

### T4：token 轮换后重启验证
```bash
# 1. hub 侧触发 token 轮换（新 epoch refName），推新 config-push revision
# 2. 观察 dshtest-1 上 dsh-worker 重启（systemctl status dsh-worker 出现 restart）
# 3. 重启后用新 token 发 T2，断言成功
# 4. 旧 token 在窗口内仍通，窗口（首次成功或 10min）后返回 401
```

> 以上命令同样适用于回归测试 SSH 兜底通道（替换 IP 为 127.0.0.1，确保 forwardIn 隧道已建立）。


---

## 开工前检查清单

- [ ] S1 (feat/mirror-session) 门禁通过
- [x] Slice 0 探针已通（`dda11ddd`，司令复跑全绿：tokens 200 / TTFT 0ms / abort 1ms / total 4190ms）
- [x] tailnet 可达性确认（Slice 0 探针已通：TTFT 0ms，200 tokens，abort 1ms，dda11ddd）
- [ ] 待验证项 G1 结论出
- [ ] hub config `gatewayHost = 100.64.0.3`（**P1 验收默认 tailnet，硬要求**）；反向 SSH 隧道仅在同机调试时启用（`gatewayHost = 127.0.0.1`）
