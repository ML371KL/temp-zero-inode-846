/**
 * Ворота хаба: каждый запрос (статика и API — `web/_routes.json` отдаёт
 * функциям всё) проходит здесь.
 *
 * 1. ПАРОЛЬ. Без годной cookie сессии закрытый адрес получает страницу входа
 *    (HTML, 401) или JSON-401 (API); открыты только `/login`, `/logout`,
 *    `/favicon.svg` и `/robots.txt`. Нет секрета HUB_PASSWORD — хаб закрыт
 *    целиком (503), а не открыт: ошибка настройки не должна снимать пароль.
 *    Сессия старше суток перевыпускается на ответе — срок «помнить устройство»
 *    скользит (functions/_lib/auth.js).
 *
 * 2. ГРАНИЦА `/api/`. Под `/api/` живут ровно registry, card/<slug> и
 *    history/<slug> — прочее получает JSON-404, а не HTML главной с кодом 200.
 *
 * 3. ЗАГОЛОВКИ. CSP с хэшем инлайн-скрипта темы из web/index.html (хэш
 *    считается здесь из того же текста, что лежит в functions/_lib/pages.js;
 *    тест сверяет, что index.html несёт его побайтно), запрет индексации,
 *    no-referrer, private-кэш: закрытое паролем не должно оседать в общих кэшах.
 */

import { passwordConfigured, readSession, issueToken, sessionCookie } from "./_lib/auth.js";
import { loginPage, notConfiguredPage } from "./_lib/pages.js";
import { staticCsp } from "./_lib/csp.js";

const PUBLIC_PATHS = new Set(["/login", "/logout", "/favicon.svg", "/robots.txt"]);
const API_RE = /^\/api\/(registry|(card|history)\/[a-z0-9][a-z0-9-]{0,39})$/;

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (PUBLIC_PATHS.has(path)) return harden(await next());

  if (path === "/api" || path.startsWith("/api/")) {
    if (!API_RE.test(path)) {
      return harden(json(404, { error: "not found", path: path.slice(0, 80) }));
    }
  }

  if (!passwordConfigured(env)) {
    return harden(path.startsWith("/api/") ? json(503, { error: "password not configured" }) : notConfiguredPage());
  }

  const session = await readSession(request, env);
  if (!session.ok) {
    if (path.startsWith("/api/")) return harden(json(401, { error: "unauthorized" }));
    if (wantsHtml(request, path)) return harden(loginPage({ status: 401 }));
    return harden(new Response("unauthorized", { status: 401, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }));
  }

  const response = harden(await next());
  if (!response.headers.has("content-security-policy")) response.headers.set("content-security-policy", await staticCsp());
  if (!path.startsWith("/api/")) response.headers.set("cache-control", "private, no-cache");
  if (session.renew) response.headers.append("set-cookie", sessionCookie(await issueToken(env)));
  return response;
}

function wantsHtml(request, path) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html") || path === "/" || path.endsWith(".html");
}

/** Копия ответа с изменяемыми заголовками и общими заголовками безопасности. */
function harden(response) {
  const out = new Response(response.body, response);
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("referrer-policy", "no-referrer");
  out.headers.set("x-robots-tag", "noindex, nofollow");
  out.headers.set("permissions-policy", "geolocation=(), camera=(), microphone=()");
  out.headers.set("x-frame-options", "DENY");
  return out;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
