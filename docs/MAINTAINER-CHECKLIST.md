# 维护者自查清单

发布新版本 / 开源前逐项确认。CI 里已经自动化了一部分（见
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) 的 `desensitize` job），
这里是需要人工判断的部分。

---

## 一、敏感信息（最高优先级）

- [ ] 仓库里**没有**真实 token（`server.token`、`ag-` / `sk-` / `ms-` 开头的 Key）
- [ ] 仓库里**没有**真实域名（自己的二级域名、`.online` / `.top` 之类）
- [ ] 仓库里**没有** RFC1918 内网网段地址
- [ ] 仓库里**没有**带真实用户名的绝对路径（占位符如 `C:\Users\<你>` 可以留）
- [ ] 仓库里**没有** `pair-url.txt` / `pair-qr.png` / `pid.txt` / `*.log`
- [ ] 仓库里**没有** UUID（隧道 ID / 账号 ID / connector ID 都是 UUID 形态）
- [ ] 仓库里**没有**邮箱地址（Access allow 列表里那个）
- [ ] 示例里的端口、instance JSON、`server_id` 都是**编造**的，不是真机快照
- [ ] 截图（如有）**不含**地址栏 token、不含文件名 / 路径里的个人信息
- [ ] `.gitignore` 覆盖上述所有模式
- [ ] `package.json` 里的 `github.com/OWNER/…` 已换成真实账号与仓库名

自查命令（在仓库根目录）：

```bash
# Key / 内网 IP / 本机路径 / Linux 家目录 / UUID / 邮箱
git grep -nE '(ag|sk|ms)-[A-Za-z0-9]{20,}'
git grep -nE '192\.168\.|10\.[0-9]+\.[0-9]+\.|172\.(1[6-9]|2[0-9]|3[01])\.'
git grep -nE '[A-Za-z]:\\+Users\\+[A-Za-z0-9_.-]'
git grep -nE '/home/[a-z][a-z0-9_-]{2,}/'
git grep -nE '\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b'
git grep -nE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|cn|net|org)'

# 自己的域名（唯一无法自动化的那条：把关键词换成你的主域/品牌词）
git grep -niE '<你的域名关键词>'
```

> 「域名泛匹配」刻意没进 CI：`cfg.compress`、`shields.io`、`apple.com/DTDs`、
> `cloudflareaccess.com` 都是正常引用，泛化匹配只会把闸门变成噪音。
> **这一条必须人工过一遍，任何输出都先处理再发布。**

---

## 二、文件完整性

必需：

- [ ] `README.md`（非官方声明 / 前提约束 / 兼容性风险 / 安全须知 / 故障排查）
- [ ] `README.en.md`（与中文版逐节对应；改中文版时必须同步改英文版）
- [ ] `LICENSE`（MIT）
- [ ] `SECURITY.md`
- [ ] `CHANGELOG.md`
- [ ] `package.json`（`version` 与 CHANGELOG 最新条目一致）
- [ ] `.gitignore`
- [ ] `src/proxy.mjs` + `src/lib/{config,args,discovery,rewrite,auth,pages,qr,pairwatch}.mjs`
- [ ] `scripts/`（`.ps1` × 3、`.sh` × 3、`.vbs`、`launch.mjs`）
- [ ] `test/`（9 个测试文件）
- [ ] `docs/how-it-works.md`、`docs/MAINTAINER-CHECKLIST.md`
- [ ] `.github/workflows/ci.yml`

脚本可执行位（**从 Windows 打包 zip 时很容易丢**）：

```bash
git update-index --chmod=+x scripts/*.sh
git ls-files -s scripts/*.sh     # 期望 mode 是 100755
```

---

## 三、逐文件脱敏要点

| 文件 | 要确认的点 |
|---|---|
| `src/proxy.mjs` | 无硬编码域名 / IP；端口与路径全部来自环境变量 |
| `src/lib/config.mjs` | 默认路径用 `os.homedir()`，不写死用户名 |
| `src/lib/pages.mjs` | 无外链 CDN、无统计脚本、无第三方二维码服务 |
| `src/lib/qr.mjs` | 纯算法，无任何网络请求 |
| `scripts/*.ps1` | 路径用 `$PSScriptRoot` 推导，不含绝对路径 |
| `scripts/*.sh` | 路径用 `BASH_SOURCE` 推导，不含绝对路径 |
| `scripts/*.vbs` | 路径用 `WScript.ScriptFullName` 推导 |
| `docs/*.md` | 示例域名一律 `example.com`，端口用 `5xxxx` |

---

## 四、代码质量

```bash
npm run check        # 全部模块语法检查
npm test             # 126 个用例，必须全绿
```

- [ ] `npm test` 全绿
- [ ] 新增行为有对应测试（尤其涉及安全边界的分支）
- [ ] 改动 `src/lib/qr.mjs` 时，`test/qr.test.mjs` 的指纹需要同步更新
      —— **并说明为什么允许编码结果变化**
- [ ] `shellcheck -S error scripts/*.sh` 无 error
- [ ] 所有 `.ps1` 能被 PowerShell Parser 解析（CI 里有）

---

## 五、文档一致性（最容易翻车的地方）

发版前对照代码逐条核对，**任何一条不一致都算 bug**：

- [ ] **`README.en.md` 与 `README.md` 同步**（改了一边就改另一边；测试数、默认值、端点表最容易漏）
- [ ] README 的「配置」表 == `src/lib/config.mjs` 里实际读的变量
- [ ] README 的「代理自有端点」表 == `src/proxy.mjs` 里实际处理的路由
- [ ] README 的「项目结构」== 实际目录
- [ ] README 的「实测状态」列 == 真实验证情况（**没跑过就写没跑过**）
- [ ] `--help` 输出 == README 的变量表与选项表（`node src/proxy.mjs --help` 对一遍）
- [ ] `package.json` 的 `version` == `src/proxy.mjs` 里的 `VERSION` == CHANGELOG 顶部

> 本项目踩过的坑：曾经把 `POCKET_LOG_DIR` 的默认值写错（实际落在 `src/.logs`），
> 还把 `httpHostHeader` 说成"必需"（实测是冗余的）。**文档说谎比没文档更糟。**

---

## 六、GitHub 发布

- [ ] 仓库名与 README 标题一致（`kimicode-pocket`）
- [ ] Description 一句话说清用途（中英各一版更好）
- [ ] Topics：`kimi-code` `cloudflare-tunnel` `reverse-proxy` `remote-access`
      `websocket` `qrcode` `mobile`
- [ ] 选择 MIT License
- [ ] 打开 **Settings → Security → Private vulnerability reporting**（SECURITY.md 依赖它）
- [ ] 首次提交信息清晰，例如 `feat: initial release v1.3.0`
- [ ] 打 tag `v1.3.0`
- [ ] 确认 CI 在三个平台都绿

---

## 七、发布后

- [ ] 手机浏览器打开 README 渲染正常、目录锚点能跳
- [ ] 代码高亮正常（`.mjs` / `.ps1` / `.sh`）
- [ ] 从零按 README 走一遍：起代理 → 起隧道 → 扫码 → 手机进得去
- [ ] 故意等一天再试一次，确认「7 天过期」的说明与实际一致
- [ ] 确认仓库是 Public（如果本意是开源）
