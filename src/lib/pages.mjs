/**
 * KimiCode Pocket — 代理自有页面
 *
 * 全部内联、无外链、无第三方资源（CDN 上的二维码服务会把配对地址
 * 发给别人，绝对不能用于含凭证的 URL）。深浅色自动适配。
 */

const BASE_CSS = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",
  "Microsoft YaHei",sans-serif;background:#f5f6f8;color:#111827;padding:24px}
@media (prefers-color-scheme:dark){body{background:#0f1115;color:#e5e7eb}}
.card{width:100%;max-width:420px;background:#fff;border-radius:16px;padding:28px;
  box-shadow:0 8px 30px rgba(15,23,42,.08)}
@media (prefers-color-scheme:dark){.card{background:#181b21;box-shadow:0 8px 30px rgba(0,0,0,.4)}}
h1{margin:0 0 8px;font-size:20px;letter-spacing:-.01em}
p{margin:8px 0;color:#4b5563}
@media (prefers-color-scheme:dark){p{color:#9ca3af}}
label{display:block;margin:20px 0 6px;font-size:14px;font-weight:600}
input{width:100%;padding:12px 14px;font-size:16px;border-radius:10px;
  border:1px solid #d1d5db;background:transparent;color:inherit}
input:focus{outline:2px solid #2563eb;outline-offset:1px;border-color:transparent}
button{width:100%;margin-top:16px;padding:12px 14px;font-size:16px;font-weight:600;
  border:0;border-radius:10px;background:#2563eb;color:#fff;cursor:pointer}
button:active{transform:scale(.99)}
.err{margin-top:14px;padding:10px 12px;border-radius:8px;background:#fee2e2;
  color:#991b1b;font-size:14px}
@media (prefers-color-scheme:dark){.err{background:#3f1d1d;color:#fca5a5}}
.hint{margin-top:18px;font-size:13px;color:#6b7280}
@media (prefers-color-scheme:dark){.hint{color:#7c8698}}
code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:rgba(127,127,127,.14);padding:2px 5px;border-radius:4px;word-break:break-all}
.qr{display:flex;justify-content:center;margin:20px 0}
.qr svg{width:220px;height:220px;border-radius:12px}
a{color:#2563eb}
`;

function page(title, body, { status = 200, headers = {} } = {}) {
  return {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers,
    },
    body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title><style>${BASE_CSS}</style></head>
<body><div class="card">${body}</div></body></html>`,
  };
}

export function loginPage({ next = '/', error = '', lockedFor = 0 } = {}) {
  const errBlock = lockedFor
    ? `<div class="err">尝试次数过多，请 ${Math.ceil(lockedFor / 1000)} 秒后再试。</div>`
    : error
      ? `<div class="err">${escapeHtml(error)}</div>`
      : '';

  return page(
    'KimiCode Pocket — 访问口令',
    `<h1>需要访问口令</h1>
     <p>这台 KimiCode Pocket 开启了额外口令保护。</p>
     <form method="post" action="/__login">
       <input type="hidden" name="next" value="${escapeHtml(next)}">
       <label for="pin">口令</label>
       <input id="pin" name="pin" type="password" inputmode="text"
              autocomplete="current-password" autofocus required>
       <button type="submit">进入</button>
     </form>
     ${errBlock}
     <p class="hint">口令由部署者在 <code>POCKET_PIN</code> 中设置。忘了就重启代理并改环境变量。</p>`,
    { status: error || lockedFor ? 401 : 200 },
  );
}

/**
 * 配对页：把 Desktop 的 server.token 直接写进 localStorage，
 * 然后跳回根路径。这样 token 从不出现在地址栏/历史记录/剪贴板。
 */
export function pairPage({ token, days = 7 }) {
  return page(
    'KimiCode Pocket — 配对中',
    `<h1>正在配对…</h1>
     <p>马上就会跳到 Kimi Code 界面。</p>
     <p class="hint" id="hint">如果没有自动跳转，<a id="go" href="/">点这里</a>。</p>
     <script>
(function () {
  var CRED = ${JSON.stringify(token)};
  var DAYS = ${Number(days) || 7};
  var ok = false;
  try {
    localStorage.setItem('kimi-web.server-credential', JSON.stringify({
      version: 1, credential: CRED, expiresAt: Date.now() + DAYS * 86400000
    }));
    ok = true;
  } catch (e) {}
  if (ok) { location.replace('/'); }
  else {
    document.getElementById('hint').innerHTML =
      '<b>浏览器禁用了本地存储</b>，无法自动配对。请改用带 <code>#token=</code> 的地址，' +
      '或在浏览器设置里允许本站保存数据。';
  }
})();
     </script>`,
  );
}

export function errorPage({ title, detail, hint = '' }) {
  return page(
    `KimiCode Pocket — ${escapeHtml(title)}`,
    `<h1>${escapeHtml(title)}</h1>
     <p>${escapeHtml(detail)}</p>
     ${hint ? `<p class="hint">${hint}</p>` : ''}`,
    { status: 503 },
  );
}

/** 一次性口令无效 / 过期 */
export function pairRejectedPage(reason) {
  return page(
    'KimiCode Pocket — 配对链接无效',
    `<h1>配对链接已失效</h1>
     <p>${escapeHtml(reason)}</p>
     <p class="hint">在电脑上重新运行隧道脚本，会打印一条新的配对链接（含二维码）。</p>`,
    { status: 401 },
  );
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
