/**
 * CSP статики хаба. Инлайн-скрипт темы в web/index.html разрешён хэшем; хэш
 * считается из THEME_SCRIPT (functions/_lib/pages.js) — того же текста, что
 * index.html обязан нести побайтно (тест tests/static.test.mjs). Модели
 * показывают свои значки (`<url>/favicon.svg`) — отсюда img-src *.pages.dev.
 */

import { THEME_SCRIPT } from "./pages.js";

let themeHash = null;
export async function themeScriptHash() {
  if (!themeHash) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(THEME_SCRIPT));
    let s = "";
    for (const b of new Uint8Array(digest)) s += String.fromCharCode(b);
    themeHash = `sha256-${btoa(s)}`;
  }
  return themeHash;
}

export async function staticCsp() {
  return [
    "default-src 'self'",
    `script-src 'self' '${await themeScriptHash()}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://*.pages.dev",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
