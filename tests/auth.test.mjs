// Пароль и «запомненное устройство»: токены, ворота, вход и выход.

import test from "node:test";
import assert from "node:assert/strict";
import { issueToken, verifyToken, checkPassword, readSession, COOKIE_NAME, COOKIE_MAX_AGE } from "../functions/_lib/auth.js";
import { onRequest as gate } from "../functions/_middleware.js";
import { onRequestPost as login, onRequestGet as loginPage } from "../functions/login.js";
import { onRequestPost as logout } from "../functions/logout.js";

const env = { HUB_PASSWORD: "верный пароль", HUB_SESSION_EPOCH: "1" };
const BASE = "https://tzi-846.pages.dev";
const withCookie = (token, path = "/", headers = {}) => new Request(`${BASE}${path}`, { headers: { cookie: `${COOKIE_NAME}=${token}`, ...headers } });
const next = () => async () => new Response("<!doctype html>static", { headers: { "content-type": "text/html" } });

test("токен: выдан — принят; подделан, чужой эпохи или пароля — нет", async () => {
  const token = await issueToken(env);
  assert.ok(await verifyToken(env, token));
  const [v, iat, sig] = token.split(".");
  const flipped = sig[0] === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
  assert.equal(await verifyToken(env, `${v}.${iat}.${flipped}`), null);
  assert.equal(await verifyToken(env, `${v}.${(parseInt(iat, 36) + 1).toString(36)}.${sig}`), null);
  assert.equal(await verifyToken({ ...env, HUB_SESSION_EPOCH: "2" }, token), null, "поднятая эпоха забывает все устройства");
  assert.equal(await verifyToken({ ...env, HUB_PASSWORD: "новый" }, token), null, "смена пароля забывает все устройства");
  assert.equal(await verifyToken(env, "мусор"), null);
  assert.equal(await verifyToken(env, await issueToken(env, Date.now() + 3600e3)), null, "токен из будущего");
});

test("сессия скользит: токен старше суток — перевыпуск", async () => {
  const fresh = await issueToken(env);
  assert.deepEqual(await readSession(withCookie(fresh), env), { ok: true, renew: false });
  const old = await issueToken(env, Date.now() - 3 * 86400e3);
  assert.deepEqual(await readSession(withCookie(old), env), { ok: true, renew: true });
  const ancient = await issueToken(env, Date.now() - 900 * 86400e3);
  assert.equal((await readSession(withCookie(ancient), env)).ok, true, "сервер не ограничивает срок: «навсегда», пока браузер хранит cookie");
});

test("checkPassword", async () => {
  assert.equal(await checkPassword(env, "верный пароль"), true);
  assert.equal(await checkPassword(env, "верный пароль "), false);
  assert.equal(await checkPassword(env, ""), false);
  assert.equal(await checkPassword({}, "что угодно"), false);
});

test("ворота: без сессии — страница входа, API — 401, статика — 401", async () => {
  const page = await gate({ request: new Request(`${BASE}/`, { headers: { accept: "text/html" } }), env, next: next() });
  assert.equal(page.status, 401);
  assert.match(await page.text(), /Вход по паролю/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'nonce-/);
  const api = await gate({ request: new Request(`${BASE}/api/registry`), env, next: next() });
  assert.equal(api.status, 401);
  assert.equal((await api.json()).error, "unauthorized");
  const js = await gate({ request: new Request(`${BASE}/app.js`, { headers: { accept: "*/*" } }), env, next: next() });
  assert.equal(js.status, 401);
});

test("ворота: открытые адреса и граница /api/", async () => {
  const icon = await gate({ request: new Request(`${BASE}/favicon.svg`), env, next: next() });
  assert.equal(icon.status, 200);
  const token = await issueToken(env);
  for (const path of ["/api/model", "/api//registry", "/api/card/", "/api/card/../x", "/api/registry/"]) {
    const r = await gate({ request: withCookie(token, path), env, next: next() });
    assert.equal(r.status, 404, path);
  }
});

test("ворота: нет секрета HUB_PASSWORD — закрыто целиком (503), а не открыто", async () => {
  const r = await gate({ request: new Request(`${BASE}/`, { headers: { accept: "text/html" } }), env: {}, next: next() });
  assert.equal(r.status, 503);
  assert.match(await r.text(), /Пароль хаба не задан/);
});

test("ворота: годная сессия пропускает, ставит CSP с хэшем темы и private-кэш; старая — перевыпускается", async () => {
  const token = await issueToken(env);
  const r = await gate({ request: withCookie(token), env, next: next() });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /script-src 'self' 'sha256-[A-Za-z0-9+/=]{44}'/);
  assert.equal(r.headers.get("cache-control"), "private, no-cache");
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(r.headers.get("set-cookie"), null);
  const old = await issueToken(env, Date.now() - 2 * 86400e3);
  const r2 = await gate({ request: withCookie(old), env, next: next() });
  assert.match(r2.headers.get("set-cookie"), new RegExp(`^${COOKIE_NAME}=v1\\.`));
  assert.match(r2.headers.get("set-cookie"), new RegExp(`Max-Age=${COOKIE_MAX_AGE}; Path=/; Secure; HttpOnly; SameSite=Lax`));
});

test("вход: верный пароль — cookie на 400 дней; неверный — 401; форма без JS — 303", async () => {
  const form = (password, accept) => new Request(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept, origin: BASE },
    body: new URLSearchParams({ password }).toString(),
  });
  const ok = await login({ request: form("верный пароль", "application/json"), env });
  assert.equal(ok.status, 204);
  const cookie = ok.headers.get("set-cookie");
  assert.match(cookie, /Max-Age=34560000/);
  const token = cookie.split(";")[0].split("=").slice(1).join("=");
  assert.ok(await verifyToken(env, token));
  const bad = await login({ request: form("нет", "application/json"), env });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).message, "Неверный пароль.");
  const plain = await login({ request: form("верный пароль", "text/html"), env });
  assert.equal(plain.status, 303);
  assert.equal(plain.headers.get("location"), "/");
  const foreign = await login({ request: new Request(`${BASE}/login`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: "password=x" }), env });
  assert.equal(foreign.status, 403);
});

test("GET /login: уже вошедшего — на главную", async () => {
  const token = await issueToken(env);
  const r = await loginPage({ request: withCookie(token, "/login"), env });
  assert.equal(r.status, 303);
  const anon = await loginPage({ request: new Request(`${BASE}/login`), env });
  assert.equal(anon.status, 200);
});

test("выход стирает cookie", async () => {
  const r = await logout({ request: new Request(`${BASE}/logout`, { method: "POST", headers: { origin: BASE } }) });
  assert.equal(r.status, 303);
  assert.match(r.headers.get("set-cookie"), new RegExp(`^${COOKIE_NAME}=; Max-Age=0`));
});
