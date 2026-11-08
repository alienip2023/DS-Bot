# 1A-5 证据：revision 等值比较修复

## 提交

| 仓库 | commit | 版本 | 父提交 |
|------|--------|------|--------|
| ds-bot | de964533 | 0.3.1-fork.36 | 549e2067 |
| dsh-remote-agent | 860cb16e | 0.10.1-fork.49 | be65502 |

## ds-bot — 测试套件（本机 macOS，2026-11-08）

命令：
```
cd /private/tmp/ds-bot-docs/ds-bot
node --test test/gateway/gateway.test.js test/gateway/proxy.test.js test/gateway/config-source-gateway.test.js test/gateway/wiring.test.js
```

结果：37/37 pass，0 fail

套件分项：
- gateway.test.js: 12/12
- proxy.test.js: 11/11
- config-source-gateway.test.js: 5/5
- wiring.test.js: 9/9（1A-5 新增 error-isolation sub-test）

## ds-bot — 刀

| 刀名 | 切哪行 | 红在哪条断言 |
|------|--------|-------------|
| K-sendpush-sync-catch | src/host/config-source.js: 将 `try { service.sendPush(nodeId) }` 改回 `.catch()` | ✖ error-isolation: sendPush throws for beta, alpha still receives push |
| K-sendpush-no-isolation | 删除 per-node try/catch，改为 `nodes.forEach(nodeId => service.sendPush(nodeId))` | ✖ error-isolation: alpha must still be sent after beta throws |

## dsh-remote-agent — 测试套件（本机 macOS，2026-11-08）

命令：
```
cd /Users/kjclaw/Library/Application\ Support/dsh-desktop/harness/bot/workspace/roster-join-3/dsh-remote-agent
node --test test/config-sync.test.js test/config-sync-request.test.js
```

结果：39/39 pass，0 fail

套件分项：
- config-sync.test.js: 21/21
- config-sync-request.test.js: 18/18（含 1A-5 新增：test 2 改为「相等跳过；更大的 stale hash 必须推」）

命令（节点 dshtest-1，ssh 别名 remote）：
```
ssh remote "cd /root && node --test dsh-remote-agent/test/config-sync.test.js dsh-remote-agent/test/config-sync-request.test.js"
```
节点结果：39/39 pass（与本机一致）

## dsh-remote-agent — 刀

| 刀名 | 切哪行 | 红在哪条断言 |
|------|--------|-------------|
| K-ra-revision-gte | lib/node/config-sync.js:365 `=== appliedRevision` 改回 `>= appliedRevision` | ✖ test 2: appliedRevision=5（stale larger hash）→ stale，但断言要 push |
| K-hub-revision-gte | lib/hub/config-sync.js `=== currentRevision` 改回 `>= currentRevision` | ✖ test 2 in config-sync-request.test.js: stale larger hash → push |

## 时间与机器

- 本机：macOS arm64，2026-11-08 22:10 +0800
- 节点：dshtest-1（ssh remote），Node.js v22，Linux arm64，2026-11-08 22:15 UTC
