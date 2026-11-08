# 模型网关 P1 分片计划 v2 (Model Gateway P1 Slice Plan)

**状态**: 修订稿 v2（2026-11-08，架构师，回应司令六条问题后待终审）
**分支**: feat/model-gateway-contract
**依赖契约**: docs/model-gateway-contract.md v3 (2396338c) — 已冻结
**前置门禁**: S1 (feat/mirror-session) 验收通过后 P1 编码才开工

> 本文档是 v1 的全量修订，逐条回应司令六条硬问题，以代码行号证据为支撑。

---

## 行号基线声明

> **所有行号均基于安装版 `DSH Desktop 0.13.2` 的 `app.asar/node_modules/@deepseek-ai/*`
> 及 ra-fork40 的 `/tmp/ra-fork40/package/lib/`。**
> 工作区 `dev/harness/node_modules` 为 0.2.2-rc.1，行号漂移，不得用作证据。

---

## 六条硬问题的代码证据与设计回应

### Q1: 远程可达性

**代码证据**:
- ra-fork40 `instance-config.js` PERSISTED_KEYS 含 `hubUrl`、`relayUrl`（L76-93）
- ra-fork40 `node/index.js` 只有 relay/transport 通道，无直连 HTTP 端口
- `127.0.0.1:${port}/v1` 在节点侧指向节点自身，不是 hub（L1 注释确认"只用 node: 内置模块"）

**设计决策**: 网关不建独立 HTTP 端点，而是在 relay 帧上增加 `hub/llm-proxy` 帧类型，把模型请求通过现有 E2E 加密通道路由到 hub 侧代理再转发上游。
- 优点：零额外 TLS/NAT/证书；复用现有 E2E（X25519+AES-256-GCM, ra-fork40 e2e.js）
- 约束：Slice 1 需在 `protocol.js` 新增 `LLM_PROXY_REQ/RES` 帧；`E2E_REQUIRED_TYPES` 加入这两个帧

**待确认项**：RTT 开销是否可接受（relay 增加一跳）；流式响应是否需要分片帧。

### Q2: 多 provider 消歧

**代码证据**:
- config-source.js L77-85: 当前 providers 含 `id`（provider 路由名）字段
- dsh-llm-pi-ai PROTOCOLS（app.asar L835-838）: 每个 provider 独立 id
- 模型请求 `body.model` 可能同名（如两个 provider 都有 `gpt-4o`）

**设计决策**: 模型请求的 `body.model` 携带 provider 前缀，格式为 `{providerId}/{modelId}`：
- hub 侧代理按 `model.split('/')[0]` 路由到对应上游 provider
- 节点 dsh-llm-pi-ai profile 的 `models[].id` 用 `{providerId}/{modelId}` 格式
- 契约 §3.2 的模型引用 `{ provider, model }` 保持不变，拼接在发起请求时

**测试覆盖**: 新增同名消歧测试——两个 provider 各有 `gpt-4o`，验证路由到正确上游。

### Q3: 节点 Token 安全

**代码证据**:
- ra-fork40 instance-config.js PERSISTED_KEYS 含 `nodeToken`（L85）
- ra-fork40 node/index.js L336-342 `resolveToken()`: 优先 `config.token`，其次 `config.nodeToken`，再次 `<stateDir>/token` 文件
- 当前 `nodeToken` 已有存储位置，但用于 hub 认证节点，不用于网关认证

**设计决策**: 网关 token 独立于节点 token，按节点签发：
- hub 在节点入网（pairing）时生成 `gatewayToken`，含字段: `{ nodeId, scope: [providerId, ...], issuedAt, expiresAt }`
- 存储: 节点侧存 `<stateDir>/gateway-token`（文件权限 0600），不进 instance.json 明文；hub 侧存 credentials store
- 吊销: hub 侧持有 token 注册表，`issuedAt + expiresAt` 有效期检查；节点离网时 hub 侧吊销
- 校验: hub 侧 HMAC-SHA256（共享密钥由 pairing 时 E2E 通道协商）

**待确认项**: `scope` 字段的粒度（provider 级还是模型级？P1 先做 provider 级）。

### Q4: 渐进迁移，不删 apiKey 推送

**代码证据**:
- config-source.js L68-83: 当前 providers 含 apiKey 明文（L82）
- config-source.js L121: `service.setSource(...)` 注册 hub 侧 config-sync source

**设计决策**: 新增 `gatewayMode` 字段（`"direct" | "hub"`，默认 `"direct"`）:
- `"direct"` 模式（当前行为）: providers 含 apiKey，节点直连上游
- `"hub"` 模式（P1 新增）: providers 含 gatewayURL/gatewayToken，不含 apiKey；节点通过 relay 帧访问 hub 代理
- 切换: 节点级 canary 开关；hub 推送含 `mode: "hub"` 的 providers 时，节点侧新建 hub gateway provider，保留旧 direct providers 直到 P1 验收通过
- 回滚: hub 侧切回 `"direct"` 模式，节点下次 config-sync 重置为 direct providers

### Q5: 真正的刀（node:test）

v1 的 curl 烟测不算刀（"红期=connection refused"不是断言失败）。修订后的测试要求:
- 框架: node:test + assert，随机端口，假上游（内存 HTTP 服务器）
- 刀的定义: 删除目标函数体（或注释掉单行判断）→ 具体断言 `assert.strictEqual(res.status, 401)` 等必须失败
- 见各 Slice 测试节

### Q6: 节点 config-sync 接收器现状（核心）

**代码证据**（最关键）:
- ra-fork40 node/index.js L1003-1072 `dispatch()` 函数：处理的帧枚举 = TASK_START、TASK_CANCEL、TASK_QUERY、ARTIFACT_LIST、ARTIFACT_PULL、ARTIFACT_CANCEL、PING、FS_REQ、SHARE_REQ、ERROR、BOT_TURN、BOT_CREATE
- **无任何 CONFIG_PUSH、HUB_CONFIG、config-sync 帧处理**；default 分支（L1069-1070）只打 debug 日志
- ra-fork40 protocol.js HUB_TO_NODE 表（L14-66）：无 CONFIG_PUSH 帧常量

**结论**：
- 节点侧 config-sync 接收器**未实现**，是新工作
- hub/config-push 帧**不存在于协议**，需新增
- config-source.js 的 `setSource()` 只服务 hub 侧的 `remote-agent:config-sync` 服务（一个 hub 侧服务），不经过 relay 帧推送到节点

**对 Slice 2 的影响**（重写）:
- 必须在 protocol.js 新增 `HUB_TO_NODE.CONFIG_PUSH` 帧常量
- 必须在 node/index.js dispatch 函数新增 `CONFIG_PUSH` 的 case
- 节点侧接收后，通过 `ctx.get('settings')` 写入 `llm-pi-ai.providers` （节点 settings API 待验证）
- 节点 dsh 0.2.2-alpha.2 是否支持 apiKeyEnv credential-ref：**待实测**（DEFER → S1 前确认）

---

## 现状分析

### 现有基础设施

| 组件 | 文件 | 状态 |
|------|------|------|
| config-source hub 侧 | `src/host/config-source.js` | 已有，推送 apiKey（需改为 hub 模式时不推） |
| config-sync service（hub 侧） | `remote-agent:config-sync` service | 已有 `setSource()` 机制，但仅 hub 侧 |
| config-push 帧（protocol） | `ra-fork40/lib/protocol.js` | **不存在**，需新增 |
| config-push 节点接收器 | `ra-fork40/lib/node/index.js` | **不存在**，需新增 |
| E2E 传输 | `ra-fork40/lib/node/transport.js` | 已有 X25519+AES-256-GCM，可复用 |
| nodeToken 存储 | `ra-fork40/lib/instance-config.js:85` | 已有，存 `<stateDir>/instance.json` |

### 差距矩阵

| 契约要求 | 当前状态 | 新工作 |
|----------|---------|--------|
| hub 网关代理 | 无 | Slice 1：hub 侧 llm-proxy 处理器 |
| config-push 帧 | 无 | Slice 2：protocol.js + node dispatch |
| 节点加载 hub config | 无 | Slice 2：节点 settings 写入 |
| gateway token 安全 | nodeToken 存在但不适用 | Slice 1：gateway-token 机制 |
| 渐进迁移 | 无 | Slice 1/2：gatewayMode 开关 |

---

## Slice 1: Hub 侧 LLM 代理处理器

### 目标
在 hub 侧新建帧处理器，接收节点经 relay E2E 通道发来的 `node/llm-proxy-req` 帧，验证 gateway token，路由到上游 provider，将响应以 `hub/llm-proxy-res` 帧流回节点。此片无节点代码改动，可用 hub 侧单测验证。

### 文件清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `src/gateway/llm-proxy.js` | hub 侧帧处理器：验证 token + 路由上游 + 流式响应 |
| 新建 | `src/gateway/gateway-token.js` | token 签发/验证/吊销（HMAC-SHA256，含 nodeId+scope+exp） |
| 修改 | `src/host/config-source.js` | 新增 `gatewayMode: "hub"` 分支：providers 含 gatewayToken 而非 apiKey；`"direct"` 分支保留原行为 |
| 修改 | ra-fork40 `lib/protocol.js` | 新增 `NODE_TO_HUB.LLM_PROXY_REQ` 和 `HUB_TO_NODE.LLM_PROXY_RES` 帧常量；加入 E2E_REQUIRED_TYPES |

### 接口 / 数据结构

**帧定义**（新增至 protocol.js）:

```js
// NODE_TO_HUB（节点请求 hub 代理）
LLM_PROXY_REQ: 'node/llm-proxy-req'
// 载荷: { reqId, nodeId, gatewayToken, providerId, body: {...openai-request} }

// HUB_TO_NODE（hub 返回代理结果）
LLM_PROXY_RES: 'hub/llm-proxy-res'
// 载荷: { reqId, chunk?, done?: true, error?: {code, message} }
// chunk: OpenAI SSE 数据行（string）
// done: true 时为最后一帧
```

**gateway token 结构**:

```json
{
  "nodeId": "node-abc123",
  "scope": ["openai", "deepseek"],
  "issuedAt": 1731059999,
  "expiresAt": 1731146399
}
```

token = `base64(payload) + "." + base64(hmac-sha256(sharedSecret, payload))`，`sharedSecret` 在 pairing 时经 E2E 通道协商，不经过 relay 明文。

**hub 侧代理请求路由**（llm-proxy.js）:

```
收到 LLM_PROXY_REQ 帧
→ verifyToken(gatewayToken, nodeId) → 验证签名 + 未过期 + scope 包含 providerId
→ lookupProvider(providerId) → 从 hub ctx.llm 取 baseURL + apiKey
→ fetch(baseURL + '/v1/chat/completions', body) → SSE stream
→ 逐行发 LLM_PROXY_RES { reqId, chunk } 帧
→ 最后发 LLM_PROXY_RES { reqId, done: true }
```

### 测试（node:test，真实帧 + 假上游）

**刀 1A: 无 token 帧被拒** 🔴
```js
// 删除 verifyToken() 中的签名校验行 → 断言失败
const res = await handleProxyReq({ gatewayToken: null, ... })
assert.strictEqual(res.error.code, 'gateway-auth-failed')
// 刀：注释掉 if (!verifyToken(...)) throw → 上面断言不再触发 → 测试红
```

**刀 1B: 有效 token + 假上游 → SSE 帧序列正确** 🟢
```js
// 假上游返回 3 个 SSE 帧 + [DONE]
const chunks = []
for await (const frame of proxyStream({ validToken, body })) chunks.push(frame)
assert.ok(chunks.length >= 3)
assert.ok(chunks.at(-1).done === true)
// 刀：注释掉 chunk 发送循环 → chunks.length < 3 → 红
```

**刀 1C: 假上游 500 → error 帧，不挂起** 🔴
```js
// 假上游返回 HTTP 500
const res = await handleProxyReq({ validToken, body: { model: 'openai/gpt-4o', ... } })
assert.strictEqual(res.error.code, 'SERVER')
// 刀：删除 5xx catch 分支 → error 帧不发 → 断言失败或超时
```

**刀 1D: scope 不含 providerId → 拒绝** 🔴
```js
// token.scope = ['deepseek']，请求 provider = 'openai'
const res = await handleProxyReq({ tokenWithWrongScope, body: { model: 'openai/gpt-4o' } })
assert.strictEqual(res.error.code, 'gateway-scope-denied')
// 刀：删除 scope 校验 → 断言失败
```

### 门禁
- 1A/1B/1C/1D 全绿
- `config-source.js` 在 `gatewayMode: "direct"` 时行为不变（apiKey 推送保留）
- protocol.js 新帧加入 E2E_REQUIRED_TYPES，裸文传输被拒

### 回滚
- 删除 `src/gateway/` 目录
- revert protocol.js（帧常量）
- revert config-source.js（gatewayMode 分支）
- 节点恢复 direct 模式直接上游连接

---

## Slice 2: Config-push 帧与节点配置加载

### 目标
在 ra-fork40 protocol.js 新增 CONFIG_PUSH 帧；在节点 dispatch 函数新增处理器，将 hub 下发的 providers 写入节点 dsh-llm-pi-ai settings。此片独立于 Slice 1，可单独测试节点 settings 写入。

### 关键前置验证（编码前必须完成）

**验证 A**: 节点 dsh 0.2.2-alpha.2 的 `ctx.get('settings')` 能否写入 `llm-pi-ai.providers`？
- 检查路径: app.asar `dsh-api-settings-controller/lib/index.js:90-208 CredentialsController`
- 检查路径: dsh-llm-pi-ai/lib/index.js:1084 `Config = z.object({ providers: z.dict(profile).volatile() })`
- 证据: volatile() 字段不被 Cordis 持久化框架存储（dsh-llm-pi-ai:1050-1082 全字段 volatile）
- **风险**: volatile 字段表示不持久化，但可以被 `settings.set()` 运行时写入并生效；需实测确认写入后 pi-ai adapter 是否重新加载

**验证 B**: credential-ref 在节点 dsh 0.2.2-alpha.2 是否支持？
- 检查路径: dsh-api-settings-controller/lib/index.js:4 `import { credentialRef } from "@deepseek-ai/dsh-credentials"`
- dsh-llm-pi-ai:1051 `apiKeyEnv: z.string().role("credential-ref")`（可选字段，无 .required()）
- 节点 DSH 0.2.2-alpha.2 需确认 `@deepseek-ai/dsh-credentials` 包已安装且 `ctx.credentials` 已注册
- **如不支持**: 改为节点侧不用 credential-ref，而是直接把 gateway token 值写入 profile.headers 或自定义认证字段（绕过 credential-ref 机制）

### 文件清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 修改 | ra-fork40 `lib/protocol.js` | 新增 `HUB_TO_NODE.CONFIG_PUSH` 帧常量（与 Slice 1 同批次） |
| 修改 | ra-fork40 `lib/node/index.js` | dispatch 函数新增 `case HUB_TO_NODE.CONFIG_PUSH: handleConfigPush(frame, d)` |
| 新建 | ra-fork40 `lib/node/config-apply.js` | 将收到的 providers 转换为 pi-ai profile 格式，调用 settings API 写入 |
| 修改 | `src/host/config-source.js` | `gatewayMode: "hub"` 时 buildConfigPayload 返回 `gatewayURL`（relay 帧路径）而非 apiKey |

### 接口 / 数据结构

**CONFIG_PUSH 帧载荷**:

```json
{
  "revision": 3,
  "providers": [
    {
      "id": "openai",
      "api": "openai-completions",
      "models": [
        { "id": "openai/gpt-4o", "name": "GPT-4o" }
      ]
    }
  ],
  "defaultModel": "openai/gpt-4o",
  "gatewayToken": "base64payload.hmac",
  "mode": "hub"
}
```

> **注意**: `baseURL` 不在此帧 — 节点侧 baseURL 由节点构造（relay 帧路径），不依赖 hub IP

**节点侧 profile 转换**（config-apply.js）:

```js
// 收到的 provider → dsh-llm-pi-ai profile（hub 模式）
{
  api: "openai-completions",    // 透传
  baseURL: HUB_RELAY_BASE,     // 特殊占位，实际请求走 LLM_PROXY_REQ 帧，不走 HTTP fetch
  models: [{ id: "openai/gpt-4o", name: "GPT-4o" }],
  // apiKeyEnv 用 gatewayToken 写入 credential-ref（或直接写入 headers）
}
```

### 测试（node:test，isolate 节点 settings）

**刀 2A: 收到 CONFIG_PUSH 帧前，节点无 hub provider** 🔴
```js
// 初始化 fake ctx，不发 CONFIG_PUSH 帧
const settings = fakeCtx.get('settings')
assert.ok(!settings.get('llm-pi-ai')?.providers?.openai)
// 刀：发一个 CONFIG_PUSH → 上面断言失败（因为 provider 已写入）→ 确认刀有效
```

**刀 2B: 收到 CONFIG_PUSH 帧后，settings 含 hub provider** 🟢
```js
await handleConfigPush(fakCtx, { providers: [{id:'openai',api:'openai-completions',models:[...]}], ... })
const p = fakeCtx.get('settings').get('llm-pi-ai').providers['openai']
assert.strictEqual(p.api, 'openai-completions')
assert.ok(Array.isArray(p.models) && p.models.length > 0)
// 刀：注释掉 settings.set() 调用 → p 为 undefined → 断言失败 → 红
```

**刀 2C: payload 含 apiKey 时被拒绝（hub 模式保护）** 🔴
```js
// hub 模式下 CONFIG_PUSH 绝不含 apiKey
const payload = buildConfigPayload(rt, { gatewayMode: 'hub', defaultModel: null })
assert.ok(!JSON.stringify(payload).includes('"apiKey"'))
// 刀：删除 gatewayMode 判断 → payload 含 apiKey → 断言失败 → 红
```

**刀 2D: 同名 provider 消歧 — 两个 provider 的 gpt-4o 不互相覆盖** 🔴
```js
// providers: [{id:'openai',models:[{id:'openai/gpt-4o'}]}, {id:'hub',models:[{id:'hub/gpt-4o'}]}]
await handleConfigPush(fakeCtx, { providers: [...] })
assert.ok(fakeCtx.get('settings').get('llm-pi-ai').providers['openai'])
assert.ok(fakeCtx.get('settings').get('llm-pi-ai').providers['hub'])
// 刀：改为 providers 数组只保留最后一个 → 第一个 assert 失败 → 红
```

### 门禁
- 验证 A/B 先完成（代码证据 + 结论写入待验证项）
- 2A/2B/2C/2D 全绿
- 节点 settings 写入后 `ctx.llm.listProviders()` 返回 hub providers
- 旧 direct providers 保持不变（gatewayMode: "direct" 时不调用 handleConfigPush）

### 回滚
- revert ra-fork40 protocol.js（删 CONFIG_PUSH 帧）
- revert ra-fork40 node/index.js（删 dispatch case）
- 删 ra-fork40 lib/node/config-apply.js
- 节点侧无 hub provider，仍用本地 direct providers（如有）

---

## Slice 3: 端到端验证 + 错误可见

### 目标
验证 Slice 1+2 集成：节点经 relay 帧调用模型，成功时流到对话页，失败时错误可见。对应契约 §6 的三条 P1 出口判据。

### 文件清单

无新增代码文件。此片是集成测试，依赖 Slice 1+2 完成。

### 接口 / 数据结构

节点侧请求链路（Slice 2 完成后）:

```
agent-loop → dsh-llm LlmRuntime.streamWithRegistration()
  → pi-ai openAICompletionsApi → baseURL = HUB_RELAY_BASE
  → 发现 baseURL 是 relay 占位 → 改为发 NODE_TO_HUB.LLM_PROXY_REQ 帧
  → hub 侧 llm-proxy.js 收帧 → 代理上游 → 发 HUB_TO_NODE.LLM_PROXY_RES 帧序列
  → 节点侧把 RES 帧拼成 SSE stream → pi-ai toStreamChunks(L1557-1680) 解析
```

> **注意**: pi-ai 原生发 HTTP fetch；需在节点侧适配层将 baseURL=HUB_RELAY_BASE 的请求
> 拦截并改走帧通道。这是 Slice 2 config-apply.js 中 `baseURL` 值选择的关键。
> 待确认: 是注入一个自定义 `transport` adapter 还是 mock fetch（前者更干净）。

错误收口链路（契约 §5.3 已定义）:

```
帧通道 TRANSPORT 错误 / token 过期
  → classifyPiAiError(L1457-1468) → AUTH / TRANSPORT / TIMEOUT
  → adapterFailureChunk(dsh-llm:2409-2420)
  → agent-loop(L923-938) → assistant/attempt + turn/end{kind:"error", error:{code}}
  → 对话页错误气泡
```

### 测试（对应契约 §6 三条判据）

**刀 3A: gateway token 失效 → AUTH 错误可见** 🔴 (P1 判据 1)
- 环境: fake relay + fake hub 代理（返回 401）
- 操作: 发消息 "hello"，gateway token 指向空值
- 断言: `turn/end.reason.kind === "error"` 且 `reason.error.code === "AUTH"`
- 对话页: 显示认证错误（非静默失败）
- 刀: 注释掉 gateway-token 校验 → hub 代理不返回 401 → turn/end.kind 变为 stop → 断言失败 → 红

**刀 3B: 任意已配置模型可跑** 🟢 (P1 判据 2)
- 环境: fake relay + fake hub 代理（返回正常 SSE stream）
- 操作: 分别用 models 列表中的 2 个模型发 "hello"
- 断言: 流式 text-delta 到达; `usage.inputTokens > 0 && usage.outputTokens > 0`; `finish.kind === "stop"`
- 刀: mock hub 代理不发流式帧 → text-delta 不到达 → 断言失败 → 红

**刀 3C: relay 帧通道断开 → TRANSPORT 错误可见** 🔴 (P1 判据 3)
- 环境: 断开 fake relay（节点发帧后无回应）
- 操作: 发消息触发 LLM_PROXY_REQ，fake relay 不回 LLM_PROXY_RES
- 断言: 超时后 `turn/end.reason.kind === "error"` 且 `reason.error.code === "TRANSPORT"` 或 `"TIMEOUT"`（dsh-agent-loop:809-822）
- 对话页: 显示错误信息（非挂起）
- 刀: 注释掉超时检测 → turn/end 不写 → 断言超时 → 红

### 门禁
- 3A/3B/3C 全绿
- allowLocalFallback 默认 false；3A/3C 验证不触发本地 fallback
- 对话页错误显示与 agent-loop error 收口一致

### 回滚
- Slice 3 无代码改动；回滚即停用节点 hub gateway provider（config-push mode 改回 direct）

---

## 依赖关系与执行顺序

```
前置: 验证 A/B（settings.set + credential-ref 可用性）
      ↓
Slice 1 (hub llm-proxy)  ────┐
         ↓                   │
Slice 2 (config-push + 节点)─┘→ Slice 3 (端到端)
```

- **前置验证 A/B 必须先完成**（可以是 S1 期间的代码探测）
- Slice 1 和 Slice 2 可并行开发（不同文件集）
- Slice 3 依赖 Slice 1+2 完成，需集成环境

---

## 平台范围

**P1 范围**: hub 仅限 macOS（DSH Desktop 0.13.2 app.asar）；节点支持 macOS、Linux、Windows（ra-fork40 零外部依赖，node: 内置模块跨平台）。
- relay 帧路径跨平台（不依赖 OS 网络配置）
- gateway-token 文件权限 0600 在 Windows 上退化为 ACL，需测试

---

## 待验证项（按优先级）

1. **【P0，Slice 2 编码前必须完成】** 节点 dsh 0.2.2-alpha.2 的 `ctx.get('settings').set(ns, path, value)` 是否能将 hub 下发的 providers 写入 `llm-pi-ai.providers` 并让 pi-ai adapter 实时生效（volatile 字段不持久化但运行时可写）。检查 dsh-api-settings-controller/lib/index.js:294-377（settings ns 注册）+ dsh-llm-pi-ai:50（apply/config 注入路径）。
2. **【P0，Slice 2 编码前必须完成】** 节点 DSH 0.2.2-alpha.2 是否已注册 `ctx.credentials`（`@deepseek-ai/dsh-credentials` 包）；若未注册，Slice 2 改为直接写 `profile.headers["Authorization"]` 而非 credential-ref。
3. **【P1，Slice 1】** relay 帧流式响应的 RTT 开销评估；是否需要批量帧（多行 SSE 合一帧）降低帧频。
4. **【P2，Slice 3】** 对话页 error turn 的 UI 渲染路径（ds-bot 前端如何显示 `turn/end.reason.kind === "error"`）。
5. **【P3，上线前】** gateway token 的 scope 粒度（provider 级 → 模型级的迁移）和 token 轮换机制（当前依赖 expiry，无主动轮换）。
