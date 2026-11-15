# DS-Bot 远程节点部署教程

> 这份教程写给第一次接触这套系统的人。照着做，能搭出一套「一台主控 + 若干节点」的 Bot 集群：你在主控上分配任务，节点上的 Bot 执行，结果回到主控。
>
> 主控和节点都可以是 Windows、Ubuntu 或 macOS。教程里**不写死任何一台机器的路径**——三个系统的数据目录不一样，每个步骤都先探测、再动手。

最后核验日期：2026-11-15。本教程按当时在跑的版本写：ds-bot `0.3.6-fork.43`、dsh-remote-agent `0.10.1-fork.86`。版本会继续涨，命令里凡是出现版本号的地方，都换成你手头实际拿到的包。

一台节点同一时间只走下面三套方案里的一套。换方案只改地址和传输方式，节点的 `roots` 不用动。

**优先级是方案一 > 方案二 > 方案三，不要倒过来。** 能直连就直连；主控和节点不在同一个网络，用大陆的中继机器；只有节点在境外、又必须加密时才走香港。这不是口味问题，是实测：跨境那条长连接会被中途的设备反复掐断，所有节点在几秒内一起掉线，而局域网直连和大陆中继不会。


---

## 0. 先选方案

三套方案用的是同一份软件。差别只在「节点怎么找到主控」。

| | 方案一：局域网 | 方案二：国内 VPS | 方案三：香港 VPS |
| --- | --- | --- | --- |
| 适合 | 主控和节点在同一个局域网 | 节点在别的网络，中继放在大陆 | 节点在别的网络，而且要线路加密 |
| 要不要公网机器 | 不要 | 要一台大陆 VPS | 要一台香港 VPS |
| 谁开端口 | 只给主控开入站 `19387` | 只给 VPS 开入站 `8890` | 只给 VPS 开入站 `80` 和 `443` |
| 地址长什么样 | `ws://<主控局域网 IP>:19387/api/remote-agent/node` | `ws://<大陆公网 IP>:8890/relay` | `wss://<域名>/relay` |
| 要不要域名 | 不要 | 不要 | 要。香港不用备案 |
| 线路加密 | 不需要。流量不出局域网 | 明文。域名指到大陆要备案，所以现在不上证书 | 有。Caddy 自动签证书 |
| 优先级 | **1（首选）** | 2 | 3（备用，实测会反复断线） |

### 0.1 为什么是这个顺序

| | 实测断线情况 | 原因 |
| --- | --- | --- |
| 方案一 | 基本不断 | 流量不出局域网，中间没有任何设备 |
| 方案二 | 连续两天零重连 | 全程在境内，中继只转发帧 |
| 方案三 | 6.5 小时 700 多次重连，每台节点每 4–5 分钟一次 | 跨境段的长连接被中间设备反复打断，客户端断、服务端不知道 |

方案三不是不能跑，是不适合当主力。它的价值在于「人在外面、节点在国内，需要一个跨境入口」；日常放着让它跑，就要接受它每隔几分钟重连一次、每次重连后头几十秒内任务派不下去。

跨境断线的指纹（第 4.4 节有完整判定）：节点日志是 `closeCode=1006`，中继日志里没有 close，只有 `error:"replaced"`；八台在 1.5–2 秒内一起断，间隔不规律。丢包、延迟、中继重启、节点进程重启，这四条都能排除。

数据怎么走：

```
方案一  节点 ──直接拨──▶ 主控:19387

方案二  主控 ──主动连出──▶ 国内 VPS:8890 ◀──主动连出── 节点
方案三  主控 ──主动连出──▶ 香港 VPS:443  ◀──主动连出── 节点
```

方案二和方案三里，主控和节点都是主动向外连，家里的路由器不用开端口。方案一没有中继，节点要能直接访问主控的局域网地址。

三套不要同时当「当前入口」。一台节点配一个地址。要从国内中继换到香港中继，两边的地址一起换，token 可以不动。

你需要准备：

- 一台自己用的电脑，装好 [DeepSeek Harness 桌面版](https://github.com/deepseek-ai/deepseek-harness/releases)。这是主控。Windows、Ubuntu、macOS 都行。
- 方案二或方案三还要一台 Linux VPS。系统用 Ubuntu。
- 若干台要跑 Bot 的电脑。系统不限。

---

## 1. 先找到数据目录（每个系统都要做）

后面所有步骤都要用到两个目录。它们在三个系统上的位置不一样，**不要照抄别人机器上的路径**，用下面的命令自己探出来。

### 1.1 两个目录分别是什么

| 目录 | 里面有什么 | 谁用 |
| --- | --- | --- |
| DSH 主目录 | 会话、模型配置、密钥、profile | 桌面版和命令行版共用 |
| harness 目录 | 插件安装位置、插件配置 | 桌面版自己用 |

命令行版（`dsh` 直接跑，没有图形界面）只有 DSH 主目录，没有 harness 目录。桌面版两个都有。

配置不在 `plugins/dsh-remote-agent/config.json`。桌面版写在：

`<harness 目录>/profiles/web/cordis.patch.yml`

里面有一段被标记成 `managed by dsh-remote-setup` 的块。面板保存时会重写这一段。能用面板就用面板；手改只改下面各方案列出的那几个键，改完要防面板下一次保存把它盖掉。

命令行版的同一份文件在 `<DSH 主目录>/profiles/web/cordis.patch.yml`。

### 1.2 探测命令

DSH 主目录默认是 `~/.dsh`，三个系统都一样。设过 `DSH_HOME` 就以它为准：

```bash
# macOS / Ubuntu
echo "${DSH_HOME:-$HOME/.dsh}"

# Windows PowerShell
if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
```

harness 目录不能猜。桌面版把它放在 Electron 的 userData 下面，目录名取决于你装的是哪个发行包，可能是 `dsh-desktop`，也可能是 `@deepseek-ai/dsh-desktop`。用程序自己的命令：

```bash
dsh desktop user-data-dir
```

打印出来的目录加上 `harness`，就是 harness 目录。Windows 上是 `\harness`。

`dsh` 命令还不存在的话，先在桌面版菜单里点 **Manage dsh Command… → Install**，装完**新开一个终端**再跑。

下面的教程里：

- `<DSH 主目录>` 指上面第一条命令的输出。
- `<harness 目录>` 指 `dsh desktop user-data-dir` 的输出再加上 `harness`。

### 1.3 一份对照（仅供核对，以探测结果为准）

| 系统 | DSH 主目录默认值 | harness 目录常见位置 |
| --- | --- | --- |
| macOS 桌面版 | `~/.dsh` | `~/Library/Application Support/dsh-desktop/harness` 或同级的 `@deepseek-ai/dsh-desktop` |
| Windows 桌面版 | `%USERPROFILE%\.dsh` | `%APPDATA%\dsh-desktop\harness` 或同级的 `@deepseek-ai\dsh-desktop` |
| Ubuntu 桌面版 | `~/.dsh` | `~/.config/dsh-desktop/harness` 或同级的 `@deepseek-ai/dsh-desktop` |
| 命令行版（三个系统） | `~/.dsh` | 没有。插件直接装在 `<DSH 主目录>/profiles/web` |

Windows 桌面版和 Ubuntu 桌面版这两行是按 Electron 的规则推出来的，没有在真机上逐项核过。**一律以 `dsh desktop user-data-dir` 的输出为准。**

---

## 2. 方案一：局域网

主控和节点在同一个局域网时用这套。不用买 VPS，不用域名，不用证书。

节点必须能访问主控的局域网 IP。节点在另一边 NAT 后面、访问不到这个 IP 时，这套不通，改走方案二或方案三。

### 2.1 主控先有口令

没有入网口令时，插件只绑 `127.0.0.1`，别的机器拨不进来。在主控面板 **远程同事 → 副机接入** 里生成口令。生成后完全退出再打开（退出方式见第 5.4 节）。

口令写在 `cordis.patch.yml` 的 `nodeToken`。不要发到聊天里，不要提交到 git。

### 2.2 主控监听局域网地址

插件自己听 `19387`，不是桌面版的网页端口。

`listenHost` **不能写 `0.0.0.0`**。写成通配地址会被拒绝，然后退回自动选择。自动选择的顺序是：你填的地址 → Tailscale 的 `100.x` → 局域网私网 IP → 本机。机器上装了 Tailscale 时，自动选择会优先拿 `100.x`，纯局域网就会拨错地址。

所以局域网方案把 `listenHost` 写成这块网卡的具体 IP，例如 `192.168.1.20`。三个系统查这个 IP：

```bash
# macOS
ipconfig getifaddr en0

# Ubuntu
ip -4 addr show scope global

# Windows PowerShell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -ne "WellKnown" }
```

主控这一侧的关键字段：

```yaml
role: hub
listenHost: 192.168.1.20          # 换成上面查到的地址
listenPort: 19387
nodeToken: <面板生成的口令>
```

走这套时不要再填 `relay` / `relayUrl`。留着的话，节点有可能连去中继而不是连你。

主控自己的防火墙要放行入站 TCP `19387`，来源限在局域网。节点不用开端口。

### 2.3 节点拨主控

面板上把主控生成的配对码 `dshra1://…` 整行贴进节点的「配对码」框，点写入，重启。这是最不容易抄错的办法。配对码里带了主控当前的身份指纹。主控后来换过身份，旧码不能再用，要重新生成。

手写的话，节点字段是：

```yaml
role: worker
nodeId: <这台机器的名字，所有节点里唯一>
transportMode: direct
hubUrl: ws://192.168.1.20:19387/api/remote-agent/node
token: <与主控 nodeToken 相同的那一串>
roots:
  - <这台机器上允许任务读写的目录>
agentMode: true
```

`hubUrl` 的路径是 `/api/remote-agent/node`，端口是 `19387`。写成 `/relay` 或写成 `8890` 都拨不进去。

手写 YAML 时，节点那段的 `inject` 必须是空列表。不清空的话，节点会一直停在等待，而且不报错。面板生成的配置已经清过。

### 2.4 验证

在节点上测主控的端口（把 IP 换成你的）：

```bash
# macOS / Ubuntu
nc -vz 192.168.1.20 19387

# Windows PowerShell
Test-NetConnection 192.168.1.20 -Port 19387
```

端口通、节点重启后，主控侧边栏里出现这台节点的 Bot，这套就好了。没有中继，所以没有 `healthz` 可看。

---

## 3. 方案二：国内 VPS

节点和主控不在一个网络时用这套。一台有公网 IP 的大陆 Linux 服务器只做转发，不跑任务，也不存文件。

地址写成 `ws://<大陆公网 IP>:8890/relay`。下面的 IP 一律用占位符，换成你自己的 VPS，不要把真实地址写进这份文档。

这是明文 WebSocket。谁能抓到你和这台 VPS 之间的流量，就能看到帧里的 token。上游的安全说明要求公网中继放在 TLS 后面。大陆机器要走正常证书，域名就得备案。没备案之前，这套用 IP + 明文，这是取舍，不是推荐。要线路加密又不要备案，用方案三。

下面以 Ubuntu 为例。IP 换成你自己的 VPS。

### 3.1 装运行环境

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # 应显示 v22.x
```

### 3.2 放上 dsh-remote-agent 包

把 `dsh-remote-agent-<版本>.tgz` 传到这台机器，比如 `/root/`：

```bash
mkdir -p /opt/dsh-remote-agent
tar -xzf /root/dsh-remote-agent-*.tgz -C /opt/dsh-remote-agent --strip-components=1
cd /opt/dsh-remote-agent
npm install --omit=dev
ls bin/dsh-remote-relay.js
```

### 3.3 写 token

中继靠 token 识别谁能连。主控用 `rt_` 开头的那一串，每个节点用 `en_` 开头的那一串，互不相同。

```bash
sudo mkdir -p /root/.dsh-remote-agent-relay
sudo tee /root/.dsh-remote-agent-relay/tokens.json >/dev/null <<'EOF'
{
  "hub-1": "换成 openssl rand -hex 24 生成的一串",
  "node-1": "换成另一串"
}
EOF
sudo chmod 600 /root/.dsh-remote-agent-relay/tokens.json
```

每增加一个节点就加一行，然后重启中继（见 3.6）。**这个文件是登录凭证。不要发到聊天里，不要提交到 git。**

### 3.4 做成开机自启

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

`active (running)` 就对了。

### 3.5 放行端口

云服务器有两层防火墙，两层都要放行 TCP `8890`：

1. 云厂商安全组，入站 TCP `8890`。只给你自己的机器用时，来源填主控和节点的出口 IP，不要对 `0.0.0.0/0` 开。
2. 机器自己的防火墙：`sudo ufw allow 8890/tcp`。

主控和节点不用开入站端口。它们只是连出去。

### 3.6 验证，再填两端

在**另一台机器**上测。在 VPS 自己上面测，测不到安全组：

```bash
curl -s http://<大陆公网 IP>:8890/healthz
```

返回里有 `ok` 就通了。还没人连上来时，hub 和 node 的数量是 0，这是正常的。

主控的托管块：

```yaml
role: hub
relayUrl: ws://<大陆公网 IP>:8890/relay
relay:
  url: ws://<大陆公网 IP>:8890/relay
  token: <tokens.json 里 hub-1 那一串>
```

`relayUrl` 和 `relay.url` 两个都写，写同一个地址。漏一个，界面和后台会各认各的。token 填在面板里，不要写进 git 仓库。

节点：

```yaml
role: worker
nodeId: <这台机器的名字，所有节点里唯一>
transportMode: relay
relayUrl: ws://<大陆公网 IP>:8890/relay
token: <tokens.json 里这台节点对应的那一串>
roots:
  - <这台机器上允许任务读写的目录>
agentMode: true
```

改了 `tokens.json` 之后：

```bash
sudo systemctl restart dsh-relay.service
```

两端都重启后，再跑一次 `healthz`。hub 数量应是 1，每连上一台节点，node 数量加 1。

---

## 4. 方案三：香港 VPS

和第 3 章是同一份中继程序。差别只有两处：机器在香港，前面加 TLS。香港不用备案，Let's Encrypt 可以直接签，所以这套走 `wss://`。

这套和方案二可以同时存在，各管各的主控。做这套时只改这一台主控和它的节点，不要改另一套已经在用的地址。

如果这台机器的 80 和 443 已经被别的程序占着，Caddy 签不了证书。先挪走占用，或者换一台这两个端口空着的机器。

### 4.1 中继只听本机

安装步骤与第 3.1 到 3.3 节相同。服务这一行改成只听回环，公网不再看到 `8890`：

```bash
ExecStart=/usr/bin/node /opt/dsh-remote-agent/bin/dsh-remote-relay.js --port 8890 --host 127.0.0.1
```

安全组放行 TCP `80` 和 `443`，**不要**对公网放行 `8890`。

### 4.2 域名和证书

把一个域名解析到这台香港机器的公网 IP。等解析生效再装 Caddy，否则签证书会失败。

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile` 写成：

```
relay.example.com {
	reverse_proxy 127.0.0.1:8890
}
```

`relay.example.com` 换成你的域名。然后：

```bash
sudo systemctl reload caddy
curl -s https://<你的域名>/healthz
```

返回里有 `ok` 就说明证书和反代都通了。Caddy 会自动续期，不用手签。

### 4.3 两端改地址

token 不动，只换地址。主控的 `relayUrl` 和 `relay.url`，以及节点的 `relayUrl`，都写成：

```
wss://<你的域名>/relay
```

端口 `443` 不用写。写成 `ws://` 或带上 `:8890` 都是错的：公网已经没有 `8890`，明文也进不了这条 TLS。

两端完全退出再打开。`healthz` 里 hub 为 1、node 数量等于已连上的节点，再停掉国内那台中继。两台同时开着、两端地址却各写各的，节点会连到你没在看的那一台。


### 4.4 跨境线路为什么会反复断

这一节是实测记录，不是推测。如果你按方案三搭完，发现节点每隔几分钟掉一次，先照这里对一遍，再决定要不要换方案。

症状长这样：

- 节点日志：`event=offline closeCode=1006`，一秒多之后 `event=reconnecting attempt=1`，再 `event=online`。1006 是「没有关闭帧就断了」，不是正常关闭。
- 中继日志：同一秒里连着几条 `node error ... error:"replaced"`，每条后面紧跟 `node offline` 和 `node online`。中继从头到尾**没有收到过**这条连接的 close，旧连接是新连接到达时才被顶掉的。
- 时间分布：多台节点在 1.5–2 秒内一起断，断的先后顺序每次都不一样，间隔从十几秒到一小时都有。

客户端断了、服务端还以为活着，说明断开发生在两端之间的某处，而不是任一端主动关闭。具体是哪一跳、用什么方式掐的，我们没能定位到单个设备——用一条纯 TLS 连接连同一台中继挂了 7 分钟没断，说明并不是「去这个 IP 的所有流量都被掐掉」，被反复打断的是这条 WS 长连接。能确定的是这既不是丢包，也不是延迟：

- `ping` 到中继 60 包 0% 丢，平均 10ms；整机 60 秒 TCP 重传只有 4 段，`TCPLostRetransmit` 为 0。
- 同一台机器上同时开着的其他长连接（浏览器、其他服务）在同一秒一条都没断。
- 中继进程和 Caddy 都没有重启，节点进程号也没变。

换成大陆中继（方案二）做对照，同一批节点、同样的客户端代码，两天零重连。差别只有「跨境」这一项。

所以：

- 能回方案一就回方案一，其次是方案二。
- 必须保留跨境入口时，把它当外网备用通道，不要指望长时间稳定；重连后头几十秒里派任务可能失败，重试即可。
- 不要靠调心跳、调超时来治它。断点在网络中间，改客户端参数只会让重连更频繁。
---

## 5. 部署主控

主控就是你每天用的那台桌面版。Windows、Ubuntu、macOS 步骤相同，差别只在第 1 章探出来的路径。三套方案的主控字段不同，回到你选的那一章抄，不要三套叠在一起。

### 5.1 确认桌面版在跑

打开 DeepSeek Harness，能看到 Bot 侧边栏即可。版本号在菜单 **About DeepSeek Harness**。

### 5.2 安装两个插件

插件装在 `<harness 目录>/profiles/web`，不在 `<DSH 主目录>`。装错地方，重启后界面上看不到变化。

先确认目录在：

```bash
ls "<harness 目录>/profiles/web/package.json"
```

Windows PowerShell 把路径换成反斜杠。

**装之前先做回滚副本：**

```bash
STAMP=$(date +%Y%m%d-%H%M)
cp -a "<harness 目录>/profiles/web/node_modules/ds-bot" "/tmp/rollback-ds-bot-$STAMP"
cp -a "<harness 目录>/profiles/web/node_modules/dsh-remote-agent" "/tmp/rollback-ra-$STAMP"
cp "<harness 目录>/profiles/web/package.json" "/tmp/rollback-package-json-$STAMP"
cp "<harness 目录>/profiles/web/pnpm-lock.yaml" "/tmp/rollback-lock-$STAMP"
```

ds-bot 在桌面版里是一个 `link:` 目录。覆盖内容，不要改 `package.json` 里它的版本号：

```bash
rm -rf "<harness 目录>/profiles/web/node_modules/ds-bot"
mkdir -p "<harness 目录>/profiles/web/node_modules/ds-bot"
tar -xzf ds-bot-*.tgz -C "<harness 目录>/profiles/web/node_modules/ds-bot" --strip-components=1
```

dsh-remote-agent 走包管理器。把 `package.json` 里的版本改成你拿到的版本，再装：

```bash
cd "<harness 目录>/profiles/web"
pnpm install
```

装完核验，两个版本都要和包一致：

```bash
node -p "require('<harness 目录>/profiles/web/node_modules/ds-bot/package.json').version"
node -p "require('<harness 目录>/profiles/web/node_modules/dsh-remote-agent/package.json').version"
```

### 5.3 填方案字段

优先用面板 **远程同事**。面板写入的就是 `cordis.patch.yml` 里那段托管块。

手改时只动这些键：

- 方案一：`listenHost`、`listenPort`、`nodeToken`。不要留 `relay`。
- 方案二、方案三：`relayUrl`、`relay.url`、`relay.token`。两个 URL 必须相同。

`roots` 填你允许远程任务声明的目录。主控自己不跑任务，但派出去的任务要落在节点的 `roots` 里。

### 5.4 完全退出再打开

关窗口不等于退出，进程还在，新配置不会加载。

- macOS：关闭按钮只是隐藏。用 **⌘Q**，或菜单里的 Quit。
- Windows：× 只是收进托盘。右键托盘图标选 **Quit**。
- Ubuntu：关闭窗口通常就是退出，以进程是否还在为准。

方案二、方案三退出重开后，再跑一次对应的 `healthz`。hub 数量应是 1。方案一没有 `healthz`，看第 2.4 节的端口测试。

---

## 6. 部署节点

一台中继（或一台局域网主控）可以挂任意多个节点。每个节点重复这一章，`nodeId` 不能重复。

### 6.1 选运行方式

| 方式 | 适合 | 插件装在哪 |
| --- | --- | --- |
| 命令行版 + systemd | Ubuntu 服务器，没有显示器 | `<DSH 主目录>/profiles/web` |
| 桌面版 | Windows / Ubuntu / macOS 的日常电脑 | `<harness 目录>/profiles/web` |

两种方式的字段完全一样。桌面版的安装步骤与第 5.2 节相同。

### 6.2 命令行版：装 dsh 和两个插件

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g @deepseek-ai/dsh
dsh --version
```

Windows 从发行页下载安装包，装完在 PowerShell 里跑 `dsh --version`。macOS 同理。

```bash
mkdir -p ~/.dsh/profiles/web
cd ~/.dsh/profiles/web
npm install /root/ds-bot-*.tgz /root/dsh-remote-agent-*.tgz
```

包的路径按你实际放置的位置改。装完用 `node -p "require(...).version"` 核两个版本号。

### 6.3 做成开机自启（Ubuntu 服务器）

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

- `--host 127.0.0.1`：节点不对公网开端口。
- `--port 3080`：本机网页端口，和 `19387`、`8890`、`443` 都不是一回事。
- `--no-open`：服务器上没有浏览器。

`DSH_HOME` 按这台机器的实际主目录改。用 root 跑就写 `/root/.dsh`，用普通用户跑就写那个用户的主目录。

### 6.4 填方案字段

配置文件就是第 1 章说的 `cordis.patch.yml`。字段按你选的方案抄第 2.3、3.6 或 4.3 节，不要混用。

- `nodeId` 在所有节点里唯一。起个能看懂的，比如 `office-pc`、`gpu-box-1`。
- `roots` 是这台机器上任务能碰的目录。声明的工作区必须落在这里面，否则会被拒绝。
- `agentMode: true` 节点才会自己跑 Bot。`false` 就只会执行单条命令。
- 每台节点的 token 不同。方案一用主控的 `nodeToken`；方案二、方案三用中继 `tokens.json` 里这台节点自己的那一串。

### 6.5 验证

方案二、方案三：

```bash
curl -s http://<中继地址>/healthz
```

方案三把 `http://<IP>:8890` 换成 `https://<域名>`。node 数量应增加 1。

节点自己的日志：

```bash
# Ubuntu 命令行版
journalctl -u dsh-worker.service --no-pager -n 50
```

桌面版的日志不写死路径。macOS 常见位置是 `~/Library/Logs/DSH Desktop/harness.log`。Windows 和 Ubuntu 以 `dsh desktop user-data-dir` 的输出为准，日志通常在它旁边的 Logs 目录。日志里能看到连上中继或主控，并且没有反复重连，就通了。

### 6.6 主机身份（三套方案都有）

主控第一次启动会在自己的状态目录生成一把身份，文件名是 `hub-identity.json`。默认目录是用户主目录下的 `.dsh-remote-agent`。Windows 就是 `%USERPROFILE%\.dsh-remote-agent\hub-identity.json`。配了 `stateDir` 就以配置为准，以日志里的 `file` 为准，不要猜。

节点第一次连上后，把这把身份的指纹钉在自己的 `~/.dsh-remote-agent/hub-pin.json`。之后主控必须用同一把身份证明自己。方案二、方案三还多一步：节点上线后 15 秒内要收到主控追发的身份帧。对不上，或者钉住了但帧没来，节点会停止重连，不会一直重试。

主控日志里看这一行：

```text
hub identity ready
```

`created: false` 才是沿用原来那把。`created: true` 表示这次新生成的。文件坏了、丢了、写不进去，都会新生成。新生成之后，已经钉住旧指纹的节点会全部停掉。

处理时只动节点，不要动主控那把身份：

- 确认还是同一台主控：在每台节点删掉 `hub-pin.json`，重启节点。它会重新钉住现在这把。
- 不要删主控的 `hub-identity.json`。删了会再换一把，所有节点又对不上。
- 如果主控每次启动都是 `created: true`，文件没落住。先让这个文件能留下来，再去重钉节点。不然删 pin 只能撑到主控下一次重启。

---

## 7. 在主控上看到节点的 Bot

节点连上之后，节点上的 Bot 会自动出现在主控侧边栏里，不用在主控上逐个添加。

前提是两边的版本都够新：

- dsh-remote-agent `0.10.1-fork.33` 及以上才会上报 Bot 名单。
- 要在主控上看到节点 Bot 用的模型，两边都要到 ds-bot `0.3.6-fork.43`、dsh-remote-agent `0.10.1-fork.86`。**只升主控不够**，模型是节点侧生成的。

等一两分钟。看不到时，在**节点那台机器**上查：

```bash
node -p "require('<插件目录>/node_modules/dsh-remote-agent/package.json').version"

# 桌面版
grep -c "roster/report" "<日志文件>"
# 命令行版
journalctl -u dsh-worker.service --no-pager | grep -c "roster/report"
```

- 版本低于 `0.10.1-fork.33`：这台机器没有上报功能。升到和主控相同的版本，两边一起升。
- 版本够、计数是 0：节点没在发。查 `role` 是不是 `worker`，地址是不是你选的那一套，token 是不是同一套。
- 版本够、计数大于 0：节点在发，是中继没转到主控，或者主控把这台节点屏蔽了。把那段日志发出来查。

---

## 8. 模型、任务、升级

主控上配好的模型，节点的 Bot 可以直接用，密钥留在主控，不会发到节点。在主控 **设置 → 模型** 里配 provider 和 key。

一个已知的小问题：节点用的模型主控这边没有时，聊天页会提示「模型不可用，换一个」。这不影响任务执行。

在主控侧边栏里点节点的 Bot，直接发消息，它就在节点那台机器上执行。任务能碰的目录受节点 `roots` 限制。读 `roots` 之外的路径会被拒绝，这是预期行为。

升级时记住三条：

1. **主控和所有节点升到同一个版本。** ds-bot 和 dsh-remote-agent 要成对升。只升一边，轻则模型栏是空的，重则上报被丢掉。
2. **中继可以落后。** 它只转发帧，不解析内容。方案二、方案三的中继版本低于主控和节点是正常的。方案一没有中继。
3. **升级前做回滚副本**，照第 5.2 节的 `cp -a` 做。出问题把副本拷回去，完全退出再打开。

---

## 9. 出问题时先分方案

不要凭感觉猜。

方案一，在节点上做第 2.4 节的端口测试。不通：主控没退出重开、`listenHost` 不是这块网卡的 IP、防火墙没放行 `19387`，或者没生成 `nodeToken` 导致只绑了本机。通了但侧边栏没有 Bot：看第 7 章的版本和 `roster/report` 计数。

方案二、方案三，把下面四样发出来：

```bash
# 1. 中继是否通。方案二用 http://<IP>:8890，方案三用 https://<域名>
curl -s http://<中继地址>/healthz

# 2. 主控版本
node -p "require('<harness 目录>/profiles/web/node_modules/ds-bot/package.json').version"
node -p "require('<harness 目录>/profiles/web/node_modules/dsh-remote-agent/package.json').version"

# 3. 节点版本
node -p "require('<插件目录>/node_modules/dsh-remote-agent/package.json').version"

# 4. 节点有没有在上报
grep -c "roster/report" "<日志文件>"
```

`healthz` 里 hub 是 0，问题在主控到中继这一段。hub 是 1 但 node 是 0，先看节点日志里有没有「hub 身份验证失败，已停止重连」。有，就是第 6.6 节，不是端口没开。没有这句，才是节点到中继这一段没通。两边都是 1 但主控看不到 Bot，问题在上报，看第 4 条的计数。

顺带一个判别：如果节点日志里反复出现 `closeCode=1006`、中继日志里对应时刻只有 `error:"replaced"` 没有 close，而且多台节点在 1.5–2 秒内一起断，这就不是端口、不是 token，是跨境的这条长连接被中间设备反复打断。照第 4.4 节处理，别在端口和密钥上白费时间。

Tailscale、Headscale 不是这三套的组成部分。主控和节点要么同网直连，要么主动连 VPS。已经装了可以留着，没装不用装。
