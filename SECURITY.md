# 安全策略

这个项目的功能就是**把一台能执行代码的电脑暴露到互联网上**。
所以安全问题是这里的第一优先级，而不是"有空再说"的加分项。

---

## 报告漏洞

**请不要公开提 Issue。**

用 GitHub 的私密渠道：

👉 https://github.com/<你的用户名>/kimicode-pocket/security/advisories/new

（发布前请把上面这行改成你自己的仓库地址。）

请在报告里包含：

- 受影响的版本 / commit
- 复现步骤（最小可复现即可）
- 你判断的影响面
- 如果有 PoC，脱敏后再贴（**不要贴真实 token、真实域名**）

我们尽力在 7 天内首次回复。

---

## 支持范围

| 版本 | 是否接受安全修复 |
|---|---|
| 1.3.x | ✅ |
| 1.2.x | ⚠️ 仅 1.3.0 及以后修复了「本机」判定缺陷，1.2.x 请升级 |
| 1.1.x | ❌ 请先升级 |
| < 1.1 | ❌ |

---

## 威胁模型（请先理解这个再评估风险）

**本项目的安全边界不是"代理"，而是"谁能访问代理"。**

我们有意绕过了 Kimi Code Desktop 自带的 Host/Origin 白名单
（那正是本项目存在的理由）。这意味着：

```
                         ┌── 边界在这里 ──┐
手机/浏览器 ── HTTPS ──► Cloudflare ──► proxy.mjs ──► Desktop（白名单已被绕过）
```

因此，任何能访问到 `proxy.mjs` 的东西，都能操作你的 Desktop，
**只要它同时拿到了 Desktop 的 server.token**。

### 已知的、设计如此的行为

| 行为 | 说明 |
|---|---|
| Host / Origin 被强制改写为回环 | 这是核心功能，不是漏洞 |
| 代理不校验 Desktop token | 校验由 Desktop 完成；代理只做转发 |
| `#token=` 是完整凭证 | 拿到它 = 拿到你的 Desktop 会话 |
| 快速隧道域名可被公开解析 | 但没 token 进不去；仍不建议长期开 |
| 配对后凭证有效期 7 天 | 前端的限制，过期需重新配对 |

### 不在范围内

- 需要先拿到 `server.token` 才能利用的问题（那已经等于拿到了钥匙）
- Kimi Code Desktop 自身的漏洞 —— 请报告给官方
- Cloudflare 侧的问题 —— 请报告给 Cloudflare
- 你自己把 `POCKET_BIND` 改成 `0.0.0.0` 又不设 `POCKET_PIN` 导致的风险
  （代理会**拒绝启动**，但如果你自己绕过了这层，责任在你）

---

## 怀疑凭证泄露时的处置

按这个顺序做，**先止血再排查**：

1. **立刻停掉隧道**（快速隧道直接杀进程；命名隧道在 Cloudflare 后台禁用）
2. **轮换 Desktop token**：重启 Kimi Code Desktop，它会生成新的 `server.token`
3. **换掉 `POCKET_PIN`**（如果开了）：改环境变量并重启代理，所有旧会话立即失效
4. **检查访问日志**：状态目录下的 `logs/proxy.log` 里搜 `access` 行，看有没有陌生 IP
5. **查 Desktop 侧痕迹**：会话列表里有没有你不认识的对话
6. 如果用过 Cloudflare Access，去 Zero Trust 日志里核对登录记录

> 第 4 步能用的前提是你没关 `POCKET_ACCESS_LOG`（默认开）。
> 日志只记 path，不记 query —— 因为 query 里可能有配对口令。

---

## 加固清单

部署到公网前，逐项确认：

- [ ] 代理**只绑 `127.0.0.1`**（默认就是；别为了"方便"改成 `0.0.0.0`）
- [ ] 设置了 `POCKET_PIN`（至少 8 位；这是 token 之外的第二道锁）
- [ ] 长期使用就走**命名隧道 + Cloudflare Access**，不要长期挂快速隧道
- [ ] 配对链接用完即弃（一次性口令 180 秒就失效，别截图存档）
- [ ] 不把带 `#token=` 的地址发到任何群聊 / Issue / 截图里
- [ ] 定期看一眼状态目录里 `logs/proxy.log` 的 `access` 行
- [ ] 电脑设置屏幕锁定 —— 物理接触等于完全控制

---

## 我们已经在代码里做的

| 措施 | 位置 |
|---|---|
| 默认只绑回环 | `src/lib/config.mjs` |
| 非回环绑定 + 无口令 → **拒绝启动** | `src/lib/config.mjs` |
| 一次性配对口令（180 秒、用后即焚、不可重放） | `src/proxy.mjs` `/__pair` |
| 配对状态只对本机可见（终端回显用它，公网 404） | `src/proxy.mjs` `/__pairstatus` |
| 配对码猜错限速（5 次 / 60 秒） | `src/proxy.mjs` `pairLimiter` |
| 「本机」= 回环 socket + 无 `CF-Connecting-IP`/`CF-Ray` | `src/lib/rewrite.mjs` `isLocalRequest` |
| `/__pair` 无免口令旁路；内部端点对隧道来源 404 | `src/proxy.mjs` |
| 口令登录失败限速（5 次 / 60 秒） | `src/lib/auth.mjs` `FailureLimiter` |
| 单 IP 请求限速（默认 600/分钟，可关） | `src/lib/auth.mjs` `RateLimiter` |
| 会话 Cookie：HttpOnly + SameSite=Lax + 条件 Secure | `src/proxy.mjs` |
| 健康检查对外不回显内部端口 | `src/proxy.mjs` `/__healthz` |
| 访问日志不记 query | `src/proxy.mjs` `logAccess` |
| 请求体上限（防大包打满内存/磁盘） | `POCKET_MAX_BODY_MB` |
| 配对页 / 登录页 `no-store` + `noindex` + `nosniff` | `src/lib/pages.mjs` |
| 二维码本地生成（绝不调用第三方在线服务） | `src/lib/qr.mjs` |
| 日志轮转（5 MB） | `src/proxy.mjs` |
