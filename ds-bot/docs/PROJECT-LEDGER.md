# DS-Bot 项目推进台账

> 最近更新：2026-11-21（fork.86 发布后）
> 基线对比：v0.3.9-fork.74（线上正常版本）

## 一、发布历史

| 版本 | 状态 | 说明 |
|---|---|---|
| fork.65-fork.74 | ✅ 正常 | 线上运行基线，joined/remote 模块完整 |
| fork.75-fork.85 | ❌ 不可用 | 在错误树上持续打补丁，D1-D4 四处回退 |
| **fork.86** | ✅ 已发布 | 修复 D1-D4，四项自检全通过 |

### fork.75-85 缺陷根因
发布树与线上 fork.74 是两条不同血统：fork.75+ 建立在更旧的树上，丢失 18 个 joined/remote 模块。

### fork.86 修复清单
| 缺陷 | 文件 | 修复内容 | 自检 |
|---|---|---|---|
| D1 致命 | `index.js` | 恢复 18 个 joined/remote 模块，MODULES 56→74 | `grep joinedTurn` ✓ |
| D2 致命 | `src/host/store.js` | 接受 state version 1 或 STATE_VERSION(2) | `grep STATE_VERSION` ✓ |
| D3 | `package.json` | files 加入 `src/gateway/` | `npm pack \| grep gateway/index.js` ✓ |
| D4 | `src/host/memory-entries.js` | 导出 fitSnapshot + cutSection + SNAPSHOT_TRUNCATED | `grep fitSnapshot` ✓ |

**发布资产**：`ds-bot-0.3.9-fork.86.tgz`（1.8M，sha256: `3b69ae23...`）
**Release**：https://github.com/alienip2023/DS-Bot/releases/tag/v0.3.9-fork.86
**分支**：`release/fork.86`（从 `release/fork.63` 重新建立，指向同一 HEAD `9d048db7`）

---

## 二、功能完成度

### 已完成功能（fork.74 基线上扩展）

| 功能 | 模块 | 文件 | 状态 | 符号验证 |
|---|---|---|---|---|
| joined/remote 模块 | 18 个模块 | `index.js` MODULES | ✅ fork.86 修复 | MODULES=74 |
| 用户消息排队/插队 | joined-prompt | `src/host/joined-prompt.js` | ✅ | joinedUserQueue/isBusy/steer 15处 |
| group round hooks | joined-turn | `src/host/joined-turn.js` | ✅ | touchRoomTurn/failRoomTurn |
| 组聊状态一致性 | groups | `src/host/groups.js` | ✅ | sessionLiveTurn/joinedInFlight 11处 |
| joined bot statusOf | handoffs | `src/host/handoffs.js` | ✅ | joinedInFlight 2处 |
| flushLateReplies 排空队列 | executor | `src/host/executor.js` | ✅ | joinedUserQueue 2处 |
| joinedAsync relay 标记 | delivery | `src/host/delivery.js` | ✅ | joinedAsync 2处 |
| working 状态写入 | tools | `src/host/tools.js` | ✅ | working 26处 |
| joined bot running 状态 | channel | `src/host/channel.js` | ✅ | running:true 2处 |
| relay bubble 隐藏 | text | `src/client/text.js` | ✅ | isRelayContext |
| schedule_bot 工具 | tasks | `src/host/tasks.js` | ✅ | 13处引用 |
| bot_connect 工具 | tasks | `src/host/tasks.js` | ✅ | Connected Apps 集成层 |
| task_token 凭证代理 | tasks + credential-interceptor | `src/host/tasks.js` + `credential-interceptor.js` | ✅ | installCredentialInterceptor 已接线 (tasks.js:527) |
| Bot Market UI | client | `src/client/market.js` (121行) | ✅ | MarketPage 已在 settings.js 注册 |
| Connected Apps 页面 | client | settings.js `bot-connect` | ✅ | 已在 SETTINGS_PAGES |
| Credentials 页面 | client | settings.js `credentials` | ✅ | 已在 SETTINGS_PAGES |
| deepseek-services | host | `src/host/deepseek-services.js` | ✅ | 在 MODULES |

### dsh-ai-cluster 协同

| 功能 | 文件 | 状态 | 说明 |
|---|---|---|---|
| bot/steer 帧处理 | `lib/bot-steer.js` | ✅ 已创建 | handleBotSteerFrame |
| node dispatch BOT_STEER | `lib/node/dispatch.js` | ✅ 已有 | case HUB_TO_NODE.BOT_STEER |
| plugin dispatch BOT_STEER | `lib/plugin/task-run/dispatch.js` | ✅ fork.86 修复 | 之前缺失，已补 |
| BOT_STEER 协议常量 | `lib/protocol.js` | ✅ | BOT_STEER: 'bot/steer' |

---

## 三、待办事项

| # | 事项 | 优先级 | 说明 |
|---|---|---|---|
| 1 | 推 main 分支 | 中 | `origin/main` 当前是旧树（joinedTurn=0）；需把 release/fork.63 合并到 main |
| 2 | 节点灰度升级验证 | 高 | 7 台坏节点（node001/002/003/004/006/007/008）升级 fork.86 后用 message_bot 探针验证 joined>0 |
| 3 | dsh-ai-cluster 推送发布 | 中 | bot-steer 修复已提交到 release/0.4.6，需推 origin |
| 4 | 发布前自检脚本固化 | 中 | 把 §2 D5 的 6 条自检写入 CI 或 pre-release 脚本，防止再次回退 |

---

## 四、自检脚本（发布前必跑）

```bash
cd ds-bot

# D1: joinedTurn 必须在 index.js
grep -q "host/joined-turn.js" index.js || { echo "D1 FAIL"; exit 1; }

# D1: MODULES 数量 ≥ 69
node -e 'const s=require("fs").readFileSync("index.js","utf8");
const n=s.match(/const MODULES\s*=\s*\[([\s\S]*?)\]/)[1].split(",").filter(Boolean).length;
if(n<69){console.error("D1 FAIL: MODULES="+n);process.exit(1)}'

# D2: store.js 必须接受 version 2
grep -q "STATE_VERSION" src/host/store.js || { echo "D2 FAIL"; exit 1; }

# D3: tarball 必须含 gateway
npm pack --dry-run 2>&1 | grep -q "src/gateway/index.js" || { echo "D3 FAIL"; exit 1; }

# D4: fitSnapshot 必须导出
grep -q "export function fitSnapshot" src/host/memory-entries.js || { echo "D4 FAIL"; exit 1; }

echo "ALL CHECKS PASS"
```

---

## 五、节点恢复步骤

```bash
# 在每台坏节点（fork.76）上执行
P=/root/.dsh/profiles/web

# 1. 备份
cp -r $P/node_modules/ds-bot $P/node_modules/ds-bot.bak

# 2. 替换
npm --prefix $P install ds-bot-0.3.9-fork.86.tgz

# 3. 重启
systemctl restart dsh-worker.service

# 4. 验证
journalctl -u dsh-worker.service --since "-60s" | grep -iE 'ds-bot|SyntaxError|newer DS Bot'

# 5. 派单探针（在 hub 上）
# message_bot → 节点 bot，确认 joined>0
```
