# 原理详解：为什么必须改写 Host 与 Origin

这份文档解释每一行关键代码背后的原因。如果你只想用，看 [README](../README.md) 就够了。

文中标注「实测」的结论，都是在真实 Kimi Code Desktop 上直接打请求验证过的，
不是从文档或经验推测的。

---

## 1. 两个必须同时解决的问题

### 问题一：Desktop 的端口是动态的

Kimi Code Desktop 启动时，会在 `~/.kimi-code/server/instances/` 下写一个实例注册文件：

```json
{
  "server_id": "01EXAMPLE0000000000000000",
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 54321,
  "started_at": 1700000000000,
  "heartbeat_at": 1700000600000,
  "host_version": "x.y.z"
}
```

**端口每次重启都可能不同。** 而隧道配置（`config.yml` 的 `ingress.service`）、
防火墙规则、反代的 `upstream` 都必须是**固定值**。

> 直接让隧道指向 Desktop 端口 → Desktop 一重启就断，需要人工改配置。

### 问题二：Host / Origin 白名单

Desktop 的内置 HTTP 服务会校验请求头。**实测结论如下：**

| 场景 | 结果 |
|---|---|
| 直连 Desktop，`Host: evil.example.com` | **403** |
| 直连 Desktop，WebSocket 带 `Origin: https://evil.example.com` | **403** |
| 直连 Desktop，WebSocket **不带** `Origin` | **101 升级成功** |
| 直连 Desktop，普通 GET 带公网 `Origin`（`Host` 仍是回环） | 200（HTTP GET 不校验 Origin） |
| 经 `proxy.mjs`，`Host: evil.example.com` | **200** |
| 经 `proxy.mjs`，WebSocket 带公网 `Origin` | **101** |

两个直接推论：

1. **Host 改写是硬需求**，不改必然 403。
2. **Origin 只能改写，不能删除** —— 因为「不带 Origin」会被**放行**。
   删掉 Origin 等于帮攻击者绕过 CSRF 语义。

而 Cloudflare 隧道默认回源时：

- `Host` = 你的公网域名（如 `kimicode.example.com`）→ 403
- `Origin` = `https://kimicode.example.com` → WebSocket 403

经 Cloudflare 转发后，403 通常表现为 **502**，手机端看到的是 WebSocket error 弹窗。

> **这就是为什么"直接开个隧道"不行。** 很多人卡在这里，误以为是 TLS 或防火墙问题。

### 一个被证伪的旧说法

早期版本（以及很多抄来的教程）会说：

> "隧道配置里必须加 `originRequest.httpHostHeader`，少了必然 403/502。"

**这是错的。** 两条证据：

1. 实测：经 `proxy.mjs` 转发时，即使回源 Host 是 `evil.example.com`，
   代理也会把它改写成 `127.0.0.1:<动态端口>`，结果依然是 **200**。
2. 现网：参考部署的命名隧道 ingress 就是一行
   `hostname: …` + `service: http://127.0.0.1:50980`，**完全没有 `originRequest`**，
   公网访问正常。

`httpHostHeader` 只有在「隧道直连 Desktop、不经过代理」时才有意义。
本项目不再使用它，也不再生成 `config.yml` —— 少一个可能写错的地方。

---

## 2. 解决方案：固定端口 + 双改写

```
手机浏览器
    │  HTTPS，Host: kimicode.example.com, Origin: https://kimicode.example.com
    ▼
Cloudflare 隧道（ingress → http://127.0.0.1:50980）
    │
    ▼
proxy.mjs 监听 127.0.0.1:50980（固定）
    │  ① 动态发现 Desktop 当前端口（如 54321）
    │  ② 改写 Host → 127.0.0.1:54321
    │  ③ 改写 Origin → http://127.0.0.1:54321
    ▼
Kimi Code Desktop 127.0.0.1:54321（动态）
```

### 2.1 端口发现（`src/lib/discovery.mjs`）

三步确认，缺一不可：

```js
for (const inst of sortByHeartbeat(readInstances(dir))) {  // ① 按 heartbeat 降序
  if (!pidAlive(inst.pid)) continue;                      // ② pid 还活着吗
  if (await healthz(inst.port)) {                         // ③ 真的能响应吗
    cache = { port: inst.port, at: now };
    return inst.port;
  }
}
```

**为什么三步都要**：

| 只做 | 会出的问题 |
|---|---|
| ① | 残留的旧注册文件指向已关闭的端口 |
| ①+② | pid 复用了（旧 pid 被新进程占用），但端口不是 Desktop |
| ①+②+③ | ✅ 可靠 |

**2 秒缓存**（`DISCOVERY_TTL_MS`）：避免每个请求都读盘 + 发 HTTP。
Desktop 重启后最坏 2 秒内自动跟上。

`pidAlive` 的细节：

```js
try { process.kill(pid, 0); return true; }
catch (e) { return e.code === 'EPERM'; }   // EPERM = 进程存在但无权限 → 也算活
```

`kill(pid, 0)` 不发信号，只做存在性检查。只有 `ESRCH`（不存在）才算死。

### 2.2 HTTP 改写（`src/lib/rewrite.mjs`）

```js
const headers = rewriteHeaders(req.headers, port);
// Host  → 127.0.0.1:<port>
// Origin → http://127.0.0.1:<port>（存在才改，不凭空添加）
```

**两个容易做错的点**：

1. **`Origin` 要改写，不要删除**（有实测依据，见上文表格）。
2. **`Host` 必须带端口。** Desktop 的白名单是 `127.0.0.1:<port>` 精确匹配。

另外 `rewriteHeaders` 会**大小写不敏感**地找 `Host` / `Origin`，
并在原始请求缺少 `Host` 时补一个（HTTP/1.0 请求可能没有）。

### 2.3 WebSocket 改写（`proxy.mjs` 的 `upgrade` 事件）

WebSocket 不能复用 HTTP 的转发逻辑，因为：

- `http.request` 不处理 `Upgrade`
- 需要在 TCP 层做双向 `pipe`

所以这里手写请求行与头：

```js
const lines = [`${req.method} ${req.url} HTTP/1.1`, ...rewriteRawHeaders(req.rawHeaders, port)];
```

**用 `rawHeaders` 而不是 `headers`**：`headers` 会把重复头合并、把大小写规范化，
重建时可能改变语义。这一点在本项目里尤其关键，因为 Desktop 的 WebSocket 鉴权
走的是**子协议**：

```
Sec-WebSocket-Protocol: kimi-code.bearer.<server.token>
```

这是一个重复头（客户端可能同时声明其它子协议），一旦被合并就废了。
`rawHeaders` 是 `[k1,v1,k2,v2,...]`，逐字节保真。

**为什么 `setTimeout(0)`**：

```js
upstream.setTimeout(0);  // WebSocket 长连接，不设空闲超时
```

Node 的 socket 默认有超时。WebSocket 可能长时间无数据（用户在想问题），
设了超时会被误杀。必须显式清零。

**为什么还要 keepalive**：

```js
upstream.setKeepAlive(true, 30_000);
clientSocket.setKeepAlive(true, 30_000);
```

手机进出休眠、路由器 NAT 表老化之后，长连接可能**静默**失效（两端都不报错，
但消息再也不通）。TCP keepalive 能更早发现死连接。

---

## 3. 配对：为什么 token 不进地址栏

Desktop 前端的凭证机制（读打包后的 `main-*.js` 得到，非猜测）：

```js
// 1. 从 hash 里读
const e = window.location.hash;                       // "#token=xxx"
const n = new URLSearchParams(e.slice(1)).get('token');

// 2. 立刻把 hash 擦掉
i.hash = "";
window.history.replaceState(window.history.state, "", `${i.pathname}${i.search}`);

// 3. 存进 localStorage，7 天后过期
localStorage.setItem('kimi-web.server-credential',
  JSON.stringify({ version: 1, credential: n, expiresAt: Date.now() + 10080 * 60 * 1000 }));
```

两个后果：

1. **`#token=` 只在"首次打开"那一次有效**，之后书签里那条地址就只剩裸域名了。
2. **7 天后 localStorage 记录被删除**，用户会看到白屏 / 401，且没有任何提示。

本项目的配对页（`/__pair?code=…`）绕开了第 1 条：它**直接写 localStorage**
（第 3 步），所以 token 从头到尾不出现在 URL 里。你分享出去的链接只含一个
180 秒后就作废的 6 位口令。

代价是：仍然受第 2 条约束，7 天后必须重新配对。这一点在 README 里被放在了显眼位置。

### 配对状态为什么要回传到终端

口令被兑换的那一刻发生在**服务端**（`consumePairCode`）。第一版是"消费即删"，
于是终端除了自己的计时器就再没有别的信息来源——到期一律打"已失效"，哪怕手机上
早已配对完成。现在记录改为**标记已兑换并保留 10 分钟**，终端每秒读一次本机专用
的 `/__pairstatus`，读到 `redeemed` 就立刻收尾。

注意 `redeemed` 的准确含义是"配对页已被打开、Desktop 凭证已随页面下发"，
**不是**"手机浏览器已经执行完 JS、把凭据写进了 localStorage"——后者服务端看不见。
所以终端文案只说"配对页已打开"，不说"登录成功"。要更严格的确认，只能让配对页
在写完 localStorage 之后再回调一个确认端点，那会引入一个新的公网入口，本期没做。

换句话说：终端显示的不是"我猜的"，而是"服务端那个码到底被用掉没有"。
这也决定了它的两个边界——代理重启（记录在内存里）或换了台机器跑命令，都读不到状态。

---

## 4. 响应压缩：为什么只压 JSON

实测 Desktop 的响应**没有** `Content-Encoding`：

```text
Cache-Control: no-cache
Content-Type: application/json; charset=utf-8
Content-Length: 1418
（没有 Content-Encoding）
```

长会话历史动辄几 MB，在 4G 上很慢。所以代理补上压缩：

| 条件 | 是否压缩 |
|---|---|
| `content-type` 是 `application/json` | ✅ |
| `content-length` 已知且 < 1 KB | ❌（压了反而更大） |
| 上游已经有 `content-encoding` | ❌（不重复压） |
| `content-type` 是 `text/event-stream` | ❌ **必须跳过** |
| 客户端不接受 br/gzip | ❌ |

**为什么 SSE 必须跳过**：流式输出依赖「每条消息一到就 flush」。
经过压缩器会引入缓冲，表现为"手机上的回答一格一格卡着出"。
本项目的做法是白名单制——只压 JSON，其它一律透传。

压缩后要**删掉 `content-length`** 并加 `Vary: Accept-Encoding`，
否则客户端会按原长度读取而卡死。

---

## 5. 为什么代理只绑 127.0.0.1

```js
const bind = env.POCKET_BIND || '127.0.0.1';
```

- 如果绑 `0.0.0.0`，同一局域网内**任何人**都能访问你的 Desktop
- 隧道是从**本机**发起连接的，绑回环完全够用
- 唯一入口是隧道，访问控制交给 Cloudflare（TLS + 可选 Access）

**而且**：如果检测到绑了非回环地址却没设 `POCKET_PIN`，代理会**直接拒绝启动**：

```text
[配置错误] 拒绝启动：POCKET_BIND=0.0.0.0 会把代理暴露到回环之外，但你没有设置 POCKET_PIN。
```

这比"打印警告然后继续跑"好——安全默认值应该是**不可用**而不是**不安全可用**。

---

## 6. 看门狗为什么"连续 2 次失败"才动手

```js
if (misses >= 2) { stopStale(); startProxy(); }
```

**只失败 1 次就重启是危险的**：GC 停顿、系统繁忙、Desktop 短暂重启都会造成
单次探活失败。此时重启代理会**中断正在进行的对话**（WebSocket 断开）。

等 2 次（约 30-60 秒）能过滤掉绝大多数瞬时抖动，同时把真实故障的恢复时间
控制在可接受范围。

---

## 7. 安全边界

| 层 | 措施 |
|---|---|
| 网络 | 代理只绑回环；入口是 Cloudflare TLS |
| 配对 | 一次性 6 位口令（180 秒、用后即焚、不可重放、猜错限速） |
| 认证 | Desktop `server.token`（43 字符随机串）+ 可选 `POCKET_PIN` |
| 限速 | 口令失败 5 次 / 60 秒；配对码同样是 5 次 / 60 秒；全局 600 请求/分钟/IP |
| 本地端点 | 「本机直连」= 回环 socket **且** 无 `CF-Connecting-IP` / `CF-Ray`；`/__paircode`、`/__pairstatus`、`/__status`、`/__qrcode` 只对本机开放 |
| 传输 | Cloudflare 到源站走加密隧道 |
| 建议加固 | Cloudflare Access（邮箱 OTP / SSO） |

**要诚实地说一件事**：Host / Origin 被无条件改写，意味着
**Desktop 那层白名单防线对本项目是有意绕过的**。
安全边界因此下移到了"谁能访问 `proxy.mjs`"。

而 `proxy.mjs` 自身**不校验 Desktop token**（校验由 Desktop 做）。
它保证的是：只监听回环、配对要有口令、口令不能暴力猜、请求不能无限刷。

> ⚠️ **`cloudflared` 也在本机发起连接。**
> 所以"回环 socket"并不能证明请求来自本机——经隧道进来的公网请求，
> `remoteAddress` 同样是 `127.0.0.1`。1.2.0 及更早只判 socket，
> 导致 `/__pair`（当时还有"本机免 code"）在公网直接可读 Desktop token。
> 1.3.0 把判定改成"回环 + 无 CF 头"，并删掉了免 code 旁路。
> 任何新增的"仅本机"端点都必须走 `isLocalRequest()`，不要写
> `isLoopbackAddr(req.socket.remoteAddress)`。

> 另外一个容易忽略的点：Desktop 在 WebSocket 握手响应里会**回显**
> `Sec-WebSocket-Protocol: kimi-code.bearer.<token>`。
> 所以**不要在隧道前面再套一层会记录响应头的反代 / APM / WAF 日志**，
> 那会把明文 token 写进日志。

---

## 8. 已知限制

1. **依赖内部实现**：`instances/*.json`、`/api/v1/healthz`、前端凭证格式都不是公开 API
2. **快速隧道地址会变**：`trycloudflare.com` 每次重启重新分配
3. **单用户设计**：没有多租户隔离，一个代理一个 Desktop
4. **凭证 7 天过期**：这是 Desktop 前端的硬编码 TTL，代理无法延长
5. **无请求级鉴权**：代理不校验 token，完全依赖 Desktop 与隧道
6. **配对页需要前端配合**：写的是 `localStorage['kimi-web.server-credential']`，
   官方改 key 或结构就会失效（改 `src/lib/pages.mjs` 即可适配）

---

## 9. 想扩展成通用工具？

当前实现已经有几个可抽象点：

| 现状 | 抽象方向 |
|---|---|
| `POCKET_APP_HOME` / `POCKET_HEALTH_PATH` 已参数化 | 已可适配其它"实例注册 + 健康检查"的桌面应用 |
| 实例发现逻辑在 `discovery.mjs` | 抽成适配器接口（读目录 / 查进程 / 扫端口） |
| Host/Origin 改写规则在 `rewrite.mjs` | 抽成可配置的 `rewriteRules` |
| 配对逻辑在 `pages.mjs` + `proxy.mjs` | 抽成 `pairStrategy`（localStorage / cookie / header） |

如果你要适配别的应用，欢迎提 Issue 说明它的实例发现方式。
