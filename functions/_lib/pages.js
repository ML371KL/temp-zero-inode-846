/**
 * Служебные страницы, которые отдают функции: вход и «пароль не настроен».
 *
 * Своя вёрстка и стили внутри — статика хаба закрыта паролем, а эти страницы
 * видны до входа. Скрипты — с одноразовым nonce в CSP: правило темы семейства
 * (с 20:00 до 07:00 — тёмная) и отправка формы без перезагрузки, чтобы после
 * входа открылся тот же адрес вместе с якорем (#calendar и т. п.). Без
 * JavaScript форма уходит обычным POST и возвращает на главную.
 */

export const THEME_SCRIPT = `(function () {
  var DAY = "hub846-theme", NIGHT = "hub846-theme-tonight", FROM = 20, TO = 7;
  function isNight(d) { var h = (d || new Date()).getHours(); return h >= FROM || h < TO; }
  function read(area, key) {
    try { var v = window[area].getItem(key); return v === "light" || v === "dark" ? v : null; }
    catch (e) { return null; }
  }
  function resolve() {
    if (isNight()) return read("sessionStorage", NIGHT) || "dark";
    return read("localStorage", DAY)
      || (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  function remember(theme) {
    try {
      if (isNight()) window.sessionStorage.setItem(NIGHT, theme);
      else window.localStorage.setItem(DAY, theme);
    } catch (e) { /* приватный режим: тема живёт до перезагрузки */ }
  }
  document.documentElement.dataset.theme = resolve();
  window.__theme = { isNight: isNight, resolve: resolve, remember: remember, from: FROM, to: TO };
})();`;

const SUBMIT_SCRIPT = `(function () {
  var form = document.getElementById("gate-form");
  var out = document.getElementById("gate-error");
  var input = document.getElementById("gate-password");
  var button = form.querySelector("button");
  form.addEventListener("submit", function (event) {
    if (!window.fetch || !window.URLSearchParams) return;
    event.preventDefault();
    button.disabled = true;
    out.textContent = "";
    fetch("/login", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: input.value }).toString(),
      credentials: "same-origin"
    }).then(function (r) {
      if (r.ok) { window.location.reload(); return; }
      return r.json().catch(function () { return {}; }).then(function (b) {
        out.textContent = b && b.message ? b.message : "Не получилось войти. Попробуйте ещё раз.";
        form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake");
        input.select();
        button.disabled = false;
      });
    }).catch(function () {
      out.textContent = "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.";
      button.disabled = false;
    });
  });
})();`;

const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" class="mark-bg"/><path d="M8.5 10.5h11M13 16h12.5M6.5 21.5h9" class="mark-bars"/><path d="M15.5 6.5v19" class="mark-market"/></svg>`;

const STYLE = `
:root{color-scheme:light;--page:#f4f3ee;--surface:#fcfcfb;--ink:#121211;--ink-2:#52514e;--muted:#6b6a65;--line:#e2e0d9;--axis:#c3c2b7;--model:#2a78d6;--model-ink:#1f5fae;--market:#eb6834;--bad:#b42318;--shadow:0 1px 2px rgba(24,22,16,.04),0 6px 24px rgba(24,22,16,.04);
--font:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,"SF Pro Text","Helvetica Neue",Roboto,"Noto Sans",Arial,sans-serif;--font-display:"Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,"SF Pro Display","Helvetica Neue",Roboto,"Noto Sans",Arial,sans-serif}
:root[data-theme="dark"]{color-scheme:dark;--page:#0f0f0e;--surface:#1a1a19;--ink:#f2f1ec;--ink-2:#c3c2b7;--muted:#a3a199;--line:#2e2e2b;--axis:#4a4944;--model:#3987e5;--model-ink:#6aa6f0;--market:#d95926;--bad:#f07070;--shadow:0 1px 2px rgba(0,0,0,.3)}
*,*::before,*::after{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--page);color:var(--ink);font:400 15px/1.55 var(--font);-webkit-font-smoothing:antialiased}
.gate{min-height:100%;display:grid;place-items:center;padding:32px 16px}
.card{width:100%;max-width:420px;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:28px 28px 26px;box-shadow:var(--shadow)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:26px}
.mark{width:36px;height:36px;flex:none}.mark-bg{fill:var(--ink)}.mark-bars{fill:none;stroke:var(--surface);stroke-width:2.4;stroke-linecap:round}.mark-market{fill:none;stroke:var(--market);stroke-width:1.8;stroke-linecap:round}
.brand b{display:block;font:650 17px/1.2 var(--font-display);letter-spacing:-.01em}.brand span{display:block;color:var(--muted);font-size:13.5px}
h1{margin:0 0 6px;font:660 24px/1.2 var(--font-display);letter-spacing:-.02em}
.lede{margin:0 0 20px;color:var(--ink-2);font-size:14.5px}
label{display:block;font-size:13px;font-weight:600;color:var(--ink-2);margin-bottom:6px}
.field{display:flex;gap:8px}
input{flex:1;min-width:0;font:inherit;font-size:16px;color:var(--ink);background:var(--page);border:1px solid var(--line);border-radius:12px;padding:11px 14px}
input:focus{outline:2px solid var(--model);outline-offset:1px;border-color:transparent}
button{appearance:none;font:inherit;font-weight:600;font-size:15px;border:0;border-radius:12px;padding:11px 18px;background:var(--ink);color:var(--surface);cursor:pointer}
button:disabled{opacity:.55;cursor:progress}
button:focus-visible{outline:2px solid var(--model);outline-offset:2px}
.error{min-height:22px;margin:10px 0 0;color:var(--bad);font-size:13.5px;font-weight:560}
.fine{margin:14px 0 0;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px;line-height:1.5}
code{font-size:12.5px;background:var(--page);border:1px solid var(--line);border-radius:6px;padding:1px 5px}
.shake{animation:shake .32s ease-in-out}
@keyframes shake{20%{transform:translateX(-6px)}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}80%{transform:translateX(2px)}}
@media (prefers-reduced-motion:reduce){.shake{animation:none}}
`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function newNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, "");
}

export function pageCsp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function shell({ title, nonce, body, withSubmit }) {
  return `<!doctype html>
<html lang="ru" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<script nonce="${nonce}">${THEME_SCRIPT}</script>
<style>${STYLE}</style>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
<main class="gate">
<div class="card">
<div class="brand">${MARK}<div><b>Модели 850</b><span>справедливая стоимость российских акций</span></div></div>
${body}
</div>
</main>
${withSubmit ? `<script nonce="${nonce}">${SUBMIT_SCRIPT}</script>` : ""}
</body>
</html>`;
}

/** Страница входа. status 401 — для любого закрытого адреса без сессии. */
export function loginPage({ status = 401, error = "" } = {}) {
  const nonce = newNonce();
  const body = `<h1>Вход по паролю</h1>
<p class="lede">Пароль спросим один раз — это устройство запомнится.</p>
<form id="gate-form" method="post" action="/login" autocomplete="on">
<label for="gate-password">Пароль</label>
<div class="field"><input id="gate-password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">Войти</button></div>
<p class="error" id="gate-error" role="alert" aria-live="polite">${escapeHtml(error)}</p>
</form>
<p class="fine">Забыть это устройство можно кнопкой внизу хаба — тогда пароль спросят снова.</p>`;
  return htmlResponse(status, shell({ title: "Вход — Модели 850", nonce, body, withSubmit: true }), nonce);
}

/** Пароль не задан: хаб закрыт целиком, пока владелец не задаст секрет. */
export function notConfiguredPage() {
  const nonce = newNonce();
  const body = `<h1>Пароль хаба не задан</h1>
<p class="lede">Хаб закрыт, пока в проекте Cloudflare Pages нет секрета <code>HUB_PASSWORD</code>.</p>
<p class="fine">Задать: Cloudflare → Workers &amp; Pages → проект хаба → Settings → Variables and Secrets → секрет <code>HUB_PASSWORD</code>, затем перевыложить. Или из терминала: <code>npx wrangler pages secret put HUB_PASSWORD --project-name tzi-846</code>.</p>`;
  return htmlResponse(503, shell({ title: "Пароль не задан — Модели 850", nonce, body, withSubmit: false }), nonce);
}

function htmlResponse(status, html, nonce) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": pageCsp(nonce),
    },
  });
}
