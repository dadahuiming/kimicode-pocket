<div align="center">

# KimiCode Pocket

**把 Kimi Code Desktop 的 Web UI 装进你的口袋——手机浏览器直接远控，零安装、零依赖、零订阅。**

<p align="center"><b>中文</b> | <a href="README.en.md">English</a></p>

[![CI](https://github.com/dadahuiming/kimicode-pocket/actions/workflows/ci.yml/badge.svg)](https://github.com/dadahuiming/kimicode-pocket/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Cloudflare Tunnel](https://img.shields.io/badge/Cloudflare-Tunnel-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D6)](#平台适配)
[![Tests](https://img.shields.io/badge/tests-249%20passing-brightgreen)](#开发与测试)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![No Subscription](https://img.shields.io/badge/subscription-not%20required-success)](#和官方远程控制的区别)

</div>

---

## 和官方远程控制的区别

Kimi 官方有「远程控制」（`kimi rc` / Settings → Remote Control），但它有**三个前提**：
要**付费会员**、要**登录同一个 Kimi 账号**、要经 **Kimi 服务中转**。

本项目走的是完全不同的路：**直接把你电脑上已经开着的 Desktop Web UI 反代到公网**。

| | Kimi 官方远程控制 | **KimiCode Pocket** |
|---|---|---|
| **订阅要求** | ❌ 需要付费会员<br><sub>官方文档原文：「远程控制需要会员权限，免费用户无法使用」</sub> | ✅ **不需要任何订阅**<br><sub>用的是你本机 Desktop 已有的 Web UI，不经过 Kimi 服务</sub> |
| **鉴权方式** | 登录同一个 Kimi 账号 | 一次性配对码（180 秒 / 用后即焚）+ 可选 PIN |
| **流量路径** | 经 Kimi 服务中转 | 你自己的 Cloudflare 隧道，**点对点** |
| **界面** | 官方远程控制界面 | **完整的 Desktop Web UI**（一模一样，含历史节点、截图、工具调用） |
| **部署** | 开关一开即可 | **一条命令**（见下） |
| **依赖** | Kimi App / 浏览器 + 账号 | 只有 Node 22+，**零 npm 依赖** |

> 官方文档：[远程控制 | Kimi Code](https://www.kimi.com/code/docs/kimi-code-cli/guides/remote-control.html)
> ——「已登录 Kimi 账号且为付费会员：远程控制需要会员权限，免费用户无法使用」

### 一键部署

```bash
# 克隆后直接跑，不需要 npm install（零依赖）
node src/proxy.mjs --pair-only --base https://your-domain.com
```

终端会打印配对链接和二维码，手机扫一下就能用。要 7×24 常驻就再跑 `npm run watchdog`。

**远程公网连接**：通过 Cloudflare Tunnel 暴露，不需要公网 IP、不需要开路由器端口、不需要 DDNS。
用自己的域名就是固定地址（本项目作者用的是 `kimicode.damingtop.online`）。

> ## ⚠️ 非官方项目
>
> 本项目是**社区开发的第三方工具**，与 Moonshot AI / Kimi 官方**没有任何关系**，
> 未获其授权或背书。使用前请自行确认符合 Kimi Code 的服务条款。
>
> 本项目依赖 Kimi Code Desktop 的**内部实现**（实例注册文件与内部健康检查接口），
> 这些不是公开 API，**官方升级随时可能使其失效**。详见 [兼容性风险](#兼容性风险)。

---

## 目录

- [和官方远程控制的区别](#和官方远程控制的区别)
- [这个项目解决什么问题](#这个项目解决什么问题)
- [特性](#特性)
- [前提约束（先读这一节）](#前提约束先读这一节)
- [部署形态](#部署形态)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [配对与凭证](#配对与凭证)
- [配置](#配置)
- [平台适配](#平台适配)
- [常驻运行（7×24）](#常驻运行724)
- [生产部署：命名隧道 + 固定域名](#生产部署命名隧道--固定域名)
- [安全加固](#安全加固)
- [运维：日志、状态与回滚](#运维日志状态与回滚)
- [给 AI Agent 的部署指令](#给-ai-agent-的部署指令)
- [兼容性风险](#兼容性风险)
- [故障排查](#故障排查)
- [项目结构](#项目结构)
- [工作原理](#工作原理)
- [开发与测试](#开发与测试)
- [来源与演进](#来源与演进)

---

## 这个项目解决什么问题

Kimi Code Desktop 自带一个完整的 Web UI，但它默认只监听 `127.0.0.1:<动态端口>`。
想在外面用手机打开它，会撞上**两个具体的障碍**：

| # | 障碍 | 具体表现 |
|---|---|---|
| 1 | **端口是动态的** | 每次重启 Desktop，监听端口都可能变化（记录在 `~/.kimi-code/server/instances/*.json`）。而隧道 / 防火墙规则必须指向**固定端口**。 |
| 2 | **Host / Origin 白名单** | Desktop 只接受 `127.0.0.1:<port>` / `localhost:<port>`。公网域名回源会被直接 **403**；经 Cloudflare 表现为 **502**，手机端则是 WebSocket error 弹窗。 |

**这两个障碍我们都实测复现过**（不是猜的）：

```text
直连 Desktop + Host: evil.example.com          → 403
直连 Desktop + WS Origin: https://evil…        → 403
直连 Desktop + WS 不带 Origin                  → 101  ← 关键
经 proxy.mjs + Host: evil.example.com          → 200  ← 代理生效
经 proxy.mjs + WS 公网 Origin                  → 101  ← 代理生效
```

> 第三条尤其重要：**删掉 Origin 反而会被放行**。所以本项目的做法是**改写**而不是删除。

**KimiCode Pocket 用一个约 500 行的反向代理同时解决这两点**：

```
手机浏览器
    │  HTTPS
    ▼
Cloudflare 隧道 ──────► proxy.mjs (固定端口 50980) ──────► Kimi Code Desktop (动态端口)
                              │
                              └─ 每请求动态发现 Desktop 端口
                                 并把 Host / Origin 改写为 127.0.0.1:<port>
```

**手机端零安装**：打开一个 URL 就是完整的 Kimi Code Web UI。

---

## 特性

| 特性 | 说明 |
|---|---|
| **固定端口** | 隧道只需指向 `50980`，Desktop 重启换端口也无需改配置 |
| **动态端口发现** | 注册文件 + pid 存活 + 真实探活三重确认，2 秒缓存 + 并发单飞 |
| **Host / Origin 双改写** | HTTP 与 WebSocket 两条路径同规则；**改写而非删除**（有实测依据） |
| **WebSocket 透传** | 用 `rawHeaders` 逐字节重建；两端任一关闭即收摊 |
| **一条命令出码** | `--pair-only --base https://…` → 终端直接打印链接 + 二维码，**token 不进地址栏** |
| **一次性口令** | 6 位、**180 秒**、用后即焚、不可重放；终端实时回报配对结果；猜错 5 次锁 60 秒 |
| **真正区分本机与公网** | 「本机」= 回环 socket **且** 无 Cloudflare 头，隧道来客拿不到任何内部端点 |
| **可选第二道口令** | `POCKET_PIN`，Cookie 会话 + 失败限速（5 次 / 60 秒） |
| **响应压缩** | JSON 走 brotli/gzip（大响应自动提高压缩比）；SSE 明确跳过 |
| **截图降采样** | `/transcript`、`/messages` 里的 base64 PNG 截图按比例降采样；**文字一个字符都不动**。实测 51 MB → 8.1 MB（其中文字 1.95 MB 原样保留） |
| **崩溃自愈** | 看门狗 30 秒探活，连续 2 次失败才重启（防抖，不打断对话） |
| **安全默认值** | 只绑 `127.0.0.1`；绑非回环又没设 PIN 时**直接拒绝启动** |
| **零依赖** | 只用 Node 内置模块，`npm install` 都不需要 |
| **不脏仓库** | 日志与配对产物一律落在平台状态目录，跑完 `git status` 依然干净 |
| **跨平台** | 核心代理三平台通用；常驻脚本按平台提供 |
| **可测** | 135 个用例（含进程级集成测试），CI 覆盖三平台 × 两个 Node 版本 |

---

## 前提约束（先读这一节）

这一节是**必须满足的硬约束**。不满足的话，后面的步骤都跑不通。

### 1. Kimi Code Desktop 必须运行在**有图形会话**的机器上

Kimi Code Desktop 是一个 **Electron 桌面应用**（GUI），不是无头服务。它需要：

- 一个真实的桌面环境（Windows 桌面 / macOS Aqua / Linux 的 X11 或 Wayland）
- 一个已登录的用户会话

> **它不能跑在纯命令行的无头服务器上。** 项目内没有任何 headless / server-only 模式
> （`--headless`、`systemd` 等关键字在应用包内零出现）。
>
> 理论上 Linux 可用 `Xvfb` 提供虚拟显示，但这**不是官方支持的用法**，
> 且是否能稳定跑通取决于官方是否提供对应 Linux 构建。本项目不对该路径作保证。

### 2. 电脑必须保持开机、不休眠

这是"7×24 远控"的物理前提。见 [常驻运行](#常驻运行724) 里的电源设置。

### 3. 目标机器上必须能运行 Node.js 22+

代理本身是纯 Node 脚本，见 [环境要求](#环境要求)。

### 4. 端口 `50980` 必须空闲

被占用时用 `POCKET_PORT` 改端口（见 [配置](#配置)）。

### 5. 你需要在 Cloudflare 侧有可用的出口

隧道（无论快速隧道还是命名隧道）都需要能连到 Cloudflare 边缘
（`*.argotunnel.com` / `*.trycloudflare.com`）。
在受限网络（如某些企业内网）中可能无法建立隧道。

### 6. 安全责任在你

拿到配对链接的人**就是**你。把它暴露到公网意味着任何人都能操作你的 Desktop，
除非你额外加了 `POCKET_PIN` 和 / 或 Cloudflare Access。见 [安全加固](#安全加固)。

---

## 部署形态

**"公网访问" ≠ "程序跑在公网服务器上"。** 本项目有三种典型形态：

### 形态 A：家庭 / 办公电脑常驻（推荐，也是本项目主场景）

```
┌─────────────────────────────┐
│ 你的电脑（Windows/macOS/Linux）│
│  ├─ Kimi Code Desktop (GUI)  │  ← 必须有人登录的桌面会话
│  ├─ proxy.mjs :50980         │
│  └─ cloudflared              │
└──────────┬──────────────────┘
           │ 出站长连接（无需公网 IP、无需端口映射）
           ▼
    Cloudflare 边缘 ──► 手机/任意设备浏览器
```

**优点**：不需要公网 IP、不需要开路由器端口、不需要 VPS。
**要求**：电脑常开，桌面会话保持登录。

### 形态 B：局域网访问（不出公网）

代理默认只绑 `127.0.0.1`，所以局域网内其它设备**访问不到**。若要在局域网用：

- **推荐**：用 SSH 端口转发 `ssh -L 50980:127.0.0.1:50980 user@你的电脑`
- **或者**：`POCKET_BIND=0.0.0.0 POCKET_PIN=<至少6位口令>` —— 注意这会把
  你的 Desktop 暴露给同一网络的**所有**设备，必须有强口令，且建议只在自己家网络这么做

> 没设 `POCKET_PIN` 就想绑 `0.0.0.0`？代理会**拒绝启动**并告诉你原因。这是故意的。

### 形态 C：有公网 IP 的服务器 / VPS

> ⚠️ **只有在你确认 Kimi Code 能在该服务器上以图形方式运行的前提下才成立。**

如果服务器是无头的，此路不通（见[前提约束](#前提约束先读这一节)）。
如果你确实让 Desktop 跑在有桌面的 Linux 机器上，可以直接：

- 用 cloudflared 隧道（同形态 A），或
- 用 Nginx / Caddy 反代到 `127.0.0.1:50980` 并自行配 TLS

**本项目不提供 Nginx / Caddy 配置**，因为隧道方案更简单且不需要开任何入站端口。
若你要自建反代：**必须先让请求经过 `proxy.mjs`**，否则 Host / Origin 改写不会发生。

---

## 环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| **Node.js** | **22+** | 需要内置 `fetch`、`AbortSignal.timeout`、`server.closeIdleConnections`、`node:test`（仅测试用）。18/20 已停止维护，不保证可用 |
| **Kimi Code Desktop** | 任意近期版本 | 必须处于运行状态且已登录 |
| **cloudflared** | 最新 | 仅公网访问需要 |
| **PowerShell** | 5.1+ 或 7+ | 仅 Windows 的常驻脚本需要 |
| **磁盘** | < 10 MB | 项目本身 ~90 KB + 日志（5 MB 自动轮转） |

**Node.js 安装**（三平台）：

```bash
# Windows
winget install OpenJS.NodeJS.LTS

# macOS
brew install node

# Linux
sudo apt install nodejs npm      # Debian/Ubuntu（注意版本可能偏旧）
```

> ⚠️ Debian/Ubuntu 仓库里的 Node 可能低于 22。用 `node --version` 确认，
> 不够就用 [NodeSource](https://github.com/nodesource/distributions) 或 `nvm`。

**cloudflared 安装**：

```bash
# Windows
winget install Cloudflare.cloudflared

# macOS
brew install cloudflared

# Linux
# 从 https://github.com/cloudflare/cloudflared/releases 下载 .deb / .rpm 后安装
```

---

## 快速开始

正常情况 2 分钟跑通；**已经有固定域名的话，从敲命令到手机出界面不到 30 秒**。

### 第 1 步：启动代理

```bash
cd kimicode-pocket
node src/proxy.mjs
```

看到下面这样就成了：

```text
KimiCode Pocket 1.3.0 代理已启动: http://127.0.0.1:50980
  健康检查   http://127.0.0.1:50980/__healthz
  运行状态   http://127.0.0.1:50980/__status
  口令保护   未开启（仅靠 Desktop token）
  Desktop    127.0.0.1:54321
```

**先在本机验证**：浏览器打开 `http://127.0.0.1:50980`，应该看到 Kimi Code 的 Web UI。

> 如果这一步就失败，**先别急着配隧道**。看[故障排查](#故障排查)。

### 第 2 步：开公网入口

本项目的目标场景是**异地用**，所以完整部署要经公网（真想只在同一 WiFi 下用，
看[部署形态 B](#部署形态)）。两条路选一条：

**A. 已有命名隧道 + 固定域名（推荐，7×24 就用这个）**

跳过本步，直接看[生产部署](#生产部署命名隧道--固定域名)。隧道起来之后，
给新设备配对只要一条命令，见[一条命令拿到配对链接](#一条命令拿到配对链接)。

**B. 还没有域名（快速隧道，临时试用）**

> 这一步用的是 **`trycloudflare.com` 快速隧道**：不用域名、不用账号，2 分钟能出结果。
> 缺点是**地址每次重启都变、且加不了 Access**。

Windows：

```powershell
pwsh -File scripts/start-tunnel.ps1
```

macOS / Linux：

```bash
chmod +x scripts/*.sh        # 从 zip 解压后必须先做这一步
./scripts/start-tunnel.sh
```

脚本会：探测代理 → 要一个一次性配对口令 → 启动隧道 → 校验公网可达 →
输出配对链接并生成 `pair-qr.png`（落在[状态目录](#日志默认放在哪)，**不在仓库里**）。

> 脚本会在启动 cloudflared 前**自动剥离 `HTTP_PROXY` / `HTTPS_PROXY`**。
> 如果你就是想让隧道走代理，加 `-RespectProxy`（PowerShell）或
> `RESPECT_PROXY=1`（shell）。

### 第 3 步：手机扫码

**固定域名（路径 A）：**

```bash
node src/proxy.mjs --pair-only --base https://kimicode.example.com
```

```text
公网入口 https://kimicode.example.com

配对链接（一次性，用后立即失效）
  https://kimicode.example.com/__pair?code=834172

  █▀▀▀▀▀█ █ ▄ ██▄ ▄▀█▄▄▀    █▀▀▀▀▀█
  ...（终端里直接出现的二维码）

  ⏳ 剩余 176 秒（01:57:04 失效，一次性）
```

**快速隧道（路径 B）：** `start-tunnel` 脚本自己会打印

```text
===== 公网远控已就绪 =====
配对链接（180 秒内有效，用一次就失效）:
https://xxxx-xxxx-xxxx.trycloudflare.com/__pair?code=834172

二维码已保存: C:\Users\<你>\AppData\Local\kimicode-pocket\pair-qr.png
```

**手机扫那个二维码**（或直接在手机上打开链接）→ 自动完成配对 → 进入 Kimi Code 界面。

> 二维码是**本地生成**的（`src/lib/qr.mjs`，终端里用半块字符画），
> 不经过任何在线二维码服务——那等于把配对地址发给第三方。

**停止：**

```bash
# Windows
pwsh -File scripts/stop.ps1

# macOS / Linux
./scripts/stop.sh
```

---

## 配对与凭证

这一节解释"为什么手机能直接用"以及"什么时候会突然打不开"。

### 配对到底做了什么

Kimi Code Web UI 需要一个凭证才能调 API。它的机制是：

1. 网页从 URL 的 **`#token=`** 片段里读 token
2. 存进 `localStorage['kimi-web.server-credential']`
3. **立刻用 `history.replaceState` 把 hash 擦掉**
4. 之后每次请求带 `Authorization: Bearer <token>`
5. WebSocket 用 `Sec-WebSocket-Protocol: kimi-code.bearer.<token>` 传递

本项目的配对页（`/__pair?code=…`）做的是**第 2 步**：
直接把这个对象写进 localStorage，然后跳回 `/`。

> 好处：**token 从头到尾不出现在地址栏、浏览历史、剪贴板里。**
> 你分享的链接里只有一个 180 秒后就作废的 6 位口令。

### ⏰ 7 天后会失效（重要）

前端把凭证的有效期写死在 **7 天**（`expiresAt = now + 10080 分钟`）。
过期后 localStorage 里的记录会被删除，**手机打开就是一片空白 / 401**。

**这不是 bug，是 Desktop 的设计。** 解决办法：重新生成一条配对链接（不需要重开隧道）：

```bash
node src/proxy.mjs --pair-only --base https://kimicode.example.com
```

> 这也是为什么建议用[命名隧道 + 固定域名](#生产部署命名隧道--固定域名)：域名固定后，你只需要重新打开
> `https://你的域名/__pair?code=…`，而不用等一条新的随机隧道地址。

### 一次性口令

| 属性 | 值 |
|---|---|
| 长度 | 6 位数字 |
| 有效期 | **180 秒**（`POCKET_PAIR_TTL_SEC` 可调，范围 30~3600） |
| 使用次数 | **1 次**，用后立即作废（记录再留 10 分钟，只给终端读状态用） |
| 获取方式 | `GET /__paircode`（**仅限本机直连**） |
| 猜错上限 | 同一 IP 连续 5 次错误锁定 60 秒 |

> **一台设备一个码。** 手机配完想再配平板，要重新生成一个（`--pair-count 2` 可以一次出两个）。
>
> 口令只在内存里，重启代理就全部作废。这也意味着：**代理重启后旧配对链接立即失效**。

### 一条命令拿到配对链接

固定域名部署最常用的动作，就是"给一台新设备开个口子"。不必重开隧道：

```bash
# 生成 1 条（在电脑上跑；代理必须已在运行）
node src/proxy.mjs --pair-only --base https://kimicode.example.com

# 一次给手机 + 平板
node src/proxy.mjs --pair-only --base https://kimicode.example.com --pair-count 2
```

屏幕上直接出现链接和终端二维码，手机扫一下就完成配对。**二维码下方有一行倒计时**：

```text
  一台设备一个码；该设备凭证 7 天有效。

  ⏳ 剩余 176 秒（01:57:04 失效，一次性）
```

手机上真的打开了配对页之后，这一行会在**约 1 秒内**原地变成：

```text
  ✔ 配对页已打开（01:54:31），手机上应已进入 Kimi Code，可以关掉这个窗口。
```

也就是说**不用干等剩下的两分多钟**：状态是由服务端回传的（`GET /__pairstatus`），
不是本地拿计时器猜的。一直没人扫，到点才变成：

```text
  ✖ 当前链接、二维码已失效，请重新生成！
```

这条链接与这张二维码同时作废（它们指向同一个一次性口令），重新跑一次命令即可。

判据是**服务端那个码被兑换掉**——手机真的打开了配对页，Desktop 凭证随页面下发。
注意这是"页面已经发出"，不是"手机浏览器已经执行完 JS"：后者在服务端是不可见的，
所以这里只说"配对页已打开"，不吹成"登录成功"。手机上先过 Cloudflare Access
登录页的时间不算在内，只要在有效期内走完即可。

多设备（`--pair-count 2`）时状态行会带上进度 `已配对 1/2`；到期只配上一台时，
提示是 `⚠ 已配对 1/2，其余链接已失效`，不会把已经配好的那台也说成失败。

默认 **180 秒**：60 秒试过，太紧（扫码 + 过 Access 登录 + 点确认），3 分钟够用，
又不至于让人"生成完就忘了"。`POCKET_PAIR_TTL_SEC` 可调 30~3600 秒。

> 输出被重定向到文件 / 管道时没有动画，只打一行
> `链接于 01:57:04 失效。` —— 不往日志里刷几百行，也不阻塞管道。
> 代价是这种模式下不回报配对结果（没有终端可报）。

`--base` 也可以写成环境变量 `POCKET_PUBLIC_URL`，这样服务定义里配一次，
以后只需要 `npm run pair`：

```bash
POCKET_PUBLIC_URL=https://kimicode.example.com node src/proxy.mjs --pair-only
```

> 启动代理时直接带上 `--base`，它会在启动完成的同一条输出里就把配对链接和
> 二维码打出来，省掉第二个终端窗口（倒计时与配对结果提示同样会跑，
> 配对结果还会写进 `proxy.log`）。

---

## 配置

**全部通过环境变量，没有配置文件。** 这样项目本身无状态——回滚 = 换回旧代码。

带 `--` 的命令行参数优先于同名环境变量（便于临时覆盖）。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `POCKET_PORT` | `50980` | 代理监听端口（`--port`） |
| `POCKET_BIND` | `127.0.0.1` | 绑定地址。改非回环**必须**同时设 `POCKET_PIN` |
| `POCKET_APP_HOME` | `~/.kimi-code` | Desktop 配置目录（实例文件与 token 所在） |
| `POCKET_HEALTH_PATH` | `/api/v1/healthz` | 探活路径 |
| `POCKET_LOG_DIR` | `<状态目录>/logs` | 日志目录（见下方说明，**不写进仓库**） |
| `POCKET_PUBLIC_URL` | *(空)* | 公网入口，如 `https://kimicode.example.com`（`--base`） |
| `POCKET_PIN` | *(空)* | 额外访问口令，至少 6 位。设了就开启 PIN 闸门（`--pin`） |
| `POCKET_UPSTREAM_TIMEOUT_MS` | `120000` | 上游**空闲**超时（不是总时长） |
| `POCKET_MAX_BODY_MB` | `64` | 请求体上限 |
| `POCKET_COMPRESS` | `1` | JSON 响应压缩开关 |
| `POCKET_TRIM` | `1` | 截图降采样开关（见下方「大响应瘦身」） |
| `POCKET_IMG_MAX_PIXELS` | `400000` | 单张截图最大像素数，超过才降采样 |
| `POCKET_IMG_MIN_KB` | `16` | 小于此大小的图不处理 |
| `POCKET_IMG_MAX_INPUT_MB` | `12` | 超过此大小的图不处理（保护内存） |
| `POCKET_TRIM_MIN_KB` | `256` | 小于此值的响应不处理 |
| `POCKET_TRIM_MAX_BUFFER_MB` | `128` | 超过此值不缓冲（保护进程内存） |
| `POCKET_TRIM_PATHS` | `transcript,messages` | 生效路径（子串匹配，小写） |
| `POCKET_TOC` | `1` | 手机端「历史节点」胶囊开关（见下方「历史节点」） |
| `POCKET_ACCESS_LOG` | `1` | 访问日志开关 |
| `POCKET_RATE_LIMIT` | `600` | 单 IP 每分钟请求上限，`0` = 关闭 |
| `POCKET_PAIR_TTL_SEC` | `180` | 一次性配对口令有效期（秒），最小 30 |

### 命令行选项

```bash
node src/proxy.mjs --help
```

| 选项 | 作用 |
|---|---|
| `--port <端口>` | 等同 `POCKET_PORT` |
| `--pin <口令>` | 等同 `POCKET_PIN` |
| `--base <地址>` | 等同 `POCKET_PUBLIC_URL`；启动时直接打印配对链接 + 二维码 |
| `--pair-only` | 只生成配对链接并退出（要求代理已在运行，且必须给 `--base`） |
| `--pair-count <n>` | 配合 `--pair-only`，一次生成 1~20 条 |

> `--base` 只接受公网地址。填 `http://127.0.0.1:50980` 会被直接拒绝——
> 那会生成一条手机根本打不开的二维码，属于"看着成功、实际不可用"。

### 日志默认放在哪

⚠️ **不在仓库里。** 默认走平台状态目录：

| 平台 | 路径 |
|---|---|
| Windows | `%LOCALAPPDATA%\kimicode-pocket\logs\` |
| macOS | `~/Library/Application Support/kimicode-pocket/logs/` |
| Linux | `~/.local/state/kimicode-pocket/logs/`（尊重 `XDG_STATE_HOME`） |

这个包是**可交付物，不是运行目录**：从仓库里跑一次就往工作树写 `.logs`，
会让 `git status` 变脏，也让"干净发布"变成一件靠 `.gitignore` 兜底的事。
需要改位置就设 `POCKET_LOG_DIR`。

### 典型取值

**端口冲突：**

```bash
# Windows PowerShell
$env:POCKET_PORT = '60980'; node src/proxy.mjs

# macOS / Linux
POCKET_PORT=60980 node src/proxy.mjs
```

**自定义 Desktop 配置目录**（Desktop 用 `KIMI_CODE_HOME` 启动过的话）：

```bash
POCKET_APP_HOME=/opt/kimi-home node src/proxy.mjs
```

**加一道口令：**

```bash
POCKET_PIN='至少八位比较好' node src/proxy.mjs
```

### 如何确认配置生效

```bash
curl http://127.0.0.1:50980/__status
```

`__status` 会回显实际生效的全部配置（仅限本机访问）。其中 `pairCodesPending`
只统计**未兑换且未过期**的口令，别把它当成"发出去过多少个"：

```json
{
  "ok": true, "version": "1.3.0", "proxyPort": 50980, "bind": "127.0.0.1",
  "desktopPort": 54321, "appHome": "C:\\Users\\<你>\\.kimi-code",
  "publicUrl": "https://kimicode.example.com", "pinEnabled": false,
  "compress": true, "accessLog": true, "rateLimitPerMin": 600,
  "pairCodesPending": 1, "uptimeSec": 128, "node": "v22.11.0"
}
```

### 常驻时的环境变量

> ⚠️ 环境变量**只在当前 shell 有效**。用看门狗常驻时，变量要写进启动脚本
> 或系统服务定义里，否则重启后会回到默认值。

---

## 历史节点（手机端补回桌面那条目录）

### 桌面有、手机没有的原因

在电脑上，长会话右侧会有一列小竖条：每一轮提问一根，当前轮加长，点一下跳过去。
这是官方的「对话目录」。手机上它**不会出现**，原因不是数据缺失，而是组件里写死了：

```js
const u = D(() => !n.mobile && !n.sessionLoading && n.items.length > 1);
//                 ↑ 这一条
const $8e = 640, z8e = `(max-width: ${$8e}px)`;   // mobile 的定义
```

`mobile` 是 `matchMedia('(max-width: 640px)')` —— **纯宽度判断，没有 UA 嗅探**。
所以桌面端和手机端读的是同一份数据、同一个 `/transcript` 接口，
差别只在一条媒体查询：窗口 ≤640px 时组件不渲染。

> 顺带一个自检方法：电脑上把浏览器窗口拖到 640px 以下，那条目录会立刻消失；
> 拖回来又出现。

### 这个项目怎么补

代理在返回 `index.html` 时注入一小段脚本（约 30KB，内联、零依赖、无 CSP 冲突），
用官方自己加的 `data-turn-id` 重新画一个胶囊，**文案「历史节点」，
和输入框上方那排系统按钮同款**（28px 高、14px 字、10px 圆角、玻璃背景），
固定贴在同一行的最右端：

```
[ 后台 Bash ] [ 后台 Agent ]              [ 历史节点 ]
┌────────────────────────────────────────────────────┐
│  输入消息…                                          │
└────────────────────────────────────────────────────┘
```

点开向上弹出节点列表，当前节点加长加亮，点一下平滑滚过去并高亮。

### 节点来源：只认用户消息

官方目录列的是**用户发出去的话**，agent 的回复不进目录。这里必须严格对齐，
判据是宿主给的 class：

| class | 是什么 | 进目录 |
|---|---|---|
| `.u-bub` | 用户消息（含同一轮的追加提问 `t8.41.f1`） | ✅ |
| `.a-msg` | agent 回复（`t8.1.f1` / `t8.41.f2`，高度可达几千像素） | ❌ |

⚠️ 注意 **`.fN` 后缀跟「是不是 agent 回复」无关**：`t8.41.f1` 是用户气泡，
`t8.41.f2` 才是 agent 回复。曾经误以为 `.fN` 都是助手帧而改成全量查询，
结果列表里混进了「已工作 1m37s…」「关键发现：…」这类 agent 输出。

### 节点来源之二：乐观消息也不算节点

只认 `.u-bub` 还不够。**发送瞬间**前端会先塞一条本地临时用户消息占位，
等服务器回包后再换成真实轮次。这条占位消息同样挂着 `.u-bub[data-turn-id]`：

| 场景 | id 形态 |
|---|---|
| 普通发送 | `msg_opt_<base36 时间>_<自增>` |
| `/技能` 触发 | `msg_skill_opt_<base36 时间>` |
| 追加 / 转发 | `msg_opt_steer_<promptId>` |

真实轮次（`t<n>:input`）一到它就从 DOM 消失，但**已经写进 localStorage 的记录不会自己消失** ——
于是一条永远点不到的幽灵节点就挂在列表最下面。用户实测截图报的就是这个：
「实际只有 2 个节点，历史会话列表显示有 3 个」。

判据只有一条：**真实轮次一定是 `t<数字>` 开头**（`isRealTurnId`）。
`collect` / `recordFromDom` / `findNode` / `loadStore` 四处都过一遍，
最后那处是为了让已升级用户的历史幽灵自动清掉，不必手动清缓存。

### 三个关键取舍

**① 节点主键用整串 `turnId`，不用轮次序号。**
桌面目录 11 个节点，手机早期版本只有 9 个 —— 因为按 `t(\d+)` 抽序号去重，
把同一轮的追加消息（`t0.41.f1`，steered message）和首条消息（`t0:input`）
合并了。改成整串 `turnId` 当主键后与桌面 1:1 对齐，列表里也**不再显示序号**
（编号里夹着 task 占位轮，任何「第几轮」都对不上用户心里的轮次）。

**② 平滑滚动复用浏览器原生 `scroll-behavior:smooth`，不自己 rAF 逐帧推。**

| 方案 | 3 万像素会话跳转的帧耗时 |
|---|---|
| 自己 rAF 每帧写 `scrollTop` | 40 帧里 14 帧超 33ms，**p95 = 183ms**，最大 283ms |
| 原生 `scroll-behavior:smooth` | p50 = p95 = **17ms**，零长任务 |

原因：rAF 版本每帧都要同步读一次 `scrollHeight` / 元素位置来推进，
逼着浏览器在滚动中反复重排；CSS 平滑由合成器驱动，根本不经过主线程。

这条也**顺手修好了桌面端**：点官方目录时脚本给它临时加上
`scroll-behavior:smooth`，那一句 `scrollTop = X` 就自动变成平滑滚动；
用户一动手指（wheel / touch / 按键 / `scrollend`）立刻撤销，
不影响应用自己的「跟随最新消息」。

**③ 定位靠 `aria-posinset` 估算 + 二分收窄，不靠存下来的绝对像素。**

先说清三个被实测推翻的做法：

| 做法 | 为什么错 |
|---|---|
| 用小步「爬」向缓存位置 | 步进比渲染快：虚拟列表要 150~330ms 才挂上新行，80ms 查一次永远看不见目标 |
| 用「渲染出的最大 turnId」判方向 | Kimi 把最后一条用户消息（`t8:input`）当**常驻锚点**留在 DOM 里，恒判「目标在下方」 |
| 用缓存里的绝对像素 `y` | 文档高度在滚动中变（同一会话 35k~55k）。实测 t6 折算后差 12k，十几屏 |

现在的做法是用虚拟列表**自己暴露的行序号** `aria-posinset`：

```
t0:input=1  t2:input=8  t3:input=10  t5:input=14  t7:input=18  t8:input=20
（aria-setsize 恒为 23）
```

它与像素无关，在任意滚动位置都稳定。用 `pos/size` 算出比例一次跳过去，
命中率极高；没命中再二分（信号取「离视口探针线最近的那一行」，
且必须等渲染稳定后才读，否则读到的是上一屏）。

### 跳转：先定位，再滑过去

「点更早的节点会卡」的根本原因是**搜索阶段需要反复大跳**，每次都让虚拟列表
重排一大段（实测 p95 = 83ms）。定位过程省不掉，但可以让它不显眼：

```
点击 → 用缓存位置按文档高度同比缩放，直接跳过去（大部分一次命中）
     → 没命中：按方向每步推进 6 屏，直到目标进入渲染区间
     → 还没命中：以缓存位置为中心 ±8 屏密扫（覆盖「分段跳恰好跨过」）
     → 目标在 DOM 里了 → scroll-behavior:smooth 对到视口中央
     → 落地闭环校正（虚拟列表重排后可能有几十像素偏差）
```

实测（手机视口 420×860，向上点更早的节点）：

| 指标 | 结果 |
|---|---|
| 落位 | **5/5 全部落在视口内** |
| 用时 | 335 ~ 1473ms，平均 647ms，4/5 在 1 秒内 |

**1.6.5 删掉了一层全屏遮罩（「光幕」）。** 它本来是为了「让搜索过程看不见」，
但实测下来它就是闪屏的来源 —— 每次跳转 = 一次 150ms 整屏淡入淡出，
跨得越多越明显。删掉之后闪屏消失，定位精度没有变差。

已知未做到：**全程 60 帧**。分段瞬移仍会有长帧。
短距离 `scroll-behavior:smooth` 实测 p50 = p95 = max = 17ms、零掉帧，
但应用自身在滚动过程中不断写 `scrollTop`，会把平滑段反复打断
（一段 1.4 屏都走不完就被拽回）。这一条还没解决，如实写在这里。

### 什么时候不显示

胶囊贴的是输入框那一行，所以**输入框不在的时候它就不该在**。三种情况会隐藏：

| 情况 | 判据 |
|---|---|
| 有浮层盖住 | `.sheet-root` / `.sheet-scrim` / `[role=dialog]` / `[aria-modal]` 且占视口 ≥ 60%×30% |
| 会话还没渲染 | `chatRendered` 还没闩上（缓存里有记录不算数） |
| 输入框被顶出视口 | workbar 的 rect 与视口无交集 |

浮层的判断**不能用 `elementFromPoint` 命中测试**：胶囊的 `z-index` 是
`2147483002`，全场最高，命中的永远是它自己，测不出下面有没有浮层。

浮层状态还必须进 `posSig`（定位签名）。只加判断、不进签名的话，
浮层关掉后签名没变，`place()` 不再被调用，`placeOk` 会永远停在 false ——
胶囊再也回不来。这个坑在 1.6.8 第一次改的时候真踩了。

「会话还没渲染」这一条单独立了 `chatRendered` 闩，而不是用「当前 `.u-bub` 数 ≥ 1」：
虚拟列表滚到两个用户气泡之间的长区域时视口里可能一个气泡都没有，那样胶囊会闪没。

### 图片为什么转成 JPEG

长会话的体积几乎全在工具截图里。实测一个会话 `/transcript`：

```
83.79MB 原始 → 12.59MB（只降分辨率，仍是 PNG）
其中图片 67 张仍占 66.49MB 的 7.08MB
```

逐张量过（平均 115KB，全部 RGB 无 alpha）：

| 方案 | 平均体积 | 结果 |
|---|---|---|
| PNG 重编码 | 115KB | 0%，PNG 对截图几乎压不动 |
| PNG 再降到 1/4 像素 | 63KB | 省 45%，但已经糊了 |
| **JPEG q80** | **21KB** | **省 81%，尺寸不变，PSNR 38~39dB** |

耗时实测几乎一样（33.8ms vs 32.8ms），所以换 JPEG 是纯收益。
编码器是自己写的基线 JPEG（项目坚持零依赖），4:2:0 色度下采样。

**注意一个容易写错的地方**：不要用「像素数已在上限内就跳过」当优化。
实测原实现就因为这个判断，67 张图只处理了 1 张 —— 而已经降采样过的
666x416 截图恰恰是体积大头。正确做法是「尺寸够小就不缩，但仍然重新编码」。

生产实测：图片 66.49MB → 1696KB（−97.5%），实际传输 7.13MB → 1.68MB（−76%）。

### 传输中断会被记下来

`res.on('finish')` 只表示**数据交给了内核缓冲区**，不代表对端收到。
实测 6MB 在本地回环 4ms 就写完了，此时 `writableFinished=true`、
`bytesWritten` 是完整值 —— 服务端根本无从得知用户什么都没收到。

所以大响应改成**分块写 + 等 drain**：一旦对端消失就会抛 `ECONNRESET`
且 `writableFinished` 保持 false。压缩路径要单独处理，因为
`z.pipe(res)` 会把数据一路推进内核，`writableFinished` 在那儿照样是 true，
只能靠 socket 的 error 事件判定。

日志里会多出这样一行：

```
传输中断 1.2.3.4 GET /api/v1/sessions/.../transcript:
  声明 5989618B，实际写出 3932637B —— 客户端没收到完整响应
```

没有这一行的话，「手机上 Failed to fetch 但日志显示 200」这种现象
是永远查不出来的。

### 预加载与持久化

客户端打开会话时其实**一次性拿到了整段 transcript**（实测 22 条 / 9 轮 / 2.1MB，
`has_more=false`），节点不是「没加载」而是「没渲染」。但整篇扫一遍对长会话代价太大
（3 万像素要扫 40+ 屏），所以：

- 只静默预扫**最近 5 个节点**，够了立刻收手
- 扫描期间不改用户看到的位置（原本贴底就重新贴底）
- 手动上滑看到哪一轮，哪一轮就自动进列表：心跳每 400ms 扫一次 DOM
- 已加载的**标题 + 位置**写进 `localStorage`（key 带 `kimi-pocket.toc.` 前缀），
  刷新回来列表还在，不用重新加载

### 系统按钮变多怎么办

左侧那一行（`.dock-workbar`）如果出现第三、第四个系统按钮，
脚本把它改成**横向滑动**（`overflow-x:auto` + `flex-wrap:nowrap`，
隐藏滚动条），并在末尾给胶囊预留宽度：

- `flex-wrap` 必须 `!important` —— 应用自己写的是 `wrap`，且样式表在文档里更靠后，
  不加 `!important` 会被压回换行（实测溢出为 0，根本不产生横向滚动）
- 「历史节点」用 `position:fixed` + `z-index:2147483002`（高于 `chat-dock` 的 100），
  **永远固定在右上角**，不会被滑走、也不会被系统按钮盖住

### 一个必须说清的边界

有些节点**不在前端的可加载范围内**（更早的轮次需要用户手动上滑才会渲染）。
所以行为是：

- **能找到** → 平滑滚过去居中 + 短暂高亮
- **找不到** → 不改滚动位置，弹一条提示「这条还没加载到，先手动上滑一下再点」

绝不假装成功，也绝不乱跳。

### 配置

```bash
POCKET_TOC=0     # 关掉历史节点，首页恢复为上游原样（默认 1）
```

### 什么时候它会自动让位

窗口宽度 >640px 时，官方目录自己会渲染。检测到 `.conversation-toc` 可见，
注入版会自动隐藏，**不会出现两条导轨**。

---

## 大响应瘦身（只压截图，不动文字）

### 这个功能解决什么问题

手机上打开某些会话时，顶部弹出：

```
无法连接到 Kimi 服务器
Web 没有拿到 Kimi 服务器的响应。
```

展开「查看详情」，会看到一组很反直觉的组合：

| 字段 | 值 |
|---|---|
| HTTP 状态 | **200** |
| 失败阶段 | `parse` |
| 底层原因 | `TypeError: Failed to fetch` |

**200 却失败**，说明响应头已经正常返回了——问题出在**响应体没读完**就被浏览器的
`fetch` 超时（通常 30 秒）掐断。真正的原因是**数据太大**。

### 体积到底花在哪里

逐字段统计后才看清：**几乎全在工具截图上**。

| 响应 | 总大小 | 截图 base64 | 文字 |
|---|---|---|---|
| `/messages` | 5.41 MB | **5.36 MB（99.1%）** | < 50 KB |
| `/transcript` | 51.00 MB | **48.63 MB（95.4%）** | 1.95 MB |

Desktop 会把工具执行时截的图以 `data:image/png;base64,...` 内嵌在响应里，
单张 2000×1250 的截图就有 **1.5 MB**。一个会话几十张，体积就上去了。

> ⚠️ **`page_size` 对它无效**：实测 `page_size=1 / 3 / 10` 返回的都是同一份
> 全量数据。不能靠调分页规避。

### 怎么解决：只降图片分辨率

> **文字一个字符都不动。** 这是设计红线。
>
> 早期版本曾按「总预算对折所有字符串」来压，结果把 846 字符的正文砍成了
> 41 字符 + 一行省略号 —— 用信息的完整性去换体积，是错的。
> 现在的做法只动图片：图片是有损也无所谓的呈现层，降分辨率后照样看得清；
> 文字少一个字都可能改变语义。

```
原来：{"imageUrl":{"url":"data:image/png;base64,iVBORw0KGgo…（2000×1250，1.5 MB）"}}
现在：{"imageUrl":{"url":"data:image/png;base64,iVBORw0KGgo…（666×416，112 KB）"}}
```

压缩在传输层完成：纯 JS 解码 PNG → 箱式降采样 → 重新编码，**零依赖**。
JSON 结构、字段名、数组长度、以及所有文字内容**完全不变**。

### 效果（实测）

| 项 | 数值 |
|---|---|
| `/transcript` | 51.00 MB → **8.07 MB**（图片 35.85 MB → 3.46 MB，−90.6%） |
| `/messages` | 5.41 MB → **0.51 MB**（图片 4.02 MB → 361 KB，−91.2%） |
| 首次处理耗时 | 1.2 s（31 张图，worker 线程并行） |
| 二次请求耗时 | **27 ms**（整响应缓存命中） |

响应头带 `x-pocket-trimmed: 1`，便于确认是否命中。

单张 2000×1250 截图的档位对比：

| 档位 | 尺寸 | 单张体积 | 31 张合计 | 耗时 |
|---|---|---|---|---|
| 原图 | 2000×1250 | 1563 KB | 35.85 MB | — |
| **÷3（默认）** | 666×416 | ~112 KB | **3.46 MB** | 1.2 s |
| ÷2 | 1000×625 | ~215 KB | 7.4 MB | 2.3 s |

### 性能设计

长会话要处理 30+ 张图，如果都在主线程同步做，Node 会被卡住 —— 期间所有
HTTP 请求、WebSocket 心跳全部排队，页面表现为「卡死 / 一直加载中」。
所以：

- **worker 线程池**（默认 4 个）：CPU 活在别的线程跑，主线程只负责 IO。
- **图片级缓存**：按内容哈希，同一张图只算一次。
- **整响应缓存**：内容没变时直接复用，51 MB 的二次请求 27 ms。
- **并发闸门**：同一时刻最多处理 2 个瘦身任务，其余排队（上游流不读，
  靠 TCP 背压把压力推回 Desktop，内存不会爆）。
- **重复请求合并**：前端会并发打 13 个一模一样的 `/transcript`，只算一次。

### 生效范围

| 会处理 | 不会处理 |
|---|---|
| 路径含 `transcript` 或 `messages` | 会话列表、status、models 等 |
| `data:image/png;base64,...` | JPEG / WebP（已是压缩格式） |
| 像素数 > `POCKET_IMG_MAX_PIXELS` | 小图（不值得二次编码） |
| `application/json` | `text/event-stream`（SSE，处理会破坏流） |
| 大于 `POCKET_TRIM_MIN_KB`（默认 256 KB） | 小于阈值的小响应 |
| 上游未压缩的响应 | 上游已带 `content-encoding` 的 |

### 调整力度

```bash
# 更小：单张图压到 144000 像素（500×312），体积再降一半
POCKET_IMG_MAX_PIXELS=144000 node src/proxy.mjs

# 更清晰：允许 1000×640
POCKET_IMG_MAX_PIXELS=640000 node src/proxy.mjs

# 完全关闭（只想原样透传，接受长会话打不开）
POCKET_TRIM=0 node src/proxy.mjs

# 只对 transcript 生效，不动 messages
POCKET_TRIM_PATHS=transcript node src/proxy.mjs
```

### 已知边界

- **降采样是有损的**：截图变小后细节会损失。文字仍可辨认，但不适合放大细看；
  需要原图时在电脑上查看。
- **只处理 PNG**。若 Kimi 后续改成 JPEG / WebP 截图，本条会自动跳过
  （不会破坏内容，只是不再瘦身）。
- 瘦身**只在代理这一层**做，Desktop 的原始数据完好无损。
- 若某张图的 JSON 骨架本身就超过缓冲上限（默认 128 MB），该响应会原样放过
  并可能仍然打不开 —— 此时可调 `POCKET_TRIM_MAX_BUFFER_MB`。

---



## 平台适配

核心代理 `src/proxy.mjs` + `src/lib/*` **三平台完全通用**（纯 Node 内置模块）。
差异只在**常驻方式**和**路径**。

### 配置目录（三平台一致）

```
~/.kimi-code/server/instances/*.json
~/.kimi-code/server.token
```

Desktop 用 `KIMI_CODE_HOME ?? os.homedir()/.kimi-code` 推导，**三平台同一相对路径**：

| 平台 | 实际路径 |
|---|---|
| Windows | `C:\Users\<你>\.kimi-code\server\instances\` |
| macOS | `/Users/<你>/.kimi-code/server/instances/` |
| Linux | `/home/<你>/.kimi-code/server/instances/` |

### 脚本对照

| 功能 | Windows | macOS / Linux | 实测状态 |
|---|---|---|---|
| 启动代理 | `node src/proxy.mjs` | 同左 | ✅ Windows 实测；三平台代码一致 |
| 启动隧道 | `scripts/start-tunnel.ps1` | `scripts/start-tunnel.sh` | ⚠️ 见下方说明 |
| 常驻 | `scripts/watchdog.ps1` + `.vbs` | `scripts/watchdog.sh` 或 systemd / launchd | ✅ Windows 有长期运行痕迹 |
| 停止 | `scripts/stop.ps1` | `scripts/stop.sh` | ✅ Windows 实测 |
| 隧道服务管理 | `scripts/tunnel-service.ps1` | `scripts/tunnel-service.sh` | Windows `status`/`check` 实测；`harden`/`watch` 需管理员；*nix 未实测 |
| 测试 | `npm test` | `npm test` | ✅ Windows 实测 135/135；CI 覆盖三平台 |

> ### ⚠️ 关于脚本验证状态（请先读）
>
> **`src/proxy.mjs` 是核心，三平台通用**，其中的转发逻辑（端口发现、Host/Origin 改写、
> WebSocket 透传）来自**已在生产长期运行的实现**；本次新增的能力
> （配对、PIN、压缩、限速、本机判定、配对状态回显）已有 135 个自动化测试覆盖，其中包含真实拉起进程的集成测试（假 Desktop 全链路 + CLI 入口）。
>
> 但要说清楚：**`scripts/*.sh` 三个 shell 脚本只在 Git Bash 做过 `bash -n` 语法校验，
> 未在真实 macOS / Linux 上端到端跑通。** `start-tunnel.ps1` 是重写过的版本，
> 其链路（隧道 → 代理 → Desktop）**尚未在真实环境完整跑过一次**。
>
> 它们大概率可用（逻辑与已验证版本一一对应），但可能存在**平台差异**：
>
> - `ps -Ao pid=,args=` 的输出格式在 BSD/macOS 与 GNU/Linux 上略有差异
> - `curl` 在 BusyBox 精简版里参数支持不全
> - `nohup` + `&` 在 systemd 会话里的行为
> - `env -u` 需要 coreutils（macOS 自带版本支持）
>
> **因此：在 macOS / Linux 上部署时，请以「目标与判据」为准，把脚本当作参考实现。
> 若脚本报错，直接用 `node src/proxy.mjs` 手动启动并自行拼接 cloudflared 命令即可
> ——核心功能不依赖这些脚本。**

### macOS 特别注意

1. **必须保持用户登录**。macOS 注销后 GUI 应用会退出。
2. **防止休眠**：系统设置 → 锁定屏幕 → 「显示器关闭时…进入睡眠」设为**永不**。
3. **首次运行 shell 脚本**需要执行权限：

   ```bash
   chmod +x scripts/*.sh
   ```

4. **Gatekeeper**：从网络下载的脚本可能被隔离，需要：

   ```bash
   xattr -d com.apple.quarantine scripts/*.sh
   ```

### Linux 特别注意

1. **必须有图形会话**（X11 / Wayland）。纯 SSH 的无头服务器**不适用**。
2. 若通过 SSH 启动 GUI 相关进程，需要设置 `DISPLAY`（本机桌面）或 `WAYLAND_DISPLAY`。
3. 端口 < 1024 需要 root，所以默认 `50980` 是安全的选择。

---

## 常驻运行（7×24）

**核心目标**：代理挂了自动重启、开机自动拉起。

### Windows

**方案 1：任务计划程序（推荐）**

1. 打开「任务计划程序」→ 创建任务
2. **常规**：勾选「只在用户登录时运行」（这样才能看到 Desktop GUI）
3. **触发器**：新建 → 「登录时」
4. **操作**：启动程序
   - 程序：`powershell.exe`
   - 参数：`-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\path\to\kimicode-pocket\scripts\watchdog.ps1"`
5. **条件**：取消「只有在计算机使用交流电源时才启动」
6. **设置**：勾选「如果任务失败，每隔 1 分钟重新启动」

**方案 2：Startup 目录 + VBS（最简单）**

1. `Win+R` → `shell:startup`
2. **右键拖动** `scripts\start-watchdog.vbs` 到该目录 → 创建快捷方式
   （不要直接复制文件：脚本路径是按自身位置推导的）
3. 下次登录即以隐藏窗口自启

**方案 3：让 Desktop 自己也自启**

Kimi Code Desktop 一般有「开机启动」选项，建议一并打开，
否则电脑重启后代理活着但找不到 Desktop（`/__healthz` 返回 `ok:false`）。

**电源设置（关键）**：

- 控制面板 → 电源选项 → 更改计划设置 → 「使计算机进入睡眠状态」设为**从不**
- 「关闭显示器」可以保留（不影响程序运行）
- 笔记本注意：合盖可能触发睡眠，需在电源选项里改「合盖时」的行为

### macOS

**方案 1：launchd（推荐）**

在 `~/Library/LaunchAgents/` 下创建 `com.kimicode.pocket.plist`：

| 字段 | 值 |
|---|---|
| `Label` | `com.kimicode.pocket` |
| `ProgramArguments` | `["/usr/local/bin/node", "/path/to/kimicode-pocket/src/proxy.mjs"]` |
| `RunAtLoad` | `true` |
| `KeepAlive` | `true` |
| `StandardOutPath` / `StandardErrorPath` | 日志路径 |
| `EnvironmentVariables` | `POCKET_PORT` / `POCKET_PIN` 等 |

加载：`launchctl load ~/Library/LaunchAgents/com.kimicode.pocket.plist`

> `RunAtLoad` + `KeepAlive` 已覆盖看门狗功能，macOS 上可以不用 `watchdog.sh`。

**方案 2：简单版**

```bash
nohup ./scripts/watchdog.sh >/dev/null 2>&1 &
```

### Linux

**方案 1：systemd 用户服务（推荐）**

前提：**必须在图形会话内**（本机桌面），不是无头服务器。

在 `~/.config/systemd/user/` 下创建 `kimicode-pocket.service`：

| 字段 | 值 |
|---|---|
| `[Unit] After` | `graphical-session.target` |
| `[Service] ExecStart` | `/usr/bin/node /path/to/kimicode-pocket/src/proxy.mjs` |
| `[Service] Restart` | `always` |
| `[Service] RestartSec` | `5` |
| `[Service] Environment` | `POCKET_PORT=50980`（如需改配置） |
| `[Install] WantedBy` | `default.target` |

```bash
systemctl --user daemon-reload
systemctl --user enable --now kimicode-pocket
systemctl --user status kimicode-pocket
```

> `Restart=always` 已覆盖看门狗。日志：`journalctl --user -u kimicode-pocket -f`。

### 三平台通用：重启验证

配置完**必须**做一次：

1. 重启电脑
2. 等桌面登录完成
3. `curl http://127.0.0.1:50980/__healthz`
4. 期望 `{"ok":true,"desktopPort":<非null>}`

若 `ok:false` → 代理起来了但 Desktop 没起来，去检查 Desktop 的开机自启。

---

## 生产部署：命名隧道 + 固定域名

快速隧道（`trycloudflare.com`）**每次重启地址都会变**，只适合临时试用。
7×24 用的话应该走**命名隧道 + 自己的域名 + Cloudflare Access**——
这也是本项目的参考部署方式（下面所有结构都来自真实在跑的配置）。

### 两种入口怎么选

| | 快速隧道 | 命名隧道（推荐） |
|---|---|---|
| 地址 | 每次启动都变 | **固定** `kimicode.example.com` |
| 配 Access | ❌ 不支持 | ✅ 支持 |
| 常驻 | 需自己看护进程 | 装成系统服务，开机自启 |
| 适用 | 试一下、临时用 | 长期 / 7×24 |

### 步骤 A：创建隧道（在控制台里做，推荐）

> **推荐用「远程管理」模式**：隧道配置存在 Cloudflare 上，本机只有一个 token，
> 不需要维护 `config.yml`。本项目的实际部署就是这种。

1. 域名接入 Cloudflare（NS 指过去），等待状态变成 **Active**
2. 进入 [Zero Trust](https://one.dash.cloudflare.com/) → **Networks → Tunnels → Create a tunnel**
3. 选 **Cloudflared**，起个名字（如 `home`），保存
4. 在 **Public Hostname** 里加一条：

   | 字段 | 值 |
   |---|---|
   | Subdomain | `kimicode` |
   | Domain | 你的域名 |
   | Type | `HTTP` |
   | URL | `127.0.0.1:50980` |

   > ⚠️ **URL 必须填代理的固定端口 `50980`，不是 Desktop 的动态端口。**
   > 也不要填 `https://`——cloudflared 到本机这一段是明文 HTTP。

5. 复制页面给的 **安装命令**（里面带 token），到目标机器上执行：

   ```bash
   # Windows / macOS / Linux 都一样，token 由控制台生成
   cloudflared service install <YOUR_TUNNEL_TOKEN>
   ```

   装完即注册为系统服务并开机自启，**不需要 `config.yml`**。

#### 附：隧道常驻方式（三平台对照）

**一条命令，三个不同的服务管理器。** 这是最容易被忽略的差异：

| 平台 | 落到哪里 | 何时启动 | 需要用户登录桌面吗 |
|---|---|---|---|
| Windows | SCM 服务 `cloudflared`（以 LocalSystem 运行） | 开机 | ❌ 不需要 |
| macOS | `/Library/LaunchDaemons/` 下的 LaunchDaemon（root） | 开机 | ❌ 不需要 |
| Linux | `/etc/systemd/system/cloudflared.service`（systemd system unit） | 开机 | ❌ 不需要 |

> **这一点决定了本项目的架构分工**：
> **隧道是「系统级」，代理是「用户级」。**
> 隧道只要能连 `127.0.0.1:50980`，完全不需要图形会话；
> 而 `proxy.mjs` 必须跑在用户的桌面会话里（因为 Desktop 是 GUI 应用）。
>
> 所以：**不要把 cloudflared 塞进 `watchdog.ps1`** —— 它有自己的服务管理器，
> 两套看护叠在一起只会互相打架。

**各平台可选方式**

Windows：

| 方式 | 开机自启 | 崩溃重启 | 说明 |
|---|---|---|---|
| `cloudflared service install <TOKEN>` | ✅ | ❌ **默认不会**，要补 `sc failure` | 官方推荐 |
| 任务计划程序（登录时/开机时） | ✅ | ✅「任务失败时重启」 | 想复用现有调度 |
| NSSM / WinSW 包一层服务 | ✅ | ✅ | 想统一日志与重启策略 |
| 启动文件夹 `.vbs` | 登录时 | ❌ | 最土，只适合临时 |

macOS：

| 方式 | 开机自启 | 崩溃重启 | 说明 |
|---|---|---|---|
| `sudo cloudflared service install <TOKEN>` | ✅ 开机 | ✅ | 官方推荐 |
| 自写 LaunchDaemon | ✅ 开机 | ✅ `KeepAlive` | 要控制日志/环境变量时 |
| 自写 LaunchAgent | 仅**登录**后 | ✅ | ⚠️ 会继承用户环境变量，容易踩 1033 |
| `nohup` 前台 | ❌ | ❌ | 临时 |

Linux：

| 方式 | 开机自启 | 崩溃重启 | 说明 |
|---|---|---|---|
| `sudo cloudflared service install <TOKEN>` | ✅ 开机 | 视版本而定 | 官方推荐，装完用 `systemctl cat` 确认 |
| 自写 systemd **system** unit + drop-in | ✅ 开机 | ✅ `Restart=always` | 最可控，推荐 |
| systemd **user** unit | 仅**登录**后 | ✅ | ⚠️ 隧道的反例：桌面会话没起来隧道就不起 |
| OpenRC / runit / s6 | ✅ 开机 | ✅ | Alpine、Void 等非 systemd 发行版 |
| supervisord / pm2 | 需自身先自启 | ✅ | 已有进程管理体系时 |
| Docker + `--restart unless-stopped` | ✅ | ✅ | 容器化部署 |

**开机自启 + 看门狗的正确分工**

| 组件 | 谁拉起（自启） | 谁重启（故障） | 常见错误 |
|---|---|---|---|
| `cloudflared` | 系统级服务，开机 | 服务管理器 | 塞进 watchdog，和 SCM/systemd 抢 |
| `proxy.mjs` | 用户级，登录时 | `watchdog.ps1` / launchd `KeepAlive` / systemd `--user` `Restart=always` | 装成系统服务 → 拿不到桌面会话 |
| Kimi Code Desktop | 应用自身的「开机启动」 | 应用自身 | 忘了开，重启后代理活着但 `ok:false` |

**用工具做（推荐）**

上面这些「装服务 + 配自重启 + 查健康 + 定时自愈」都收进了一个脚本，
不用背命令：

```powershell
# Windows（需要管理员）
pwsh -File scripts\tunnel-service.ps1 status      # 查状态（不需要管理员）
pwsh -File scripts\tunnel-service.ps1 harden      # 配崩溃自重启
pwsh -File scripts\tunnel-service.ps1 check       # 探一次健康
pwsh -File scripts\tunnel-service.ps1 watch       # 装定时健康检查（每 5 分钟）
```

```bash
# macOS / Linux（需要 sudo）
sudo ./scripts/tunnel-service.sh status
sudo ./scripts/tunnel-service.sh harden
sudo ./scripts/tunnel-service.sh check
sudo ./scripts/tunnel-service.sh watch
```

`install` 也能一步到位：`tunnel-service.ps1 install -Token <TOKEN>` /
`sudo ./scripts/tunnel-service.sh install <TOKEN>`。

> **这个工具和它放在哪个目录无关**：
> `harden` / `install` / `uninstall` 只操作系统服务，不写任何文件；
> `check` 的失败计数写在**用户级状态目录**
> （Windows `%LOCALAPPDATA%\kimicode-pocket`、Linux `${XDG_STATE_HOME}`、
> macOS `~/Library/Application Support/kimicode-pocket`），不落在脚本目录。
>
> 只有 **`watch` 会把定时任务绑定到脚本路径**。所以如果你把这个仓库当作
> "待发布源码"而不是"运行目录"，请**先把 `tunnel-service.*` 复制到一个固定的
> 运行目录再执行 `watch`** —— 否则源码目录一移动/删除，定时任务就静默失效了。
> 工具检测到旁边有 `package.json` 时会主动提示这一点。

#### 隧道要不要自己的看门狗？

**要，但不是"进程存活"那种。** 这里必须分清楚两层：

| 故障形态 | 谁能发现 | 谁负责恢复 |
|---|---|---|
| 进程崩了 / 被杀 | 服务管理器 | Windows `sc failure`、systemd `Restart=always`、launchd `KeepAlive` |
| **进程活着，但到边缘的连接掉了** | 只有主动探测 | 健康检查 + 定时器 |
| 本地代理挂了 | `watchdog.ps1` / `.sh` | 项目已有的代理看门狗 |

第二层是最容易被忽略的：NAT 老化、Wi-Fi 切到有线、开关 VPN/Clash，
都可能让 cloudflared **进程还在、但连接没了**——表现就是手机上
`error 1033`，而本机一切正常。服务管理器对此完全无感。

所以本项目不做"第二个常驻看门狗进程"，而是：

```
cloudflared 自己在 127.0.0.1:20241/ready 暴露真实连接数
        ↓
tunnel-service 的 check 读 readyConnections
        ↓
连续 2 次为 0 才重启服务（防抖，别一次抖动就打断会话）
        ↓
用各系统自己的定时器调度（不新增常驻进程）
```

三平台的定时器分别是：

| 平台 | 定时机制 | 装载命令 |
|---|---|---|
| Windows | 任务计划程序（SYSTEM，每 5 分钟） | `tunnel-service.ps1 watch` |
| macOS | LaunchDaemon `StartInterval` | `tunnel-service.sh watch` |
| Linux | systemd timer（`OnUnitActiveSec`） | `tunnel-service.sh watch` |

看实际输出：

```bash
curl -s http://127.0.0.1:20241/ready
# {"status":200,"readyConnections":3,"connectorId":"..."}
```

> `readyConnections` 是**真实边缘连接数**，不是心跳计数。
> 它是"隧道到底通不通"最可靠的本地判据——不用打公网、不用过 Access。
>
> 同一台机器跑多条隧道时，每条要有独立的 `--metrics` 端口，
> 用 `-MetricsPort` / `--port` 指定要盯哪一条。

**手动等价命令（如果你不想用工具）**

Windows：

```powershell
sc.exe failure cloudflared reset= 86400 actions= restart/5000/restart/10000/restart/30000
sc.exe failureflag cloudflared 1
sc.exe qfailure cloudflared        # 确认
```

Linux：

```bash
systemctl cat cloudflared            # 先看现状
sudo systemctl edit cloudflared      # 写入：
# [Unit]
# StartLimitIntervalSec=0
# [Service]
# Restart=always
# RestartSec=5
sudo systemctl daemon-reload && sudo systemctl restart cloudflared
```

不配这一层的话，cloudflared 偶发崩溃就得等下次重启电脑才恢复——而表现是
「手机上一片 502，但本机 `127.0.0.1:50980` 完全正常」，很容易误判成代理的问题。

卸载：`cloudflared service uninstall`（Windows 需管理员，macOS/Linux 加 `sudo`），
或 `tunnel-service.ps1 uninstall` / `sudo ./scripts/tunnel-service.sh uninstall`。

**macOS 的一个额外好处**

LaunchDaemon **不继承用户 shell 的环境变量**，所以你 shell 里残留的
`HTTP_PROXY` 不会传染给隧道——反而比手动 `nohup` 更不容易踩 `error 1033`。
反过来说，如果你用的是 LaunchAgent（登录后启动），它就会继承。

**token 模式的固有风险**

token 会明文落在服务定义里：Windows 在注册表 `ImagePath`、Linux 在
`ExecStart=`、macOS 在 plist 中。**本机管理员都能读到。**
共用机器上建议改用「本地管理 + `credentials-file`」并收紧文件权限，
或者干脆只在那台专用机器上开 token 模式。

### 步骤 B：`originRequest` 要不要配？

**不需要 `httpHostHeader`。**

实测依据：本项目的参考部署里，ingress 就是一行

```yaml
- hostname: kimicode.example.com
  service: http://127.0.0.1:50980
```

没有 `originRequest`，公网访问正常。原因很简单——**代理自己会把 Host 改成
`127.0.0.1:<动态端口>`**，cloudflared 传什么 Host 进来都不影响结果。

> 早期文档说"少了 `httpHostHeader` 必然 403/502"，那是**在隧道直连 Desktop、
> 不经过代理**的场景下才成立。已经改正，见 [CHANGELOG](CHANGELOG.md)。

### 步骤 C：DNS

控制台加 Public Hostname 时会自动建一条记录，形如：

```text
kimicode.example.com   CNAME   <tunnel-id>.cfargotunnel.com   已代理（橙云）
```

**这条记录的「已代理」必须打开（橙云）。**

- 灰云（DNS only）→ 流量绕过 Cloudflare → **Access 失效**，且 Host 头变成你的域名
- `cfargotunnel.com` 指向的是 Cloudflare 内网地址，公网直连不通，这是正常的

命令行也能建：

```bash
cloudflared tunnel route dns kimicode kimicode.example.com
```

### 步骤 D：接一行 Access（强烈建议）

命名隧道 + Access 才是完整形态。Fast Tunnel 加不了 Access。

配置要点（均为控制台现有字段）：

| 字段 | 建议值 | 说明 |
|---|---|---|
| Application type | `Self-hosted` | |
| Application domain | `kimicode.example.com` | 必须与隧道 hostname **完全一致** |
| Session Duration | `8 hours` 或更短 | 越长越省事，但被盗用的窗口也越长 |
| Policy Action | `Allow` | |
| Policy Include | `Emails` → 你自己的邮箱 | |

> 配完用**无痕窗口**验证：应该先跳到 `https://<team>.cloudflareaccess.com/...` 登录页。
> 如果无痕窗口直接进了 Web UI，说明 Access 没生效，回去核对域名拼写。

### 步骤 E（可选）：不用控制台，本地管理

也可以完全不碰控制台，用 `config.yml`：

```yaml
tunnel: kimicode
credentials-file: /path/to/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: kimicode.example.com
    service: http://127.0.0.1:50980
  - service: http_status:404      # 兜底，必须放最后
```

```bash
cloudflared tunnel create kimicode
cloudflared tunnel route dns kimicode kimicode.example.com
cloudflared service install
```

> 本地管理模式下，改配置要改文件 + 重启服务；远程管理模式改完保存即生效。
> 两者**不要混用**（同一隧道同时有本地 config 和控制台配置会以控制台为准，容易困惑）。

### ⚠️ 隧道通常是和别人共用的

一条隧道可以挂多个 hostname（比如 `app-a.example.com`、`app-b.example.com`、
`kimicode.example.com` 共用一条）。改 ingress 时注意两点：

1. **`http_status:404` 必须留在最后一行**，否则它会把后面所有规则都吃掉
2. **带 `path` 的规则要排在只有 `hostname` 的规则前面**，否则永远匹配不到

改完先确认别的服务没断，再离开页面。

---


## 安全加固

分四层，**建议至少做前两层**。

### 第零层：先搞清楚"本机"到底指什么（1.3.0 修过的一个真漏洞）

这一条不是配置，是**必须理解的前提**。

`cloudflared` 在**本机**发起回环连接，所以经隧道进来的公网请求，
`remoteAddress` **也是 `127.0.0.1`**。如果代码只看 socket 地址，就会把
全世界的请求当成"本机直连"——`/__pair`（本机免口令那条路）、
`/__paircode`、`/__status` 一起裸奔，等于把 Desktop 的 `server.token`
挂在公网首页上。

1.3.0 起，「本机直连」的定义是 **回环 socket + 不带 Cloudflare 头**
（`CF-Connecting-IP` / `CF-Ray` 任一存在即视为经隧道来访），并且：

- `/__pair` **没有**任何免口令的旁路，一律必须持一次性 code
- `/__status`、`/__paircode`、`/__pairstatus`、`/__qrcode` 对隧道来源一律 404
- `/__healthz` 对隧道来源只回 `{"ok":true}`

> 升级到 1.3.0 之后你会发现：从公网访问 `/__status` 是 404。**这是对的**，
> 不要试图"修"它。

### 第一层：`POCKET_PIN`（免费、5 秒）

```bash
POCKET_PIN='你的口令至少八位' node src/proxy.mjs
```

效果：

- 打开任何页面先要口令（`/__login`）
- Cookie 会话 7 天，`HttpOnly` + `SameSite=Lax`
- 连续输错 **5 次锁 60 秒**
- 换 PIN 即全端下线（会话密钥由 PIN 派生）

> 诚实说明：Desktop 的 `server.token` 是 43 字符随机串（约 250 bit 熵），
> **爆破在数学上不可行**。PIN 的价值不是"防爆破"，而是
> 「token 万一泄露还有一层」+「可以随时换口令而不动 Desktop」。

### 第二层：Cloudflare Access（长期使用强烈建议）

Access 在隧道**之前**加一层身份验证，即使 URL 泄露也进不来。

1. 登录 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/)
2. **Access → Applications → Add an application → Self-hosted**
3. 填写：
   - **Application name**：`KimiCode Pocket`
   - **Session Duration**：建议 `8 hours` 或更短
   - **Application domain**：`kimicode.example.com`
4. **Add a policy**：Action `Allow` → `Emails` → 你自己的邮箱
5. 保存

**验证**：用**无痕窗口**访问，应该先跳 Cloudflare 登录页。
如果无痕窗口能直接进 Web UI，说明 Access 没生效，回去检查域名是否完全一致。

### 第三层：Zone 级开关（一次配好，长期有效）

这些在 **Cloudflare 控制台 → 你的域名 → SSL/TLS 与 Security** 里，属于整域设置：

| 设置 | 建议 | 为什么 |
|---|---|---|
| **Always Use HTTPS** | 开 | 手机在弱网下更容易手输 `http://`，开了就自动跳 |
| **Minimum TLS Version** | **1.2** 起 | 默认常是 1.0（TLS 1.0/1.1 已被各大浏览器弃用，属无谓的攻击面） |
| **HSTS** | 开，`max-age` ≥ 半年 | 防止降级攻击；开了之后**不要轻易关**，浏览器会记住 |
| **SSL/TLS 模式** | Full（strict） | 隧道回源走 Cloudflare 内部加密通道，与这个设置关系不大，但整域建议从严 |
| **Bot Fight / Security Level** | Medium 起 | 挡掉一部分自动化扫描 |

> ⚠️ **Minimum TLS Version 改成 1.2 之前，先确认自己没有老设备/老系统还在用。**
> 改完立刻用手机实测一次。

### 第四层：网络侧

- 代理**只绑 `127.0.0.1`**（默认，别改）
- 用完即关隧道
- 定期看状态目录里 `proxy.log` 的 `access` 行

---

## 运维：日志、状态与回滚

### 桌面通知（Windows）

代理出错时会弹 Windows 通知 —— 不用事后翻日志才发现出过事。

**触发时机：**

| 类别 | 具体事件 |
|---|---|
| 服务可用性 | 进程启动、进程非 0 退出（看门狗会重启） |
| 请求失败 | 上游连不上、上游超时、上游传输中断、瘦身失败、响应过大未瘦身 |
| 代码异常 | 未处理的 Promise 拒绝、未捕获异常（已被兜住、服务继续跑） |
| 资源预警 | 内存超 1.5 GB / 2.5 GB、瘦身排队堆积 |

**三条硬约束（实测逼出来的，改代码前请先读）：**

1. **异步发送**。每次 Toast 约 **1000 ms**（起 powershell + WinRT）。
   同步发会卡住正在服务的请求。
2. **同类去重**。真实故障是一串相同错误，不去重会连弹几十个窗口，
   用户会直接关掉通知 —— 那还不如没有。默认 5 分钟内同类只弹一次。
3. **中文走 `-EncodedCommand`**（UTF-16LE base64）。
   直接 `-Command` 传中文在部分场景会乱码。

发送失败（powershell 不可用、非 Windows、WinRT 被禁）**全部静默吞掉**，
只写日志。通知系统自己坏了不能拖垮代理。

**配置：**

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `POCKET_NOTIFY` | `1` | `0` 彻底关闭 |
| `POCKET_NOTIFY_DEDUPE_SEC` | `300` | 同类错误去重窗口（秒） |
| `POCKET_NOTIFY_MIN_INTERVAL_MS` | `3000` | 任意两条通知的最小间隔 |
| `POCKET_NOTIFY_MAX_PER_MIN` | `6` | 每分钟上限 |
| `POCKET_NOTIFY_APPID` | `KimiCodePocket` | 通知归属标识 |
| `POCKET_NOTIFY_RSS_WARN_MB` | `1536` | 内存预警阈值 |
| `POCKET_NOTIFY_RSS_CRIT_MB` | `2560` | 内存严重阈值 |

**排查「为什么没收到通知」**：看 `/__status` 的 `notify` 字段。

```json
"notify": { "enabled": true, "sent": 3, "deduped": 5, "throttled": 0, "failed": 0 }
```

`deduped` 高说明被同类去重挡了（正常）；`failed` 非 0 说明 powershell 那条路有问题。

### 日志位置

**不在仓库里**，默认走平台状态目录（见[配置](#配置)）：

| 文件 | 内容 | 轮转 |
|---|---|---|
| `<状态目录>/logs/proxy.log` | 代理运行日志 + 访问日志 | ✅ 超过 5 MB 转为 `.1` |
| `<状态目录>/watchdog.log` | 看门狗探活与重启记录 | ✅ 超过 5 MB 截断 |
| `<状态目录>/proxy.out` / `proxy.err` | 代理 stdout / stderr | ❌ 无轮转（通常很小） |
| `<状态目录>/pair-url.txt` / `pair-qr.png` | 最近一次快速隧道生成的配对产物 | — |

`<状态目录>` 在 Windows 是 `%LOCALAPPDATA%\kimicode-pocket`，
macOS 是 `~/Library/Application Support/kimicode-pocket`，
Linux 是 `~/.local/state/kimicode-pocket`（尊重 `XDG_STATE_HOME`）。

访问日志格式：

```text
2026-10-17T13:02:11.981Z access 203.0.113.7 GET /api/v1/providers 200 42ms
```

> **只记 path，不记 query。** 因为 query 里可能有配对口令与 client_id。
> 不想要访问日志就设 `POCKET_ACCESS_LOG=0`。

### 三层故障定位

按顺序排查，能快速定位在哪一层：

```bash
# 第 1 层：代理自己活着吗？Desktop 找到了吗？
curl -s http://127.0.0.1:50980/__healthz
```

| 返回 | 含义 | 下一步 |
|---|---|---|
| 连不上 | 代理进程挂了 | 看 `watchdog.log`、`proxy.err` |
| `{"ok":false,"desktopPort":null}` | 代理活着，但找不到 Desktop | 检查 Desktop 是否运行、`instances/` 有没有文件 |
| `{"ok":true,"desktopPort":5xxxx}` | 代理 + Desktop 都正常 | 问题在隧道层，看 cf 日志 |

```bash
# 第 2 层：本机直连 Web UI 通吗？
curl -sI http://127.0.0.1:50980 | head -1     # 期望 200（开了 PIN 会是 302）

# 第 3 层：隧道通吗？
curl -sI https://你的域名 | head -1
```

### 升级 Kimi Code Desktop 之后

1. `curl http://127.0.0.1:50980/__healthz` —— 还是 `ok:true` 吗？
2. 若 `ok:false`：去 `~/.kimi-code/server/instances/` 看**有没有新的 `.json` 文件**
3. 若有新文件但代理找不到：说明字段名或路径变了 → 见[兼容性风险](#兼容性风险)
4. 本机浏览器访问 `http://127.0.0.1:50980` —— 能打开 Web UI 吗？

### 回滚

本项目自身无状态（不写配置、不建数据库），"回滚"就是**换回旧版本代码**：

```bash
cd kimicode-pocket
git checkout <旧版本 tag>
# 重启代理即可，无需清理任何数据
```

唯一需要留意的是日志文件，它们不影响功能。

---

## 给 AI Agent 的部署指令

> **这一节是写给 AI Agent 的**（Claude Code / Cursor / Copilot Workspace 等）。
> 人类读者可以跳过，但其中的「判据」与「禁止事项」同样适用于手动部署。

### 核心原则：**目标驱动，而非命令照抄**

本 README 给出的命令是**参考实现**，不是唯一路径。不同机器的差异很大：

- **Windows**：可能是 PowerShell 5.1 而非 7+，`curl` 可能是别名而非真实 curl
- **macOS**：Apple Silicon 与 Intel 的 Homebrew 路径不同（`/opt/homebrew` vs `/usr/local`）
- **Linux**：发行版差异极大，`ps`/`curl` 参数支持不一
- **容器 / WSL**：可能没有图形会话，`systemd` 可能不可用

**请以本节的「目标 + 判据」为准，自行决定用什么命令达成。**

### 部署目标（四个，必须全部达成）

| # | 目标 | 判据（可验证） |
|---|---|---|
| G1 | 代理在跑，且能找到 Desktop | `curl http://127.0.0.1:50980/__healthz` 返回 `"ok":true` 且 `desktopPort` 为数字 |
| G2 | 代理能转发到真实 Web UI | `curl -s http://127.0.0.1:50980 \| grep -q '<title>Kimi Code</title>'` |
| G3 | 公网可达 | 隧道 URL 返回 200（或开启 PIN 时返回 302 到 `/__login`） |
| G4 | 配对链接交付 | 用户拿到 `/__pair?code=XXXXXX` 链接与二维码，并知晓有效期 |

**G1/G2 不通过就不要继续做 G3**——否则你会花时间排查隧道，而问题其实在代理层。

### Step 0：环境探测（只读）

| 要探测的 | 为什么 | 建议手段 |
|---|---|---|
| Node 版本 ≥ 22 | 低于 22 没有 `fetch` / `AbortSignal.timeout` / `server.closeIdleConnections` | `node --version` |
| Desktop 在跑 | 没有实例注册文件就一定失败 | 列 `~/.kimi-code/server/instances/`；或看进程 |
| 端口 50980 空闲 | 被占用则代理起不来 | `netstat -ano \| findstr :50980` / `lsof -i:50980` / `ss -ltnp` |
| cloudflared 存在 | 没有它做不了公网 | `cloudflared --version` |
| **有无图形会话** | 无 DISPLAY 的 Linux 跑不了 GUI | `echo $DISPLAY`（*nix） |
| 环境里有没有代理变量 | `HTTP_PROXY` 会让 cloudflared 走本地代理 → error 1033 | `env \| grep -i proxy` |

**任一项不满足 → 停止，向用户报告具体缺什么，不要自行安装系统软件。**

### Step 1：达成 G1

**参考做法**：`node src/proxy.mjs`（前台或后台重定向到文件）。

**判据**：`/__healthz` 返回 `"ok":true` 且 `desktopPort` 是数字。

| 现象 | 含义 | 建议动作 |
|---|---|---|
| 连接被拒 | 代理没起来 | 看 stderr，多半是 Node 版本或语法问题 |
| `"ok":false` | 代理活着但找不到 Desktop | 确认 Desktop 真在运行；确认实例目录路径 |
| 启动直接报「拒绝启动」 | 你设了 `POCKET_BIND` 但没设 `POCKET_PIN` | 二选一：改回 `127.0.0.1`，或补上 PIN |

### Step 2：达成 G2

**判据**：`curl -s http://127.0.0.1:50980 | grep -q '<title>Kimi Code</title>'`
（若开了 PIN，`curl -sI` 应返回 302 而不是 200，这是正常的）。

403 → Host/Origin 改写有问题；502 → 上游连接失败。两者都先回看 G1 的 `desktopPort`。

### Step 3：达成 G3

**参考做法**：`scripts/start-tunnel.ps1` / `start-tunnel.sh`，或**自行拼接**：

```bash
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:50980
```

核心要求只有一条：**指向代理的固定端口（50980），不是 Desktop 的动态端口。**
`httpHostHeader` 不是必需的（代理会改写 Host）。

> ⚠️ 启动 cloudflared 前**先清掉 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`**。
> 否则隧道会注册成功但数据面连不上（Cloudflare 报 `error 1033`）。

**判据**：隧道 URL 返回 200（或 302 到 `/__login`）。

### Step 4：达成 G4

**首选**（已有固定域名时，一条命令出链接 + 终端二维码）：

```bash
node src/proxy.mjs --pair-only --base https://<域名>
# 多设备：--pair-count 2
```

**次选**（快速隧道）：跑 `start-tunnel` 脚本，它自己会打印链接并生成 `pair-qr.png`。

向用户交付：

1. **配对链接** `https://<域名>/__pair?code=<6位>`（或二维码）
2. **有效期**：链接 **180 秒**、一次性；手机端配对后 **7 天**过期
3. **安全提醒**：这条链路等同于操作他的电脑；建议开 `POCKET_PIN`
4. **常驻提示**：指向[常驻运行](#常驻运行724)对应平台

> ⚠️ **不要在公网侧尝试 `curl https://<域名>/__paircode`**：那几个端点只对
> 本机直连开放（1.3.0 起），公网一律 404。取码必须在电脑上跑。
>
> 永远不要试图"绕过那个 404"——它挡住的是"一次 `GET /__pair` 就拿到
> Desktop token"的完整接管链路。

### 按平台调整建议（不是死命令）

| 平台 | 建议 | 注意 |
|---|---|---|
| **Windows** | 优先 `.ps1` 脚本 | PowerShell 5.1 也支持；`curl` 可能是别名，必要时用 `Invoke-WebRequest` |
| **macOS** | 手动 `node` + cloudflared；常驻用 launchd | 首次运行 `.sh` 需 `chmod +x` 与去隔离属性 |
| **Linux** | 手动 `node` + cloudflared；常驻用 systemd user service | 确认有 `DISPLAY` |
| **WSL / 容器** | ⚠️ 通常无图形会话 | 若 Desktop 不在同一环境，此路不通 |

### Agent 禁止事项

- ❌ **不要**把配对链接、`#token=`、`server.token` 写进日志/提交信息/Issue/任何持久化文件
- ❌ **不要**修改 `~/.kimi-code/` 下任何文件（那是 Desktop 的领地）
- ❌ **不要**把代理改成监听 `0.0.0.0` 而不设 `POCKET_PIN`（代理会拒绝启动，别去绕过它）
- ❌ **不要**在无图形会话的环境尝试部署并声称成功（先探测 `DISPLAY`）
- ❌ **不要**跳过判据直接报告"部署完成"——G1-G4 必须逐条有证据
- ❌ **不要**为了让脚本跑通而大改脚本；核心功能不依赖脚本，手动启动即可
- ❌ **不要**用在线二维码服务生成配对码（会把地址发给第三方）

### 失败时的标准输出格式

```markdown
## 部署失败

- **失败目标**：G1 / G2 / G3 / G4
- **判据**：<期望什么>
- **实际**：<实际输出，脱敏后的>
- **已执行的命令**：`<命令>`
- **本机环境**：<OS + Node 版本 + 是否有图形会话>
- **建议排查方向**：<指向 README 的具体章节>
```

### 成功时的标准输出格式

```markdown
## 部署完成

- G1 代理与 Desktop：✅ `{"ok":true,"desktopPort":<port>}`
- G2 本机 Web UI：✅ HTTP 200 / title 匹配
- G3 公网可达：✅ <域名> 返回 200
- G4 配对交付：链接与二维码已生成（不在此处回显 code/token）
- 本机环境：<OS + Node 版本>
- 后续建议：<开 POCKET_PIN / 配 Access / 配常驻>
```

---

## 兼容性风险

**本项目依赖以下内部实现，官方升级可能随时更改：**

| 依赖 | 位置 | 失效表现 |
|---|---|---|
| 实例注册文件 | `~/.kimi-code/server/instances/*.json`（`port` / `pid` / `heartbeat_at`） | 端口发现失败 |
| 健康检查接口 | `GET /api/v1/healthz` | 探活失败 |
| Host/Origin 白名单行为 | Desktop 内置 HTTP 服务 | 改写规则失效 |
| 配置根目录推导 | `KIMI_CODE_HOME ?? ~/.kimi-code` | 找不到实例 |
| 前端凭证存储 | `localStorage['kimi-web.server-credential']`，TTL 7 天 | 配对页失效 |
| WebSocket 鉴权方式 | `Sec-WebSocket-Protocol: kimi-code.bearer.<token>` | WS 连接失败 |

**失效时的表现**：`/__healthz` 返回 `{"ok":false,"desktopPort":null}`，页面 503。

**排查顺序**：先确认 Desktop 确实在跑 → 再看 `instances/` 下有没有新文件 →
手动 `curl http://127.0.0.1:<该端口>/api/v1/healthz`。

如果只是路径变了，用 `POCKET_APP_HOME` / `POCKET_HEALTH_PATH` 覆盖即可，不必改代码。
如果是凭证机制变了，改 `src/lib/pages.mjs` 里的配对逻辑即可。

---

## 故障排查

<details>
<summary><b>从公网访问 <code>/__status</code> 或 <code>/__paircode</code> 返回 404</b></summary>

**这是 1.3.0 起的预期行为，不是故障。**

这几个端点是"仅本机直连"的运维接口：`cloudflared` 在本机发起回环连接，
如果不靠 Cloudflare 头把它们排除掉，任何拿到域名的人都能取到 Desktop 的
`server.token`（详见[安全加固 · 第零层](#安全加固)）。

要取配对口令，请**在电脑上**跑：

```bash
node src/proxy.mjs --pair-only --base https://你的域名
```

或者本机 `curl http://127.0.0.1:50980/__paircode`。
</details>

<details>
<summary><b>手机突然打不开了（配对一周之后）</b></summary>

**十有八九是凭证过期。** Desktop 前端把 token 的有效期写死在 **7 天**，
过期后 localStorage 里的记录会被删掉，页面就是白屏或 401。

解决：在电脑上重新生成一条配对链接（`--pair-only --base https://你的域名`），
用**新的链接**重新配对。不需要重开隧道。

> 顺带解释一个常见困惑：配对链接打开后，浏览器会立刻用 `history.replaceState`
> 把 `#token=` 擦掉。所以**书签里那条带 token 的地址只能用一次**，
> 7 天后必须重新拿链接——裸域名是进不去的。
</details>

<details>
<summary><b>Access 登录成功但页面又跳回登录页（302 循环）</b></summary>

常见于三种情况：

1. **Cookie 被浏览器拦了**：无痕窗口/隐私模式下第三方 Cookie 限制可能导致
   `cloudflareaccess.com` 的会话存不下。换普通窗口、允许第三方 Cookie 再试。
2. **DNS 记录不是「已代理」（灰云）**：Access 依赖 Cloudflare 代理。
   灰云时流量直连，Access 那一层直接失效。把橙云打开。
3. **Application domain 与隧道 hostname 不一致**：比如配了 `a.example.com`
   但实际访问 `b.example.com`，Access 认为这不是受保护域名，直接放行——
   表现为"根本没出现登录页"。

排查顺序：先看无痕窗口**会不会**要求登录（不会 → 第 3 条），再查 DNS 是否橙云。
</details>

<details>
<summary><b>改了隧道 ingress 之后，别的服务挂了</b></summary>

一条隧道常常挂着多个域名（比如同一个隧道同时跑着 `app-a.example.com`、
`app-b.example.com`、`kimicode.example.com`）。两个高频错误：

- **`http_status:404` 没放最后**：它会把后面所有规则都吃掉。
- **带 `path` 的规则放在了只有 `hostname` 的规则后面**：永远匹配不到。

改完先在控制台核对一下完整 ingress 列表的顺序，再离开页面。
</details>

<details>
<summary><b>页面 502 / 手机端 WebSocket error</b></summary>

几乎都是 Host 或 Origin 被拒。检查：

1. 代理是否在跑（`curl http://127.0.0.1:50980/__healthz`）
2. 请求是否**真的经过** `proxy.mjs`（隧道指向的端口对不对？）
3. 看状态目录里的 `logs/proxy.log` 有无 `403` / `ws upstream error`
4. 如果加了 Cloudflare Access，确认策略没把你自己挡住
</details>

<details>
<summary><b>公网 error 1033（隧道连不上）</b></summary>

**最常见原因：本机开着代理 / VPN（Clash、Surge、v2ray、sing-box，尤其 TUN 模式）。**

这类工具会接管全部流量，常把 cloudflared 的边缘连接（`*.argotunnel.com`）掐断，
导致隧道注册成功但数据面连不上。

**第二常见原因：shell 里的 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。**
即使你关掉了 TUN、系统代理也显示关闭，只要启动 `cloudflared` 的那个 shell
注入了这些变量，子进程就会继承 → 同样 1033。

**本项目 v1.2.0 起会在启动隧道前自动剥离这些变量**（`-RespectProxy` 可关闭）。

按顺序试：

1. 关掉代理的 TUN 模式（不用退出软件）
2. 彻底退出代理软件
3. 给代理加直连规则放行 `*.argotunnel.com` / `*.trycloudflare.com`
4. 改用手机热点：电脑连手机热点，再用局域网方式（如果你开了 `POCKET_BIND`）
</details>

<details>
<summary><b>503 — Desktop 未运行或未注册实例</b></summary>

1. Kimi Code Desktop 是否真的在运行（**要有窗口**，不能只是后台进程）
2. `~/.kimi-code/server/instances/` 下是否有 `.json` 文件
3. 文件里的 `port` 手动 `curl http://127.0.0.1:<port>/api/v1/healthz` 是否响应
4. 若 Desktop 刚重启，等 2 秒（发现缓存 TTL）再试
5. 若 Desktop 用 `KIMI_CODE_HOME` 启动，代理需设同样的 `POCKET_APP_HOME`
</details>

<details>
<summary><b>配对码提示"已失效 / 错误"</b></summary>

- 一次性口令**180 秒**过期，且**只能用一次**
- 代理重启后所有口令作废
- 重新在电脑上生成一条：`node src/proxy.mjs --pair-only --base https://你的域名`

也可以本机手动取一个：`curl http://127.0.0.1:50980/__paircode`
（**只有本机能取**，公网会 404，见上一条）
</details>

<details>
<summary><b>手机已经进去了，电脑上却显示"已失效"</b></summary>

1.3.0 之前确实会这样：终端只倒计时，从不问服务端结果。现在终端每秒读一次
`/__pairstatus`，配对页一被打开就立刻改成 `✔ 配对页已打开`。如果仍然看到"已失效"，按顺序查：

1. **用的是不是同一台电脑的终端**——`--pair-only` 连的是本机 `127.0.0.1:50980`，
   远程 SSH / 另一台机器上跑就查不到状态
2. **代理在这期间重启过吗**——重启后内存里的口令记录全没了，终端只能按超时处理
3. **是不是非 TTY 模式**（输出被重定向、被别的程序调用）：那种模式只打一行失效时刻，
   本来就不回报结果

想要准的反馈，就在真实终端窗口里跑（`npm run pair` 或双击脚本）。
</details>

<details>
<summary><b>二维码扫不出来</b></summary>

- 优先用终端里打印的那张（黑块白底，极性正确）
- 或者用 `pair-qr.png`（同样是本地生成），不要用第三方工具重新生成
- 确保屏幕亮度够、没有缩放模糊
- 二维码内容是一条 180 秒就失效的链接，扫不出来就直接手输那条 URL
</details>

<details>
<summary><b>忘了 POCKET_PIN</b></summary>

没有找回机制（不存明文以外的任何东西）。改环境变量重启代理即可，
旧会话会因为密钥变化全部失效。
</details>

<details>
<summary><b>watchdog 反复重启代理</b></summary>

看 `watchdog.log`。若出现 `proxy still unhealthy after restart`，
说明**进程能起但探活失败**：

```bash
node --version                       # 需要 22+
netstat -ano | findstr :50980        # Windows 查端口占用
lsof -i :50980                       # macOS/Linux
```

常见原因：Node 版本过低、端口被占用、`proxy.err` 里有语法错误、
或者 `POCKET_BIND` + `POCKET_PIN` 组合不合法导致启动即退出。
</details>

<details>
<summary><b>stop 脚本杀不掉，代理又自己起来了</b></summary>

说明看门狗没被杀掉。v1.2.0 已修复（同时匹配 `powershell.exe` 与 `pwsh.exe`）。

如果你还在旧版本，手动确认：

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*watchdog.ps1*' }
```

把列出来的进程杀掉，再停代理。
</details>

<details>
<summary><b>端口 50980 被占用（EADDRINUSE）</b></summary>

```bash
# Windows
netstat -ano | findstr :50980        # 找 LISTENING 的 PID
taskkill /PID <pid> /F

# macOS / Linux
lsof -ti :50980 | xargs kill -9
```

或者直接换端口：`POCKET_PORT=60980 node src/proxy.mjs`
</details>

<details>
<summary><b>macOS：脚本报 "Operation not permitted"</b></summary>

```bash
chmod +x scripts/*.sh
xattr -d com.apple.quarantine scripts/*.sh
```

若仍被拦，去「系统设置 → 隐私与安全性」允许。
</details>

<details>
<summary><b>Linux：代理起来但 Desktop 找不到</b></summary>

确认是**图形会话**里启动的。纯 SSH 会话没有 `DISPLAY`：

```bash
echo $DISPLAY        # 应该有值，如 :0
```

为空说明你在无头会话里——本项目不适用该场景。
</details>

---

## 项目结构

```
kimicode-pocket/
├── src/
│   ├── proxy.mjs              # 入口：HTTP 转发、WS 透传、自有端点、压缩、限速
│   └── lib/
│       ├── config.mjs         # 环境变量解析 + 安全闸门（非回环必须带 PIN）+ 公网入口校验
│       ├── args.mjs           # 命令行参数解析（纯函数，可单测）
│       ├── discovery.mjs      # 实例发现（注册文件 + pid + 真实探活 + 并发单飞）
│       ├── rewrite.mjs        # Host/Origin 改写 + 「本机直连」判定（回环且无 CF 头）
│       ├── auth.mjs           # 会话令牌、Cookie、失败限速、全局限速
│       ├── pages.mjs          # 登录页 / 配对页 / 错误页（内联，无外链）
│       ├── pairwatch.mjs      # 终端倒计时 + 配对状态回显（成功即收尾）
│       ├── trim.mjs           # 大响应瘦身：只压截图，文字不动；并发闸门 + 缓存
│       ├── toc.mjs            # 手机端历史节点：注入胶囊脚本（复用 data-turn-id）
│       ├── image.mjs          # 零依赖 PNG 解码 / 箱式降采样 / 重编码
│       ├── pool.mjs           # worker 池调度器（可注入，便于单测异常时序）
│       ├── image-async.mjs    # 图片压缩调度 + 内容哈希去重 + LRU 结果缓存
│       ├── image-worker.mjs   # worker 线程入口（PNG 压缩的 CPU 活）
│       └── qr.mjs             # 零依赖二维码：SVG / 终端 / PNG
├── scripts/
│   ├── start-tunnel.ps1       # Windows：起隧道 + 配对码 + 二维码
│   ├── start-tunnel.sh        # macOS/Linux：同上
│   ├── watchdog.ps1           # Windows 看门狗
│   ├── watchdog.sh            # macOS/Linux 看门狗
│   ├── stop.ps1 / stop.sh     # 停止看门狗 + 代理
│   ├── start-watchdog.vbs     # Windows 隐藏窗口启动器（路径自推导）
│   ├── tunnel-service.ps1     # Windows：隧道服务 装/卸/配自重启/健康探测/定时自愈
│   ├── tunnel-service.sh      # macOS/Linux：同上（systemd / launchd）
│   └── launch.mjs             # npm run tunnel|tunnel-service|watchdog|stop 的实际入口
├── test/
│   ├── args.test.mjs
│   ├── config.test.mjs
│   ├── discovery.test.mjs
│   ├── rewrite.test.mjs
│   ├── auth.test.mjs
│   ├── qr.test.mjs
│   ├── pairwatch.test.mjs     # 倒计时/成功/部分成功/轮询失败 的终端行为
│   ├── proxy.integration.test.mjs   # 自带假 Desktop，进程级集成测试
│   └── cli.test.mjs           # 命令行入口的对外契约（帮助/退出码/出码）
├── docs/
│   ├── how-it-works.md        # 原理详解（含实测依据）
│   └── MAINTAINER-CHECKLIST.md
├── .github/workflows/ci.yml   # 三平台 × Node 22/24 + shellcheck + 脱敏闸门
├── CHANGELOG.md
├── SECURITY.md
├── LICENSE
├── README.en.md
└── README.md
```

---

## 工作原理

详见 [docs/how-it-works.md](docs/how-it-works.md)。

1. **端口发现**：读 `instances/*.json` → 按 `heartbeat_at` 排序 → 校验 pid 存活 →
   `GET /api/v1/healthz` 真实探活 → 命中即缓存 2 秒
2. **HTTP 转发**：改写 `Host` 与 `Origin` 为 `127.0.0.1:<port>` 后原样转发
3. **WebSocket 升级**：用 `rawHeaders` 逐字节重建请求行与头（同样改写 Host/Origin），
   然后双向 `pipe`；两端任一关闭就收摊，不设应用层空闲超时（半开连接交给 TCP keepalive 发现）
4. **自愈**：看门狗独立进程轮询 `/__healthz`，连续 2 次失败才重拉

### 代理自有端点

| 端点 | 谁能访问 | 作用 |
|---|---|---|
| `GET /__healthz` | 本机直连返回完整信息；经隧道只返回 `{ok}` | 探活 |
| `GET /__status` | **仅本机直连** | 运行状态与生效配置 |
| `GET /__paircode` | **仅本机直连** | 取一次性配对口令 |
| `GET /__pairstatus?codes=a,b`（`code=` 亦可） | **仅本机直连** | 这批口令的状态：`pending` / `redeemed` / `expired` / `unknown`，供终端回显配对结果 |
| `GET /__pair?code=` | 持有效口令者（**没有免口令旁路**） | 配对页（写入凭证后跳转） |
| `GET /__login` | 任何人（仅开了 PIN 时存在） | 口令登录页 |
| `GET\|POST /__qrcode` | **仅本机直连** | 把文本渲染成 PNG 二维码 |

> **「本机直连」= 回环 socket 且不带 Cloudflare 头**（`CF-Connecting-IP` / `CF-Ray`）。
> 只判 socket 是不够的：`cloudflared` 也在本机发起连接。这是 1.3.0 修掉的漏洞。
>
> 为什么 `/__healthz` 对公网只回 `{ok}`：旧版本会把 `desktopPort` 一并回显，
> 等于向互联网公布你本机的内部端口。虽然利用价值不高，但没有必要。

---

## 开发与测试

```bash
# 零依赖，不需要 npm install
node src/proxy.mjs            # 启动
npm run check                 # 语法检查（全部模块）
npm test                      # 135 个用例
```

测试分两层：

- **单元测试**：配置解析、实例发现、头改写、会话令牌、限速、二维码编码
- **集成测试**：`test/proxy.integration.test.mjs` 会起一个**假 Desktop**
  （一个几十行的 HTTP/WS 服务器），再 spawn 真的 `proxy.mjs` 指向它，
  覆盖端口发现 → 转发 → 压缩 → WS → 配对 → PIN 全链路。
  **不需要装 Kimi Code Desktop 也能跑。**

二维码编码器（`src/lib/qr.mjs`）做过严格校验：开发期与 `qrcode@1.x`
逐模块对拍 **704 组**（4 个纠错等级 × 8 种掩码 × 多种长度，版本 1-34），**零差异**。
`test/qr.test.mjs` 用矩阵指纹把结果锁死，防止后续改动悄悄改变编码。

---

## 来源与演进

这个项目的**基线不是从零写的**。

它的核心——固定端口反代、三期端口发现、Host/Origin 改写、WebSocket 原始头重建——
来自一套**已经在作者本机长期运行、每天在用**的实现。开源化时做了两件事：

1. **脱敏**：环境变量统一改名为 `POCKET_*`，移除一切本机路径、端口、域名痕迹
2. **增量增强**：在不动核心转发逻辑的前提下，补上配对、二维码、PIN、压缩、限速、测试

所以如果你在阅读 `src/proxy.mjs` 时觉得"转发那部分写得很克制、周边功能很新"，
那是故意的：**能跑的部分不重写，缺的部分才加。**

### 1.3.0 的一次自我纠错

1.2.0 之前，"仅本机"的判断是 `isLoopbackAddr(req.socket.remoteAddress)`。
它错在把"来自 127.0.0.1"等同于"来自本机"——而 `cloudflared` 恰恰就在本机
建立这条回环连接。结果是：**经隧道进来的公网请求被当成本机直连**，
`/__pair` 的"本机免口令"分支直接把 Desktop 的 `server.token` 交给了任何人。

这个缺陷在"只开 `POCKET_PIN`、没上 Cloudflare Access"的部署里等同于
**远程代码执行**。1.3.0 修掉了它，并把判定固化成 `isLocalRequest()`
（回环 + 无 CF 头），同时删掉了免口令旁路。

> 教训写在[安全加固 · 第零层](#安全加固)里：**网络层的事实（谁连过来的）
> 不能靠"地址看起来像本机"来推断，必须靠只有中间层才能伪造的凭据来区分。**

---

## 贡献

欢迎 Issue 与 PR。提交前请：

- 不要提交 `*.log`、`proxy.out/err`、`pair-url.txt`、`pair-qr.png`、任何含 token 的文件
- 说明你测试的 Kimi Code Desktop 版本**与操作系统**
- 跑一遍 `npm test`，并确认 `npm run check` 通过
- 涉及内部实现变更的适配，请在 PR 描述里写清依据（最好是 `curl` 实测输出）

CI 里有一道**脱敏闸门**，会自动拦截真实凭证、内网 IP、本机绝对路径与真实隧道域名。

## 安全

见 [SECURITY.md](SECURITY.md)。**发现漏洞请不要公开提 Issue。**

## 许可证

[MIT](LICENSE)

## 免责声明

本项目按"现状"提供，不附带任何担保。使用本工具将你的桌面应用暴露到公网
**存在固有安全风险**，包括但不限于凭证泄露、未授权访问。请自行评估并承担相应责任。

作者不对因使用本项目造成的任何损失负责。
