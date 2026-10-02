/**
 * /logout — «забыть это устройство»: стирает cookie сессии и ведёт на главную,
 * где снова спросят пароль. Только POST (кнопка-форма внизу хаба): ссылку
 * GET мог бы «нажать» предзагрузчик браузера.
 */

import { clearedCookie } from "./_lib/auth.js";

export function onRequestPost({ request }) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return new Response("forbidden", { status: 403, headers: { "cache-control": "no-store" } });
  }
  return new Response(null, {
    status: 303,
    headers: { location: "/", "set-cookie": clearedCookie(), "cache-control": "no-store" },
  });
}

export function onRequestGet() {
  return new Response(null, { status: 303, headers: { location: "/", "cache-control": "no-store" } });
}
