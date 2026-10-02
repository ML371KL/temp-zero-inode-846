// Статика хаба и реестр: то, что ломается молча.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { THEME_SCRIPT } from "../functions/_lib/pages.js";
import { themeScriptHash } from "../functions/_lib/csp.js";
import { normalizeRegistry } from "../functions/_lib/registry.js";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("index.html несёт скрипт темы побайтно — иначе CSP по хэшу его заблокирует", async () => {
  const html = read("web/index.html");
  assert.ok(html.includes(`<script>${THEME_SCRIPT}</script>`));
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
  assert.equal(inline.length, 1, "единственный инлайн-скрипт — тема");
  assert.match(await themeScriptHash(), /^sha256-[A-Za-z0-9+/]{43}=$/);
});

test("клиент без синтаксических ошибок и без внешних адресов данных", () => {
  execFileSync(process.execPath, ["--check", new URL("../web/app.js", import.meta.url).pathname]);
  const js = read("web/app.js");
  assert.match(js, /const API_REGISTRY = "\/api\/registry";/);
  assert.match(js, /const API_CARD = \(slug\) => `\/api\/card\//);
  assert.ok(!/(fetch|getJson)\(\s*["'`]https?:/.test(js), "данные — только через свои /api/*");
  assert.ok(!/\binnerHTML\b/.test(js), "разметка — только через узлы DOM");
});

test("вес статики в пределах (без сборки, как витрины семейства)", () => {
  const dir = new URL("../web/", import.meta.url);
  const total = fs.readdirSync(dir).reduce((s, f) => s + fs.statSync(new URL(f, dir)).size, 0);
  assert.ok(total < 200_000, `web/ весит ${total} байт`);
});

test("все запросы проходят через функции (иначе статика открыта без пароля)", () => {
  const routes = JSON.parse(read("web/_routes.json"));
  assert.deepEqual(routes.include, ["/*"]);
  assert.deepEqual(routes.exclude, []);
});

test("реестр: валиден, slug уникальны, у живых — https-адрес", () => {
  const raw = JSON.parse(read("registry.json"));
  const reg = normalizeRegistry(raw);
  assert.equal(reg.rejected.length, 0, `отброшены: ${reg.rejected.join(", ")}`);
  assert.equal(reg.models.length, raw.models.length);
  for (const m of reg.models.filter((x) => x.status === "live")) assert.match(m.url, /^https:\/\/[^/]+$/);
});

test("реестр: негодные записи отбрасываются, а не роняют хаб", () => {
  const reg = normalizeRegistry({ models: [
    { slug: "ok", name: "Норма", url: "https://a.pages.dev/" },
    { slug: "Bad Slug", name: "X", url: "https://b.pages.dev" },
    { slug: "nourl", name: "Без адреса" },
    { slug: "plain", name: "HTTP", url: "http://c.pages.dev" },
    { slug: "ok", name: "Дубль", url: "https://d.pages.dev" },
    { slug: "soon", name: "Скоро", status: "planned" },
  ] });
  assert.deepEqual(reg.models.map((m) => m.slug), ["ok", "soon"]);
  assert.equal(reg.models[0].url, "https://a.pages.dev");
  assert.deepEqual(reg.models[0].aliases, ["Норма"]);
  assert.throws(() => normalizeRegistry({ models: [] }));
});

test("wrangler.toml: проект tzi-846, статика web, флаг публичных подзапросов", () => {
  const toml = read("wrangler.toml");
  assert.match(toml, /^name = "tzi-846"$/m);
  assert.match(toml, /^pages_build_output_dir = "web"$/m);
  assert.match(toml, /global_fetch_strictly_public/);
  assert.ok(!/HUB_PASSWORD\s*=/.test(toml), "пароль — секрет, не переменная файла");
});
