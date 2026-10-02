/**
 * /login — вход по паролю.
 *
 * GET  — страница входа (уже вошедшего — на главную).
 * POST — пароль из формы. Верный: cookie сессии на 400 дней и 204 (запрос
 *        скрипта страницы, Accept: application/json) или 303 на главную
 *        (форма без JavaScript). Неверный: 401 с причиной, счётчик неудач +1;
 *        после 10 неудач за 15 минут — 429 до конца окна.
 */

import {
  passwordConfigured, readSession, checkPassword, issueToken, sessionCookie,
  lockedFor, recordFailure, clearFailures,
} from "./_lib/auth.js";
import { loginPage, notConfiguredPage } from "./_lib/pages.js";

const FAIL_DELAY_MS = 400;

export async function onRequestGet({ request, env }) {
  if (!passwordConfigured(env)) return notConfiguredPage();
  const session = await readSession(request, env);
  if (session.ok) return redirect("/");
  return loginPage({ status: 200 });
}

export async function onRequestPost({ request, env }) {
  const asJson = (request.headers.get("accept") || "").includes("application/json");
  if (!passwordConfigured(env)) return asJson ? reply(503, "Пароль хаба не задан.") : notConfiguredPage();

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return reply(403, "Чужой источник запроса.");

  const wait = await lockedFor(request);
  if (wait > 0) {
    const message = `Слишком много попыток. Попробуйте через ${Math.ceil(wait / 60)} мин.`;
    return asJson ? reply(429, message, { "retry-after": String(wait) }) : loginPage({ status: 429, error: message });
  }

  let password = "";
  try {
    const form = await request.formData();
    password = String(form.get("password") || "");
  } catch (error) {
    password = "";
  }

  if (!(await checkPassword(env, password))) {
    await recordFailure(request);
    await new Promise((resolve) => setTimeout(resolve, FAIL_DELAY_MS));
    const message = "Неверный пароль.";
    return asJson ? reply(401, message) : loginPage({ status: 401, error: message });
  }

  await clearFailures(request);
  const cookie = sessionCookie(await issueToken(env));
  if (asJson) {
    return new Response(null, { status: 204, headers: { "set-cookie": cookie, "cache-control": "no-store" } });
  }
  return redirect("/", cookie);
}

function redirect(location, cookie) {
  const headers = { location, "cache-control": "no-store" };
  if (cookie) headers["set-cookie"] = cookie;
  return new Response(null, { status: 303, headers });
}

function reply(status, message, extra) {
  return new Response(JSON.stringify({ ok: false, message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(extra || {}) },
  });
}
