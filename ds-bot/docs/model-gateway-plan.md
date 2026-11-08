# 模型网关 P1 分片计划 v18 (Model Gateway P1 Slice Plan)

**状态**: 修订稿 v18（2026-11-08，架构师，新增 Slice 1A-7 E2E 触发补推）
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
- `src/host/config-source.js` — per-provider `gateway: true` 分支；source 签名改为 `(nodeId) => buildConfigPayload(rt, { gateway: nodeId && port ? { host, port, token: tokenStore.ensure(nodeId) } : null })`；baseURL = `.../gw/{id}/v1`；refName 含 epoch 后缀；mixed 支持（zero-arg source 向后兼容）

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


**Slice 1A-3：hub 启动接线（ds-bot install）**

`install` 内必须完成以下接线，否则 `createGatewayServer`（`ds-bot/src/gateway/index.js:10-20`）全仓无生产调用方，网关为死代码。

**① 配置来源优先级**（`config-source.js:138-150` `settings.describe()` 找 `ns:'ds-bot'`；当前 `~/.dsh/settings.yaml` 无 `ds-bot` 段，恒默认 — tailnet 节点连不上）：

优先级：`settings ds-bot.gateway.host/port`（存在才算）→ `DS_BOT_GATEWAY_HOST`/`DS_BOT_GATEWAY_PORT` 环境变量 → 默认 `127.0.0.1:4387`。**P1 验收用环境变量绑 `100.64.0.3`。**

**② 实时 provider 来源**

`config-source.js` 新增同步函数 `listGatewayProviders(rt)` 复用 `settings` + `ctx.llm.listConfigurableProviders()` 派生直连上游形状 `{id, baseURL, apiKey, models}`（不做 gateway 改写）；`readUpstreamProviders(list, gatewayOrigin)` 滤自环（已存在于 upstream.js）。`createRouter` / `createProxy` 接受「数组或函数」，每请求解析最新列表。

**注意**：`listGatewayProviders` 每请求派生（固定 settings 解析开销），P1 不做缓存，P2 视调用量再加（已知限制 §3）。

**③ effect 形状（Cordis 语义）**

`config-source.js:173` 用 `ctx.effect(async () => ...)`。Cordis 只按 `typeof result === 'function'` 登记 disposer（app.asar 已核），async 回调的 Promise 不算 → `stop()` 永不被调用 → 重载即 EADDRINUSE。正确写法：

```js
// effect 回调必须同步返回 disposer；异步启动放旁路
ctx.effect(() => {
  let gateway = null
  void (async () => {
    const providers = () => listGatewayProviders(rt)
    gateway = createGatewayServer({ gatewayHost, gatewayPort, secrets, store: tokenStore, providers, rt })
    const actualPort = await gateway.start()        // null on EADDRINUSE（内部已 warn，resolve null）
    if (actualPort !== null) ctx.provide('ds-bot:gateway-port', actualPort)
    ctx.get('remote-agent:config-sync').setSource((nodeId) =>
      buildConfigPayload(rt, {
        defaultModel,
        gateway: nodeId && actualPort !== null
          ? { host: gatewayHost, port: actualPort, token: ensureToken(nodeId) }
          : null,
      })
    )
  })().catch(err => rt.logger.error('gateway install failed', err))
  return () => gateway?.stop()        // 同步返回 disposer，stop() 才会被 Cordis 调用
})
```

测试 mock 必须模拟真实语义（不 await async 回调 Promise），否则 `1A3-stop` 是假绿。

**④ token 值来源与持久化**（`token-store.js` 真实 API：`register` / `rotate` / `resolve` / `get` / `remove` / `gc` / `size`，无 `ensure`）：

- `tokenStore.register(nodeId)` → `{ refName }`（epoch 后缀）
- auth 需要的 token 值（32B random）存在 `secrets: Map<refName, tokenValue>`（`auth.js:21-38`）
- 值来源：先从 `$DSH_HOME/.credentials.yaml refs:` 读（`config-source.js:46` `parseCredentialRefs`）；无则生成
- 生成后 `ctx.get('credentials').set(refName, value)` **fire-and-forget** 落盘；内存 `secrets` Map 立刻可用
- 重启复用 `.credentials.yaml` 里的值；崩溃窗口见「已知限制」§2

**`ensureToken(nodeId)` 必须同步**：`ra/lib/hub/config-sync.js:24-51` `readSource` 拒绝 Promise。token 预取同步读 credentials；`credentials.set` 只做旁路异步持久化。

**测试**（ds-bot `test/gateway/`，共 6 条）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `1A3-start` start() 成功后 ctx.provide 有端口 | `ctx.get('ds-bot:gateway-port') > 0` | 删 ctx.provide → undefined → 红 |
| `1A3-node-token` 不同 nodeId 得到不同 token | `ensureToken('node-a') !== ensureToken('node-b')` | 删 nodeId 分流 → 两节点同值 → 红 |
| `1A3-no-gateway` actualPort=null → source.gateway=null | `source('node-x').gateway === null` | 删 null 守卫 → 红 |
| `1A3-stop` stop() 后端口不再监听（mock 需同步模拟） | `connect(actualPort)` → ECONNREFUSED | 删 disposer return → stop 不调用 → 红 |
| `1A3-providers` install 后 2 models provider → /v1/models 200 length 2；未知 → 404 | `data.length === 2`；`status === 404` | `providers: []` → 404 → 红 |
| `1A3-config` 环境变量 `DS_BOT_GATEWAY_HOST=127.0.0.2` 绑定正确 | 绑定 host 与 payload.gateway.host 一致 | 恒 127.0.0.1 → 断言失败 → 红 |

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

#### 1A-4. ra 侧接线：readSource(nodeId) + extractProviderFingerprints（dsh-remote-agent）

**背景**：ds-bot 侧 `setSource((nodeId) => ...)` 按节点分发不同 token，但 `ra/lib/hub/config-sync.js:24-37` `readSource(nodeId)` 内部是 `payload = sourceFn()`——nodeId 没传给 source → 所有节点收到同一 token → T1/T2 真机必失败。同时 `ra/lib/node/config-sync.js:422-424` 只比 provider id 集合；token 轮换仅改 `apiKeyEnv`，id 不变 → `shouldRestart=false` → 节点持旧 ref → G1 必踩。

**1A-4 完成后才具备完整链路**：节点经 tailnet 连 `100.64.0.3:4387`、token 轮换能自动重启；T1/T2 真机验收排在 1A-4 之后。

**修改文件**（dsh-remote-agent，目标版本 `0.10.1-fork.48`）：

1. `lib/hub/config-sync.js:24-37`：
   - `payload = sourceFn()` → `payload = sourceFn(nodeId)`
   - 零参 source（`sourceFn.length === 0`）仍兼容，不传 nodeId 视同之前行为
   - 必须同步返回普通对象（现有 Promise 检测逻辑不变）

2. `lib/node/config-sync.js:422-424`：
   - 替换 `sameProviderSet(extractProviderIds(...))` → `sameProviderFingerprints(extractProviderFingerprints(...))`
   - 指纹：`{ id, baseURL, apiKeyEnv }` 三元组
   - `lastPayload` 落盘结构补 `baseURL`/`apiKeyEnv` 字段（`lib/node/config-sync.js` 第 9 步现在只存 `{id}`）
   - 旧状态文件缺字段（无 `baseURL`/`apiKeyEnv`）→ 视为 `legacy-fingerprint`，允许一次重启，日志标记 `legacy-fingerprint`

3. `package.json`（dsh-remote-agent）：版本号改为 `0.10.1-fork.48`（提交信息与版本必须一致）

**Slice 1A-4 测试**（dsh-remote-agent `test/config-sync.test.js` + `test/config-sync-request.test.js`，node:test）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `1A4-source-nodeid` source 收到 nodeId | `source.lastCallArgs[0] === nodeId`（mock source 记录入参） | 删 `sourceFn(nodeId)` 参数 → `lastCallArgs[0] === undefined` → 红 |
| `1A4-rotate-restart` 只改 apiKeyEnv → shouldRestart=true | `shouldRestart === true` | 删 `apiKeyEnv` 进入指纹 → `shouldRestart=false` → 红 |
| `1A4-idempotent` payload 不变 → shouldRestart=false | `shouldRestart === false` | 删 fingerprint 比较 → 恒 true → 红 |
| `1A4-legacy` 旧状态文件无 baseURL/apiKeyEnv → 一次重启 + legacy 日志 | `result.restarted === true && log.includes('legacy-fingerprint')` | 删 legacy 兜底 → 抛错 → 红 |

**Slice 1A-4 门禁**：4 条全绿 + `node --check` 通过；版本号与 commit 信息一致 `0.10.1-fork.48`。

#### 1A-5. 真机接线修复（P1 必修，三处 bug）

**背景（真机实测事实，非推测）**：

| 现象 | 原因 |
|---|---|
| 节点 `.credentials.yaml` 无 `GATEWAY_TOKEN_`，`config-sync.json` mtime 停在 12:39 | `handleSyncRequest` 用 `appliedRevision >= revision` 判定已最新；revision 是内容哈希（数值），节点旧 hash 比新 hash 大 → 永远判已最新 → 永不推送 |
| 网关监听 `127.0.0.1:4387`，`~/.dsh/settings.yaml:198-200` 配 `100.64.0.3:4387` 无效 | `settings.describe()` 找 `ns:'ds-bot'`，该 ns 未注册 → 恒默认 `127.0.0.1`；已有 `DS_BOT_GATEWAY_HOST` 回退但未读 YAML `ds-bot:` 段 |
| `harness.log: config-source skipped 3 provider(s) without a protocol or key` | source 被调用（attach 前的旧 syncRequest），但无协议/key 的 provider 被过滤；attach 后无补推路径，已在线节点永久错过 |

**修改文件（ds-bot `0.3.1-fork.36`）**：

1. `src/host/config-source.js`（或 `src/gateway/index.js`）— 配置回退读 YAML `ds-bot:` 段：
   - 读 `settings.describe('ds-bot')?.gateway?.host` / `?.port`（若已注册）
   - 否则读 `DS_BOT_GATEWAY_HOST`/`DS_BOT_GATEWAY_PORT` 环境变量
   - 否则默认 `127.0.0.1:4387`
   - 诊断 warn（`!actualHost || actualHost === '127.0.0.1'`）：日志 `gateway bound to loopback, tailnet nodes will not reach it`
   - 诊断 warn（`listGatewayProviders` 返回空列表）：日志 `no upstream providers available, models endpoint will 404`
   - 诊断 warn（attach 后发现已在线节点）：日志 `node {nodeId} was online before gateway attach, sending push now`

2. `src/host/config-source.js`（或 hub/config-source install 钩子）— attach 后补推：
   - `install()` 末尾：`for (const nodeId of registry.onlineNodes()) { sendPush(nodeId) }`（非阻塞，fire-and-forget）
   - 补推前输出上述 warn

**修改文件（dsh-remote-agent `0.10.1-fork.49`）**：

1. `lib/hub/config-sync.js`（`handleSyncRequest`）— revision 判定改为相等：
   - `if (appliedRevision >= revision)` → `if (appliedRevision === revision)`
   - 注释：revision 是内容哈希（`computeRevision` 返回 `djb2` 等整型），无序语义，**不可比大小**（不可改回 `>=`）

**Slice 1A-5 测试**（`test/config-sync.test.js`，node:test）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `1A5-revision-eq` appliedRevision = 旧 hash（数值大于新）→ 推送 | handleSyncRequest 调用 sendPush | 改回 `>=` → 不推送 → 红 |
| `1A5-revision-same` appliedRevision = 当前 hash → 不推送 | sendPush 未调用 | 删 `=== revision` 检查 → 恒推送 → 红 |
| `1A5-attach-push` install 后已在线节点收到补推 | `registry.onlineNodes()` 返回的每个 nodeId 都调用 sendPush | 删 attach 后循环 → 在线节点无推送 → 红 |
| `1A5-warn-loopback` host=127.0.0.1 时输出诊断 warn | log 含 `loopback` | 删 warn → 无日志 → 红 |

**Slice 1A-5 门禁**：
- 4 条测试全绿 + `node --check` 通过
- 版本：ds-bot `0.3.1-fork.36`，ra `0.10.1-fork.49`；package.json 与 commit message 必须一致
- **注**：1A-5 只修了 revision 相等判定与补推路径；绑定地址（dshHome 解析）与 token 落盘属 1A-6；T1/T2/T3 真机验收排在 1A-6 装机之后，不在 1A-5 门禁内。

**1B 隧道暂缓**：隧道 supervisor（Slice 1B）P1 范围内暂不实施；tailnet 直连已通，1B 留 P2。

#### 1A-6. dshHome 统一解析 + 启动诊断 + 双触发推送（ds-bot `0.3.1-fork.37`）

**背景（真机实测事实，fork.36，22:28 启动）**：

| 现象 | 原因 |
|---|---|
| 日志 `gateway listening on 127.0.0.1:4387`，settings.yaml:198-200 配 `100.64.0.3:4387` 无效 | `config-source.js:199` `&& rt.dshHome` 为假 → 整段 YAML 读取未执行，恒默认 127.0.0.1 |
| `~/.dsh/.credentials.yaml` 无 `GATEWAY_TOKEN_` | `readRefsFile` 用同一 `rt.dshHome` → 拼出 `undefined/.credentials.yaml` → 抛错被 catch 吞 → token 只在内存，未落盘 |
| 日志：`config-sync source attached`(+2457ms) → `gateway not ready, providers pushed direct` → `gateway listening`(+2538ms) | attach/首推早于网关就绪；`attached` 标志挡住重推 → 节点永远收到 `gateway: null` |

**修改文件（ds-bot `0.3.1-fork.37`）**：

1. **新增 `resolveDshHome(rt)`**（`src/host/config-source.js` 或独立 `src/utils/dsh-home.js`）：
   ```js
   function resolveDshHome(rt) {
     return rt.dshHome                              // 优先 rt 字段
       ?? process.env.DSH_HOME                      // 次选环境变量
       ?? path.join(os.homedir(), '.dsh')           // 默认
   }
   ```
   全局替换 `rt.dshHome`（credentials 路径、settings.yaml 路径）→ `resolveDshHome(rt)`。

2. **启动诊断日志**（gateway install 成功后输出）：
   - `dshHome=<path>`（来源标注）
   - `gateway config host=<host> port=<port> from=<settings.describe|yaml:<path>|env|default>`
   - `gateway listening on <host>:<port>`（现有，确认 host 正确）

3. **`readRefsFile` 错误可见**：catch 块改为 `rt.logger.warn('readRefsFile failed', err)`，不许静默吞掉。

4. **抽 `pushOnline(service, nodeIdList, reason)`**，两处调用：
   - attach 回调：`pushOnline(service, [nodeId], 'attach')`
   - 网关就绪后（`gateway.start()` 成功）：`pushOnline(service, registry.onlineNodes(), 'gateway-ready')`
   - 门禁：第二次推送（reason=`gateway-ready`）的 payload 必须带 `gateway.baseURL`（含 tailnet host）与 `GATEWAY_TOKEN_*` ref

**新增契约条款**（写入 `docs/model-gateway-contract.md` 已知约束，本次只写计划，契约在下一笔提交）：
> 任何读取 `~/.dsh` 的代码不得依赖 `rt.dshHome` 存在；必须走 `resolveDshHome(rt)` 统一解析器；失败要可见（warn），不许靠 catch 静默吞掉。

**Slice 1A-6 测试**（ds-bot `test/gateway/`，node:test）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `1A6-dsh-home` rt.dshHome=undefined 时 resolveDshHome 回退至 DSH_HOME 或 ~/.dsh | `resolveDshHome({}) === process.env.DSH_HOME \|\| endsWith('.dsh')` | 删回退逻辑 → undefined → 红 |
| `1A6-yaml-source` settings.yaml 有 ds-bot.gateway.host=127.0.0.2 时 gateway 绑 127.0.0.2 | `actualHost === '127.0.0.2'` | 删 YAML 读取（恒 127.0.0.1）→ 红 |
| `1A6-repush` 网关就绪后补推 payload 含 gateway.baseURL + GATEWAY_TOKEN ref | `payload.providers[0].baseURL.includes('4387') && payload.providers[0].apiKeyEnv.startsWith('GATEWAY_TOKEN_')` | 删 gateway-ready pushOnline → payload 无 gateway → 红 |

**Slice 1A-6 门禁**：
- 3 条测试全绿 + `node --check` 通过
- 版本：ds-bot `0.3.1-fork.37`；package.json 与 commit message 一致
- T1/T2/T3 真机验收排在 1A-6 装机之后（含二次推送 gateway-ready 日志确认）

---

#### 1A-7. E2E 建立后触发 config-sync 补推（dsh-remote-agent，0.10.1-fork.50）

**真机根因（证据来源）**：

真机日志出现 `config-sync: no e2e session, refuse to push ... revision:1181119400`；
- `lib/hub/config-sync.js` 的 `hasE2E` 护栏在 E2E 未建立时拒推，设计正确；
- `pushOnline`（1A-6 新增）在 attach 与 gateway-ready 两个时刻触发，但此时 E2E 会话尚未建立，推送全部被护栏拒绝；
- 节点侧全仓无发送 `CONFIG_SYNC_REQUEST` 的代码（`lib/protocol.js:136` 仅定义，`lib/hub/registry-ingest.js:351` 仅接收）；
- 重连不触发推送，节点永久停在旧配置（`/root/.dsh/config-sync.json` mtime 12:39）。

**修法（ra，0.10.1-fork.50）**：

- hub：`handleE2EOffer()` 成功后发 `e2eEstablished(nodeId)` 事件；config-sync 订阅，对该节点调用 `sendPush(nodeId)`（护栏此时已过，E2E 已建立）；
- node：transport `online` 事件后读本地 `appliedRevision` 并发 `CONFIG_SYNC_REQUEST`（现有接收路径 `registry-ingest.js:351` 已就绪，不需要新帧）；
- **护栏不动**：`hasE2E` 守住「无会话绝不发明文」。

**已知不变量（新增契约条款）**：带密钥的下行不得在无 E2E 时发送，也不得因时序丢失而永远不重试——护栏 + 补推缺一不可。

**修改文件**（dsh-remote-agent 仓库）：
- `lib/hub/config-sync.js` — 订阅 `e2eEstablished` 事件，对节点补推
- `lib/hub/e2e.js`（或 `handleE2EOffer` 所在文件）— 成功后 emit `e2eEstablished`
- `lib/node/index.js` — transport online 后发 `CONFIG_SYNC_REQUEST`

**Slice 1A-7 测试**（dsh-remote-agent `test/config-sync.test.js`，node:test）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `1A7-e2e-push` | E2E 建立后 sendPush 被调用，payload 含 `GATEWAY_TOKEN_` ref | 删 e2eEstablished 订阅 → 不推 → 红 |
| `1A7-node-request` | node transport online 后发 CONFIG_SYNC_REQUEST，hub 收到后推送 | 删 CONFIG_SYNC_REQUEST 发送 → 节点无更新 → 红 |
| `1A7-no-plaintext` | hasE2E=false 时推送被拒，apiKey 不出现在明文帧 | 删 hasE2E 护栏 → 明文下行 → 红 |

**版本**：ra `0.10.1-fork.50`（package.json 同步，commit 信息一致）。

**真机验收顺序**（更新）：1A-7 装机 → 用户 ⌘Q 重启 → 先核「E2E established 日志 + 节点 `.credentials.yaml` 出现 `GATEWAY_TOKEN_`」→ 再跑 T1/T2/T3；T4（token 轮换重启）依赖 1A-4 fingerprint，仍排在 T1–T3 之后。1B 隧道继续暂缓。


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
| `1Q` tcp connection 闭环 | accept() + pipe 双向工作 | 删 tcp connection handler → 红 |
| `1Q2` 节点上线 → 隧道建立 | forwardIn 调用，boundPort 返回 | 删 establishTunnel → 红 |
| `1R` 节点离线 → 隧道关闭 | conn.end 调用 | 删 closeTunnel → 红 |
| `1S` 断线重连 ≤5s | conn close 后 5s 内重新 forwardIn | 删 retry → 红 |
| `1T` AllowTcpForwarding 禁 → 降级 | 日志含 tcp-forwarding-denied | 删 forwarding 检查 → 红 |

---

### Slice 2：Config-Push Payload 扩展

**修改文件**：
- `src/host/config-source.js`（ds-bot）— per-provider gateway 开关 + epoch refName；source 签名 `(nodeId) => payload`（ra/lib/hub/config-sync.js:24 `readSource(nodeId)` 须改为 `sourceFn(nodeId)`）
- `lib/node/config-sync.js`（dsh-remote-agent）— fingerprint 扩展已移入 **Slice 1A-4**（见下）；S2 不再重复

**Slice 2 测试**（dsh-remote-agent `test/config-sync/` + ds-bot `test/`，node:test）：

| 测试 | 断言 | 刀 |
|---|---|---|
| `2A` hub provider apiKey = '' | `p.apiKey === ''` | 删 hub 分支 → 红 |
| `2B` baseURL 含 /v1 | `p.baseURL.endsWith('/v1')` | 删 /v1 → 红 |
| `2C` apiKeyEnv = GATEWAY_TOKEN_* | `p.apiKeyEnv.startsWith('GATEWAY_TOKEN_')` | 删 → 红 |
| `2D` gateway token 写进 credentials | credentials.yaml 含 `GATEWAY_TOKEN_*:`（随 provider apiKey/apiKeyEnv 写入，无需 extraRefs 字段） | 删 apiKey 写入 → credentials 无 token → 红 |
| `2E` direct provider 不变 | 与原 buildConfigPayload 一致 | 破坏 direct 分支 → 红 |
| `2F` stale revision 静默丢弃 | `result.stale === true` | 删 revision 检查 → 红 |
| `2G` apiKeyEnv 合法 ref 名 | `/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.apiKeyEnv)` | 用含连字符 nodeId → 红 |
| `2H` baseURL/apiKeyEnv 变化触发重启 | 改 baseURL，`shouldRestart === true`（依赖 1A-4 fingerprint 扩展） | 删 fingerprint 扩展 → false → 红（须 1A-4 已合入） |

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

## 已知限制

0. **E2E 护栏 + 补推缺一不可**：带密钥的下行不得在无 E2E 时发送，也不得因时序丢失永远不重试（1A-7）。

1. **`currentRevision` 为单值**：改成 per-node source 后，`currentRevision` 只表示「最近一次计算」的版本，不反映各节点实际 appliedRevision。`handleSyncRequest` 每次 `readSource(nodeId)` + `computeRevision` 实时对比，正确性不受影响；per-node revision map 状态展示留 P2。

2. **token 旁路持久化窗口**：`credentials.set` 为 fire-and-forget 异步持久化。推送成功但进程在落盘前崩溃时，重启后 `parseCredentialRefs` 找不到旧 refName → 生成新 token，下次 config-push（revision 递增）自动推送新 token 自愈。节点短暂 401（最多一个推送周期）不影响后续使用。

3. **`listGatewayProviders` 每请求派生**：固定 settings 解析开销，P1 不做缓存。P2 视调用量决定是否加内存缓存 + settings 变更订阅刷新。


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

- [x] S1 (feat/mirror-session) 门禁已通过
- [x] Slice 0 探针已通（`dda11ddd`，司令复跑全绿：tokens 200 / TTFT 0ms / abort 1ms / total 4190ms）
- [x] tailnet 可达性确认（Slice 0 探针已通：TTFT 0ms，200 tokens，abort 1ms，dda11ddd）
- [ ] 待验证项 G1 结论出
- [ ] hub config `gatewayHost = 100.64.0.3`（**P1 验收默认 tailnet，硬要求**）；反向 SSH 隧道仅在同机调试时启用（`gatewayHost = 127.0.0.1`）
