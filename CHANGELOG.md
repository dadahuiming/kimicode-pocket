# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

---

## [1.5.0] — 2026-10-19

一次**方向性纠正**。1.4.0 为了压体积去截断字符串，结果把正常长度的正文也砍掉了
（一个 846 字符的回复只剩 41 字符 + 一行省略号）。这一版推翻那个做法：
**文字一个字符都不动，只降截图的图片分辨率。**

### 🔴 纠正 1.4.0 的错误做法

逐字段统计后才看清真相：

| 响应 | 总大小 | 截图 base64 | 文字 |
|---|---|---|---|
| `/messages` | 5.41 MB | **5.36 MB（99.1%）** | < 50 KB |
| `/transcript` | 51.00 MB | **48.63 MB（95.4%）** | 1.95 MB |

**体积几乎全在工具截图上，正文只占零头。** 按「总预算对折所有字符串」压缩，
等于拿正文的完整性去换那几个百分点 —— 这是错的。

### 🟢 新增：图片降采样

- **`lib/image.mjs`**：纯 JS 的 PNG 解码 / 箱式降采样 / 重编码，**零依赖**。
- **`lib/image-async.mjs` + `lib/image-worker.mjs`**：压缩跑在 **worker 线程**，
  主线程不再被 CPU 阻塞（实测心跳从 0 次恢复到 68 次/1.2 秒）。
- 只处理 `data:image/png;base64,...`；JPEG / WebP 已是压缩格式，不碰。
- 按 `POCKET_IMG_MAX_PIXELS`（默认 400000 ≈ 666×416）等比降采样，
  2000×1250 的截图降到 ÷3。

实测（单张 2000×1250 截图）：

| 档位 | 尺寸 | 单张体积 | 31 张合计 | 耗时 |
|---|---|---|---|---|
| 原图 | 2000×1250 | 1563 KB | 35.85 MB | — |
| **÷3（默认）** | 666×416 | ~112 KB | **3.46 MB（−90.6%）** | 1.2 s |
| ÷2 | 1000×625 | ~215 KB | 7.4 MB | 2.3 s |

### 🟢 新增：缓存与并发控制

- **图片级缓存**：按内容哈希，同一张图只算一次。
- **整响应缓存**：`/transcript` 51 MB 的二次请求从 **3131 ms 降到 27 ms**。
- **并发闸门**：同一时刻最多处理 2 个瘦身任务，其余排队。
- **重复请求合并**：前端会并发打 13 个一模一样的 `/transcript`，
  现在只算一次，其余等同一个结果。

### 🐛 修复

- **gzip 分支写错导致连接挂死**：原代码 `z.end(body, () => z.pipe(res))`
  在 `pipe` 接上之前就把压缩流结束了，数据全丢、浏览器一直「加载中」。
  改成 `z.pipe(res); z.end(body);`。
- **压缩级别从 9 降到 6**：单张图编码 399 ms → 37 ms（快 10 倍），
  体积只从 131 KB 变 140 KB（+7%）。

### 🔧 配置变更

| 变量 | 默认 | 说明 |
|---|---|---|
| `POCKET_TRIM` | `1` | 总开关 |
| `POCKET_IMG_MAX_PIXELS` | `400000` | 单张图最大像素数，超过才降采样 |
| `POCKET_IMG_MIN_KB` | `16` | 小于此大小的图不处理 |
| `POCKET_IMG_MAX_INPUT_MB` | `12` | 超过此大小的图不处理（保护内存） |
| `POCKET_TRIM_MIN_KB` | `256` | 小于此值的响应不处理 |
| `POCKET_TRIM_MAX_BUFFER_MB` | `128` | 超过此值不缓冲 |
| `POCKET_TRIM_PATHS` | `transcript,messages` | 生效路径 |

**移除**：`POCKET_TRIM_MAX_CHARS`、`POCKET_TRIM_TOTAL_KB`
—— 不再有「总预算」概念，文字永不截断。

### 🧪 测试

- `test/trim.test.mjs` 重写（**30 个用例**），关键几条：
  - 20 万字正文 + 大图混排 → **正文逐字符相同**
  - 文字里本来就有「…[已省略 …]…」样式 → 不受影响
  - 结构与字段名逐一比对不变
  - 缓存命中结果一致、并发只算一次
- 全量 **133** 个用例通过。

### ⚠️ 已知边界

- 降采样是**有损**的：截图变小后细节会损失（文字仍可辨认，但不适合放大看）。
  需要原图时在电脑上看。
- 只处理 PNG。若上游改成 JPEG / WebP 截图，本条自动跳过（不会破坏内容）。

---

## [1.4.0] — 2026-10-19

一次**可用性修复**。手机上打开长会话时，页面顶部报「无法连接到 Kimi 服务器 /
`TypeError: Failed to fetch`」，但 HTTP 状态却是 **200** —— 这类"看起来像网络
问题、实际是数据太大"的故障，本版从根上解决。

### 🟢 新增

- **大响应裁剪（`lib/trim.mjs`）**：`/transcript` 与 `/messages` 的响应
  超过阈值时，在**传输层**把超长字符串截断为「首 60% + 省略标记 + 尾 28%」。
  **JSON 结构与字段名完全不变**，只改字符串长度 —— 前端照常解析，
  不会因为"字段消失/类型改变"而白屏。
  - 实测：单个会话 `/transcript` 57.4 MB → **241 KB（−99.58%）**，
    `/messages` 7.86 MB → **146 KB（−98.14%）**，耗时约 135 ms。
  - 结构性校验：`items` / `steps` / `frames` 数量与字段名逐一比对不变；
    24 items、154 steps、3 frames 全部保留。
  - 小于 `POCKET_TRIM_MIN_KB`（默认 256 KB）的响应原样放过，不花多余 CPU。
  - 裁剪后再走压缩，流量与 CPU 都省；响应头带 `x-pocket-trimmed: 1` 便于判定。
  - SSE（`text/event-stream`）、静态资源、上游已压缩的响应一律跳过。
  - 极端情况下若 JSON 骨架本身就超过总预算（字段极多），会显式标记
    `overBudget` 并记日志 —— 宁可超预算，也不让前端崩。

### 🔧 新增配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `POCKET_TRIM` | `1` | 总开关，`0` 关闭裁剪 |
| `POCKET_TRIM_MAX_CHARS` | `32768` | 单个字符串最多保留字符数 |
| `POCKET_TRIM_TOTAL_KB` | `1024` | 裁剪后整体目标上限 |
| `POCKET_TRIM_MIN_KB` | `256` | 小于此值的响应不处理 |
| `POCKET_TRIM_MAX_BUFFER_MB` | `128` | 超过此值不缓冲（保护进程内存） |
| `POCKET_TRIM_PATHS` | `transcript,messages` | 生效路径（子串匹配，小写） |

### 🧪 测试

- 新增 `test/trim.test.mjs`（**23 个用例**）：路径/类型/大小门槛判定、
  结构不变性、首尾保留、短字符串不受影响、非 JSON 放过、对折重试、
  结构超预算下限、真实体量降幅。
- 全量 `126` 个用例通过。

### ⚠️ 已知边界

- `page_size` 对 `/transcript` **无效**（实测 1 / 3 / 10 都返回同一份全量数据），
  所以不能靠调分页规避，只能靠裁剪。
- 裁剪只在代理这一层做，**Desktop 原始数据完好**，电脑上仍可看到全文。

---

## [1.3.0] — 2026-10-18

一次**安全修复 + 上手体验**的版本。含一个 P0：在只靠 `POCKET_PIN` 防护的
部署里，公网任何人都能拿到 Desktop 的 `server.token`。

### 🔴 安全修复

- **「本机」判定被隧道穿透（P0）**：`cloudflared` 在**本机**发起回环连接，
  于是经隧道进来的公网请求 `remoteAddress` 也是 `127.0.0.1`。旧代码只判 socket，
  导致 `/__pair`（当时有"回环免 code"分支）、`/__paircode`、`/__status`、
  `/__qrcode` 对全网开放——攻击者一次 `GET /__pair` 就能把 token 读走，
  进而在宿主机上执行任意代码。
  现在是 `isLocalRequest()`：**回环 socket 且不带 `CF-Connecting-IP` / `CF-Ray`**。
  新增 `isTunneledRequest()` / `isLocalRequest()` 两个纯函数并有单测覆盖。
- **删除 `/__pair` 的免口令旁路**：一律必须持一次性 code，本机也不例外。
  取 code 走 `--pair-only` 或 `GET /__paircode`（仅本机直连）。
- **配对码增加失败限速**：5 次 / 60 秒，与 `/__login` 对齐（此前只有全局速率）。
- **`/__healthz` 纳入全局限速**：它每次都真去探活 Desktop，不该是免费的放大入口。
- `POCKET_PUBLIC_URL` 拒绝回环地址：避免生成一条手机根本打不开的二维码。

### 新增

- **命令行参数**：`--port` / `--pin` / `--base` / `--pair-only` / `--pair-count`，
  优先级高于同名环境变量。
- **一条命令出配对链接**：`node src/proxy.mjs --pair-only --base https://…`
  直接打印链接 + **终端二维码**（黑块白底，深色终端也能扫）。
- **启动即出码**：带 `--base` 启动时，同一条输出里就给配对链接与二维码。
- **`--pair-count N`**：一次给手机 + 平板出多个码（一码一台设备）。
- **配对链接 180 秒有效，终端实时回报配对结果**：二维码下方一行
  `⏳ 剩余 176 秒（01:57:04 失效）` 原地刷新；**配对页一被打开，约 1 秒内**换成
  `✔ 配对页已打开（…）` 并直接收尾，不再空等剩下的两分多钟；只有始终没人扫，
  才会在到点后变红提示 `当前链接、二维码已失效，请重新生成！`。
  多设备时状态行带 `已配对 1/2` 进度；只配上一部分时收尾为
  `⚠ 已配对 1/2，其余链接已失效`，不会把已经配好的那台说成失败。
  非 TTY（管道/CI）下只打一行 `链接于 HH:MM:SS 失效。`，不刷屏也不阻塞。
- **`GET /__pairstatus`**：仅本机可读的配对状态端点（`pending` / `redeemed` /
  `expired` / `unknown`），终端据此回显结果。口令记录不再"消费即删"，而是标记
  为已兑换并保留 10 分钟——删掉之后就再也分不清"被用掉了"和"过期了"。
  措辞刻意保守：`redeemed` 的语义是"配对页已被打开、凭证已下发"，不是
  "手机浏览器已执行完 JS"，所以终端只说"配对页已打开"。
- `POCKET_PUBLIC_URL` 环境变量；`npm run pair` 快捷脚本。
- `/__status` 增加 `publicUrl` 字段。

### 性能

- **访问日志改异步缓冲**：原来每个请求 `mkdir` + `exists` + `stat` + `append`
  四次同步调用直接阻塞事件循环；现在内存聚合、500ms / 64 行批量落盘，
  退出前同步 flush。
- **上游连接池**：显式 `keepAlive`（Node 18/20 的全局 agent 默认不 keep-alive，
  每个代理请求都要重新握手）。
- **端口发现单飞**：缓存过期瞬间的并发请求复用在途结果，不再各自跑一遍
  「读目录 + 读文件 + 逐个探活」。
- **压缩分档**：`content-length > 512 KB` 时 brotli 用 q6 / gzip 用 level 6，
  小响应仍用低档不浪费 CPU。

### 变更

- **`POCKET_PAIR_TTL_SEC` 默认值 300 → 180**（最小 30，最大 3600）。中间试过
  60 秒，实测太紧：扫码、过 Cloudflare Access 登录、再点确认，手慢一点就到了；
  3 分钟够用，又不至于让人"生成完就忘了"。
- 日志与运行态**不再写进仓库**：`proxy.log`、`watchdog.log`、`proxy.out/err`、
  `pair-url.txt`、`pair-qr.png` 全部落到平台状态目录
  （Windows `%LOCALAPPDATA%\kimicode-pocket`、macOS `~/Library/Application Support/kimicode-pocket`、
  Linux `~/.local/state/kimicode-pocket`）。`POCKET_LOG_DIR` 仍可覆盖。
- 最低 Node 版本 **18 → 22**（18/20 均已停止维护）；CI 矩阵改为 22 / 24。
- `package.json` 补齐 `repository` / `bugs` / `homepage` / `author` / `publishConfig`，
  `files` 纳入 `test/`（装完也能跑 `npm test`）。
- WebSocket 两端 `close` 也触发收摊；不再可能出现半开 socket 滞留。

### 修复

- `src/lib/config.mjs` 注释把安全闸门写成「没有设 PID」，应为 `PIN`。
- 文档里的示例域名统一改成中性的 `app-a.example.com` / `app-b.example.com`。
- `/__status` 现在也记访问日志（此前唯一不记的端点）。`/__pairstatus` 的**成功轮询**刻意不记（终端每秒问一次，会刷屏），只记公网探测的 404 与方法错误的 405。
- **终端只倒计时、从不回报结果**：手机上明明已经配对好了，电脑上照样在到期时
  打「已失效」。根因是配对码"消费即删"，终端无从区分"被用掉了"与"过期了"。
  现在记录改为标记已兑换并保留 10 分钟，终端每秒读一次 `/__pairstatus`。

### 文档

- **新增 `README.en.md`**：与中文版逐节对应的英文文档，顶部互相提供语言切换。
- 「仅回环」的表述全部改为「仅本机直连」，并新增**安全加固 · 第零层**
  解释为什么 socket 地址不足以证明来源。
- 新增「一条命令拿到配对链接」「命令行选项」「日志默认放在哪」三节。
- 故障排查新增「公网访问 `/__status` 返回 404 是预期行为」。
- 脱敏闸门补 UUID、邮箱、Linux 真实家目录三类检查（域名泛匹配因误报太多不做，
  改由维护清单人工核对）。

### 测试

- 65 → **103** 用例。新增：`isTunneledRequest` / `isLocalRequest`、
  `parseArgs` / `parsePairCount`、`publicUrl` 校验、`defaultStateDir`、
  经隧道请求的端点隔离、配对码锁定、命令行入口的进程级契约测试，
  以及配对状态回显的终端行为（成功 / 到期 / 部分成功 / 轮询失败）。

---

## [1.2.0] — 2026-10-17

一次完整的自审 + 加固。核心转发逻辑（端口发现 / Host-Origin 改写 / WS 透传）
保持与已在生产验证过的实现一致，下面是**增量**。

### 新增

- **一次性配对口令**：`GET /__paircode` 取 6 位口令（5 分钟、一次性、不可重放），
  手机打开 `/__pair?code=XXXXXX` 即自动写入凭证并跳转。
  **token 从此不出现在地址栏、历史记录和剪贴板里。**
- **零依赖二维码**：`src/lib/qr.mjs` 自实现（Byte 模式 / L-M-Q-H / 版本 1-40），
  输出 SVG、终端字符画、PNG。配对时终端直接出图，手机扫码即开。
  > 刻意不用任何在线二维码服务 —— 那等于把配对地址发给第三方。
- **`POCKET_PIN` 第二道口令**：Cookie 会话（HttpOnly / SameSite=Lax），
  失败 5 次锁 60 秒。换 PIN 即全端下线。
- **JSON 响应压缩**（brotli / gzip），实测长会话接口 1418 → 564 字节。
  只压 `application/json`；`text/event-stream` 明确跳过，避免破坏流式输出。
- **`GET /__status`**（仅回环）：版本、端口、Desktop 端口、PIN 状态、运行时长。
- **全局限速**（`POCKET_RATE_LIMIT`，默认 600/分钟/IP）与**请求体上限**（默认 64 MB）。
- **访问日志**：`access <ip> <method> <path> <status> <ms>`，**不记 query**。
- **TCP keepalive**（30s）：减少手机休眠 / 路由器 NAT 后 WebSocket 静默断链。
- **`--help` / `--version`**。
- **`test/`（65 个用例）**：单元测试 + 进程级集成测试（自带假 Desktop，无需真装客户端）。
- **GitHub Actions CI**：三平台 × Node 18/20/22、shellcheck、PowerShell 语法解析、脱敏闸门。
- **`SECURITY.md`**：威胁模型、凭证泄露处置流程、加固清单。
- **`scripts/launch.mjs`**：`npm run tunnel|watchdog|stop` 现在**真的执行**。

### 修复

- **`stop.ps1` 杀不掉用 `pwsh` 启动的看门狗**：原来只匹配 `powershell.exe`，
  导致看门狗活下来 30 秒后又把代理拉起来，表现为"stop 无效"。
- **日志目录落错位置**：`POCKET_LOG_DIR` 默认值实际落在 `<repo>/src/.logs`，
  文档却写 `<repo>/.logs`。已统一到仓库根目录。
- **上游空闲超时 30s 太短**：长任务（会话压缩、大文件读写）可能长时间无字节，
  会被误杀成 502。改为默认 120s 且可配（`POCKET_UPSTREAM_TIMEOUT_MS`）。
- **删除「`httpHostHeader` 少了必然 403/502」的错误说法**：
  实测代理已把 Host 改成回环，该配置是冗余保险而非必需。隧道脚本也不再写 config.yml。
- **隧道脚本不剔除 `HTTP_PROXY` / `HTTPS_PROXY`**：
  cloudflared 继承本地代理变量会导致 `error 1033`。现在默认剥离（`-RespectProxy` 可关闭）。
- **`.sh` 脚本依赖 `pgrep -f` 与 `sed` 正则**：改为 `ps + awk` 字面量匹配、
  用 `node` 解析 JSON，规避平台差异。
- **`start-watchdog.vbs` 硬编码路径**：改为按自身位置自动推导，用快捷方式即可，无需编辑。
- **`npm run tunnel|watchdog|stop` 只打印不执行**：改成真调用。
- **Windows 脚本"已实测"标注过度**：改为逐脚本标注实际验证状态。

### 文档

- 新增「来源与演进」，说明基线来自已验证的本地实现。
- 补充**配对后凭证 7 天过期**（前端写死的 TTL）——这是"手机突然打不开"的头号原因。
- 补充"配对链接打开后 `#token=` 会被 `history.replaceState` 立即清掉"这一事实。
- 修正 `httpHostHeader` 相关表述，并附上实测证据（Host 403 / 无 Origin 放行 101）。
- 脱敏：移除示例里残留的本机动态端口与仿真度过高的实例 JSON。

### 文档修正（对照真实 Cloudflare 部署逐项核对后）

把「固定域名（可选）」改写为 **「生产部署：命名隧道 + 固定域名」**，
因为核对发现参考部署用的就是命名隧道 + Access，而不是文档原先假设的快速隧道：

- 明确 **远程管理（token）模式**是推荐路径：本机不需要 `config.yml`
- 明确 **DNS 记录必须是「已代理」（橙云）**，否则 Access 直接失效
- 明确 **ingress 不需要 `originRequest.httpHostHeader`**（现网配置里就没有）
- 补充 **ingress 顺序**要求：`http_status:404` 必须在最后、`path` 规则必须在前
- 补充 **一条隧道常被多个服务共用**，改之前要确认不误伤
- 新增 **Zone 级安全开关**清单（Always Use HTTPS / Minimum TLS 1.2 / HSTS / SSL 模式）
- 故障排查新增两个高频项：Access 302 循环、改 ingress 打挂其它服务
- 新增 **「隧道常驻方式（三平台对照）」**：
  - 说明 `cloudflared service install` 一条命令在三个平台落到**不同服务管理器**
    （Windows SCM / macOS LaunchDaemon / Linux systemd system unit）
  - 明确 **隧道是系统级、代理是用户级** 的分工，不要把 cloudflared 塞进 watchdog
  - 列出三平台各自的可选方式（含 NSSM/WinSW、LaunchAgent、OpenRC/runit、Docker 等）
  - 补上 **Windows 服务默认崩溃不重启**，需 `sc failure` 显式配置
  - 补上 **Linux 建议用 drop-in 显式声明 `Restart=always`**
  - 补上 **token 模式会把 token 明文写进服务定义** 的风险提示
- 新增 **「隧道要不要自己的看门狗？」** 一节：
  - 区分「进程死亡」（服务管理器负责）与「进程活着但边缘连接掉了」（必须主动探测）
  - 判据用 cloudflared 自带的 `127.0.0.1:20241/ready` 里的 `readyConnections`，
    **不打公网、不过 Access**
  - 用各系统自己的定时器（计划任务 / systemd timer / launchd StartInterval）调度，
    不新增常驻进程；连续 2 次失败才重启

### 新增

- **`scripts/tunnel-service.ps1` / `tunnel-service.sh`**：隧道服务管理工具，
  子命令 `status | install | uninstall | harden | check | watch | unwatch`。
  - `harden`：Windows 写 `sc failure` + `failureflag`；Linux 写 systemd drop-in
    （`Restart=always` + `StartLimitIntervalSec=0`）；macOS 用 PlistBuddy 保证 `KeepAlive`
  - `check`：读 `/ready` 判 `readyConnections`，失败计数落在**用户级状态目录**
    （Windows `%LOCALAPPDATA%\kimicode-pocket`、Linux `${XDG_STATE_HOME}`、
    macOS `~/Library/Application Support/kimicode-pocket`），
    **不写脚本所在目录**，因此从源码目录或运行目录调用都不会污染代码树；
    连续 2 次才重启（防抖，避免一次抖动打断正在用的会话）
  - `watch`：把 `check -Restart` 注册成系统定时任务，三平台各自的机制
  - 统一支持 `-MetricsPort` / `--port`，同机多隧道时指定要盯哪一条
- `npm run tunnel-service -- status` 也可用（`launch.mjs` 现在会透传子命令）。

---

## [1.1.0] — 2026-10-16

### 新增

- macOS / Linux 脚本：`watchdog.sh`、`start-tunnel.sh`、`stop.sh`。
- 「脚本对照」表增加**实测状态**列，明确 `*nix` 脚本仅做过语法校验。
- 「给 AI Agent 的部署指令」改为**目标驱动**：G1-G4 四个目标 + 可验证判据 + 失败分支，
  而不是让 agent 照抄命令。

### 修复

- 隧道脚本原先指向 Desktop 的**动态端口**，Desktop 一重启就断；
  改为指向代理的固定端口。
- 隧道脚本增加"启动前探测代理"与"启动后校验页面标题"。

---

## [1.0.0] — 2026-10-15

首次开源打包。

- 固定端口反向代理（动态端口发现 + Host/Origin 改写 + WebSocket 透传）。
- Windows 常驻脚本（任务计划程序 / Startup + VBS）。
- 文档：快速开始、配置、常驻、固定域名、Cloudflare Access、故障排查。
