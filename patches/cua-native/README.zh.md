# 电脑操控原生补丁

一条命令把「电脑操控」从 `missing` 修到能加载。不改 `app.asar`，也不把 `@deepseek-ai/*` 拷进 ds-bot 插件目录。

```bash
node patches/cua-native/install-cua-native.mjs
```

脚本会自己带上 `ELECTRON_NO_ASAR=1` 重新拉起。想先看会做什么：

```bash
node patches/cua-native/install-cua-native.mjs --dry-run
```

指定 profile 或家目录：

```bash
node patches/cua-native/install-cua-native.mjs --profile web
node patches/cua-native/install-cua-native.mjs --dsh-home "$DSH_HOME" --profile web
```

## 根因

`app.asar` 里的 `@deepseek-ai/dsh-experimental-cua-macos` 带了 Swift 源码（`native/Package.swift`、`native/Sources`），但 `native/bin` 是空的，预编译二进制没随包发。

`lib/index.js` 的 `prepareNativeExecutable` 只有 `isSourcePackage()` 为真才调用 `xcrun swift build`。`isSourcePackage()` 要求包目录往上三级是名为 `@deepseek-ai/dsh-root` 的源码 checkout，并且路径正好是 `packages/experimental/cua-macos`。装进 profile 或 asar 的副本不满足这个条件，于是直接 `access(native/bin/darwin-<arch>/dsh-cua-native, X_OK)`。文件不在，提供方就报 `missing`，明细是二进制 `not found in app.asar`。

npm 上的同名包更旧，不能拿来顶。

## 为什么放在 profile 的 node_modules

桌面用 `harness-node-entry.mjs` 拉起，profile boot 不传 `bareModuleBaseUrl`。`loader.import('@deepseek-ai/dsh-experimental-cua-macos')` 的第一次解析锚点是 `<profile>/cordis.yml`，也就是从该 profile 的 `node_modules` 往上找。

`host-module-fallback.mjs` 先走这次普通解析。只有包名以 `@deepseek-ai/` 开头，并且错误码是 `ERR_MODULE_NOT_FOUND`，才用 `app.asar` 里的 dsh 入口再解析一次。所以副本必须放在 profile 的 `node_modules/@deepseek-ai/` 下，解析才会先命中它，不再掉进没有二进制的 asar 包。

## 脚本做什么

1. 只读打开 `/Applications/DSH Desktop.app/Contents/Resources/app.asar`。数据区基址是 `8 + readUInt32LE(4)`。
2. 提取 `@deepseek-ai/dsh-experimental-cua-macos` 整包到临时目录。
3. 执行 `xcrun swift build --package-path native --configuration release --product dsh-cua-native --arch <本机架构>`。
4. 把产物放到副本的 `native/bin/darwin-<arch>/dsh-cua-native` 并 `chmod 755`。不把 `native/.build` 装进 profile。
5. 整包装到目标 profile 的 `node_modules/@deepseek-ai/`。
6. 用 `createRequire(<profile>/cordis.yml)` 确认解析落在这份副本，并且 `access(X_OK)` 通过。

路径不写死某一台机器：app 路径从 `/Applications/DSH Desktop.app` 推导，可用 `--app` 或 `DSH_APP_ASAR` 覆盖。`DSH_HOME` 取环境变量，否则用 `~/Library/Application Support/dsh-desktop/harness`。`--profile` 可给 profile 名或绝对路径；省略时先看正在跑的进程命令行里有没有 `<DSH_HOME>/profiles/<name>/`，没有再在只剩一个带 `cordis.yml` 的 profile 时用它。`desktop-safe-mode` 不优先。

幂等：副本已在，且这次记录的二进制 sha256、源码指纹和包指纹都与这次 asar 提取一致，就打印 `action: skip`，不重新编译，也不覆盖副本。这个 sha256 只用来认出同一份已装二进制，不是跨机器、跨编译批次的固定摘要。同一份源码已经编译过时，复用 `DSH_HOME/.cache/cua-native/` 里的产物，避免再跑 swift。

失败时脚本会尽量把刚换上的目录改回去或删掉，并打印回滚提示。手动回滚：

```bash
rm -rf "$DSH_HOME/profiles/<profile>/node_modules/@deepseek-ai/dsh-experimental-cua-macos"
```

删掉之后，解析重新落到 asar，现象回到 `missing`。

## 怎么算通过

通过不看某一份固定 sha256。同一次源码、不同编译批次，哈希可以不同。脚本这次编出来的和先前手放的那份不一样，是正常的，不能拿其中一份当标准答案，也不能因此覆盖正在用的二进制。

同时满足下面四条才算通过：

- 产物是 Mach-O arm64。
- `access` 的 `X_OK` 通过。
- `swift build` 退出码为 0。复用缓存时，那一次编译的退出码已经是 0。
- `createRequire(<profile>/cordis.yml)` 解析到副本的 `lib/index.js`，不是 `app.asar`。

打印出来的 sha256 只是这次二进制的记录，用来判断同一份副本要不要跳过重编译。它不是验收口令。

## 装完之后

脚本不重启 DSH。正在跑的进程可能已经缓存了 asar 里的失败模块。用户重启后，`loader.import` 才会命中这份副本，`prepareNativeExecutable` 的 `access()` 通过，随后才会 `setProviderStatus({state:'ready'})`。没重启之前，不能把界面当成已经 ready。

辅助功能和屏幕录制这两项 TCC 权限脚本授不了，要用户自己在系统设置里点开。

以后在这个 profile 跑 `pnpm install` 可能清掉这份不在 lockfile 里的副本。清掉之后再跑本脚本即可。

## 红线

- 不打印凭证。
- 不写 `app.asar`，只读打开。
- 目标路径里出现 `ds-bot` 或 `ds-bot+` 时直接拒绝，避免把 `@deepseek-ai/*` 拷进 ds-bot 插件目录。
