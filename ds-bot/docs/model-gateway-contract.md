# 模型网关契约 (Model Gateway Contract)

**状态**: 修订稿 v2（2026-11-08，架构师，司令 6 处复核意见修正后待终审）  
**分支**: feat/model-gateway-contract  
**任务**: T-20261108-model-gateway-contract

> 本文档定义主控 hub 向副机 node 下发模型 provider 配置、节点侧加载与调用的契约。  
> 所有结论均以 DSH 源码（app.asar）行号证据为支撑，未验证项明确标注。

---

## 1. 节点侧 Provider 配置

### 1.1 Provider 配置 Schema

DSH 节点的 LLM 配置由 `dsh-llm-pi-ai` 包管理。核心 schema：

**文件**: `app.asar/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1050-1084`

```js
const profile = z.object({
  apiKeyEnv: z.string().role("credential-ref"),          // L1051 — 凭据引用名
  displayName: z.string(),                               // L1052 — 显示名
  api: z.union(supportedProtocols()),                    // L1053 — 线协议
  baseURL: z.string(),                                   // L1054 — 端点 URL
  models: z.array(modelProfile),                         // L1055 — 模型列表
  modelOverrides: z.dict(modelOverride),                 // L1056 — 模型覆盖
  compat: compatProfile,                                 // L1057 — 兼容性开关
  defaultContextWindow: z.number().default(1000000),     // L1058
  defaultMaxTokens: z.number().default(128000),          // L1059
  defaultInput: z.array(z.union(MODALITIES)),            // L1060
  headers: z.dict(z.string()),                           // L1061 — 自定义请求头
  reasoning: z.union(THINKING_LEVELS),                   // L1062
  thinkingBudgets,                                       // L1063
  cacheRetention: z.union(["none","short","long"]),      // L1064-1068
  transport: z.union(["sse","websocket","websocket-cached","auto"]), // L1069-1074
  timeoutMs: z.natural(),                                // L1075
  streamIdleTimeoutMs: z.number().default(300000),       // L1077
  retryPolicy: RetryPolicySchema                         // L1081
});

// L1084 — 顶层 Config；providers dict 为 volatile（不持久化）
const Config = z.object({ providers: z.dict(profile).default({}).volatile() });
```

所有 `profile` 字段均 volatile（不持久化）。Config 通过 Cordis 插件 `apply(ctx, config)` 注入，每次启动重新加载。

### 1.2 加载路径

1. 插件 `apply(ctx, config)` 被调用（dsh-llm-pi-ai:50）
2. `resolveProfiles(providers, "strict")` (L1118) 遍历每个 provider 条目，校验 baseURL、headers、streamIdleTimeoutMs 等
3. `buildProvider(spec)` (L927-939) 构造 pi-ai Provider 对象，注册到 adapter 的 Models 集合
4. 凭据不经过此模块存储（L810-813 注释明确）：harness 在请求进入 pi-ai 前通过 `ctx.credentials` 解析

### 1.3 节点能否只配一个指向 hub 的 OpenAI 兼容端点？

**可以。** 证据：

- `profile.api` (L1053) 接受 `"openai-completions"`，对应 OpenAI `/v1/chat/completions` 协议
- `profile.baseURL` (L1054) 可设为 hub 网关地址
- `profile.apiKeyEnv` (L1051) 引用 hub 下发的节点 token（credential-ref）
- `profile.models` (L1055) 手动声明模型列表，不需要端点支持 `/v1/models` 发现

**最小配置示例**（单 provider 指向 hub 网关）:

```json
{
  "providers": {
    "hub": {
      "apiKeyEnv": "HUB_NODE_TOKEN",
      "displayName": "Hub Gateway",
      "api": "openai-completions",
      "baseURL": "https://hub-gateway.example.com/v1",
      "models": [
        { "id": "[REDACTED]", "name": "Claude Sonnet 5.5", "input": ["text","image"] },
        { "id": "deepseek-chat", "name": "DeepSeek Chat", "input": ["text"] }
      ]
    }
  }
}
```

**前提**：hub 网关实现 OpenAI `/v1/chat/completions` 兼容面（见 §2）；认证使用 Bearer token。

### 1.4 自定义 Provider 注册路径

`dsh-llm-pi-ai` 支持两类 provider 注册（L796-938）：

**A. 目录 catalog provider**（L909 `reuseCatalogProvider`）:
- pi-ai 内置 30+ provider 目录（L2700-2870 `PROVIDER_DATA`），含 anthropic、openai、deepseek、groq、openrouter 等
- 当 profile 不指定 `api` 且 provider 名匹配 catalog 时复用（L929 判断逻辑）

**B. 手声明 route**（L932-938 `buildProvider`）:
- 当 profile 指定 `api` 字段时，使用 `PROTOCOLS[spec.api]` 构造 provider（L930-931）
- 支持协议（L835-838 `PROTOCOLS` 表）：`openai-completions`、`openai-responses`、`anthropic-messages`
- 认证通过 `harnessApiKeyAuth` (L863-871) 解析凭据，传给 pi-ai

---

## 2. 网关最小 OpenAI 兼容面

### 2.1 支持的线协议

**文件**: `dsh-llm-pi-ai/lib/index.js:835-838`

```js
const PROTOCOLS = {
  "openai-completions": openAICompletionsApi,   // OpenAI /v1/chat/completions
  "openai-responses":   openAIResponsesApi,     // OpenAI Responses API
  "anthropic-messages": anthropicMessagesApi    // Anthropic Messages API
};
```

P1 网关只需实现 `openai-completions` 协议（pi-ai 的默认协议，L2496: `const api = request.api ?? "openai-completions"`）。

### 2.2 模型发现面 — GET /v1/models

**文件**: `dsh-llm-pi-ai/lib/index.js:2278-2282, 2483-2520`

```js
const LISTABLE_PROTOCOLS = new Set(["anthropic-messages","openai-completions","openai-responses"]); // L2278-2282
```

OpenAI 协议发现（L2270-2271, L2509）:
- 端点: `GET {baseURL}/models`（L2307-2308: OpenAI protocols list at `{baseURL}/models`）
- 认证: `Authorization: Bearer {apiKey}` (L2509)
- 响应: 标准 `{ data: [...] }` 数组或 `{ models: {...} }` map（L2263）

**P1 可以不实现**：如果 hub 下发 `profile.models` 手动声明完整模型列表，节点不调用 `/v1/models`。P2 建议实现。

### 2.3 对话补全面 — POST /v1/chat/completions

基于 `COMPLETIONS_COMPAT_GATE`（L397-424）声明的 offer 字段，网关需支持以下请求字段：

| 字段 | 说明 | 来源行号 |
|------|------|---------|
| `model` | 模型 ID | profile.models[].id |
| `messages` | 对话历史（system/user/assistant/tool） | L1216-1429 |
| `stream` | `true`（DSH 默认流式） | L1069 transport |
| `tools` | 工具定义（function calling） | L777 provider declarations |
| `max_tokens` | 最大输出 token | L403 maxTokensField offer |
| `temperature` | 温度 | L368 |
| `reasoning_effort` | 推理强度 | L400 supportsReasoningEffort offer |
| `stream_options` | `{ include_usage: true }` | L401 supportsUsageInStreaming offer |

### 2.4 流式响应解析

**文件**: `dsh-llm-pi-ai/lib/index.js:1557-1680 toStreamChunks`

pi-ai 将 OpenAI SSE 事件翻译为 DSH 内部 StreamChunks：

| pi-ai 事件 | DSH chunk type | 说明 |
|------------|----------------|------|
| `start` | — | 流开始 |
| `text_start` | `block-start` (text) | L1563-1568 |
| `text_delta` | `text-delta` | L1570-1575 |
| `text_end` | `block-end` (text) | L1577-1588 |
| `thinking_start` | `block-start` (reasoning) | L1590-1595 |
| `thinking_delta` | `reasoning-delta` | L1597-1602 |
| `thinking_end` | `block-end` (reasoning) | L1604-1615 |
| `toolcall_start` | `block-start` (tool-call) | L1617-1630 |
| `toolcall_delta` | `tool-call-delta` | L1632-1641 |
| `toolcall_end` | `block-end` (tool-call) | L1643+ |
| `done` | `usage` + `finish` | 正常结束，携带 usage |
| `error` | `finish` (error/aborted) | 错误结束 |

**Usage 映射**（L1448-1455 `mapUsage`）:

```js
{
  inputTokens:  usage.input,
  outputTokens: usage.output,
  totalTokens:  usage.totalTokens,
  cacheReadTokens:  usage.cacheRead  > 0 ? usage.cacheRead  : undefined,
  cacheWriteTokens: usage.cacheWrite > 0 ? usage.cacheWrite : undefined
}
```

### 2.5 工具调用

DSH 通过 pi-ai 的 `openai-completions` 发送 `tools` 参数。`COMPLETIONS_COMPAT_GATE` 控制行为：
- `requiresToolResultName` (L404): 工具结果是否需要 name 字段
- `requiresAssistantAfterToolResult` (L405): 工具结果后是否需要 assistant 消息
- `supportsMidConvoToolAdditions` (L423): 是否支持中途添加工具

---

## 3. 模型引用映射

### 3.1 Hub 侧模型引用格式

Hub 侧的模型选择以 `{ provider, model }` 二元组表示。

**文件**: `dsh-agent-default-model/lib/index.js:22,41,59`

```js
provider: z.string().required().volatile(),  // L22 — provider 路由名，如 "openai"
// ...
provider: this.config.provider.get(),        // L41 — 读取当前 provider
provider: next.provider,                     // L59 — 更新 provider
```

`provider` 是 pi-ai providers dict 的 key；`model` 是 `profile.models[].id`。

### 3.2 节点侧 modelRef

节点 `profile.models[]` 中每个模型的 `id` 字段（L1044-1045 modelProfile.id）是模型引用：

```js
const modelProfile = z.object({
  id:              z.string().required(),              // L1045
  name:            z.string(),
  input:           z.array(z.union(MODALITIES)),       // L1040
  reasoningEfforts: z.union([z.const(false), reasoningEfforts]), // L1041
  compat:          compatProfile                       // L1042
});
```

**映射关系**:
- Hub 的 `provider` → 节点 `providers` dict key
- Hub 的 `model` → 节点 `providers[provider].models[].id`
- 查找路径: `profiles.get(provider).piProvider.getModels().find(m => m.id === model)`

### 3.3 同名模型多 Provider 消歧

Provider 路由名（`providers` dict key）是命名空间。两个 provider 可以各有同名模型而不冲突：
- `providers["openai"].models.find(m => m.id === "gpt-4o")` 与 `providers["hub"].models.find(m => m.id === "gpt-4o")` 互相独立
- `buildProvider(spec)` (L927-939) 为每个 provider 路由创建独立 pi-ai Provider 对象

### 3.4 Catalog 合并

节点模型目录来自两个来源：

| 来源 | 机制 | 优先级 |
|------|------|--------|
| Hub 下发（config-push） | 写入节点 settings → `resolveProfiles()` 加载 → `buildProvider()` 注册 | 覆盖同名本地 provider |
| pi-ai 内置 catalog | `PROVIDER_DATA` (L2700-2870)，30+ provider | 只在 profile 未指定 `api` 且名称匹配时复用 |

Hub 下发的 providers dict 整体覆盖同名本地 provider；未下发的 provider 保留本地配置。

---

## 4. 凭据管理

### 4.1 Hub 侧凭据存储

**文件**: `dsh-api-settings-controller/lib/index.js:90-208 CredentialsController`

Hub 侧的 API key 通过 DSH CredentialsController 管理：
- `describe(refs)` (L157): 查询凭据状态（不返回明文值）
- `set(ref, value)` (L174-176): 设置凭据（写入 DSH secrets store）
- `unset(ref)` (L184-187): 删除凭据

凭据以 `credentialRef` 形式引用（`z.string().role("credential-ref")`，dsh-llm-pi-ai:1051），不内联在配置中。

实际读取路径（dsh-llm-deepseek-api-key:53-65 `resolveApiKey`）：
1. 从 `credentialRef` → DSH secrets store 读取
2. 回退到环境变量

### 4.2 节点侧凭据约束

**凭据不经过 pi-ai 模块存储**（dsh-llm-pi-ai:810-813 注释）：

> "Credentials never reach this module's storage: the harness resolves a route's key through `ctx.credentials` before the request enters pi-ai and hands it over as a stream option"

`harnessApiKeyAuth` (L863-871) 在请求时通过 `ctx.credentials` 解析凭据，结果通过 stream option 传给 pi-ai，不缓存。

### 4.3 绝不下发的字段

| 字段 | 存储位置 | 下发到节点 | 原因 |
|------|----------|-----------|------|
| 上游 provider `apiKey` | DSH secrets store（hub 侧） | ❌ | 节点不直连上游，不需要 |
| 上游 provider `baseURL` | hub 配置 | ❌ | 节点只连 hub 网关端点 |
| `apiKeyEnv`（上游凭据引用名） | hub 配置 | ❌ | 节点用 hub 网关 token 认证 |
| 自定义 `headers` | hub 配置 | ❌ | 节点请求发往 hub 网关，hub 负责转发头 |
| 模型列表 `models[]` | hub 配置 | ✅ 应下发 | 节点需要知道可用模型 ID 与能力 |
| `defaultContextWindow` / `defaultMaxTokens` | hub 配置 | ✅ 建议下发 | 节点发起请求时需要这些参数 |

**Hub config-push 应下发的最小 provider 配置**:

```json
{
  "providers": {
    "hub": {
      "api": "openai-completions",
      "baseURL": "https://hub-gateway.example.com/v1",
      "models": [
        { "id": "[REDACTED]", "name": "Claude Sonnet 5.5", "input": ["text","image"] },
        { "id": "deepseek-chat",     "name": "DeepSeek Chat",      "input": ["text"] }
      ]
    }
  }
}
```

节点凭据（hub 网关 token）通过独立安全通道下发（节点 token），不放在 config-push 的 providers 里。

---

## 5. 失败与降级

### 5.1 错误码映射

**文件**: `dsh-llm-pi-ai/lib/index.js:1457-1468 classifyPiAiError`

> 检查按**代码顺序**执行，先命中先返回（L1457-1468）。

| 优先级 | 上游 HTTP 状态 / 错误 | 分类码 | 触发条件 |
|--------|----------------------|--------|---------|
| 1 | 余额/配额耗尽（含 402、余额字样） | `QUOTA_EXCEEDED` | `isQuotaExceededError(message)` (L1458)，先于所有 HTTP 码检查 |
| 2 | 401 | `AUTH` | `/\b401\b/` (L1459) |
| 3 | 403 | `FORBIDDEN` | `/\b403\b/` (L1460)，**403 独立为 FORBIDDEN，非 AUTH** |
| 4 | 429 / rate limit | `RATE_LIMIT` | `/\b429\b\|rate.?limit/i` (L1461) |
| 5 | 413 / payload too large | `INVALID_REQUEST` | `/\b413\b\|payload too large/i` (L1462) |
| 6 | 400 / invalid request | `INVALID_REQUEST` | `/\b400\b\|invalid.?request/i` (L1463) |
| 7 | 5xx | `SERVER` | `/\b5\d\d\b/` (L1464) |
| 8 | timeout | `TIMEOUT` | `/\btime(?:d)?\s*out\b/i` (L1465) |
| 9 | stream ended prematurely | `TRANSPORT` | `/stream ended (?:before\|without)\b/i` (L1466) |
| 10 | network / connection / ECONN* | `TRANSPORT` | `/\b(?:network\|connection\|socket\|fetch)\b/i` (L1467) |
| 11 | 其他 | `PI_AI_ERROR` | 默认分支 (L1468) |

**文件**: `dsh-llm/lib/index.js:2436` 导出的规范错误码常量：

| 常量 | 说明 |
|------|------|
| `ACCOUNT_QUOTA_EXCEEDED_CODE` | 账户配额耗尽 |
| `CONTEXT_WINDOW_EXCEEDED_CODE` | 上下文窗口溢出 |
| `EMPTY_RESPONSE_CODE` | 空响应（stop 但无内容） |
| `INVALID_CREDENTIAL_CODE` | 凭据无效 |
| `QUOTA_EXCEEDED_CODE` | 配额超限 |
| `IMAGE_OFFLOAD_REQUIRED_CODE` | 需要图片卸载 |

### 5.2 Finish Reason 映射

**文件**: `dsh-llm-pi-ai/lib/index.js:1480-1533 mapStopReason`

| pi-ai stopReason | DSH finish kind | 错误码 |
|-----------------|-----------------|--------|
| `stop` + 有内容 | `stop` | — |
| `stop` + 无内容 | `error` | `EMPTY_RESPONSE` |
| `length` | `max-tokens` | — |
| `toolUse` | `tool-calls` | — |
| `error` + overflow 特征 | `error` | `CONTEXT_WINDOW_EXCEEDED` |
| `error` + 其他 | `error` | classifyPiAiError 结果 |
| `aborted` | `aborted` | `ABORTED` |
| `pending` / `deferred` | `error` | `PI_AI_ERROR` |

### 5.3 网关不可达 / 超时

- `fetch` 抛出网络错误 → 分类为 `TRANSPORT`（L1467）
- 超时 → 分类为 `TIMEOUT`（L1465）
- 错误通过 `adapterFailureChunk`（dsh-llm:2409-2420）包装为 `{type:"finish", reason:{kind:"error", failure:{message,code}}}` 传递给 agent-loop
- agent-loop 收到 error/aborted finish（dsh-agent-loop:923-938）：
  - 写入 `assistant/attempt`（非 `assistant/message`）：L924-928
  - catch 块设 `turnEnds = { kind:"error", error:{ message, code } }`（L809-814）；若为 cancel 则 `{ kind:"aborted", reason:cause }`（L803-806）
  - finally 写 `turn/end { turn, reason: turnEnds }`（L819-822）
  - `interrupted:true` **仅在** abort-with-content 分支（L891-905）：`signal.aborted` 且流已有内容时才写 `assistant/message { interrupted:true }`；无内容时写 `assistant/attempt`
- **断言**：断网/超时错误应断言 `turn/end.reason.kind === "error"` 且 `reason.error.code` 为 `TRANSPORT` 或 `TIMEOUT`

### 5.4 节点本地 Fallback

**P1 建议：节点不保留本地 fallback provider。**

理由：
- pi-ai 不自动切换 provider；重试由 `dsh-llm-retry` 的 `RetryPolicy` 控制，不跨 provider
- 保留本地 provider 需要本地 API key，增大凭据泄露面
- P1 目标是所有模型通过 hub 网关，网关不可达时错误应明确可见

如节点仍保留本地 provider（如本地 DeepSeek key）：hub 网关 TRANSPORT 错误不会自动 fallback 到本地 provider；需要用户手动切换模型。

**配置位预留**：P1 在 hub/config-push frame schema 预留 `allowLocalFallback: boolean`（默认 `false`）配置位。P1 不实现自动切换逻辑，但 schema 落地避免 P3 改动 frame 格式。节点收到 `allowLocalFallback: true` 时的行为留 P3 定义。

---

## 6. P1 出口判据

### 测试 1: 节点无凭据时失败明确

**目标**: 验证节点在 hub 网关 token 未设置时，模型请求失败并返回可见错误。

**步骤**:
1. 节点配置只有 hub gateway provider；`apiKeyEnv` 是可选字段（L1051 无 `.required()`），指向一个空 credential-ref（已注册但值为空）或直接省略
2. 发送一条消息触发模型请求
3. 预期链路: `resolveApiKey` 返回 undefined → `harnessApiKeyAuth.resolve()` 返回 `{auth:{}}` → 网关返回 HTTP 401 → `classifyPiAiError` → `AUTH`

**验收标准**:
- finish chunk 的 `failure.code` 为 `"AUTH"` 或 `INVALID_CREDENTIAL_CODE`
- 错误消息含 "401" 或认证失败描述
- 不触发任何本地 fallback model

### 测试 2: 任意已配置模型可跑

**目标**: 验证 hub 下发的每个模型都能通过 hub 网关成功完成一轮对话。

**步骤**:
1. 节点配置 hub gateway provider，models 列表包含至少 2 个不同模型（如 `[REDACTED]`、`deepseek-chat`）
2. 分别选择每个模型发送一条简单消息（如 "hello"）
3. 预期链路: DSH 节点 → hub 网关 → 上游 provider → 流式响应

**验收标准**:
- 流式 `text-delta` chunks 正常到达
- `block-end` + `usage`（含 `inputTokens`、`outputTokens`）+ `finish` (kind: stop) 正常到达
- 两个模型均成功
- 对话页显示 assistant 消息

### 测试 3: 断网错误在对话中可见

**目标**: 验证 hub 网关不可达时，错误信息在节点 agent 对话中可见（不静默失败）。

**步骤**:
1. 节点配置 hub gateway provider，baseURL 指向不可达地址（如 `http://192.0.2.1:9999/v1`）
2. 发送一条消息触发模型请求
3. 预期链路: `fetch` 抛出连接错误 → `classifyPiAiError` → `TRANSPORT` → agent-loop 写 error finish

**验收标准**:
- finish chunk 的 `failure.code` 为 `"TRANSPORT"` 或 `"TIMEOUT"`
- 错误消息含连接失败描述（如 "could not reach"）
- agent-loop 写 `assistant/attempt`（非 `assistant/message`）+ `turn/end { reason: { kind:"error", error:{ code:"TRANSPORT"|"TIMEOUT" } } }`（dsh-agent-loop:809-822）
- 用户在对话页可见错误信息（红色提示或错误气泡）

---

## 附: 文件证据索引

| 主题 | 文件（app.asar/node_modules/@deepseek-ai/） | 行号 |
|------|----------------------------------------------|------|
| profile schema | dsh-llm-pi-ai/lib/index.js | 1050-1082 |
| Config 顶层 | dsh-llm-pi-ai/lib/index.js | 1084 |
| resolveProfiles | dsh-llm-pi-ai/lib/index.js | 1118-1187 |
| buildProvider | dsh-llm-pi-ai/lib/index.js | 927-939 |
| reuseCatalogProvider | dsh-llm-pi-ai/lib/index.js | 909-919 |
| PROTOCOLS 表 | dsh-llm-pi-ai/lib/index.js | 835-838 |
| LISTABLE_PROTOCOLS | dsh-llm-pi-ai/lib/index.js | 2278-2282 |
| discoverModels | dsh-llm-pi-ai/lib/index.js | 2483-2520 |
| listingUrl (OpenAI 用 {baseURL}/models) | dsh-llm-pi-ai/lib/index.js | 2306-2317 |
| harnessApiKeyAuth | dsh-llm-pi-ai/lib/index.js | 863-871 |
| routeAuth | dsh-llm-pi-ai/lib/index.js | 894-901 |
| COMPLETIONS_COMPAT_GATE | dsh-llm-pi-ai/lib/index.js | 397-424 |
| toStreamChunks | dsh-llm-pi-ai/lib/index.js | 1557-1680 |
| mapUsage | dsh-llm-pi-ai/lib/index.js | 1448-1455 |
| classifyPiAiError | dsh-llm-pi-ai/lib/index.js | 1457-1468 |
| mapStopReason | dsh-llm-pi-ai/lib/index.js | 1480-1533 |
| PROVIDER_DATA catalog (30+ providers) | dsh-llm-pi-ai/lib/index.js | 2700-2870 |
| Credentials never in pi-ai storage | dsh-llm-pi-ai/lib/index.js | 810-813 (comment) |
| AgentDefaultModelConfig | dsh-agent-default-model/lib/index.js | 22, 41, 59 |
| CredentialsController | dsh-api-settings-controller/lib/index.js | 90-208 |
| resolveApiKey | dsh-llm-deepseek-api-key/lib/index.js | 53-65 |
| normalizeApiKey | dsh-llm/lib/index.js | 501 |
| LlmAdapter (base class) | dsh-llm/lib/index.js | 1670 |
| registerConfigurableProviders | dsh-llm/lib/index.js | 1919 |
| Error codes export | dsh-llm/lib/index.js | 2436 |
| adapterFailureChunk | dsh-llm/lib/index.js | 2409-2420 |

---

## 待验证项

1. **（DEFER → S1 实测）** hub 网关最小请求字段集：本文档基于 `COMPLETIONS_COMPAT_GATE` 推导。pi-ai 实际发送的 HTTP 请求体需在 S1 中用网络抓包确认，特别是 `reasoning_effort`、`stream_options`、`tools` 的确切格式。
2. **（DEFER → S1 实测）** 节点配置 hub gateway provider 后，主控 `modelCatalog` API 是否正确返回 hub provider 的模型列表（供建 Bot 时选型用）。
3. **（DEFER → P2）** hub 网关是否需要实现 `/v1/models` 端点用于动态发现。P1 用手动声明 models，P2 建议实现以支持运行时更新。
