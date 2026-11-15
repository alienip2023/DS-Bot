# DS-Bot 远程节点部署教程

> 这份教程写给第一次接触这套系统的人。照着做，能搭出一套「一台主控 + 若干节点」的 Bot 集群：你在主控上分配任务，节点上的 Bot 执行，结果回到主控。
>
> 主控和节点都可以是 Windows、Ubuntu 或 macOS。教程里**不写死任何一台机器的路径**——三个系统的数据目录不一样，每个步骤都先探测、再动手。

最后核验日期：2026-11-15。本教程按当时在跑的版本写：ds-bot `0.3.6-fork.39`、dsh-remote-agent `0.10.1-fork.83`。版本会继续涨，命令里凡是出现版本号的地方，都换成你手头实际拿到的包。

---

## 0. 先搞清楚三样东西

这套系统由三个角色组成。一台机器可以只当其中一个。

| 角色 | 跑在哪 | 干什么 | 必须有公网 IP |
| --- | --- | --- | --- |
| 主控 | 你自己用的那台电脑（桌面版） | 你在这里看所有 Bot、分配任务、看结果 | 不需要 |
| 中继 | 一台有公网 IP 的 Linux 服务器 | 只负责转发。主控和节点都主动连它，所以两边都可以藏在路由器后面 | 需要 |
| 节点 | 任何一台能上网的电脑 | 跑 Bot、执行任务、把结果交回主控 | 不需要 |

数据怎么走：

```
你的主控  ──主动连出──▶  中继（公网 IP，8890 端口）  ◀──主动连出──  节点 1
                                                    ◀──主动连出──  节点 2
```

三个要点：

1. 主控和节点都是**主动向外连**，不需要在你家里的路由器上开端口，也不需要 Tailscale、Headscale 这类打洞工具。
2. 中继不执行任务，也不保存你的文件。它只认一个地址：`ws://<中继 IP>:8890/relay`。
3. 现在用的是明文 WebSocket。认证靠帧里的 token，不靠证书。**不需要域名，也不需要 TLS 证书。** 域名和证书是可选项，见第 9 章。

你需要准备：

- 一台自己用的电脑，装好 [DeepSeek Harness 桌面版](https://github.com/deepseek-ai/deepseek-harness/releases)（Windows / Ubuntu / macOS 都行）。这是主控。
- 一台有公网 IP 的 Linux 服务器，能从外网访问它的 8890 端口。这是中继。腾讯云、阿里云、搬瓦工都可以，系统用 Ubuntu。
- 若干台要跑 Bot 的电脑。可以是云服务器，也可以是家里的机器，系统不限。

---

## 1. 先找到数据目录（每个系统都要做）

后面所有步骤都要用到两个目录。它们在三个系统上的位置不一样，**不要照抄别人机器上的路径**，用下面的命令自己探出来。

### 1.1 两个目录分别是什么

| 目录 | 里面有什么 | 谁用 |
| --- | --- | --- |
| DSH 主目录 | 会话、模型配置、密钥、profile | 桌面版和命令行版共用 |
| harness 目录 | 插件安装位置、插件配置 | 桌面版自己用 |

命令行版（`dsh` 直接跑，没有图形界面）只有 DSH 主目录，没有 harness 目录。桌面版两个都有。

### 1.2 探测命令

DSH 主目录默认是 `~/.dsh`，三个系统都一样。如果你设过 `DSH_HOME` 环境变量，以它为准：

```bash
# macOS / Ubuntu
echo "${DSH_HOME:-$HOME/.dsh}"

# Windows PowerShell
if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
```

harness 目录不能猜。桌面版把它放在 Electron 的 userData 下面，而 userData 的名字取决于你装的是哪个发行包。同一个软件在三台机器上可能分别是 `dsh-desktop` 和 `@deepseek-ai/dsh-desktop`。所以用这条命令问程序自己：

```bash
# macOS / Ubuntu（桌面版装好 dsh 命令之后）
dsh desktop user-data-dir

# Windows PowerShell
dsh desktop user-data-dir
```

它打印出来的那个目录，加上 `harness`，就是 harness 目录。例如打印 `/Users/me/Library/Application Support/dsh-desktop`，则 harness 目录是 `/Users/me/Library/Application Support/dsh-desktop/harness`。

如果 `dsh` 命令还不存在，先在桌面版菜单里点 **Manage dsh Command… → Install**，装完**新开一个终端**再跑。

下面的教程里：

- `<DSH 主目录>` 指上面第一条命令的输出。
- `<harness 目录>` 指 `dsh desktop user-data-dir` 的输出再加上 `/harness`（Windows 上是 `\harness`）。

### 1.3 一份对照（仅供核对，以探测结果为准）

| 系统 | DSH 主目录默认值 | harness 目录常见位置 |
| --- | --- | --- |
| macOS 桌面版 | `~/.dsh` | `~/Library/Application Support/dsh-desktop/harness` 或 `~/Library/Application Support/@deepseek-ai/dsh-desktop/harness` |
| Windows 桌面版 | `%USERPROFILE%\.dsh` | `%APPDATA%\dsh-desktop\harness` 或 `%APPDATA%\@deepseek-ai\dsh-desktop\harness` |
| Ubuntu 桌面版 | `~/.dsh` | `~/.config/dsh-desktop/harness` 或 `~/.config/@deepseek-ai/dsh-desktop/harness` |
| 命令行版（三个系统） | `~/.dsh` | 没有。插件直接装在 `<DSH 主目录>/profiles/web` |

Windows 桌面版和 Ubuntu 桌面版这两行是按 Electron 的规则推出来的，没有在真机上逐项核过。**一律以 `dsh desktop user-data-dir` 的输出为准。**

---

## 2. 部署中继

中继是唯一需要公网 IP 的机器。下面以 Ubuntu 为例。

### 2.1 装运行环境

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

node --version   # 应显示 v22.x
```

### 2.2 放上 dsh-remote-agent 包

把 `dsh-remote-agent-<版本>.tgz` 传到这台机器，比如放到 `/root/`。解压并装依赖：

```bash
mkdir -p /opt/dsh-remote-agent
tar -xzf /root/dsh-remote-agent-*.tgz -C /opt/dsh-remote-agent --strip-components=1
cd /opt/dsh-remote-agent
npm install --omit=dev
```

确认入口在：

```bash
ls bin/dsh-remote-relay.js
```

### 2.3 写一个 token

中继靠 token 识别谁能连上来。主控和每个节点各用一个，互不相同。

```bash
sudo mkdir -p /root/.dsh-remote-agent-relay
sudo tee /root/.dsh-remote-agent-relay/tokens.json >/dev/null <<'EOF'
{
  "hub-1": "换成一串随机字符",
  "node-1": "换成另一串随机字符"
}
EOF
sudo chmod 600 /root/.dsh-remote-agent-relay/tokens.json
```

随机字符可以用 `openssl rand -hex 24` 生成。每增加一个节点，就在这个文件里加一行，然后重启中继（见 2.6）。

**这个文件里的字符串就是登录凭证。不要发到聊天里，不要提交到 git。**

### 2.4 做成开机自启的服务

```bash
sudo tee /etc/systemd/system/dsh-relay.service >/dev/null <<'EOF'
[Unit]
Description=DSH remote relay
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/dsh-remote-agent/bin/dsh-remote-relay.js --port 8890 --host 0.0.0.0
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now dsh-relay.service
sudo systemctl status dsh-relay.service --no-pager
```

`status` 里看到 `active (running)` 就对了。

### 2.5 放行端口

云服务器有两层防火墙，两层都要放行 TCP 8890：

1. 云厂商控制台的安全组，添加入站规则：TCP 8890，来源 `0.0.0.0/0`。
2. 机器自己的防火墙：

```bash
sudo ufw allow 8890/tcp
```

### 2.6 验证

在**另一台机器**上测（在中继自己上面测没有意义，测不到安全组）：

```bash
curl -s http://<中继公网 IP>:8890/healthz
```

返回里有 `ok` 就通了。此刻还没有主控和节点连上来，所以 hub 和 node 的数量是 0，这是正常的。

以后改了 `tokens.json`，执行：

```bash
sudo systemctl restart dsh-relay.service
```

---

## 3. 部署主控

主控就是你每天用的那台桌面版。Windows、Ubuntu、macOS 步骤相同，差别只在第 1 章探出来的路径。

### 3.1 确认桌面版在跑

打开 DeepSeek Harness，能看到 Bot 侧边栏即可。记下它的版本号（菜单 **About DeepSeek Harness**）。

### 3.2 安装 ds-bot 和 dsh-remote-agent

桌面版的插件装在 `<harness 目录>` 下，不在 `<DSH 主目录>` 下。这两个位置不要搞混——装错地方，重启后界面上看不到任何变化。

先拿到两个包：`ds-bot-<版本>.tgz` 和 `dsh-remote-agent-<版本>.tgz`。然后：

```bash
# 下面以 bash 为例。先确认目录真的存在
ls "<harness 目录>/profiles/web/package.json"
```

Windows 上用 PowerShell，把下面的路径写法换成反斜杠。

**这一步会改掉你正在用的插件，装之前先做回滚副本：**

```bash
STAMP=$(date +%Y%m%d-%H%M)
cp -a "<harness 目录>/profiles/web/node_modules/ds-bot" "/tmp/rollback-ds-bot-$STAMP"
cp -a "<harness 目录>/profiles/web/node_modules/dsh-remote-agent" "/tmp/rollback-ra-$STAMP"
cp "<harness 目录>/profiles/web/package.json" "/tmp/rollback-package-json-$STAMP"
cp "<harness 目录>/profiles/web/pnpm-lock.yaml" "/tmp/rollback-lock-$STAMP"
```

然后安装。ds-bot 在桌面版里是一个 `link:` 目录，直接覆盖内容、不要改 `package.json` 里的版本号：

```bash
rm -rf "<harness 目录>/profiles/web/node_modules/ds-bot"
mkdir -p "<harness 目录>/profiles/web/node_modules/ds-bot"
tar -xzf ds-bot-*.tgz -C "<harness 目录>/profiles/web/node_modules/ds-bot" --strip-components=1
```

dsh-remote-agent 走包管理器。改 `package.json` 里的版本号，再装：

```bash
cd "<harness 目录>/profiles/web"
# 把 dsh-remote-agent 的版本改成你拿到的版本，然后
pnpm install
```

装完核验：

```bash
node -p "require('<harness 目录>/profiles/web/node_modules/ds-bot/package.json').version"
node -p "require('<harness 目录>/profiles/web/node_modules/dsh-remote-agent/package.json').version"
```

两个版本号都要和你拿到的包一致。

### 3.3 配置主控

配置文件在 `<harness 目录>/plugins/dsh-remote-agent/config.json`。没有这个文件就新建。内容：

```json
{
  "role": "hub",
  "transportMode": "direct",
  "listenPort": 19387,
  "roots": ["<你允许节点读写的目录>"],
  "relayUrl": "ws://<中继公网 IP>:8890/relay",
  "relay": { "url": "ws://<中继公网 IP>:8890/relay" }
}
```

- `role` 必须是 `hub`。写成 `worker` 这台机器就变成节点了。
- `relayUrl` 和 `relay.url` 两个都写，写同一个地址。漏一个，界面和后台会各认各的。
- `roots` 是你允许远程任务碰的目录。主控自己不跑任务，但派出去的任务要声明工作区，这里填你的项目目录。

token 不写在这个文件里。主控用的 token 是第 2.3 步 `tokens.json` 里 `hub-1` 那一串，填到桌面版的插件设置界面里（**设置 → 远程节点**），不要写进 git 仓库。

### 3.4 重启并验证

**完全退出**桌面版再打开。注意：

- macOS 上点关闭按钮只是隐藏窗口，进程还在。要用 **⌘Q**，或者菜单里的 Quit。
- Windows 上点 × 只是隐藏到托盘，进程还在。要右键托盘图标选 **Quit**。
- Ubuntu 上关闭窗口通常就是退出，但以进程是否还在为准。

验证：

```bash
curl -s http://<中继公网 IP>:8890/healthz
```

现在返回里的 hub 数量应该是 1。主控侧边栏里能看到自己的 Bot，说明主控这一侧好了。

---

## 4. 部署节点

节点是跑 Bot 的机器。一台中继可以挂任意多个节点，每个节点重复这一章。

### 4.1 选运行方式

| 方式 | 适合 | 怎么跑 |
| --- | --- | --- |
| 命令行版 + systemd | Ubuntu 服务器，没有显示器 | 本章 4.2 往下 |
| 桌面版 | Windows / Ubuntu / macOS 的日常电脑 | 和第 3 章一样装插件，配置改成节点（见 4.5） |

两种方式的配置字段完全一样，差别只在插件装在哪：命令行版装在 `<DSH 主目录>/profiles/web`，桌面版装在 `<harness 目录>/profiles/web`。

### 4.2 命令行版：装 dsh

```bash
# Ubuntu
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装 dsh（按 DeepSeek Harness 的发行说明）
npm install -g @deepseek-ai/dsh

dsh --version
```

Windows 上从发行页下载安装包，装完在 PowerShell 里跑 `dsh --version`。macOS 同理。

### 4.3 装两个插件

```bash
mkdir -p ~/.dsh/profiles/web
cd ~/.dsh/profiles/web
npm install /root/ds-bot-*.tgz /root/dsh-remote-agent-*.tgz
```

路径按你实际把包放的位置改。装完同样用 `node -p "require(...).version"` 核两个版本号。

### 4.4 做成开机自启（Ubuntu 服务器）

```bash
sudo tee /etc/systemd/system/dsh-worker.service >/dev/null <<'EOF'
[Unit]
Description=DSH worker
After=network-online.target

[Service]
Environment=DSH_HOME=/root/.dsh
ExecStart=/usr/bin/dsh --profile web --host 127.0.0.1 --port 3080 --no-open
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now dsh-worker.service
```

三个参数不要改：

- `--host 127.0.0.1`：只监听本机。节点不需要对外开端口。
- `--port 3080`：本机端口，和中继的 8890 无关。
- `--no-open`：服务器上没有浏览器，不要尝试打开。

`DSH_HOME` 按这台机器的实际主目录改。用 root 跑就写 `/root/.dsh`，用普通用户跑就写那个用户的主目录。

### 4.5 配置节点

配置文件位置：

- 命令行版：`<DSH 主目录>/plugins/dsh-remote-agent/config.json`
- 桌面版：`<harness 目录>/plugins/dsh-remote-agent/config.json`

内容：

```json
{
  "role": "worker",
  "transportMode": "relay",
  "nodeId": "给这台机器起的名字",
  "roots": ["/这台机器上允许任务读写的目录"],
  "agentMode": true,
  "relayUrl": "ws://<中继公网 IP>:8890/relay"
}
```

- `nodeId` 在所有节点里必须唯一。主控靠它区分机器。起个能看懂的，比如 `office-pc`、`gpu-box-1`。
- `roots` 是这台机器上任务能碰的目录。任务声明的工作区必须落在这里面，否则会被拒绝。
- `agentMode` 设 `true`，节点才能自己跑 Bot。设 `false` 就只会执行单条命令。
- token 用第 2.3 步里这台节点对应的那一串（`node-1`），填在插件设置里。每台节点的 token 不同。

### 4.6 验证节点连上了

重启节点进程后，在任意一台机器上：

```bash
curl -s http://<中继公网 IP>:8890/healthz
```

node 数量应该增加 1。

再看节点自己的日志：

```bash
# Ubuntu 命令行版
journalctl -u dsh-worker.service --no-pager -n 50

# 桌面版（三个系统，日志目录在 userData 旁边）
# macOS: ~/Library/Logs/DSH Desktop/harness.log
# 其他系统以 dsh desktop user-data-dir 的输出为准，日志通常在它的上一级 Logs 目录
```

日志里能看到连上 `8890` 的记录，并且没有反复重连，就通了。

---

## 5. 在主控上看到节点的 Bot

节点连上之后，节点上的 Bot 会自动出现在主控的侧边栏里。这不需要在主控上逐个添加。

前提是两边的版本都够新：

- dsh-remote-agent `0.10.1-fork.33` 及以上才会上报 Bot 名单。
- 要在主控上看到节点 Bot 用的模型，两边都要到 ds-bot `0.3.6-fork.39`、dsh-remote-agent `0.10.1-fork.83`。**只升主控不够**，模型是节点侧生成的。

等一两分钟后，主控侧边栏里应该出现节点的 Bot，名字前面带节点标识。

### 看不到时，按这个顺序查

在**节点那台机器**上：

```bash
# 1. 版本够不够
node -p "require('<插件目录>/node_modules/dsh-remote-agent/package.json').version"

# 2. 有没有在发上报
# 桌面版
grep -c "roster/report" "<日志文件>"
# 命令行版
journalctl -u dsh-worker.service --no-pager | grep -c "roster/report"
```

- 版本低于 `0.10.1-fork.33`：这台机器没有上报功能。升到和主控相同的版本，两边一起升。
- 版本够、计数是 0：节点没在发。查 `config.json` 的 `role` 是不是 `worker`、`relayUrl` 对不对、token 对不对。
- 版本够、计数大于 0：节点在发，是中继没转到主控，或者主控把这台节点屏蔽了。把那段日志发出来查。

---

## 6. 模型配置

主控上配好的模型，节点的 Bot 可以直接用，密钥留在主控，不会发到节点。

在主控的 **设置 → 模型** 里配好 provider 和 key。节点侧边栏里点开一个 Bot，模型栏显示的就是节点上报上来的模型。

一个已知的小问题：如果节点用的模型主控这边没有，聊天页会提示「模型不可用，换一个」。这不影响任务执行，只是主控的模型选择器不认识它。

---

## 7. 分配任务

在主控的侧边栏里点节点的 Bot，直接给它发消息，它就在节点那台机器上执行。

任务能碰的目录受节点 `roots` 限制。让它读 `roots` 之外的路径会被拒绝，这是预期行为，不是故障。

---

## 8. 升级

版本号在涨。升级时记住三条：

1. **主控和所有节点升到同一个版本。** 尤其是 ds-bot 和 dsh-remote-agent 要成对升。只升一边，轻则功能缺失（比如模型栏是空的），重则上报被丢掉。
2. **中继可以落后。** 中继只转发帧，不解析内容。它的版本低于主控和节点是正常的，不必每次跟着升。
3. **升级前做回滚副本**，照第 3.2 步的 `cp -a` 做。出问题把副本拷回去，重启即可。

升级后必须**完全退出**再打开，第 3.4 步的退出方式三个系统各不相同，不要只关窗口。

---

## 9. 可选项（现在不用做）

下面三件事都能做，但当前这套不依赖它们。没做不影响接入、派任务、模型同步。

### 9.1 TLS 证书

现在是明文 `ws://`。谁能抓到你和中继之间的流量，就能看到帧的内容。token 在帧里，所以抓包等于拿到凭证。

换成 `wss://` 线路上就是加密的。代价：

- 域名指向大陆服务器要备案。
- 不备案就得用 IP 证书，或者把中继放到境外。

只有你自己的主控和节点在连时，明文够用。要给别人开入口，或者这台中继要换 IP，再加。

### 9.2 域名

中继认的是 `ws://<IP>:8890/relay`。IP 不变就不需要域名。只有打算加证书，或者 IP 会变、不想每台机器都改配置时，才需要。

### 9.3 Tailscale / Headscale

这是打洞工具，用来让没有公网 IP 的机器互相直连。现在主控和节点都主动连中继，不需要打洞。已经装了可以留着当备用，没装不用装。

---

## 10. 出问题时先收集这四样

不要凭感觉猜。把下面四样发出来：

```bash
# 1. 中继是否通，在任意一台机器上跑
curl -s http://<中继公网 IP>:8890/healthz

# 2. 主控版本
node -p "require('<harness 目录>/profiles/web/node_modules/ds-bot/package.json').version"
node -p "require('<harness 目录>/profiles/web/node_modules/dsh-remote-agent/package.json').version"

# 3. 节点版本（在节点上跑，插件目录按它的运行方式选）
node -p "require('<插件目录>/node_modules/dsh-remote-agent/package.json').version"

# 4. 节点有没有在上报
grep -c "roster/report" "<日志文件>"
```

`healthz` 里 hub 是 0，问题在主控到中继这一段。hub 是 1 但 node 是 0，问题在节点到中继这一段。两边都是 1 但主控看不到 Bot，问题在上报，看第 4 条的计数。
