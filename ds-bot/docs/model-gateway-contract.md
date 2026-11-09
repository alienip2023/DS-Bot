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

**P1 实现（只读）**：`GET /gw/{providerId}/v1/models` 返回 `profile.models` 列表映射（`{data:[{id,object:"model"}]}`），不做动态发现。实现成本：一次数组映射，用于 T1 验收与用户模型选择 UI。

**P2 扩展**：动态发现（调用上游 `/v1/models` 或 `/v1/models`）留 P2。

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

## 行号基线声明

> **本契约所有行号均基于安装版 `DSH Desktop 0.13.2` 的 `app.asar/node_modules/@deepseek-ai/*`。**  
> 工作区 `dev/harness/node_modules` 为 0.2.2-rc.1，行号与行为与安装版存在漂移，**不得用作契约证据**。  
> 下次核对时须先确认读的是 `DSH Desktop.app/Contents/Resources/app.asar`，而非工作区副本。

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
3. **（P1 实现，P2 扩展）** hub 网关 `/v1/models` 端点：P1 实现只读版本（读 `profile.models` 返回静态列表），动态发现（调上游 `/v1/models`）留 P2。


---

## §P1b 全量模型配置同步（主控配好的模型，节点 Bot 在节点上自己跑）

**状态**：设计稿（2026-11-09），待司令复核。**口径**：节点 Bot 的 agent loop / 工具 / 文件都在节点，模型调用由节点直发上游；主控只负责把「已配置好的模型配置」同步到节点。**作废**此前「hub 代跑」两版口径（用户原话「也不是由主控代跑」）。`/gw` 网关只保留给「模型物理上只在主控」的情形（§P1b.4 的 xdpool 账号池、本机 LM Studio piion）。

**基线声明**：DSH 行号为已装 DSH Desktop 0.13.2 app.asar（包版本 0.2.2-alpha.2）；ra 行号为 dsh-remote-agent `0.10.1-fork.53`（`/tmp/ra-pkg53/lib/…`）；ds-bot 行号为本分支（base `e27166f0`）。节点实测对象：`dshtest-1`（linux/x64，DSH 0.2.2-alpha.2，systemd `dsh-worker`）。

### P1b.0 先纠正三个会误导实现的事实

1. **节点已装且已启用 `llm-deepseek-api-key`**（节点 `profiles/web/node_modules/@deepseek-ai/dsh-llm-deepseek-api-key` 存在；节点模型探测日志已列出 `deepseek-official/deepseek-flash`、`deepseek-v4-pro`）。节点 Bot 报 `no API key for provider route "deepseek-official"`（`dsh-llm-deepseek-api-key/lib/index.js:68`）缺的**只有凭据 `DEEPSEEK_API_KEY`**：节点 `.credentials.yaml` refs 现有 `JINA_API_KEY / SILICONFLOW_API_KEY / CCMAX_API_KEY / GATEWAY_TOKEN_dshtest_1`，没有 `DEEPSEEK_API_KEY`、`XAI_API_KEY`。主控 `.credentials.yaml` refs 里三者齐全（只核名称，未核值）。
2. **xdpool 不是 API-key 型 provider**：它是「本机 WorkBuddy 桌面 App 登录态」账号池，token 由腾讯 SSO 铸造并与设备绑定（dsh-xdpool 2.5.1 README「已知限制」第一条），账号存 `~/.dsh/.xdpool/accounts.json`。**不存在可同步的 key**。
3. **FallbacksChain/Auto 在主控当前是空链**：主控 `llm-fallbacks` 条目只有 `roles`，没有 `rootChain`，实测 `FallbacksChain/Auto` 返回 `EMPTY_EFFECTIVE_CHAIN`（主控 xdpool 网关 `127.0.0.1:8326` 502）。链配置本身需先在主控补齐，同步才有意义。

### P1b.1 照搬 vs 我们独有（避免假装有现成实现）

| 项 | 来源 | 内容 |
|---|---|---|
| 跨机共享模型清单 | **我们独有** | OpenMausBot 文档原话 "There is no shared provider list that configures every engine"，其多机是「整台 host 拥有全部 agent/凭据/模型，client 只是 UI」。「主控配好、节点自己跑」没有可抄实现 |
| 清单来自实际执行端 + Re-detect/Refresh，失败保留上次成功目录 | 照搬 | 节点 `model-catalog.js` 已按此做（缓存 + 刷新器）；本方案补「失败保留上次」与 UI 刷新按钮 |
| 每个 openai-compat 端点 = 实例 `{name, baseURL, apiKeyEnv, model}`，key 只发往该 baseURL | 照搬 | 即现有 pi-ai provider 条目；同步只写 `apiKeyEnv` ref 名，值进 `.credentials.yaml` |
| 跨引擎剥离其它引擎 key | 照搬（**已有**） | `ds-bot/src/host/local-agents/discover.js:11-14` `DROP_EXACT` 含 `XAI_API_KEY/OPENAI_API_KEY/ANTHROPIC_*`，CLI 子进程不继承同步下来的 key |
| 实例错误不拖垮其它实例；界面「不可用 + 具体原因」（缺 key / 网络 / HTTP 状态 / 空清单分别提示） | 照搬 | 见 P1b.7 |
| Bot 默认模型与单会话覆盖分开保存，「Agent default」 | 照搬 | 现状：`bot/update{model}` 直接改会话模型（`models.js:234-250`）；本方案不动存储结构，只在 P1b.8 加语义约束，分开保存留 P3 |
| 进程型依赖节点本机已登录 CLI，提示去终端登录，**不同步登录态** | 照搬 | P1b.5 |
| config 0600、key 不进命令行参数 | 照搬（**已有**） | ra `atomicWriteSecure`（`config-sync.js` 写 0600）；CLI 子进程 key 不走 argv |
| 同步 provider 配置 + key 到节点、节点按指纹重启 | **我们独有**（已有 M2 实现） | 本方案在其上扩展 |
| 插件条目（llm-deepseek / llm-fallbacks）同步、凭据所有权与撤销、CLI 期望清单 | **我们独有**（新增） | P1b.2 / P1b.5 |

### P1b.2 同步载荷 v2（`hub/config-push`，向后兼容）

现状：载荷 `{revision, providers[{id,baseURL,apiKey,apiKeyEnv,api,models[{id,name}]}], defaultModel}`；节点 `mergePatch`（ra `lib/node/config-sync.js:208-231`）**只替换 `- id: llm-pi-ai` 条目**，模型被裁成 `{id,name}`（:220），整张 providers 表每次整体替换。

新增字段（均可缺；旧节点按未知字段忽略，旧 hub 不发）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema` | `2` | 载荷版本；节点回执 `hub/config-ack` 增 `schema`，hub 据此判断节点是否理解 v2 |
| `providers[].models[]` | `{id,name,contextWindow?,maxTokens?,input?,reasoningEfforts?}` | **补全**每模型字段（今天被裁掉，导致节点上下文窗口/思考档/图片能力全靠默认值） |
| `providers[].compat / displayName / streamIdleTimeoutMs / headers?` | 对象/标量 | pi-ai profile 的同名字段（`dsh-llm-pi-ai/lib/index.js:1050-1082`）；`headers` 若含密钥则**不同步**并在 UI 标「含自定义头，需节点手配」 |
| `providers[].catalog` | `true` | pi-ai 内置目录 provider（如 `xai`，主控 patch 里没有 `api/baseURL`）：只下发 `apiKeyEnv`+key+模型覆盖，节点走 `reuseCatalogProvider`（`dsh-llm-pi-ai/lib/index.js:909-919`）。**此项属 fork.64 范围，本方案不重复实现，只约束字段名** |
| `plugins[]` | `[{entryId, name, config, credentialRefs:[{ref, apiKey}]}]` | **新增**：非 pi-ai 的插件配置条目，见 P1b.3/4。`entryId` 白名单仅 `llm-deepseek`（第 1 片）、`llm-fallbacks`（第 4 片）；其它 id 节点一律拒收 `plugin-not-allowed` |
| `cliExpect[]` | `string[]` | 主控期望存在的进程型路由，如 `["claude-code","codex-cli"]`；**只用于界面比对，不触发安装** |

**版本兼容**：节点在 `hello/node` 的 `caps` 增 `config-sync/2`（现 `CAPS = ['fs','exec','artifact','agent']`，ra `lib/node/index.js:103`，hello 追加项见 `:389`、`:1268`）。hub 仅对带该 cap 的节点发 `schema:2`；其余节点继续发 v1。`BOT_UPDATE`、`BOT_CREATE` 帧不变。`CONFIG_PUSH` 已在 E2E 必加密集合（§3.2），含 key 的新字段随同一帧，**无需新增明文帧**。

**配置来源（hub 侧，`config-source.js`）**：`buildConfigPayload(rt,…)`（:93）今天遍历 `ctx.llm.listConfigurableProviders()`，并要求 `profile.api` 为字符串、`apiKeyEnv` 合法、key 在 refs 里（:112）；因此 `deepseek-official`（其 `llm-deepseek-api-key` 配置无 `api` 字段）被整类跳过，`LOCAL_CLI_PREFIX`（:102）跳过进程型。v2 新增并列分支：对白名单 `entryId`，从 `settings.describe({redactSecrets:true})` 取该条目配置并**按字段白名单裁剪**（见下），key 由 `.credentials.yaml` refs 取，沿用现有 `readRefsFile`。

### P1b.3 逐类实现方案

| 类 | 主控配置位置 | 节点现状 | 同步什么 | 节点怎么落 | 缺口与补法 |
|---|---|---|---|---|---|
| **pi-ai 各 provider**（jina/siliconflow/ccmax/xai；piion 走网关） | `llm-pi-ai.config.providers` | 已有 4 个，key 已同步；缺 `XAI_API_KEY` | 现有字段 + 补全模型字段/compat；xai 为 catalog 型 | 沿用 `mergePatch` 的 pi-ai 条目；buildPatchEntry（:242）扩写补全字段 | 模型字段补全靠 ra 改（:220），第 2 片；`piion` 仍 `gateway:true` 走 `/gw`（物理在主控） |
| **deepseek-official** | `llm-deepseek` 条目（`name: @deepseek-ai/dsh-llm-deepseek-api-key`），key 为 ref `DEEPSEEK_API_KEY` | 插件已装已启用；缺 key；节点 patch 无该条目（用包默认） | 条目 `config` 白名单：`models[]`、`thinking`、`reasoningEffort`、`maxTokens`、`defaultContextWindow`、`streamIdleTimeoutMs`、`retryPolicy`；`baseURL` **仅当非官方源时**同步；凭据 ref `DEEPSEEK_API_KEY` | 新增通用「受管条目替换」：只替换同 `entryId` 条目（保留其它条目与注释），不再只认 `llm-pi-ai` | **第 1 片**。仅缺 key + 可选配置，节点无需装新插件 |
| **xdpool / xdpool-global（账号池）** | `llm-xdpool`（含 `automation*` 签到/收益账本） | 未装 `dsh-xdpool`；节点是无桌面 Linux，无法登录 WorkBuddy 桌面 App | **不同步任何 xdpool 配置**（`automation`、`automationEarnings` 是主控独有的账号积分状态，含账号 id，绝不下发） | 走 `/gw`：节点登记合成 provider `xdpool-hub`（`api: openai-completions`，`baseURL: http://<gwHost>:<port>/gw/xdpool-hub/v1`，`apiKeyEnv` 为节点网关 token） | 这是「物理上只在主控」的**唯一正当例外**：设备绑定 SSO，无可迁移凭据。网关上游指向主控 xdpool 本地网关 `127.0.0.1:8326`（OpenAI 兼容，实测 SSE/`tool_calls`/`usage` 齐全）。网关须补：①按 `body.model` 前缀白名单（`xdpool/`、`xdpool-global/`、`xdpool-aggregate/`、`xdpool-free/`）②上游 502+`code` 归一化（`QUOTA→402`，`session_dead→503`）③审计行（节点、模型、状态、首包耗时、token 数，不含内容）④并发上限。**上游 key 文件** `…/harness/openai-gateway/api-key`（0600）只由主控网关读取，绝不下发。路径解析方式 未核实 |
| **xdpool-aggregate / xdpool-free（聚合渠道）** | `~/.dsh/.xdpool` 下各厂商 API key，仅「填了 key 才启用」 | 无 | 优先同走上面的 `/gw/xdpool-hub`（同一 8326 网关已含这些前缀，零额外工作）；纯 API-key 厂商后续可改为「实例同步」让节点直连 | 第 3 片先走网关；直连实例化需读 `.xdpool` 存储格式（**未核实**），列后续片 | 无 |
| **FallbacksChain/Auto** | `llm-fallbacks`（现仅 `roles`，**无 `rootChain`**） | 节点**未装** `dsh-llm-fallbacks` | `plugins[]` 条目 `llm-fallbacks` 的 `rootChain/timeSlots/roles/rules` | **不展开成 provider，也不在网关里解析**：链是插件行为（失败时沿链切换并继续当前 step），必须在发起调用的那一侧，即节点。网关解析会让链在主控跑、占主控额度，违背「节点自己调上游」 | ①主控先配 `rootChain`（尾项须恰为一个官方模型）；②节点缺插件 → ra 目前无「装插件」帧，**补法二选一**：人工 `dsh plugin add dsh-llm-fallbacks`（界面给命令与「复制」），或 P2 新增 `plugin/install` 白名单帧；③链成员只有节点也有 provider+key 才可走，同步时由 hub 计算「链成员在节点是否齐备」，缺哪个在界面点名 |
| **claude-code / codex-cli** | 主控本机 CLI，`local-agents` 适配器（`ctx.llm.registerAdapter`，仅对找到的 CLI 注册路由，`local-agents/index.js:104-115`） | 节点未装 `claude`/`codex` | 不同步登录态与 key；只同步 `cliExpect[]` | 节点装 CLI 后，`local-agents` 的 `scan()` 自动注册路由，无需同步任何东西 | P1b.5 |

**`deepseek-official` 条目裁剪原则**：只同步「模型怎么用」类字段（白名单，见上表）；图片卸载配额、文件 API 超时等调参项（`dsh-llm-deepseek/lib/index.js:334-342`）不同步，节点用包默认，避免主控/节点版本差异下发不兼容字段。白名单外字段一律丢弃并在日志里只记数量。

### P1b.4 节点落地（ra `lib/node/config-sync.js` 改造）

对账现状与改法（行号为 fork.53）：

| 位置 | 现状 | 改法 |
|---|---|---|
| `mergePatch` :208-231 | 正则只认 `llm-pi-ai`，其它条目原样保留 | 抽成 `replaceManagedEntry(existing, entryId, yaml)`，对白名单 `entryId` 逐条替换/追加；**只动自己管的条目**，其它（`remote-agent` 等）不碰 |
| `buildPatchEntry` :242-275 | 仅写 `apiKeyEnv/api/baseURL/models{id,name}` | 补全模型字段与 compat；标量一律 `JSON.stringify`（沿用防注入写法）；新增 `buildPluginEntry(entry)` |
| `mergeCredentials` :118 | 只增/覆盖 refs，**从不删除** | 在 `config-sync.json` 记 `ownedRefs:[…]`（本机由同步写入的 ref 名）；推送后凡在 `ownedRefs` 而不在新载荷者**删除并从 `ownedRefs` 移除**。节点自配的 ref（不在 `ownedRefs`）永不动 |
| `handleConfigPush` :346-478 | 先写 revision 再写 creds/patch，失败回滚 | 流程不变；回滚快照范围不变（credentials + patch）；新增校验 `plugin-not-allowed / plugin-config-invalid`，校验失败在写盘**之前**返回，不产生半截状态 |
| `scheduleRestart` :319-335 | `systemctl restart --no-block dsh-worker`，仅 Linux/systemd | 抽成 `restartStrategy`：systemd → 现状；非 systemd → **不重启，回执 `shouldRestart:true, restartMode:'manual'`**，界面提示「请重启节点 DSH」。执行机需覆盖 Win/Linux/macOS，这是该项的硬约束 |
| `extractProviderFingerprints` :55 | 指纹含 id+baseURL+apiKeyEnv+keyDigest | 指纹并入 `plugins[]`：`entryId + sha256(白名单 config)[:16] + 各 ref keyDigest` |
| 节点模型上报 `model-catalog.js:6-10` | `MAX_MODELS=64`、每 provider 24、provider 数 8 | 主控清单 65 项，**同步全量后必然被截断**：上限提到 `256 / 64 / 16`，并在上报里加 `truncated:true`（否则界面看到「少了」却不知为什么）。第 2 片随带 |

**重启是否必需（核心未决项）**：ra 注释称「DSH worker 启动时读一次 credentials」，但 `llm-deepseek-api-key` 的 `resolveApiKey`（:60-70）每次请求调 `credentials.resolve(ref)`，节点 profile `patchReload: "live"`。因此「只换 key / 模型清单」**可能不需要重启**，两者矛盾，**未核实**。第 1 片出口判据含一条探针：在 `dshtest-1` 上写入新 key 后不重启直接发一轮，判断热生效边界；若热生效，则 `shouldRestart` 的判定要收窄为「新增/删除 provider 或改 baseURL」。

### P1b.5 进程型 claude-code / codex-cli：节点装 CLI、节点自己登录

结论：**可行但靠节点本机准备**，界面给可执行提示，不静默灰显。

- **节点上报**：复用现有周期帧 `node/resource`（ra `protocol.js:88` `RESOURCE`；字段可缺、旧 hub 忽略；该帧今天已携带 `models`，`node/index.js:734`），增 `cli:[{route, installed:boolean, version:string|null, signedIn:true|false|null, checkedAt:number}]`。数据源是节点 ds-bot 的 `local-agents` `detected()`（`local-agents/index.js:177` 定义，已含 `route/name/path/version/signIn`）；节点侧通过 `ctx.provide('ds-bot:cli-report')` 暴露，ra 与 `readDefaultModel` 同样用 `ctx.get` 读取，**ra 不探测 CLI**。
- **`signedIn` 取值**：目前没有登录态探针，适配器只会在首次调用时抛 `LOCAL_AGENT_SIGNIN`（`local-agents/adapter.js:520`）。故 `signedIn=null`（未知）直到出现过一次 `LOCAL_AGENT_SIGNIN`，此后置 `false` 并保持到下次成功回合；是否存在可无副作用查询登录态的 CLI 子命令，**未核实**，不编造。
- **版本兼容**：新 hub + 旧节点 → 帧里无 `cli` 字段 → 界面显示「节点 ra 版本过低，未上报 CLI 状态（需 ≥ 本方案版本）」，与「未安装」是不同文案；旧 hub + 新节点 → 多余字段被忽略。
- **界面文案（可执行）**：`未安装` →「节点 <名> 还没装 claude-code。点此查看安装步骤」（点开：安装命令 + 复制按钮 + 「装完后点『重新检测』」，检测即触发节点 `local-agent-refresh`，`local-agents/index.js:187`）；`已装未登录` →「在节点终端运行 `<signIn 命令>` 完成登录」（命令取 `SIGN_IN` 表，`local-agents/index.js:18-29`，如 codex/claude）；`已装已登录` → 可选。安装命令文案表维护在 ds-bot，**具体包名与版本以官方文档为准，实现时核对，此处未核实**。
- **限制（须对用户可见）**：进程型自带 agent 循环：其内置 `bash/edit` 由 CLI 自己在节点 `cwd` 内执行，只有 DS Bot 团队工具经 LoopbackMcp 桥接（`local-agents/mcp.js`、`toolsFor` `local-agents/index.js:96-101`）。这与「节点 Bot 的工具」不是一套，节点 Bot 选进程型模型时，工具行为以 CLI 为准；这是进程型本身的特性，不是同步缺陷。节点 `cwd` 取会话 header/Bot workDir（`cwdFor`，:87-95），不会指向主控路径。
- **登录态不同步**（照搬 OpenMausBot）：理由 ①设备绑定 ②同步登录态等于搬运凭据。

### P1b.6 凭据传输与生命周期

- **传输**：`hub/config-push` 在 E2E 必加密集合（§3.2）；无 E2E 不发、不重试明文；E2E 建立后补推（ra fork.50/51 已修，`1A-7`）。
- **日志**：hub/节点日志只记 `provider id` 与数量、`entryId`、`revision`、`keyDigest` 前 16 位（现已如此）；错误文案过 `sanitizeError`（ra `config-sync.js:97`，去 `sk-…` 与 URL）。新增字段不得进错误文案。
- **落盘**：`.credentials.yaml` 0600（`atomicWriteSecure`），原子 rename；revision 文件 0600。key 不进 argv、不进子进程环境（`cleanEnv` 剥离，`discover.js:11-19`）。
- **轮换**：主控 key 变 → 载荷内容哈希变 → revision 变 → 节点覆盖 ref → `keyDigest` 变 → 重启/热生效（见 P1b.4 未决项）。
- **撤销**：当前**缺口**——`mergeCredentials` 永不删 ref，主控删 key 后节点仍留旧 key。补法：`ownedRefs` 所有权表（P1b.4），撤销 = 从载荷里去掉该 ref，节点删除；节点下线时撤销在重连的 `config-sync-request` 流程里补上。**节点本地自配的 ref 永不被同步删除**。
- **网关 token**（`GATEWAY_TOKEN_<node>`）不属于本方案的「模型 key」，沿用 §4，轮换仍属 P2。

### P1b.7 推送时机、生效与界面可见

- **何时推**：①节点上线/重连（现有 `pushOnline`、`config-sync-request`）；②主控配置内容哈希变化（现已按内容哈希算 revision；触发点用「设置变更事件」优先，**事件名未核实**，兜底每 60s 重算一次，哈希未变不发）；③界面「同步到节点」按钮（手动，等同 Refresh）。
- **何时生效**：回执 `ok:true` 后，若 `shouldRestart` 且 systemd → 300ms 后重启（也会终止在途回合，故 hub 在推送前若节点有在途回合，**延后到回合结束**，见 P1b.8 在途表）；非 systemd → `restartMode:'manual'`，界面提示手动重启；热生效见 P1b.4 未决项。
- **失败可见**：hub 为每节点保存 `configSync:{revision, status:'ok'|'pending'|'failed'|'needs-restart', errorCode?, at}`（`errorCode` 取 `snapshot-failed / merge-failed / credentials-write-failed / patch-write-failed / plugin-not-allowed / plugin-config-invalid / e2e-required` 等**代码**，不含任何值），显示在节点行与建 Bot/换模型抽屉顶部：「该节点模型配置未同步成功（原因代码），[重试]」。现状 hub 如何消费 `hub/config-ack` 的失败，**未核实**，第 1 片先核后改。
- **回滚**：沿用写盘前快照 `config-sync.bak/` 与 revision 回退（`rollback` :481）；本方案不改快照范围。校验失败发生在写盘前，不需要回滚。
- **模型清单不一致的呈现**（照搬 a/c）：以节点实际上报为准（`RESOURCE.models`）；hub 端对照主控清单，逐模型给原因：缺 key / 节点缺插件 / 网关未开放 / 空清单 / 节点未上报（旧版）——**不再用单一「不可用」**。清单刷新失败保留上次成功目录并标「X 分钟前」。

### P1b.8 对话中途换模型

- `bot/update{model}` 在节点最终走 `models.js:234-250 applyModel → selectSessionModel`，**立即写会话的模型选择，哪怕回合在途**。`dsh-agent-loop/lib/index.js:671` 的 `preStep` **每个 step** 读 `model.current()`，所以在途回合的**下一步**就会换模型，而不是「下一回合」。原生**不保证**「在途不受影响」。
- v1 约束：hub 在途表（§S2-4 的单 Bot 单在途表）命中时，`bot/update{model}` 直接拒绝 `bot-update-busy`（文案「该 Bot 正在回复，回复结束后再切换模型」）；节点端再校验一道 `live.get(chatOf).turn !== undefined` 防竞态。保证「下一回合起生效、在途回合不受影响」**成立**。
- 校验补强：`joined-page.js:202-211` 目前只验 `modelRef` 的 provider ∈ `listProviders`，不验 model id。同步落地后 provider 集合变大，补验 `model ∈ listModels(provider)`，否则「选了存在但无该模型的 provider」要到发消息才报错。
- 提示缓存：provider/model 切换后上游提示缓存必然失效（整段历史重发）；跨 provider 历史消息格式兼容（如 `reasoning` 块、工具调用 id），**未核实**，真机验收含「同一会话 deepseek→siliconflow→deepseek 各答一轮」。

### P1b.9 分片（风险最大者在前）

| 片 | 改谁 | 做什么 | 完成判据 |
|---|---|---|---|
| **P1b-1（第一片）** | ra + ds-bot | 载荷 v2 骨架 + `plugins[]` 白名单仅 `llm-deepseek` + `replaceManagedEntry` + `ownedRefs` 凭据所有权/撤销 + `caps:config-sync/2` 协商 + 热生效探针 | `dshtest-1` 上建 `deepseek-official/deepseek-flash` 的 Bot，发消息得到回复（不再报缺 key）；节点 `.credentials.yaml` 出现 `DEEPSEEK_API_KEY` 且权限 0600；主控删该 key → 节点 ref 被删；原 4 个 pi-ai provider 不受影响；校验失败路径**必须红**：`plugin-not-allowed`、截断的 YAML 不落盘、写盘失败恢复快照；旧节点（无 cap）收到 v1 载荷行为不变 |
| P1b-2 | ra + ds-bot | pi-ai 模型字段补全（:220）；`compat/displayName/streamIdleTimeoutMs`；节点上报上限提升 + `truncated`；`xai` 与 fork.64 对齐 | 主控 65 项模型在节点清单中按 provider 逐项对得上；`xai` 带 `reasoningEfforts` 的节点 Bot 可选思考档；清单被截断时界面显示 |
| P1b-3 | ds-bot（网关） | `/gw/xdpool-hub`：白名单、错误归一化、审计、并发上限；节点登记合成 provider | 节点 Bot 选 `xdpool/deepseek-v4.1-flash` 得到回复；越权前缀 → 403；上游 `QUOTA` → 402；断开客户端后上游连接关闭（取消）——**上游取消行为 未核实，须真测** |
| P1b-4 | ra + ds-bot | `llm-fallbacks` 条目同步 + 节点装插件的补法（人工命令或 `plugin/install` 帧）+ 链成员齐备度计算 | 主控配好 `rootChain` 后，节点 `FallbacksChain/Auto` 可选；故意让首链路失败 → 节点沿链切到下一个并继续本 step |
| P1b-5 | ra（字段）+ ds-bot（探测与界面） | `node/resource.cli[]` 上报；`cliExpect[]`；界面可执行提示；「重新检测」 | 节点未装 → 显示安装步骤；装好未登录 → 显示登录命令；登录后 → 可选并跑通一轮；旧节点显示「版本过低」而非「未安装」 |
| P1b-6 | ds-bot | `bot-update-busy`、`model ∈ listModels` 校验、`configSync` 状态展示、失败原因文案、`同步到节点` 按钮 | 在途时换模型被拒且文案可读；同步失败在界面看到代码化原因与重试 |

**为什么 P1b-1 排第一、且风险最大**：①它是节点 Bot **当下就报错**的那条（缺 `DEEPSEEK_API_KEY`），价值最高；②它第一次让 ra 的配置合并**脱离「只改 llm-pi-ai」**，改的是整个 `cordis.patch.yml` 的写入逻辑，写坏会让节点 DSH 起不来，所以要把「受管条目替换 + 快照回滚 + 白名单」一次做对，并用必须红的测试钉住；③后续各片复用这套机制。`fork.64`（工程师在做的抽屉/灰显/错误可读/xai 补全）只触及 UI 与 xai，与 P1b-1 无文件冲突，可并行；唯一重叠是 `xai` 的 catalog 字段名，以 P1b.2 表为准。

### P1b.10 本节未核实项

1. 节点热生效边界（P1b.4）：只换 key/模型清单是否无需重启。
2. hub 当前如何展示 `hub/config-ack` 失败；「设置变更事件」名称与触发时机。
3. 主控 xdpool 网关 key 文件路径在 ds-bot 内的解析方式；`.xdpool` 聚合渠道的 key 存储格式。
4. 进程型是否有无副作用的登录态查询命令；各 CLI 官方安装命令的现行写法。
5. 网关取消语义：客户端断开后主控 xdpool 网关是否停止上游生成。
6. 跨 provider 同会话切换的历史兼容。
7. 节点非 systemd 平台（macOS/Windows）重启与热加载的实际行为：本节点实测只覆盖 Linux。
