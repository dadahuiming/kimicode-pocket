<div align="center">

# KimiCode Pocket

**Put Kimi Code Desktop's web UI in your pocket — control it from any phone browser, nothing to install on the phone.**

<p align="center"><b>English</b> | <a href="README.md">中文</a></p>

[![CI](https://github.com/dadahuiming/kimicode-pocket/actions/workflows/ci.yml/badge.svg)](https://github.com/dadahuiming/kimicode-pocket/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Cloudflare Tunnel](https://img.shields.io/badge/Cloudflare-Tunnel-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D6)](#platform-parity)
[![Tests](https://img.shields.io/badge/tests-126%20passing-brightgreen)](#development--testing)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

</div>

> ## ⚠️ Unofficial project
>
> This is a **community-built third-party tool**. It has **no affiliation with, and no
> endorsement from, Moonshot AI / Kimi**. Check that your use complies with Kimi Code's
> terms of service.
>
> It relies on **internal implementation details** of Kimi Code Desktop (the instance
> registry files and the internal health endpoint). These are not public APIs and a
> Desktop update may break them at any time. See [Compatibility risks](#compatibility-risks).

---

## Table of contents

- [What problem does this solve](#what-problem-does-this-solve)
- [Features](#features)
- [Prerequisites (read this first)](#prerequisites-read-this-first)
- [Deployment shapes](#deployment-shapes)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Pairing and credentials](#pairing-and-credentials)
- [Configuration](#configuration)
- [Platform parity](#platform-parity)
- [Running 24/7](#running-247)
- [Production: named tunnel + fixed domain](#production-named-tunnel--fixed-domain)
- [Security hardening](#security-hardening)
- [Operations: logs, status, rollback](#operations-logs-status-rollback)
- [Instructions for AI agents](#instructions-for-ai-agents)
- [Compatibility risks](#compatibility-risks)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [How it works](#how-it-works)
- [Development and testing](#development--testing)
- [Origins and evolution](#origins-and-evolution)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)
- [Disclaimer](#disclaimer)

---

## What problem does this solve

Kimi Code Desktop embeds a web UI that only listens on loopback, and — this is the
important part — **its port changes every time it restarts**. Meanwhile a Cloudflare
tunnel's ingress must point at a **fixed** port.

Two more things make naive port forwarding fail:

1. The Desktop HTTP server has a **Host allowlist**. A request carrying a non-loopback
   `Host` gets `403`.
2. The WebSocket endpoint checks `Origin`. A public `Origin` gets `403`; a request with
   **no `Origin` at all** gets `101`. So you must **rewrite** `Origin`, never delete it —
   deleting it would hand attackers a bypass.

KimiCode Pocket solves all three at once: a tiny zero-dependency reverse proxy on a
fixed port that discovers the Desktop port dynamically, rewrites `Host`/`Origin` to
loopback on both HTTP and WebSocket, and relays everything.

| Measured on a real deployment | Result |
|---|---|
| Fixed proxy port | `50980`, never changes |
| Desktop port changes | handled — rediscovered automatically in ~2s |
| Phone over 4G, long conversation JSON | brotli/gzip, ~1/10 of the original bytes |
| One-time pairing link | 6 digits, **180 seconds**, single use |

---

## Features

| Feature | What it does |
|---|---|
| **Fixed port** | The tunnel only ever points at `50980`; a Desktop restart changes nothing |
| **Dynamic port discovery** | Registry file + PID liveness + real health probe, 2s cache with in-flight deduplication |
| **Host / Origin rewriting** | Same rule for HTTP and WebSocket; **rewrite, never delete** (measured, not guessed) |
| **WebSocket passthrough** | Rebuilt byte-for-byte from `rawHeaders`; either side closing tears both down |
| **One command to a link** | `--pair-only --base https://…` prints the link plus a terminal QR code; **the token never enters the URL bar** |
| **One-time code** | 6 digits, **180 seconds**, single use, no replay; 5 wrong guesses locks the IP for 60s; `--pair-count` for several devices at once |
| **Live pairing feedback** | The terminal counts down under the QR code and flips to a success line within about a second of the pairing page opening; an all-unscanned batch is the only thing that ends in red "expired" |
| **Real local-vs-public split** | "Local" means loopback socket **and** no Cloudflare headers; tunnel traffic gets no internal endpoints |
| **Optional second password** | `POCKET_PIN`, cookie session, 5 failures / 60s |
| **Response compression** | JSON only, brotli/gzip (bigger responses get a higher level); SSE explicitly skipped |
| **Crash recovery** | Watchdog probes every 30s, restarts only after 2 consecutive failures (no interrupted conversations) |
| **Safe defaults** | Binds `127.0.0.1` only; refuses to start on a non-loopback bind without a PIN |
| **Zero dependencies** | Node built-ins only — you don't even need `npm install` |
| **Doesn't dirty the repo** | Logs and pairing artefacts go to the platform state directory; `git status` stays clean |
| **Cross-platform** | Proxy core is identical on all three platforms; only the daemon scripts differ |
| **Testable** | 126 tests, including process-level integration tests; CI covers 3 OS × 2 Node versions |

---

## Prerequisites (read this first)

These are hard constraints. If one fails, nothing further will work.

### 1. Kimi Code Desktop must run in a machine with a **graphical session**

It is a GUI application. A headless Linux box reached over plain SSH will not do — no
`DISPLAY`, no Desktop, no web UI.

### 2. The computer must stay powered on and must not sleep

The Desktop is the thing serving the UI. Sleep = connection gone.

### 3. The machine must be able to run Node.js 22+

Needed for built-in `fetch`, `AbortSignal.timeout` and `server.closeIdleConnections`.
Node 18 and 20 are out of maintenance and are not supported.

### 4. Port `50980` must be free

Change it with `POCKET_PORT` / `--port` if something else uses it.

### 5. You need a working egress path to Cloudflare

`cloudflared` makes an outbound connection. A corporate proxy or a TUN-mode VPN that
swallows `*.argotunnel.com` is the single most common cause of `error 1033`.

### 6. Security is on you

**This tool exposes a computer that can execute code.** Read
[Security hardening](#security-hardening) before you point a domain at it.

---

## Deployment shapes

**"Public access" does not mean "the program runs on a public server".**

### Shape A: an always-on home / office computer (recommended, the main scenario)

```
┌──────────────────────────────────┐
│ your computer (Win/macOS/Linux)  │
│  ├─ Kimi Code Desktop (GUI)      │  ← needs a logged-in desktop session
│  ├─ proxy.mjs :50980             │
│  └─ cloudflared                  │
└──────────┬───────────────────────┘
           │ outbound long-lived connection (no public IP, no port forwarding)
           ▼
   Cloudflare edge ──► phone / any browser
```

**Pros:** no public IP, no router ports, no VPS.
**Requires:** machine stays on, desktop session stays logged in.

### Shape B: LAN access only (no public exposure)

By default the proxy binds `127.0.0.1`, so other LAN devices cannot reach it. If you
want LAN access:

- **Recommended:** SSH port forwarding — `ssh -L 50980:127.0.0.1:50980 user@your-pc`
- **Or:** `POCKET_BIND=0.0.0.0 POCKET_PIN=<at least 6 chars>` — this exposes your
  Desktop to **every** device on that network. Use a strong PIN, and only on a network
  you trust.

> If you bind a non-loopback address without `POCKET_PIN`, the proxy **refuses to
> start** and tells you why. That is deliberate.

### Shape C: a server / VPS with a public IP

> ⚠️ Only viable if Kimi Code can run **with graphics** on that machine.

If the server is headless, this path is closed (see [prerequisites](#prerequisites-read-this-first)).
If the Desktop genuinely runs on a Linux box with a desktop, you can either use a
cloudflared tunnel (same as shape A) or put Nginx/Caddy in front of `127.0.0.1:50980`
with your own TLS.

**No Nginx/Caddy config is shipped**, because the tunnel is simpler and needs no
inbound ports. If you do build your own reverse proxy: **requests must pass through
`proxy.mjs`**, otherwise the Host/Origin rewriting never happens.

---

## Requirements

| Component | Version | Why |
|---|---|---|
| **Node.js** | **22+** | built-in `fetch`, `AbortSignal.timeout`, `server.closeIdleConnections`, `node:test` (tests only). 18/20 are EOL and unsupported |
| **cloudflared** | recent | only for public access; install from [Cloudflare's releases](https://github.com/cloudflare/cloudflared/releases) |
| Kimi Code Desktop | current | must have been started at least once so it writes `server.token` |
| OS | Windows 10+ / macOS 12+ / any modern Linux | |

```bash
# Windows
winget install OpenJS.NodeJS.LTS
winget install Cloudflare.cloudflared

# macOS
brew install node cloudflared

# Linux
# install Node 22 from nodesource or your distro, then:
# download the .deb / .rpm from https://github.com/cloudflare/cloudflared/releases
```

> ⚠️ Debian/Ubuntu repo packages may be older than Node 22. Check with `node --version`.

---

## Quick start

Two minutes normally; **under 30 seconds if you already own a domain** and the tunnel is
up.

### Step 1: start the proxy

```bash
cd kimicode-pocket
node src/proxy.mjs
```

You should see:

```text
KimiCode Pocket 1.3.0 代理已启动: http://127.0.0.1:50980
  健康检查   http://127.0.0.1:50980/__healthz
  运行状态   http://127.0.0.1:50980/__status
  口令保护   未开启（仅靠 Desktop token）
  Desktop    127.0.0.1:54321
```

(Output is Chinese; the numbers matter more than the labels.)

**Verify locally first:** open `http://127.0.0.1:50980` in a browser on that machine.
You should get the Kimi Code web UI.

> If this fails, **do not start on the tunnel yet** — see [Troubleshooting](#troubleshooting).

### Step 2: expose it publicly

The point of this project is **remote access**, so the full deployment goes through the
public internet (if you only need the same Wi-Fi, see [shape B](#deployment-shapes)).
Pick one:

**A. You already have a named tunnel + fixed domain (recommended for 24/7)**

Skip this step and go to [Production deployment](#production-named-tunnel--fixed-domain).
Once the tunnel is up, adding a device is one command (see
[one command to a link](#one-command-to-a-link)).

**B. You don't have a domain yet (quick tunnel, temporary)**

> This uses a `trycloudflare.com` quick tunnel: no domain, no account, two minutes to a
> working URL. Downsides: **the address changes on every restart**, and **Access cannot
> be attached**.

Windows:

```powershell
pwsh -File scripts/start-tunnel.ps1
```

macOS / Linux:

```bash
chmod +x scripts/*.sh        # required after unzipping
./scripts/start-tunnel.sh
```

The script probes the proxy, asks it for a one-time code, starts the tunnel, verifies
public reachability, prints the pairing link and writes `pair-qr.png` (into the
[state directory](#where-logs-live), **not the repo**).

> The script strips `HTTP_PROXY` / `HTTPS_PROXY` before launching cloudflared. If you
> actually want the tunnel to go through your proxy, pass `-RespectProxy` (PowerShell)
> or `RESPECT_PROXY=1` (shell).

### Step 3: scan with your phone

**Fixed domain (path A):**

```bash
node src/proxy.mjs --pair-only --base https://kimicode.example.com
```

```text
公网入口 https://kimicode.example.com

配对链接（一次性，用后立即失效）
  https://kimicode.example.com/__pair?code=834172

  █▀▀▀▀▀█ █ ▄ ██▄ ▄▀█▄▄▀    █▀▀▀▀▀█
  ... (the QR code is drawn right in your terminal)

  ⏳ 剩余 176 秒（01:57:04 失效，一次性）
```

**Quick tunnel (path B):** the `start-tunnel` script prints its own block:

```text
===== 公网远控已就绪 =====
配对链接（180 秒内有效，用一次就失效）:
https://xxxx-xxxx-xxxx.trycloudflare.com/__pair?code=834172

二维码已保存: C:\Users\<you>\AppData\Local\kimicode-pocket\pair-qr.png
```

**Scan the QR code** (or open the link on the phone) → pairing completes → the Kimi Code
UI opens.

> The QR code is generated **locally** (`src/lib/qr.mjs`, drawn with half-block
> characters). No third-party QR service is ever contacted — that would hand your
> pairing URL to a stranger.

**Stopping:**

```bash
# Windows
pwsh -File scripts/stop.ps1

# macOS / Linux
./scripts/stop.sh
```

---

## Pairing and credentials

This section explains why the phone "just works", and when it suddenly stops working.

### What pairing actually does

Kimi Code's web UI needs a credential to call its API:

1. It reads `#token=` from the URL fragment
2. Stores it in `localStorage['kimi-web.server-credential']`
3. **Immediately erases the fragment** with `history.replaceState`
4. Sends `Authorization: Bearer <token>` on every request
5. Uses `Sec-WebSocket-Protocol: kimi-code.bearer.<token>` for the WebSocket

This project's pairing page (`/__pair?code=…`) does **step 2 directly**: it writes the
object into `localStorage` and redirects to `/`.

> Upside: **the token never appears in the address bar, the browsing history, or the
> clipboard.** The link you share carries only a 6-digit code that dies after 180 seconds.

### ⏰ It expires after 7 days (important)

The frontend hardcodes a **7-day** lifetime (`expiresAt = now + 10080 minutes`). After
that, the entry is removed from `localStorage` and the phone shows a blank page or 401.

**This is not a bug — it is Desktop's design.** Generate a new pairing link (no need to
restart the tunnel):

```bash
node src/proxy.mjs --pair-only --base https://kimicode.example.com
```

> Which is exactly why a [named tunnel with a fixed domain](#production-named-tunnel--fixed-domain)
> is recommended: the domain stays the same, so you only need a fresh code.

### The one-time code

| Property | Value |
|---|---|
| Length | 6 digits |
| Lifetime | **180 seconds** (`POCKET_PAIR_TTL_SEC`, range 30–3600) |
| Uses | **once** — dead the moment it is redeemed (the record lingers 10 min, only so the terminal can read the outcome) |
| How to obtain | `GET /__paircode` (**local direct connections only**) |
| Wrong guesses | same IP: 5 failures → locked for 60 seconds |
| Live feedback | yes — the terminal shows a countdown and switches to a success line the second the code is redeemed |

> **One code per device.** Pairing a tablet after a phone needs a new code
> (`--pair-count 2` produces two at once).
>
> Codes live in memory only, so restarting the proxy invalidates every outstanding link.

### One command to a link

The most common action on a fixed-domain deployment is "open a door for a new device".
No need to touch the tunnel:

```bash
# one link (run on the computer; the proxy must already be running)
node src/proxy.mjs --pair-only --base https://kimicode.example.com

# phone + tablet at once
node src/proxy.mjs --pair-only --base https://kimicode.example.com --pair-count 2
```

The terminal prints the link, the QR code, and then a countdown:

```text
  一台设备一个码；该设备凭证 7 天有效。

  ⏳ 剩余 176 秒（01:57:04 失效，一次性）
```

Once the phone actually opens the pairing page, that line is replaced **within about a second**:

```text
  ✔ 配对页已打开（01:54:31），手机上应已进入 Kimi Code，可以关掉这个窗口。
```

So you do **not** sit through the remaining two minutes. The verdict comes back from the
server (`GET /__pairstatus`), not from a local timer guessing. If nobody scans, it only
flips at the deadline:

```text
  ✖ 当前链接、二维码已失效，请重新生成！
```

The link and the QR code die together (they encode the same one-time code). Run the
command again for a fresh one.

The signal is **the server-side code being redeemed** — the phone really opened the
pairing page and the Desktop credential went out with it. That is "page delivered", not
"the phone's browser finished running the JS"; the latter is invisible to the server, so
the wording stays at "pairing page opened" instead of claiming a login. Time spent on the
Cloudflare Access login screen does not count, as long as the page opens before the deadline.

With several devices (`--pair-count 2`) the status line carries a `已配对 1/2` counter.
If only one of them was paired, the closing line is `⚠ 已配对 1/2，其余链接已失效` — it
does not call the device that did pair a failure.

The default is **180 seconds**. 60 seconds was tried and proved too tight (scan, clear the
Access login, then confirm); three minutes is enough without inviting people to leave a
live code lying around. `POCKET_PAIR_TTL_SEC` accepts 30–3600.

> When stdout is a pipe or a file there is no animation: it prints a single line,
> `链接于 01:57:04 失效。`, so logs don't get hundreds of lines and pipelines don't block.
> The trade-off is that this mode cannot report the pairing result — there is no terminal
> to report it to.

`--base` also has an environment equivalent, so a service definition can set it once and
the daily command becomes just `npm run pair`:

```bash
POCKET_PUBLIC_URL=https://kimicode.example.com node src/proxy.mjs --pair-only
```

> Starting the proxy with `--base` prints the link and QR code in the same startup
> output — one terminal window instead of two (the countdown and the success line run
> there as well, and the outcome is also written to `proxy.log`).

---

## Configuration

**Environment variables only, no config file.** The project stays stateless, so a
rollback is just "put the old code back".

Command-line flags win over the same-named environment variable.

| Variable | Default | Description |
|---|---|---|
| `POCKET_PORT` | `50980` | Listening port (`--port`) |
| `POCKET_BIND` | `127.0.0.1` | Bind address. A non-loopback value **requires** `POCKET_PIN` |
| `POCKET_APP_HOME` | `~/.kimi-code` | Desktop config dir (instance files and token) |
| `POCKET_HEALTH_PATH` | `/api/v1/healthz` | Health probe path |
| `POCKET_LOG_DIR` | `<state dir>/logs` | Log directory (**never inside the repo**) |
| `POCKET_PUBLIC_URL` | *(empty)* | Public base URL, e.g. `https://kimicode.example.com` (`--base`) |
| `POCKET_PIN` | *(empty)* | Extra access password, min 6 chars. Enables the PIN gate (`--pin`) |
| `POCKET_UPSTREAM_TIMEOUT_MS` | `120000` | Upstream **idle** timeout (not total) |
| `POCKET_MAX_BODY_MB` | `64` | Request body limit |
| `POCKET_COMPRESS` | `1` | JSON response compression |
| `POCKET_ACCESS_LOG` | `1` | Access log |
| `POCKET_RATE_LIMIT` | `600` | Requests per minute per IP, `0` disables |
| `POCKET_PAIR_TTL_SEC` | `180` | One-time code lifetime in seconds (min 30) |

### Command-line options

```bash
node src/proxy.mjs --help
```

| Option | Effect |
|---|---|
| `--port <port>` | same as `POCKET_PORT` |
| `--pin <secret>` | same as `POCKET_PIN` |
| `--base <url>` | same as `POCKET_PUBLIC_URL`; also prints a pairing link + QR on startup |
| `--pair-only` | only generate a pairing link, then exit (proxy must be running; `--base` required) |
| `--pair-count <n>` | with `--pair-only`, generate 1–20 codes at once |

> `--base` accepts public addresses only. A loopback value such as
> `http://127.0.0.1:50980` is rejected outright — it would produce a QR code no phone
> can open, i.e. a "successful" failure.

### Where logs live

⚠️ **Not in the repo.** Defaults to the platform state directory:

| Platform | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\kimicode-pocket\logs\` |
| macOS | `~/Library/Application Support/kimicode-pocket/logs/` |
| Linux | `~/.local/state/kimicode-pocket/logs/` (honours `XDG_STATE_HOME`) |

This package is a **deliverable, not a working directory**. Running it from the repo
would write a `.logs` folder into the working tree, dirtying `git status` and turning
"clean release" into something that only holds thanks to `.gitignore`. Override with
`POCKET_LOG_DIR` if you want.

### Typical values

**Port conflict:**

```bash
# Windows PowerShell
$env:POCKET_PORT = '60980'; node src/proxy.mjs

# macOS / Linux
POCKET_PORT=60980 node src/proxy.mjs
```

**Custom Desktop config directory** (if Desktop was started with `KIMI_CODE_HOME`):

```bash
POCKET_APP_HOME=/opt/kimi-home node src/proxy.mjs
```

**Add a password:**

```bash
POCKET_PIN='a-longer-passphrase-is-better' node src/proxy.mjs
```

### Checking that settings took effect

```bash
curl http://127.0.0.1:50980/__status
```

`__status` echoes the effective configuration (**local direct connections only**).
`pairCodesPending` counts only codes that are **neither redeemed nor expired** — do not
read it as "how many were ever issued":

```json
{
  "ok": true, "version": "1.3.0", "proxyPort": 50980, "bind": "127.0.0.1",
  "desktopPort": 54321, "appHome": "C:\\Users\\<you>\\.kimi-code",
  "publicUrl": "https://kimicode.example.com", "pinEnabled": false,
  "compress": true, "accessLog": true, "rateLimitPerMin": 600,
  "pairCodesPending": 1, "uptimeSec": 128, "node": "v22.11.0"
}
```

### Environment variables when running as a service

> ⚠️ Environment variables only apply to the current shell. When running under a
> watchdog or a service manager, put them in the service definition, or they silently
> revert to defaults after a reboot.

---

## Platform parity

`src/proxy.mjs` + `src/lib/*` are **identical on all three platforms** (pure Node
built-ins). What differs is daemonisation and paths.

### Config directory (same everywhere)

```
~/.kimi-code/server/instances/*.json
~/.kimi-code/server.token
```

| Platform | `instances` path |
|---|---|
| Windows | `C:\Users\<you>\.kimi-code\server\instances\` |
| macOS | `/Users/<you>/.kimi-code/server/instances/` |
| Linux | `/home/<you>/.kimi-code/server/instances/` |

### Scripts

| Task | Windows | macOS / Linux | Verification status |
|---|---|---|---|
| Start proxy | `node src/proxy.mjs` | same | ✅ tested on Windows; identical code everywhere |
| Start tunnel | `scripts/start-tunnel.ps1` | `scripts/start-tunnel.sh` | ⚠️ see note below |
| Run 24/7 | `scripts/watchdog.ps1` + `.vbs` | `scripts/watchdog.sh` or systemd / launchd | ✅ long-running on Windows |
| Stop | `scripts/stop.ps1` | `scripts/stop.sh` | ✅ tested on Windows |
| Tunnel service | `scripts/tunnel-service.ps1` | `scripts/tunnel-service.sh` | Windows `status`/`check` tested; `harden`/`watch` need admin; *nix untested |
| Tests | `npm test` | `npm test` | ✅ 126/126 on Windows; CI covers all three |

> ### ⚠️ About verification status (please read)
>
> **`src/proxy.mjs` is the core and is platform-independent.** Its forwarding logic
> (port discovery, Host/Origin rewriting, WebSocket passthrough) comes from an
> implementation that has been running in production for a long time. The newer
> features (pairing, PIN, compression, rate limiting, the local-vs-public check) are
> covered by 126 automated tests, including process-level ones that spawn real processes.
>
> To be explicit: **the three `.sh` scripts have only been syntax-checked with
> `bash -n` (under Git Bash) and have not been run end-to-end on real macOS or Linux.**
> `start-tunnel.ps1` is a rewritten version whose full chain (tunnel → proxy → Desktop)
> **has not yet been exercised end to end in a real environment.**
>
> They will most likely work (they mirror the verified logic), but platform differences
> exist:
>
> - `ps -Ao pid=,args=` differs slightly between BSD/macOS and GNU/Linux
> - `curl` in BusyBox builds lacks some flags
> - `nohup` + `&` behaves differently inside a systemd session
> - `env -u` needs coreutils (the macOS build has it)
>
> **So: on macOS/Linux, treat the scripts as reference implementations and follow the
> goals and success criteria instead. If a script fails, start `node src/proxy.mjs`
> manually and assemble the cloudflared command yourself — the core does not depend on
> these scripts.**

### macOS notes

1. **The user must stay logged in.** Logging out quits GUI apps.
2. **Prevent sleep:** System Settings → Lock Screen → "Turn display off … prevent
   sleep" → **Never**.
3. **First run of shell scripts** needs the executable bit:

   ```bash
   chmod +x scripts/*.sh
   ```

4. **Gatekeeper** may quarantine downloaded scripts:

   ```bash
   xattr -d com.apple.quarantine scripts/*.sh
   ```

### Linux notes

1. **A graphical session is required** (X11 / Wayland). Headless servers over plain SSH
   are out of scope.
2. If you start GUI-related processes over SSH, set `DISPLAY` (local desktop) or
   `WAYLAND_DISPLAY`.
3. Ports below 1024 need root, so the default `50980` is the safe choice.

---

## Running 24/7

**Goal: the proxy restarts when it dies, and starts at boot.**

### Windows

**Option 1: Task Scheduler (recommended)**

1. Open Task Scheduler → Create Task
2. **General**: "Run only when user is logged on" (needed to see the Desktop GUI)
3. **Triggers**: New → "At log on"
4. **Actions**: Start a program
   - Program: `powershell.exe`
   - Arguments: `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\path\to\kimicode-pocket\scripts\watchdog.ps1"`
5. **Conditions**: uncheck "Start the task only if the computer is on AC power"
6. **Settings**: check "If the task fails, restart every 1 minute"

**Option 2: Startup folder + VBS (simplest)**

1. `Win+R` → `shell:startup`
2. **Right-drag** `scripts\start-watchdog.vbs` into it → Create shortcut
   (don't copy the file: the script locates itself relative to its own path)
3. It starts hidden at the next logon

**Option 3: let Desktop start itself too**

Kimi Code Desktop usually has a "launch at login" option. Turn it on, otherwise after a
reboot the proxy is alive but finds no Desktop (`/__healthz` → `ok:false`).

**Power settings (important):**

- Control Panel → Power Options → "Put the computer to sleep" → **Never**
- "Turn off the display" can stay — it doesn't stop programs
- Laptops: closing the lid may sleep; change the lid action

### macOS

**Option 1: launchd (recommended)**

Create `~/Library/LaunchAgents/com.kimicode.pocket.plist`:

| Key | Value |
|---|---|
| `Label` | `com.kimicode.pocket` |
| `ProgramArguments` | `["/usr/local/bin/node", "/path/to/kimicode-pocket/src/proxy.mjs"]` |
| `RunAtLoad` | `true` |
| `KeepAlive` | `true` |
| `StandardOutPath` / `StandardErrorPath` | log paths |
| `EnvironmentVariables` | `POCKET_PORT` / `POCKET_PIN` etc. |

Load it: `launchctl load ~/Library/LaunchAgents/com.kimicode.pocket.plist`

> `RunAtLoad` + `KeepAlive` already replace the watchdog; `watchdog.sh` is unnecessary.

**Option 2: quick and dirty**

```bash
nohup ./scripts/watchdog.sh >/dev/null 2>&1 &
```

### Linux

**Option 1: systemd user service (recommended)**

Requires a **graphical session** (local desktop), not a headless server.

Create `~/.config/systemd/user/kimicode-pocket.service`:

| Key | Value |
|---|---|
| `[Unit] After` | `graphical-session.target` |
| `[Service] ExecStart` | `/usr/bin/node /path/to/kimicode-pocket/src/proxy.mjs` |
| `[Service] Restart` | `always` |
| `[Service] RestartSec` | `5` |
| `[Service] Environment` | `POCKET_PORT=50980` (if you need to change settings) |
| `[Install] WantedBy` | `default.target` |

```bash
systemctl --user daemon-reload
systemctl --user enable --now kimicode-pocket
systemctl --user status kimicode-pocket
```

> `Restart=always` already replaces the watchdog. Logs:
> `journalctl --user -u kimicode-pocket -f`.

### Verify with a reboot (all platforms)

Do this once, **always**:

1. Reboot
2. Wait for the desktop login to finish
3. `curl http://127.0.0.1:50980/__healthz`
4. Expect `{"ok":true,"desktopPort":<not null>}`

If `ok:false` → the proxy started but the Desktop didn't; go check Desktop's own
launch-at-login setting.

---

## Production: named tunnel + fixed domain

A quick tunnel (`trycloudflare.com`) **gets a new address on every restart** and is only
good for a trial. For 24/7 use, go with **a named tunnel + your own domain + Cloudflare
Access** — that is also this project's reference deployment.

### Which entry point to choose

| | Quick tunnel | Named tunnel (recommended) |
|---|---|---|
| Address | changes on every start | **fixed** `kimicode.example.com` |
| Access support | ❌ | ✅ |
| Persistence | you babysit the process | installs as a system service |
| Good for | trying it out | long-term / 24/7 |

### Step A: create the tunnel (in the dashboard, recommended)

> **Use the "remotely managed" mode**: the config lives in Cloudflare, the machine only
> holds a token, and there is no `config.yml` to maintain. This is how the reference
> deployment runs.

1. Onboard your domain to Cloudflare (NS records), wait for **Active**
2. [Zero Trust](https://one.dash.cloudflare.com/) → **Networks → Tunnels → Create a tunnel**
3. Choose **Cloudflared**, name it (e.g. `home`), save
4. Add a **Public Hostname**:

   | Field | Value |
   |---|---|
   | Subdomain | `kimicode` |
   | Domain | your domain |
   | Type | `HTTP` |
   | URL | `127.0.0.1:50980` |

   > ⚠️ **The URL must be the proxy's fixed port `50980`, not Desktop's dynamic port.**
   > Do not use `https://` — the cloudflared → localhost hop is plain HTTP.

5. Copy the **install command** the dashboard shows (it embeds the token) and run it:

   ```bash
   # identical on Windows / macOS / Linux, token generated by the dashboard
   cloudflared service install <YOUR_TUNNEL_TOKEN>
   ```

   It registers a system service that starts at boot. **No `config.yml` needed.**

#### Appendix: how the tunnel is daemonised (three platforms)

**One command, three different service managers.** This is the most commonly missed
difference:

| Platform | Lands in | Starts | Needs a desktop login? |
|---|---|---|---|
| Windows | SCM service `cloudflared` (LocalSystem) | at boot | ❌ no |
| macOS | LaunchDaemon in `/Library/LaunchDaemons/` (root) | at boot | ❌ no |
| Linux | `/etc/systemd/system/cloudflared.service` (system unit) | at boot | ❌ no |

> **This shapes the whole architecture: the tunnel is system-level, the proxy is
> user-level.**
> The tunnel only needs to reach `127.0.0.1:50980`, so it needs no graphical session;
> `proxy.mjs` must run inside the user's desktop session, because Desktop is a GUI app.
>
> Therefore: **do not shove cloudflared into `watchdog.ps1`** — it has its own service
> manager, and two supervisors will fight each other.

**Options per platform**

Windows:

| Approach | Boot start | Crash restart | Note |
|---|---|---|---|
| `cloudflared service install <TOKEN>` | ✅ | ❌ **not by default**; add `sc failure` | official |
| Task Scheduler (at logon / at startup) | ✅ | ✅ "restart on failure" | reuses an existing scheduler |
| NSSM / WinSW wrapper | ✅ | ✅ | unified logs and restart policy |
| Startup folder `.vbs` | at logon | ❌ | crudest, temporary only |

macOS:

| Approach | Boot start | Crash restart | Note |
|---|---|---|---|
| `sudo cloudflared service install <TOKEN>` | ✅ | ✅ | official |
| hand-written LaunchDaemon | ✅ | ✅ via `KeepAlive` | when you need control over env/logs |
| hand-written LaunchAgent | only **after login** | ✅ | ⚠️ inherits user env — a classic 1033 trap |
| `nohup` in a shell | ❌ | ❌ | temporary |

Linux:

| Approach | Boot start | Crash restart | Note |
|---|---|---|---|
| `sudo cloudflared service install <TOKEN>` | ✅ | version-dependent | official; verify with `systemctl cat` |
| hand-written systemd **system** unit + drop-in | ✅ | ✅ `Restart=always` | most controllable |
| systemd **user** unit | only **after login** | ✅ | ⚠️ the counter-example: no session, no tunnel |
| OpenRC / runit / s6 | ✅ | ✅ | Alpine, Void, … |
| supervisord / pm2 | needs its own boot start | ✅ | if you already run one |
| Docker + `--restart unless-stopped` | ✅ | ✅ | containerised |

**Right division of labour**

| Component | Who starts it | Who restarts it | Common mistake |
|---|---|---|---|
| `cloudflared` | system service, at boot | the service manager | stuffing it into the watchdog, fighting SCM/systemd |
| `proxy.mjs` | user-level, at login | `watchdog.ps1` / launchd `KeepAlive` / systemd `--user` `Restart=always` | installing it as a system service → no desktop session |
| Kimi Code Desktop | the app's own "launch at login" | the app itself | forgetting it → proxy alive but `ok:false` |

**Use the included tool (recommended)**

All of "install the service + configure restart + check health + schedule self-healing"
is wrapped in one script:

```bash
# Windows (admin shell for install/harden)
pwsh -File scripts\tunnel-service.ps1 status     # what is installed now
pwsh -File scripts\tunnel-service.ps1 harden     # sc failure + automatic start
pwsh -File scripts\tunnel-service.ps1 check      # read readyConnections
pwsh -File scripts\tunnel-service.ps1 watch      # install the 5-minute health task

# macOS / Linux
./scripts/tunnel-service.sh status
./scripts/tunnel-service.sh harden
./scripts/tunnel-service.sh check
./scripts/tunnel-service.sh watch
```

#### Does the tunnel need its own watchdog?

**Yes — but not a "process is alive" one.** Two distinct failure modes:

| Failure | Who notices | Who fixes it |
|---|---|---|
| Process crashed / killed | the service manager | Windows `sc failure`, systemd `Restart=always`, launchd `KeepAlive` |
| **Process alive but the edge connection dropped** | only active probing | health check + timer |
| The local proxy died | `watchdog.ps1` / `.sh` | the proxy watchdog |

The second one is the easy one to miss: NAT ageing, Wi-Fi switching to Ethernet, or
toggling a VPN can leave cloudflared **running with no connections** — the phone shows
`error 1033` while the machine looks fine. The service manager cannot see this.

So this project does not add a second resident daemon. It does:

```
cloudflared exposes the real connection count at 127.0.0.1:20241/ready
        ↓
tunnel-service's check reads readyConnections
        ↓
restart the service only after 2 consecutive zeroes (avoid one-off blips)
        ↓
let each OS's own timer schedule it (no extra resident process)
```

| Platform | Timer | Install command |
|---|---|---|
| Windows | Task Scheduler (SYSTEM, every 5 minutes) | `tunnel-service.ps1 watch` |
| macOS | LaunchDaemon `StartInterval` | `tunnel-service.sh watch` |
| Linux | systemd timer (`OnUnitActiveSec`) | `tunnel-service.sh watch` |

```bash
curl -s http://127.0.0.1:20241/ready
# {"status":200,"readyConnections":3,"connectorId":"..."}
```

> `readyConnections` is the **real edge connection count**, not a heartbeat. It is the
> most reliable local signal for "is the tunnel actually up" — no public request, no
> Access round trip.
>
> When several tunnels run on one machine, each needs its own `--metrics` port; select
> which one to watch with `-MetricsPort` / `--port`.

### Step B: is `originRequest` needed?

**No.** The proxy rewrites `Host` to `127.0.0.1:50980`, so `httpHostHeader` is
redundant. The reference deployment has no `originRequest` block at all.

If you inherited a config that sets `httpHostHeader`, it does no harm — just don't
believe it is required.

### Step C: DNS

Creating the public hostname in the dashboard creates the CNAME for you:
`kimicode` → `<tunnel-id>.cfargotunnel.com`, **proxied (orange cloud)**.

> Access requires the orange cloud. A grey-cloud record bypasses Access entirely.

### Step D: add one line of Access (strongly recommended)

1. [Zero Trust](https://one.dash.cloudflare.com/) → **Access → Applications → Add an
   application → Self-hosted**
2. Fill in:
   - **Application name**: `KimiCode Pocket`
   - **Session Duration**: `8 hours` or shorter
   - **Application domain**: `kimicode.example.com`
3. **Add a policy**: Action `Allow` → `Emails` → your own address
4. Save

**Verify** in a private window: you should hit the Cloudflare login page first. If the
private window goes straight into the web UI, Access is not active — re-check that the
domain matches exactly.

### Step E (optional): manage locally instead of the dashboard

```bash
cloudflared tunnel login
cloudflared tunnel create home
cloudflared tunnel route dns home kimicode.example.com
cloudflared tunnel run --token <TOKEN> home
```

The dashboard path is recommended: fewer moving parts, and the ingress is validated
before it goes live.

### ⚠️ Tunnels are usually shared

One tunnel can serve several hostnames (e.g. `app-a.example.com`, `app-b.example.com`
and `kimicode.example.com` on the same tunnel). Two frequent mistakes when editing
ingress:

1. **`http_status:404` must stay last**, otherwise it swallows every rule after it
2. **Rules with `path` must come before host-only rules**, or they never match

Confirm the other services are still up before you close the page.

---

## Security hardening

Four layers. **At least do the first two.**

### Layer 0: understand what "local" means (a real bug fixed in 1.3.0)

This is not a setting, it's a prerequisite for reasoning about the rest.

`cloudflared` opens its loopback connection **from this machine**, so a public request
arriving through the tunnel has `remoteAddress === 127.0.0.1` as well. Code that only
looks at the socket address therefore treats the whole internet as "local direct
access" — and `/__pair` (which used to have a "local, no code needed" branch),
`/__paircode` and `/__status` are all exposed. That is equivalent to publishing Desktop's
`server.token` on your front page.

Since 1.3.0, "local direct" means **loopback socket + no Cloudflare headers**
(`CF-Connecting-IP` or `CF-Ray` present ⇒ treat as tunnel traffic). Consequently:

- `/__pair` has **no** code-free bypass at all
- `/__status`, `/__paircode`, `/__pairstatus`, `/__qrcode` return 404 to tunnel traffic
- `/__healthz` returns only `{"ok":true}` to tunnel traffic

> After upgrading you may notice `/__status` returning 404 from the public side.
> **That is correct.** Do not "fix" it.

### Layer 1: `POCKET_PIN` (free, 5 seconds)

```bash
POCKET_PIN='a-longer-passphrase-is-better' node src/proxy.mjs
```

Effects:

- Every page asks for the password first (`/__login`)
- Cookie session for 7 days, `HttpOnly` + `SameSite=Lax`
- **5 wrong attempts → 60 second lock**
- Changing the PIN logs every device out (the session key is derived from the PIN)

> Honest note: Desktop's `server.token` is 43 random characters (~250 bits of entropy),
> so **brute force is mathematically hopeless**. The PIN is not anti-brute-force; it is
> "one more layer if the token leaks" plus "I can rotate a password without touching
> Desktop".

### Layer 2: Cloudflare Access (strongly recommended for long-term use)

Access authenticates **before** the tunnel, so a leaked URL is still useless.

See [Step D](#step-d-add-one-line-of-access-strongly-recommended).

### Layer 3: zone-level switches (set once, effective forever)

Cloudflare dashboard → your domain → SSL/TLS and Security:

| Setting | Recommendation | Why |
|---|---|---|
| **Always Use HTTPS** | on | phones on flaky networks type `http://` |
| **Minimum TLS Version** | **1.2** or higher | the default is often 1.0 (TLS 1.0/1.1 are deprecated and pure attack surface) |
| **HSTS** | on, `max-age` ≥ 6 months | prevents downgrade attacks; **don't** turn it off casually, browsers remember |
| **SSL/TLS mode** | Full (strict) | the tunnel's origin hop is internal, but be strict zone-wide |
| **Bot Fight / Security Level** | Medium or higher | filters some automated scanning |

> ⚠️ **Before raising Minimum TLS to 1.2, make sure no old device still needs 1.0.**
> Test with your phone immediately afterwards.

### Layer 4: the network side

- Bind the proxy to `127.0.0.1` only (the default — don't change it)
- Shut the tunnel down when you're done
- Skim the `access` lines in `proxy.log` now and then

---

## Operations: logs, status, rollback

### Log locations

**Not in the repo.** Defaults to the platform state directory (see
[Configuration](#configuration)):

| File | Contents | Rotation |
|---|---|---|
| `<state dir>/logs/proxy.log` | proxy log + access log | ✅ rotates to `.1` past 5 MB |
| `<state dir>/watchdog.log` | watchdog probes and restarts | ✅ truncated past 5 MB |
| `<state dir>/proxy.out` / `proxy.err` | proxy stdout / stderr | ❌ none (usually tiny) |
| `<state dir>/pair-url.txt` / `pair-qr.png` | last quick-tunnel pairing artefacts | — |

`<state dir>` is `%LOCALAPPDATA%\kimicode-pocket` on Windows,
`~/Library/Application Support/kimicode-pocket` on macOS, and
`~/.local/state/kimicode-pocket` on Linux (honours `XDG_STATE_HOME`).

Access log format:

```text
2026-10-17T13:02:11.981Z access 203.0.113.7 GET /api/v1/providers 200 42ms
```

> **Only the path is logged, never the query string** — it may contain a pairing code or
> a `client_id`. Set `POCKET_ACCESS_LOG=0` to turn it off.

### Three-layer triage

```bash
# 1) is the proxy alive, and did it find a Desktop?
curl -s http://127.0.0.1:50980/__healthz

# 2) can this machine reach the Desktop web UI directly?
curl -s http://127.0.0.1:<desktopPort>/api/v1/healthz

# 3) is the tunnel up? (real edge connection count)
curl -s http://127.0.0.1:20241/ready
```

### After upgrading Kimi Code Desktop

Nothing to do, normally. The registry file is rewritten on start, `heartbeat_at` moves,
and discovery picks it up within 2 seconds. If the UI 404s or the WebSocket dies, check
[Compatibility risks](#compatibility-risks).

### Rollback

```bash
# stop the proxy, then start the previous version — no data to clean up
```

Nothing is persisted except the log files. There is no state directory to migrate.

---

## Instructions for AI agents

This section is written for an agent deploying the project on someone's machine.

### Core principle: **drive to goals, don't copy commands**

The commands below are one valid path, not a ritual. Adapt them to the platform, and
verify with the criteria rather than "I ran the command".

### Deployment goals (all four must hold)

| # | Goal | Verifiable criterion |
|---|---|---|
| G1 | Proxy is running and found a Desktop | `curl http://127.0.0.1:50980/__healthz` returns `"ok":true` with a numeric `desktopPort` |
| G2 | The proxy actually forwards the web UI | `curl -s http://127.0.0.1:50980 \| grep -q '<title>Kimi Code</title>'` |
| G3 | Reachable from the internet | the tunnel URL returns 200 (or 302 to `/__login` with a PIN set) |
| G4 | A pairing link is delivered | the user has a `/__pair?code=XXXXXX` link and knows its lifetime |

**Do not proceed to G3 while G1/G2 fail** — otherwise you'll debug the tunnel when the
problem is one layer below.

### Step 0: environment probe (read-only)

| Probe | Why | Suggested command |
|---|---|---|
| Node ≥ 22 | below 22 there is no `fetch` / `AbortSignal.timeout` / `server.closeIdleConnections` | `node --version` |
| Desktop is running | without a registry file it always fails | list `~/.kimi-code/server/instances/`, or check the process |
| Port 50980 free | otherwise the proxy cannot start | `netstat -ano \| findstr :50980` / `lsof -i:50980` / `ss -ltnp` |
| cloudflared present | no tunnel without it | `cloudflared --version` |
| **graphical session** | a Linux box without `DISPLAY` cannot run a GUI | `echo $DISPLAY` (*nix) |
| proxy variables in the environment | `HTTP_PROXY` makes cloudflared fail with `error 1033` | `env \| grep -i proxy` |

**If any of these fails, stop and report exactly what is missing. Do not install system
software on your own.**

### Step 1: achieve G1

**Reference:** `node src/proxy.mjs` (foreground, or background with output redirected).

**Criterion:** `/__healthz` returns `"ok":true` with a numeric `desktopPort`.

| Symptom | Meaning | Suggested action |
|---|---|---|
| connection refused | proxy not up | read stderr: usually Node version or a syntax error |
| `"ok":false` | proxy alive, no Desktop | confirm Desktop really runs; confirm the instance directory |
| "refuses to start" | you set `POCKET_BIND` without `POCKET_PIN` | do one or the other: revert to `127.0.0.1`, or add a PIN |

### Step 2: achieve G2

**Criterion:** `curl -s http://127.0.0.1:50980 | grep -q '<title>Kimi Code</title>'`
(with a PIN set, `curl -sI` returning 302 is correct).

403 → Host/Origin rewriting; 502 → upstream connection. Both send you back to G1's
`desktopPort`.

### Step 3: achieve G3

**Reference:** `scripts/start-tunnel.ps1` / `start-tunnel.sh`, or assemble it yourself:

```bash
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:50980
```

The one hard requirement: **point at the proxy's fixed port (50980), not Desktop's
dynamic port.** `httpHostHeader` is not required (the proxy rewrites `Host`).

> ⚠️ Clear `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` before launching cloudflared,
> otherwise the tunnel registers but the data plane cannot connect (`error 1033`).

**Criterion:** the tunnel URL returns 200 (or 302 to `/__login`).

### Step 4: achieve G4

**Preferred** (fixed domain, one command):

```bash
node src/proxy.mjs --pair-only --base https://<domain>
# several devices: --pair-count 2
```

**Fallback** (quick tunnel): run `start-tunnel`, which prints the link and writes
`pair-qr.png` itself.

Deliver to the user:

1. **Pairing link** `https://<domain>/__pair?code=<6 digits>` (or the QR code)
2. **Lifetime**: link **180 seconds**, single use; the phone's credential lives **7 days**
3. **Security note**: this link is equivalent to operating their computer; recommend
   `POCKET_PIN`
4. **Persistence**: point to [Running 24/7](#running-247) for their platform

> ⚠️ **Never try `curl https://<domain>/__paircode` from the public side.** Those
> endpoints only answer local direct connections (since 1.3.0); the public side gets
> 404. Codes must be requested on the computer itself.
>
> Never try to "work around" that 404 — it blocks the chain where a single
> `GET /__pair` hands out Desktop's token.

### Platform notes (guidance, not law)

| Platform | Suggestion | Caveat |
|---|---|---|
| **Windows** | prefer the `.ps1` scripts | PowerShell 5.1 works; `curl` may be an alias, use `Invoke-WebRequest` |
| **macOS** | `node` + cloudflared manually; launchd for persistence | `.sh` needs `chmod +x` and de-quarantine |
| **Linux** | `node` + cloudflared manually; systemd user service | make sure `DISPLAY` exists |
| **WSL / containers** | ⚠️ usually no graphical session | if Desktop lives outside, this path is closed |

### Prohibitions

- ❌ **Do not** write pairing links, `#token=` URLs or `server.token` into logs, commit
  messages, issues, or any persistent file
- ❌ **Do not** modify anything under `~/.kimi-code/` (that is Desktop's territory)
- ❌ **Do not** bind `0.0.0.0` without `POCKET_PIN` (the proxy refuses to start — don't
  bypass it)
- ❌ **Do not** claim success from a headless environment (probe `DISPLAY` first)
- ❌ **Do not** report "deployment complete" without per-goal evidence
- ❌ **Do not** rewrite the scripts to make them work; the core doesn't need them
- ❌ **Do not** use an online QR service (it leaks the URL)

### Failure report format

```markdown
## Deployment failed at G<n>

- Platform / Node: Windows 11 / v22.x
- What I ran: <command>
- Observed: <status code / stderr line>
- What I checked: <probes, in order>
- Blocked by: <missing capability / permission / dependency>
```

### Success report format

```markdown
## Deployment complete

- G1 ✅ /__healthz → {"ok":true,"desktopPort":54321}
- G2 ✅ local / returns <title>Kimi Code</title>
- G3 ✅ https://<domain> → 200 (or 302 /__login)
- G4 ✅ pairing link issued, 180s lifetime, countdown shown, pairing result echoed back
- Persistence: <service name / task name>, verified after reboot
```

---

## Compatibility risks

**These are internal implementation details and may change at any time:**

| Dependency | Location | Symptom when broken |
|---|---|---|
| Instance registry | `~/.kimi-code/server/instances/*.json` (`port` / `pid` / `heartbeat_at`) | port discovery fails |
| Health endpoint | `GET /api/v1/healthz` | probe fails |
| Host/Origin allowlist behaviour | Desktop's built-in HTTP server | rewriting stops working |
| Config root derivation | `KIMI_CODE_HOME ?? ~/.kimi-code` | instances not found |
| Frontend credential storage | `localStorage['kimi-web.server-credential']`, 7-day TTL | pairing page stops working |
| WebSocket auth | `Sec-WebSocket-Protocol: kimi-code.bearer.<token>` | WS connection fails |

**Symptom:** `/__healthz` returns `{"ok":false,"desktopPort":null}` and pages 503.

**Order of investigation:** Desktop really running → any new file under `instances/` →
`curl http://127.0.0.1:<that port>/api/v1/healthz` by hand.

If only a path moved, override it with `POCKET_APP_HOME` / `POCKET_HEALTH_PATH`; no code
change needed. If the credential mechanism changed, adapt
`src/lib/pages.mjs`.

---

## Troubleshooting

<details>
<summary><b><code>/__status</code> or <code>/__paircode</code> returns 404 from the public side</b></summary>

**Expected since 1.3.0, not a fault.**

Those are operator endpoints restricted to "local direct connections": cloudflared
connects from loopback, so without filtering on Cloudflare headers anyone with the domain
could fetch Desktop's `server.token` (see [Security hardening](#security-hardening)).

To get a pairing code, run this **on the computer**:

```bash
node src/proxy.mjs --pair-only --base https://your-domain
```

or `curl http://127.0.0.1:50980/__paircode`.
</details>

<details>
<summary><b>The phone stopped working (a week after pairing)</b></summary>

**Almost certainly the credential expired.** The frontend hardcodes a **7-day** lifetime;
after that the `localStorage` entry is deleted and you get a blank page or 401.

Fix: generate a new pairing link (`--pair-only --base https://your-domain`) and pair
again — no need to restart the tunnel.

> Related confusion: the browser erases `#token=` with `history.replaceState`
> immediately, so **a bookmarked token URL only ever works once**. After 7 days you need
> a fresh link; the bare domain won't do.
</details>

<details>
<summary><b>Access login succeeds but bounces back to the login page (302 loop)</b></summary>

Three common causes:

1. **Cookies blocked**: private windows / tracking protection can stop the
   `cloudflareaccess.com` session. Use a normal window and allow third-party cookies.
2. **DNS record is not proxied (grey cloud)**: Access depends on the Cloudflare proxy.
   Grey cloud = traffic goes direct and Access is out of the path. Turn the orange cloud on.
3. **Application domain ≠ tunnel hostname**: you protected `a.example.com` but browse
   `b.example.com`, so Access considers it unprotected and lets it through — which looks
   like "no login page at all".

Triage: does a private window ask for login (no → case 3), then check the DNS proxy
status.
</details>

<details>
<summary><b>Changing tunnel ingress broke another service</b></summary>

One tunnel often serves several hostnames (e.g. `app-a.example.com`, `app-b.example.com`
and `kimicode.example.com`). Two frequent errors:

- **`http_status:404` not last** — it swallows every rule after it
- **A `path` rule placed after a host-only rule** — it never matches

Re-read the whole ingress list in order before leaving the page.
</details>

<details>
<summary><b>502s, or a WebSocket error on the phone</b></summary>

Almost always Host or Origin being rejected. Check:

1. Is the tunnel pointing at `50980` (the proxy) rather than Desktop's port?
2. `curl -s http://127.0.0.1:50980/__status` — is `desktopPort` a number?
3. Proxy log: `ws upstream error` or `403` lines
4. Run `cloudflared tunnel --url http://127.0.0.1:50980` manually and read its stderr
</details>

<details>
<summary><b>503 — Desktop not running or no registered instance</b></summary>

1. Is Kimi Code Desktop really running (**with a window**, not just a background process)?
2. Is there a `.json` file under `~/.kimi-code/server/instances/`?
3. `curl http://127.0.0.1:<port from that file>/api/v1/healthz`
4. If Desktop just restarted, wait 2 seconds (discovery cache TTL)
5. If Desktop was started with `KIMI_CODE_HOME`, set the same `POCKET_APP_HOME`
</details>

<details>
<summary><b>Pairing code says "invalid / expired"</b></summary>

- A one-time code lives **180 seconds** and works **once**
- Restarting the proxy invalidates every outstanding code
- If you exceed 5 wrong attempts from one IP, you're locked for 60 seconds
- Generate a new one on the computer:
  `node src/proxy.mjs --pair-only --base https://your-domain`
</details>

<details>
<summary><b>The phone is in, but the computer says "expired"</b></summary>

Before 1.3.0 this was real: the terminal only counted down and never asked the server.
It now polls `/__pairstatus` once a second and switches to `✔ 配对页已打开` the moment the
pairing page is served. If you still see "expired", check in this order:

1. **Is the terminal on the same computer?** `--pair-only` talks to the local
   `127.0.0.1:50980`; from SSH or another box it cannot read the state
2. **Did the proxy restart in between?** Codes live in memory, so the terminal can only
   fall back to its own deadline
3. **Is stdout a pipe or a file?** That mode prints one expiry line and deliberately
   reports nothing else

For an accurate answer, run it in a real terminal window (`npm run pair`).
</details>

<details>
<summary><b>The QR code won't scan</b></summary>

- Prefer the one printed in the terminal (black on white, correct polarity)
- Or use `pair-qr.png` (also generated locally) — don't re-generate it with a third-party tool
- Enough screen brightness, no scaling blur
- It encodes a 180-second link; if it won't scan, just type the URL
</details>

<details>
<summary><b>Forgot the PIN</b></summary>

There's no recovery (nothing but the plaintext you configured is stored). Change the
environment variable and restart; existing sessions die because the key changes.
</details>

<details>
<summary><b>The watchdog keeps restarting the proxy</b></summary>

Read `watchdog.log`. `proxy still unhealthy after restart` means **the process starts but
the probe fails**:

```bash
node --version                       # needs 22+
netstat -ano | findstr :50980        # Windows: port in use
lsof -i :50980                       # macOS / Linux
```

Common causes: too-old Node, port conflict, a syntax error in `proxy.err`, or an invalid
`POCKET_BIND` + `POCKET_PIN` combination causing an immediate exit.
</details>

---

## Project layout

```
kimicode-pocket/
├── src/
│   ├── proxy.mjs              # entry: HTTP forwarding, WS passthrough, own endpoints, compression, limits
│   └── lib/
│       ├── config.mjs         # env parsing + safety gate (non-loopback requires a PIN) + public URL validation
│       ├── args.mjs           # CLI parsing (pure functions, unit-tested)
│       ├── discovery.mjs      # instance discovery (registry + pid + real probe + in-flight dedup)
│       ├── rewrite.mjs        # Host/Origin rewriting + "local direct" detection (loopback and no CF headers)
│       ├── auth.mjs           # session tokens, cookies, failure limiter, rate limiter
│       ├── pages.mjs          # login / pairing / error pages (inline, no external links)
│       ├── pairwatch.mjs      # terminal countdown + pairing status echo (stops on success)
│       └── qr.mjs             # zero-dependency QR: SVG / terminal / PNG
├── scripts/
│   ├── start-tunnel.ps1       # Windows: tunnel + pairing code + QR
│   ├── start-tunnel.sh        # macOS/Linux: same
│   ├── watchdog.ps1           # Windows watchdog
│   ├── watchdog.sh            # macOS/Linux watchdog
│   ├── stop.ps1 / stop.sh     # stop watchdog + proxy
│   ├── start-watchdog.vbs     # Windows hidden-window launcher (self-locating)
│   ├── tunnel-service.ps1     # Windows: tunnel service install/uninstall/harden/check/watch
│   ├── tunnel-service.sh      # macOS/Linux: same (systemd / launchd)
│   └── launch.mjs             # actual entry behind npm run tunnel|tunnel-service|watchdog|stop
├── test/
│   ├── args.test.mjs
│   ├── config.test.mjs
│   ├── discovery.test.mjs
│   ├── rewrite.test.mjs
│   ├── auth.test.mjs
│   ├── qr.test.mjs
│   ├── proxy.integration.test.mjs   # ships a fake Desktop, process-level integration tests
│   ├── pairwatch.test.mjs     # countdown / success / partial / poll-failure terminal behaviour
│   └── cli.test.mjs           # CLI contract (help / exit codes / link + expiry output)
├── docs/
│   ├── how-it-works.md        # deep dive, with measurements
│   └── MAINTAINER-CHECKLIST.md
├── .github/workflows/ci.yml   # 3 OS × Node 22/24 + shellcheck + desensitisation gate
├── CHANGELOG.md
├── SECURITY.md
├── LICENSE
├── README.en.md
└── README.md
```

---

## How it works

See [docs/how-it-works.md](docs/how-it-works.md) for the long version.

1. **Port discovery:** read `instances/*.json` → sort by `heartbeat_at` → check PID
   liveness → real `GET /api/v1/healthz` → cache for 2 seconds (concurrent lookups share
   one in-flight probe)
2. **HTTP forwarding:** rewrite `Host` and `Origin` to `127.0.0.1:<port>`, then forward
   verbatim
3. **WebSocket upgrade:** rebuild the request line and headers from `rawHeaders`
   (byte-faithful), rewriting Host/Origin; then pipe both ways. Either side closing tears
   down both — no application-level idle timeout, half-open sockets are left to TCP
   keepalive
4. **Self-healing:** a separate watchdog polls `/__healthz` and restarts after two
   consecutive failures

### Proxy endpoints

| Endpoint | Who can reach it | Purpose |
|---|---|---|
| `GET /__healthz` | full detail for local direct; `{ok}` only via the tunnel | liveness |
| `GET /__status` | **local direct only** | effective configuration |
| `GET /__paircode` | **local direct only** | issue a one-time code |
| `GET /__pairstatus?codes=a,b` (`code=` also accepted) | **local direct only** | state of those codes: `pending` / `redeemed` / `expired` / `unknown`, so the terminal can report the outcome |
| `GET /__pair?code=` | holders of a valid code (**no bypass**) | pairing page (writes the credential, then redirects) |
| `GET /__login` | anyone (exists only when a PIN is set) | password page |
| `GET\|POST /__qrcode` | **local direct only** | render text as a PNG QR code |

> **"Local direct" = loopback socket and no Cloudflare headers** (`CF-Connecting-IP` /
> `CF-Ray`). The socket alone is not enough: cloudflared also connects from loopback.
> That is the bug fixed in 1.3.0.
>
> Why `/__healthz` hides detail from the internet: earlier versions echoed
> `desktopPort`, publishing an internal port. Low value to an attacker, but unnecessary.

---

## Development & testing

```bash
# zero dependencies, no npm install required
node src/proxy.mjs            # run
npm run check                 # syntax check (all modules)
npm test                      # 126 tests
```

Two layers of tests:

- **Unit:** config parsing, instance discovery, header rewriting, session tokens, rate
  limiting, QR encoding
- **Integration:** `test/proxy.integration.test.mjs` starts a **fake Desktop** (a
  few-dozen-line HTTP/WS server), then spawns the real `proxy.mjs` against it, covering
  discovery → forwarding → compression → WS → pairing → PIN. **No real Desktop needed.**
- **CLI contract:** `test/cli.test.mjs` checks help, exit codes, and the pairing output
  (link, QR, expiry line)

---

## Origins and evolution

The core is **not written from scratch**.

Fixed-port reverse proxying, three-stage port discovery, Host/Origin rewriting and
WebSocket header rebuilding come from an implementation that has been running
**on the author's own machine, daily**, for a long time. Open-sourcing did two things:

1. **Desensitisation:** environment variables unified as `POCKET_*`, every machine path,
   port and domain trace removed
2. **Incremental hardening:** pairing, QR codes, PIN, compression, rate limiting and
   tests added without touching the forwarding core

So if `src/proxy.mjs` reads as "the forwarding part is restrained, the surrounding
features are new", that is deliberate: **don't rewrite what works, only add what's
missing.**

### 1.3.0: a self-correction

Before 1.2.0, "local" meant `isLoopbackAddr(req.socket.remoteAddress)`. The mistake was
equating "comes from 127.0.0.1" with "comes from this machine" — while `cloudflared`
is exactly what opens that loopback connection. The result: **public requests through the
tunnel were treated as local**, and `/__pair`'s "local, no code" branch handed Desktop's
`server.token` to anyone.

On a deployment protected only by `POCKET_PIN` (no Cloudflare Access) that is equivalent
to **remote code execution**. 1.3.0 fixes it, freezes the rule into `isLocalRequest()`
(loopback + no CF headers) and removes the code-free bypass.

> The lesson lives in [Security hardening](#security-hardening): **a network-layer fact
> ("who connected") must not be inferred from "the address looks local". It needs a
> signal only the intermediary can set.**

---

## Contributing

Issues and PRs welcome. Before submitting:

- Don't commit `*.log`, `proxy.out/err`, `pair-url.txt`, `pair-qr.png`, or anything
  containing a token
- State the Kimi Code Desktop version **and** OS you tested on
- Run `npm test` and make sure `npm run check` passes
- For adaptations to internal changes, include your evidence (ideally raw `curl` output)

---

## Security

Please **do not open a public issue** for vulnerabilities. Use GitHub's private channel:

👉 https://github.com/dadahuiming/kimicode-pocket/security/advisories/new

Include the affected version/commit, minimal reproduction steps, your assessment of the
impact, and a desensitised PoC if you have one (**no real tokens or domains**).

See [SECURITY.md](SECURITY.md) for the threat model and supported versions.

---

## License

[MIT](LICENSE).

---

## Disclaimer

This is an unofficial community project, not affiliated with or endorsed by Moonshot AI
or Kimi. "Kimi Code" and "Kimi" are trademarks of their respective owners.

You are exposing a computer that can execute code to the public internet. You are
responsible for the consequences: use a strong PIN, use Cloudflare Access, close the
tunnel when you're done, and never deploy this on a network you don't own or administer
without authorisation.
