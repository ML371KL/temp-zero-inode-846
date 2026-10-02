/**
 * Пароль хаба и «запомненное устройство».
 *
 * Пароль — секрет Pages `HUB_PASSWORD` (в репозитории его нет). Верный пароль
 * один раз — и браузер получает подписанную cookie `__Host-hub846`:
 * HttpOnly, Secure, SameSite=Lax, Max-Age 400 дней (больше браузеры не
 * хранят). Каждый заход старше суток перевыпускает cookie — срок сдвигается,
 * поэтому устройство, которое открывает хаб хотя бы раз в 400 дней, пароль
 * больше не увидит никогда.
 *
 * Сброс:
 *   • одно устройство — кнопка «Забыть это устройство» внизу хаба (POST /logout);
 *   • все устройства сразу — сменить HUB_PASSWORD или поднять HUB_SESSION_EPOCH:
 *     ключ подписи выводится из обоих, старые cookie перестают сходиться.
 *
 * Токен: `v1.<время выдачи base36>.<HMAC-SHA256 base64url>`. Пароль
 * сравнивается через HMAC обеих строк (время сравнения не зависит от того,
 * сколько символов совпало). Перебор сдерживает счётчик неудач на IP в Cache
 * API края: 10 ошибок за 15 минут — пауза до конца окна.
 */

export const COOKIE_NAME = "__Host-hub846";
export const COOKIE_MAX_AGE = 400 * 24 * 3600;
const RENEW_AFTER_SECONDS = 24 * 3600;
const FAIL_LIMIT = 10;
const FAIL_WINDOW_SECONDS = 15 * 60;
const enc = new TextEncoder();

export function passwordConfigured(env) {
  return Boolean(env && typeof env.HUB_PASSWORD === "string" && env.HUB_PASSWORD.length > 0);
}

async function hmacKey(material) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(material));
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function sessionKey(env) {
  return hmacKey(`tzi-846|session|${env.HUB_SESSION_EPOCH || "1"}|${env.HUB_PASSWORD}`);
}

export async function issueToken(env, now = Date.now()) {
  const body = `v1.${Math.floor(now / 1000).toString(36)}`;
  const sig = await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

/** { iat } для годного токена, иначе null. */
export async function verifyToken(env, token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^[0-9a-z]{1,12}$/.test(parts[1])) return null;
  const iat = parseInt(parts[1], 36);
  if (!Number.isFinite(iat) || iat * 1000 > now + 5 * 60 * 1000) return null;
  const sig = b64urlDecode(parts[2]);
  if (!sig || sig.length !== 32) return null;
  const ok = await crypto.subtle.verify("HMAC", await sessionKey(env), sig, enc.encode(`v1.${parts[1]}`));
  return ok ? { iat } : null;
}

/** Сессия запроса: { ok, renew }. */
export async function readSession(request, env, now = Date.now()) {
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return { ok: false, renew: false };
  const session = await verifyToken(env, token, now);
  if (!session) return { ok: false, renew: false };
  return { ok: true, renew: now / 1000 - session.iat > RENEW_AFTER_SECONDS };
}

export async function checkPassword(env, candidate) {
  if (!passwordConfigured(env) || typeof candidate !== "string" || candidate.length > 512) return false;
  const key = await hmacKey(`tzi-846|compare|${env.HUB_SESSION_EPOCH || "1"}`);
  const [a, b] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(candidate)),
    crypto.subtle.sign("HMAC", key, enc.encode(env.HUB_PASSWORD)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Max-Age=${COOKIE_MAX_AGE}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearedCookie() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/* ── сдерживание перебора: счётчик неудач на IP в кэше края ── */

async function failKey(request) {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "local";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`tzi-846|ip|${ip}`)));
  return new Request(new URL(`/__hub-auth/fails/${b64url(digest).slice(0, 22)}`, request.url).toString());
}

function edgeCache() {
  return typeof caches !== "undefined" && caches.default ? caches.default : null;
}

async function readFails(request) {
  const cache = edgeCache();
  if (!cache) return { n: 0, until: 0 };
  try {
    const hit = await cache.match(await failKey(request));
    if (!hit) return { n: 0, until: 0 };
    const data = await hit.json();
    return data.until > Date.now() ? data : { n: 0, until: 0 };
  } catch (error) {
    return { n: 0, until: 0 };
  }
}

/** Сколько секунд ждать до следующей попытки (0 — можно). */
export async function lockedFor(request) {
  const fails = await readFails(request);
  return fails.n >= FAIL_LIMIT ? Math.max(1, Math.ceil((fails.until - Date.now()) / 1000)) : 0;
}

export async function recordFailure(request) {
  const cache = edgeCache();
  if (!cache) return;
  const fails = await readFails(request);
  const until = fails.until > Date.now() ? fails.until : Date.now() + FAIL_WINDOW_SECONDS * 1000;
  const body = JSON.stringify({ n: fails.n + 1, until });
  const ttl = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  try {
    await cache.put(await failKey(request), new Response(body, {
      headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
    }));
  } catch (error) {
    /* кэш края недоступен — без счётчика */
  }
}

export async function clearFailures(request) {
  const cache = edgeCache();
  if (!cache) return;
  try {
    await cache.delete(await failKey(request));
  } catch (error) {
    /* нечего чистить */
  }
}

/* ── base64url ── */

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch (error) {
    return null;
  }
}
