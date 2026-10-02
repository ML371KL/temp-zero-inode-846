// Дверь карточки, история и разбор вкладок дашборда модели — на подменённом fetch.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { onRequestGet as cardEndpoint } from "../functions/api/card/[slug].js";
import { onRequestGet as historyEndpoint } from "../functions/api/history/[slug].js";
import { parseScreens, releaseProblem } from "../functions/_lib/sources.js";
import { mergeHistory, emptyHistory, historyRows, rowsFromPayload, historyProblem } from "../functions/_lib/history.js";

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const realFetch = globalThis.fetch;

function stubFetch(routes) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), ua: init && init.headers && init.headers["user-agent"] });
    for (const [prefix, respond] of routes) if (String(url).startsWith(prefix)) return respond();
    return new Response("not found", { status: 404 });
  };
  return seen;
}

test.afterEach(() => { globalThis.fetch = realFetch; });

const ctx = (slug, env = {}) => ({ request: new Request(`https://tzi-846.pages.dev/api/card/${slug}`), env, params: { slug } });

test("карточка: выпуск с двери модели, вкладки с её страницы", async () => {
  const seen = stubFetch([
    ["https://tzi-850-sber.pages.dev/api/model", () => new Response(fixture("sber.json"))],
    ["https://tzi-850-sber.pages.dev/", () => new Response(fixture("sber-index.html"))],
  ]);
  const r = await cardEndpoint(ctx("sber"));
  assert.equal(r.status, 200);
  const card = await r.json();
  assert.equal(card.ok, true);
  assert.equal(card.source, "model");
  assert.equal(card.fair.printed_median, 350);
  assert.ok(card.screens.some((s) => s.id === "capital" && s.title === "Капитал и дивиденды"));
  assert.ok(seen.every((s) => s.ua && s.ua.startsWith("tzi-846-hub")), "дверь моделей требует User-Agent");
});

test("карточка: витрина модели лежит — запасной адрес данных", async () => {
  stubFetch([
    ["https://tzi-850-sber.pages.dev/api/model", () => new Response("<html>oops</html>", { status: 200 })],
    ["https://ml371kl.github.io/temp-zero-inode-850-sber-data/latest.json", () => new Response(fixture("sber.json"))],
  ]);
  const card = await (await cardEndpoint(ctx("sber"))).json();
  assert.equal(card.ok, true);
  assert.equal(card.source, "data");
});

test("карточка: нет ни одного источника — 502 с причинами, без чисел", async () => {
  stubFetch([]);
  const r = await cardEndpoint(ctx("magnit"));
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.equal(body.name, "Магнит");
  assert.ok(body.errors.length >= 1);
});

test("карточка: неизвестная модель — 404", async () => {
  stubFetch([]);
  assert.equal((await cardEndpoint(ctx("nope"))).status, 404);
});

test("releaseProblem и parseScreens", () => {
  assert.equal(releaseProblem(JSON.parse(fixture("x5.json"))), null);
  assert.equal(releaseProblem({ schema: "a", meta: {} }), "no valuation");
  assert.equal(releaseProblem([]), "not an object");
  const screens = parseScreens(fixture("sber-index.html"));
  assert.deepEqual(screens.map((s) => s.id), ["overview", "market", "model", "report", "capital", "book"]);
});

test("история: строка на день, новая заменяет, импорт не затирает свою, прореживание", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  let h = mergeHistory(emptyHistory("x"), "x", [{ d: "2026-10-01", sha: "a", med: 100, px: 90 }], now);
  h = mergeHistory(h, "x", [{ d: "2026-10-01", sha: "b", med: 101, px: 91 }], now);
  assert.deepEqual(historyRows(h).map((r) => [r.d, r.sha, r.med]), [["2026-10-01", "b", 101]]);
  h = mergeHistory(h, "x", [{ d: "2026-10-01", sha: null, med: 50 }, { d: "2026-09-30", sha: null, med: 99 }], now);
  assert.deepEqual(historyRows(h).map((r) => [r.d, r.med]), [["2026-09-30", 99], ["2026-10-01", 101]]);
  assert.equal(historyProblem(h, "x"), null);
  // 300 дней подряд: старше 180 дней — по неделям
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push({ d: new Date(now.getTime() - i * 86400e3).toISOString().slice(0, 10), sha: `s${i}`, med: i });
  const thin = mergeHistory(emptyHistory("y"), "y", rows, now);
  assert.ok(thin.d.length < 300 && thin.d.length > 181, `строк ${thin.d.length}`);
  assert.equal(thin.d[thin.d.length - 1], "2026-10-02");
});

test("история: импорт журнала модели (valuation_history Сбера)", () => {
  const rows = rowsFromPayload(JSON.parse(fixture("sber.json")), "SBER");
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].d, rows[0].med, rows[0].lo80, rows[0].px], ["2026-10-02", 348.6, 251.37, 276.29]);
  assert.deepEqual(rowsFromPayload(JSON.parse(fixture("x5.json")), "X5"), []);
});

test("дверь истории: нет файла — пустая история (200), битый — 502", async () => {
  const env = { HISTORY_BASE_URL: "https://raw.githubusercontent.com/o/r/history/" };
  stubFetch([]);
  const empty = await historyEndpoint({ env, params: { slug: "x5" } });
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).d, []);
  stubFetch([["https://raw.githubusercontent.com/o/r/history/x5.json", () => new Response(JSON.stringify({ v: 1, slug: "sber", d: [] }))]]);
  assert.equal((await historyEndpoint({ env, params: { slug: "x5" } })).status, 502);
  const good = mergeHistory(emptyHistory("x5"), "x5", [{ d: "2026-10-01", sha: "a", med: 3148, px: 1926 }]);
  stubFetch([["https://raw.githubusercontent.com/o/r/history/x5.json", () => new Response(JSON.stringify(good))]]);
  const ok = await historyEndpoint({ env, params: { slug: "x5" } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).med, [3148]);
});
