# 模型网关 P1 分片计划 (Model Gateway P1 Slice Plan)

**状态**: 初稿（2026-11-08，架构师，待司令复核）
**分支**: feat/model-gateway-contract
**依赖契约**: docs/model-gateway-contract.md v3 (2396338c) — 已冻结
**前置门禁**: S1 (feat/mirror-session) 验收通过后 P1 编码才开工

> P1 目标：节点通过 hub 网关调用模型，不持有上游 provider 凭据；网关不可达时错误在对话中可见。
> 本文档将 P1 拆为 3 片可独立验收的工作单元，每片含文件清单、接口/数据结构、测试（含必红刀）、门禁、回滚。

---

## 行号基线声明

> **本计划引用的契约行号均基于安装版 `DSH Desktop 0.13.2` 的 `app.asar/node_modules/@deepseek-ai/*`。**
> 工作区 `dev/harness/node_modules` 为 0.2.2-rc.1，行号与行为与安装版存在漂移，不得用作证据。

---

## 现状分析

### 已有基础设施

| 组件 | 文件 | 当前行为 |
|------|------|---------|
| config-source | `src/host/config-source.js` | `buildConfigPayload()` 已构建 `{ providers, defaultModel }`，但 providers 含 `apiKey` 明文（L82）——契约要求移除 |
| config-sync | `remote-agent:config-sync` service | 已有 `setSource()` 机制，hub 侧调用 source 构建 payload 并推送 |
| connectors/gateway | `src/host/connectors/gateway.js` | 已有本地 HTTP server + nonce auth + SSE 代理模式——可参考但不是 P1 复用目标 |
| dsh-llm-pi-ai | app.asar `dsh-llm-pi-ai/lib/index.js` | profile schema 支持 `api: "openai-completions"` + `baseURL` + 手动 `models`，无需 `/v1/models` 发现 |

### 与契约的差距

| 契约要求 | 当前状态 | 差距 |
|----------|---------|------|
| 节点不持有上游 apiKey | config-source.js L82 推送 apiKey 明文 | 需改为推送 gateway URL，移除 apiKey |
| 节点用 hub 网关 token 认证 | 节点无网关 token 机制 | 需新增网关端点 + 节点 token 下发 |
| 网关代理到上游 provider | 无网关 HTTP 服务 | 需新建网关服务 |
| 错误可见 | agent-loop 已有 error 收口机制 | 无需改 agent-loop，验证即可 |

---

## Slice 1: Hub 网关 HTTP 端点

### 目标
在 hub 侧新建 OpenAI 兼容 HTTP 网关，节点用 node token 认证，网关代理到上游 provider。此片不涉及节点侧改动，可独立 curl 验证。

### 文件清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `src/gateway/index.js` | 网关生命周期：start/stop，端口管理 |
| 新建 | `src/gateway/router.js` | 请求路由：认证 → 模型匹配 → 上游选择 → 代理转发 |
| 新建 | `src/gateway/auth.js` | node token 验证（timingSafeEqual，参考 connectors/gateway.js:24） |
| 新建 | `src/gateway/proxy.js` | SSE 流代理：接收上游响应 → 透传给节点 |
| 新建 | `src/gateway/upstream.js` | 上游 provider 选择：根据请求 `model` 字段查找已注册 provider 的 baseURL + apiKey |
| 修改 | `src/host/config-source.js` | `buildConfigPayload()` 移除 `apiKey` 字段（L82），改为推送 `gatewayURL` |

### 接口 / 数据结构

**网关 HTTP 接口**:

```
POST /v1/chat/completions
  Authorization: Bearer {nodeToken}
  Content-Type: application/json
  Body: { model, messages, stream: true, tools?, max_tokens?, ... }

Response (成功): SSE stream (OpenAI 兼容格式)
Response (401): { error: { message: "invalid node token", type: "invalid_request_error" } }
Response (404): { error: { message: "model not found: {model}", type: "invalid_request_error" } }
Response (502): { error: { message: "upstream error: {detail}", type: "server_error" } }
```

**node token 存储**:
- hub 在 `.credentials.yaml` 的 `refs:` 段存储 `HUB_NODE_TOKEN` 值
- 网关启动时读取，不内联在配置中

**upstream 选择逻辑** (`upstream.js`):
```
输入: { model: "[REDACTED]", providers: [已注册 provider 列表] }
逻辑:
  1. 解析 model 中的 provider 前缀（如 "openai/gpt-4o" → provider="openai"）
  2. 若无前缀，遍历所有 provider 查找 models[].id === model
  3. 返回 { baseURL, apiKey, api } 或 null
```

**config-source 修改**:
```js
// 修改前 (L77-83):
providers.push({
  id: entry.provider,
  api: profile.api,
  baseURL: profile.baseURL,   // ← 上游直连 URL
  apiKeyEnv,
  apiKey,                     // ← 明文 apiKey（移除）
  models,
});

// 修改后:
providers.push({
  id: entry.provider,
  api: profile.api,
  gatewayURL: `http://127.0.0.1:${gatewayPort}/v1`,  // ← hub 网关 URL
  models,                                             // ← 模型列表保留
  // apiKey 和 apiKeyEnv 不再推送
});
```

### 测试

**必红刀 1A: 无 token 请求被拒** 🔴
- 前提: 网关已启动，node token 已配置
- 操作: `curl -X POST http://127.0.0.1:{port}/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"test","messages":[{"role":"user","content":"hi"}]}'`（不带 Authorization）
- 红期（实现前）: 网关不存在 → connection refused
- 绿期（实现后）: HTTP 401 + `{ error: { message: "invalid node token" } }`

**必红刀 1B: 有 token 且模型匹配 → 流式响应** 🟢
- 前提: 网关已启动，node token 有效，至少一个上游 provider 已注册且 apiKey 有效
- 操作: `curl -X POST .../v1/chat/completions -H "Authorization: Bearer {token}" -d '{"model":"{validModel}","messages":[{"role":"user","content":"hi"}],"stream":true}'`
- 红期: 网关不存在
- 绿期: SSE 流正常返回（`data: {...}` 帧）

**必红刀 1C: 上游不可达 → 502** 🔴
- 前提: 配置一个 baseURL 指向不可达地址的 provider
- 操作: 用有效 token + 该 provider 的模型发请求
- 红期: 网关不存在
- 绿期: HTTP 502 + `{ error: { message: "upstream error: ..." } }`

### 门禁
- 1A/1B/1C 全绿
- 网关 start/stop 无残留进程
- `config-source.js` 输出的 payload 不含 `apiKey` 字段

### 回滚
- 删除 `src/gateway/` 目录
- `git revert` config-source.js 的修改
- 节点回退到当前行为（apiKey 直推），不影响 S1

---

## Slice 2: 节点加载网关 Provider 配置

### 目标
节点收到 hub config-push 后，将 providers 加载到 dsh-llm-pi-ai settings，模型目录正确显示 hub 下发的模型。此片不涉及网关端点本身，只验证配置数据到达节点并生效。

### 文件清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 修改 | `src/host/config-source.js` | 已在 Slice 1 改（移除 apiKey，加 gatewayURL） |
| 修改 | 节点侧 config-sync 接收器 | 将收到的 providers 写入 `llm-pi-ai` settings（`providers` dict），apiKeyEnv 指向 `HUB_NODE_TOKEN` |
| 新建 | `src/gateway/apply-config.js` | 将推送的 providers 配置转换为 dsh-llm-pi-ai profile 格式并写入 settings |

### 接口 / 数据结构

**hub → node config-push payload（修订后）**:
```json
{
  "revision": 1,
  "providers": [
    {
      "id": "openai",
      "api": "openai-completions",
      "gatewayURL": "http://hub-gateway:8080/v1",
      "models": [
        { "id": "gpt-4o", "name": "GPT-4o" },
        { "id": "[REDACTED]", "name": "Claude Sonnet 5.5" }
      ]
    }
  ],
  "defaultModel": "openai/gpt-4o"
}
```

**节点侧 profile 转换** (`apply-config.js`):
```js
// 收到的 provider → dsh-llm-pi-ai profile
{
  apiKeyEnv: "HUB_NODE_TOKEN",        // 统一指向节点 token
  displayName: "Hub: openai",         // 前缀 Hub 标记来源
  api: "openai-completions",           // 透传
  baseURL: "http://hub-gateway:8080/v1", // gatewayURL → baseURL
  models: [...]                        // 透传
}
```

**节点 settings 写入路径**:
- settings ns: `llm-pi-ai`
- settings path: `providers.{providerId}`
- 写入后 `resolveProfiles()` (dsh-llm-pi-ai:1118) 自动加载

### 测试

**必红刀 2A: 推送前节点无 hub provider** 🔴
- 前提: 节点未收到 config-push
- 操作: 查询节点 settings `llm-pi-ai.providers`
- 红期: 无 `hub` 开头的 provider
- 绿期: 推送后出现 `hub` provider，含 gatewayURL 和 models

**必红刀 2B: 推送后模型目录包含 hub 模型** 🟢
- 前提: config-push 成功，节点已加载
- 操作: 调用节点 `modelCatalog` API
- 红期: 不含 hub 下发的模型 ID
- 绿期: 返回的 catalog 含 hub 下发的所有模型

**必红刀 2C: 推送的 payload 不含 apiKey** 🔴
- 前提: config-push payload 已构建
- 操作: 检查 payload JSON
- 红期: 含 `apiKey` 字段（当前行为）
- 绿期: 无 `apiKey` 字段，有 `gatewayURL` 字段

### 门禁
- 2A/2B/2C 全绿
- 节点 settings 中 hub provider 的 `apiKeyEnv` 指向 `HUB_NODE_TOKEN`
- 节点 modelCatalog 返回的 hub 模型可被 agent-loop 选择

### 回滚
- `git revert` apply-config.js 和 config-source.js 修改
- 节点恢复本地 provider 配置（如有）
- config-push 恢复推送 apiKey 的旧行为

---

## Slice 3: 节点模型请求路由 + 错误可见

### 目标
节点 agent 发起模型请求时走 hub 网关，成功时流式响应到达对话页，失败时错误（TRANSPORT/TIMEOUT/AUTH）在对话中可见。此片验证 P1 三条出口判据。

### 文件清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 无新增 | — | 节点 dsh-llm-pi-ai 已支持 `openai-completions` 协议；agent-loop 已有 error 收口机制 |
| 验证 | — | 此片主要是端到端测试，验证前两片的集成 |

### 接口 / 数据结构

节点侧无新接口。模型请求走已有路径:
```
agent-loop → dsh-llm LlmRuntime.streamWithRegistration() → pi-ai openAICompletionsApi → fetch(gatewayURL/chat/completions)
```

凭据解析链路:
```
pi-ai harnessApiKeyAuth(L863-871) → ctx.credentials.resolve("HUB_NODE_TOKEN") → DSH secrets store → apiKey
→ Authorization: Bearer {apiKey} 发往 hub 网关
```

错误收口链路（契约 §5.3 已定义）:
```
fetch 失败 → classifyPiAiError(L1457-1468) → TRANSPORT/TIMEOUT/AUTH
→ adapterFailureChunk(dsh-llm:2409-2420) → {type:"finish", reason:{kind:"error", failure:{message,code}}}
→ agent-loop(L923-938) → assistant/attempt + turn/end{kind:"error", error:{message,code}}
→ 对话页显示错误
```

### 测试

**必红刀 3A: 无凭据 → AUTH 错误可见** 🔴 (P1 出口判据 1)
- 前提: 节点配置只有 hub gateway provider，`HUB_NODE_TOKEN` 未设置或为空
- 操作: 发送消息 "hello"
- 红期: 无网关 → 请求发往不存在的 provider → 可能静默失败或走本地 fallback
- 绿期:
  - finish chunk `failure.code` 为 `"AUTH"`
  - `turn/end.reason.kind === "error"` 且 `reason.error.code === "AUTH"`
  - 对话页显示认证错误（红色提示或错误气泡）
  - 不触发任何本地 fallback model

**必红刀 3B: 任意已配置模型可跑** 🟢 (P1 出口判据 2)
- 前提: 节点配置 hub gateway provider，`HUB_NODE_TOKEN` 有效，models 列表含至少 2 个模型
- 操作: 分别选择每个模型发送 "hello"
- 红期: 无网关 → 请求失败
- 绿期:
  - 流式 `text-delta` chunks 到达
  - `block-end` + `usage`（含 `inputTokens`、`outputTokens`）+ `finish` (kind: stop)
  - 两个模型均成功
  - 对话页显示 assistant 消息

**必红刀 3C: 断网 → TRANSPORT 错误可见** 🔴 (P1 出口判据 3)
- 前提: 节点配置 hub gateway provider，gatewayURL 指向不可达地址（如 `http://192.0.2.1:9999/v1`）
- 操作: 发送消息 "hello"
- 红期: 无网关 → 可能走本地 fallback 或静默失败
- 绿期:
  - finish chunk `failure.code` 为 `"TRANSPORT"` 或 `"TIMEOUT"`
  - `turn/end.reason.kind === "error"` 且 `reason.error.code` 为 `TRANSPORT` 或 `TIMEOUT`（dsh-agent-loop:809-822）
  - agent-loop 写 `assistant/attempt`（非 `assistant/message`）+ `turn/end`（契约 §5.3）
  - 对话页可见错误信息

### 门禁
- 3A/3B/3C 全绿
- 对话页错误显示格式与 agent-loop error 收口一致
- 无本地 fallback 被触发（`allowLocalFallback` 默认 false）

### 回滚
- 此片无代码改动，回滚即恢复节点本地 provider 配置
- 节点 settings 中删除 hub gateway provider 即恢复本地行为

---

## 依赖关系与执行顺序

```
Slice 1 (Hub 网关) ──→ Slice 2 (节点加载配置) ──→ Slice 3 (端到端验证)
     │                       │
     │                       └─ 依赖 Slice 1 的 config-source 修改
     └─ 独立可验证（curl 测试）
```

- Slice 1 和 Slice 2 可并行开发（不同文件），但 Slice 2 的测试需要 Slice 1 的 config-source 修改
- Slice 3 依赖 Slice 1 + Slice 2 完成后才能端到端测试
- **P1 编码在 S1 门禁通过后才开始**

---

## P1 整体门禁

| 判据 | 验证方法 | 对应测试 |
|------|---------|---------|
| 节点不持有上游 apiKey | config-push payload 无 apiKey 字段 | 2C |
| 任意已配置模型可跑 | 端到端流式对话 | 3B |
| 断网错误可见 | 对话页显示 TRANSPORT/TIMEOUT | 3C |
| 无本地 fallback | allowLocalFallback=false 生效 | 3A/3C |
| 网关 start/stop 无残留 | 进程检查 | 1A/1B/1C 后 |

---

## 待验证项

1. **（Slice 1）** 网关端口选择策略：固定端口 vs 动态分配 + 注册到 config-sync。需确认 hub 进程内网关与 config-source 的交互时机。
2. **（Slice 2）** 节点 config-sync 接收器的确切文件路径和接口。需在 S1 代码中确认 config-sync 的接收端实现。
3. **（Slice 3）** 对话页错误显示的确切 UI 行为。需确认 ds-bot 前端如何渲染 `turn/end.reason.kind === "error"`。
