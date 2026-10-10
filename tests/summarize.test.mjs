// Сводка выпусков пяти моделей семейства: что хаб читает из каждого контракта.
// Фикстуры — урезанные настоящие выпуски 01.10.2026, у Т-Технологий — 09.10.2026
// (tools/trim-fixture.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalizeRegistry } from "../functions/_lib/registry.js";
import { summarize, classifyEvent, mentions } from "../functions/_lib/summarize.js";

const registry = normalizeRegistry(JSON.parse(fs.readFileSync(new URL("../registry.json", import.meta.url), "utf8")));
const others = registry.models.map((m) => ({ slug: m.slug, aliases: m.aliases }));
const fixture = (slug) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${slug}.json`, import.meta.url), "utf8"));
const card = (slug) => summarize(registry.models.find((m) => m.slug === slug), fixture(slug), { others, today: "2026-10-02" });

test("Магнит (magnit-v5.1): медиана, полосы, рынок, миры, брокеры", () => {
  const c = card("magnit");
  assert.equal(c.schema, "magnit-v5.1");
  assert.equal(c.fair.median, 1294.6);
  assert.equal(c.fair.printed_median, 1300);
  assert.deepEqual(c.fair.printed_band80, [250, 2550]);
  assert.deepEqual(c.fair.printed_band50, [700, 2000]);
  assert.equal(c.price.value, 1575);
  assert.equal(c.price.date, "2026-10-01");
  assert.ok(Math.abs(c.upside - (1294.6 / 1575 - 1)) < 1e-12);
  assert.equal(c.fair.p_below, 0.608);
  assert.deepEqual(c.worlds.map((w) => [w.key, w.price]), [["N", 2345], ["H", 1102], ["M", 1369]]);
  assert.equal(c.brokers.median, 2450);
  assert.equal(c.brokers.n, 9);
  assert.equal(c.dividend, null, "в выпуске Магнита нет дивидендов — null, а не 0");
  assert.equal(c.next_fact.title, "ПАО «Магнит»: МСФО за 2026 год");
  assert.equal(c.health.warn, false);
});

test("X5 (x5-v1): заголовок в корне выпуска, точка, дивиденд, мультипликаторы", () => {
  const c = card("x5");
  assert.equal(c.fair.median, 3148.43);
  assert.equal(c.fair.printed_median, 3150);
  assert.deepEqual(c.fair.printed_band80, [2400, 3900]);
  assert.deepEqual(c.fair.printed_band50, [2750, 3550]);
  assert.equal(c.fair.point, 3242.28);
  assert.equal(c.fair.printed_point, 3250);
  assert.equal(c.fair.p_below, 0.015);
  assert.equal(c.price.value, 1926);
  assert.equal(c.price.status, "live");
  assert.equal(c.dividend.dps, 215.712568);
  assert.equal(c.dividend.record_date, "2027-01-06");
  assert.equal(c.dividend.record_estimated, true);
  assert.equal(c.multiples.pe, 7.12752941);
  assert.equal(c.brokers.median, 2505);
  assert.equal(c.brokers.n, 4);
  // отчёт, которого ждёт модель X5, — next_report.closing
  assert.equal(c.next_fact.date, "2027-03-19");
  // ближайший существенный отчёт компании — операционные результаты 16.10
  assert.equal(c.next_report.date, "2026-10-16");
});

test("Лента (lenta-v1): окно даты отчёта, дивиденды с года, published_at", () => {
  const c = card("lenta");
  assert.equal(c.fair.printed_median, 3150);
  assert.equal(c.price.value, 1767.5);
  assert.equal(c.release.published_at, "2026-10-01T17:37:11+00:00");
  assert.deepEqual(c.dividend, { from_year: 2028 });
  assert.equal(c.next_report.precision, "window");
  assert.equal(c.next_report.earliest, "2026-10-26");
  assert.equal(c.next_report.latest, "2026-11-03");
});

test("Сбербанк (sber-v1): две категории акций, рекомендации, флаги выпуска", () => {
  const c = card("sber");
  assert.equal(c.ticker, "SBER");
  assert.equal(c.price.value, 276.29);
  assert.equal(c.fair.printed_median, 350);
  assert.deepEqual(c.others.map((o) => o.ticker), ["SBERP"]);
  assert.equal(c.others[0].upside, 0.258211);
  assert.deepEqual(c.brokers.recs, { buy: 12, hold: 1, sell: 0 });
  assert.equal(c.dividend.dps, 42.97);
  assert.equal(c.dividend.yield, 0.155525);
  assert.equal(c.multiples.pb, 0.6973);
  assert.equal(c.cap, 6173.77);
  assert.equal(c.health.warn, false, "первый квартал книги закрыт, отчёта ещё нет — справка, фишка на витрине Сбера зелёная");
  assert.ok(c.health.notes.some((n) => n.level === "info" && /до отчёта/.test(n.text)));
  assert.ok(c.health.notes.some((n) => n.level === "info" && /объяснения/.test(n.text)));
  assert.equal(c.next_report.date, "2026-10-28", "ежемесячная РСБУ — мелкое событие, ближайший отчёт — МСФО");
});

test("Т-Технологии (t-v1): объявленный дивиденд, месячные релизы — мелкие, отчёт — МСФО", () => {
  const c = summarize(registry.models.find((m) => m.slug === "t"), fixture("t"), { others, today: "2026-10-10" });
  assert.equal(c.schema, "t-v1");
  assert.equal(c.ticker, "T");
  assert.equal(c.fair.median, 313.73);
  assert.equal(c.fair.printed_median, 315);
  assert.deepEqual(c.fair.printed_band80, [235, 390]);
  assert.deepEqual(c.fair.printed_band50, [270, 355]);
  assert.equal(c.fair.printed_point, 330);
  assert.equal(c.fair.p_below, 0.254);
  assert.equal(c.price.value, 269.46);
  assert.ok(Math.abs(c.upside - (313.73 / 269.46 - 1)) < 1e-12);
  assert.deepEqual(c.others, []);
  assert.equal(c.brokers.median, 400);
  assert.equal(c.brokers.n, 13);
  assert.equal(c.dividend.dps, 4.7);
  assert.equal(c.dividend.record_date, "2026-10-12");
  assert.equal(c.dividend.record_estimated, false);
  assert.equal(c.multiples.pb, 0.9008);
  assert.equal(c.cap, 722.89);
  assert.equal(c.health.warn, false, "первый квартал книги закрыт, отчёта ещё нет — справка, фишка на витрине зелёная");
  const monthly = c.events.filter((e) => e.kind === "ops_release");
  assert.ok(monthly.length > 0 && monthly.every((e) => e.minor), "операционный релиз за месяц — мелкое событие, как РСБУ Сбера");
  assert.equal(c.next_report.kind, "ifrs", "ближайший отчёт — МСФО, а не месячный релиз");
  assert.equal(c.next_report.date, "2026-11-19");
  assert.equal(c.next_report.precision, "window");
  assert.equal(c.next_fact.date, "2026-11-19");
});

// Жёлтый выпуск в хабе — зеркало фишки выпуска на витрине модели (releaseChip в
// её web/app.js); правила — CHIP_RULES в functions/_lib/summarize.js.
test("свежесть: жёлтый — по правилу фишки на витрине самой модели", () => {
  const health = (slug, patch) => {
    const d = structuredClone(fixture(slug));
    patch(d);
    return summarize(registry.models.find((m) => m.slug === slug), d, { others, today: "2026-10-10" }).health;
  };
  const raise = (name) => (d) => { d.checks.flags.find((f) => f.name === name).raised = true; };
  const warns = (h) => h.notes.filter((n) => n.level === "warn").map((n) => n.text);

  // Т и Сбер (и новые модели по их образцу)
  assert.equal(health("t", () => {}).warn, false);
  assert.match(warns(health("t", (d) => { d.meta.periods_closed = 2; }))[0], /больше чем на период/);
  const reported = health("t", raise("report_fact"));
  assert.equal(reported.warn, true, "отчёт вышел, факт не внесён");
  assert.ok(!reported.notes.some((n) => /до отчёта/.test(n.text)), "справки о закрытом квартале уже нет");
  assert.equal(health("t", raise("book_update")).warn, true);
  assert.equal(health("sber", raise("price_fallback")).warn, true);
  assert.equal(health("t", raise("dividend_register")).warn, false, "на витрине Т это событие, фишка зелёная");
  assert.equal(health("sber", raise("ras_mismatch")).warn, false);
  assert.deepEqual(warns(health("t", (d) => { d.checks.gates = [{ name: "manual_input_overdue", title: "Ручной вход просрочен", fired: true }, { name: "guidance_gap", fired: true }]; })), ["Ручной вход просрочен"]);
  assert.equal(health("t", (d) => { d.live.degraded = ["кривая вчерашняя"]; }).warn, false, "причина без тревоги: degraded_flag = false");
  assert.equal(health("t", (d) => { d.live.degraded_flag = true; }).warn, true);

  // Лента и Магнит: первый закрытый период и гейты книги в корне выпуска
  assert.equal(health("lenta", () => {}).warn, false);
  assert.equal(health("lenta", (d) => { d.meta.book_first_period_closed = true; d.meta.periods_closed = 1; }).warn, true);
  assert.equal(health("lenta", (d) => { d.gates = [{ key: "guidance_gap" }, { key: "ev_ebitda" }]; }).warn, false);
  assert.deepEqual(warns(health("lenta", (d) => { d.gates = [{ key: "security_change" }]; })), ["Карточка акции сменилась после даты книги"]);
  assert.equal(health("magnit", (d) => { d.gates = [{ key: "limited_liability" }]; }).warn, false, "у Магнита такого правила нет");
  assert.deepEqual(warns(health("magnit", (d) => { d.gates = [{ key: "sigma_calibration" }]; })), ["Пора перекалибровать σ активов"]);
  assert.equal(health("magnit", (d) => { d.meta.book_first_period_closed = true; }).warn, true);

  // X5: любой поднятый флаг и цена «последняя принятая»
  assert.equal(health("x5", () => {}).warn, false);
  assert.equal(health("x5", raise("dividend_register")).warn, true);
  assert.deepEqual(warns(health("x5", (d) => { d.market.price_status = "fallback"; })), ["Цена — последняя принятая"]);
});

test("календарь: чужие отчёты приписаны своей компании, макро — без компании", () => {
  const m = card("magnit");
  const x5q3 = m.events.find((e) => /ИКС 5: операционные/.test(e.title));
  assert.equal(x5q3.company, "x5");
  const lentaQ3 = m.events.find((e) => /^Лента:/.test(e.title));
  assert.equal(lentaQ3.company, "lenta");
  const tander = m.events.find((e) => /Тандер/.test(e.title));
  assert.equal(tander.company, "magnit");
  const cbr = m.events.find((e) => e.cls === "macro" && /ключевой ставке/.test(e.title));
  assert.equal(cbr.company, null);
  const s = card("sber");
  assert.ok(s.events.filter((e) => e.minor).every((e) => /РСБУ|0409102/.test(e.title)));
  assert.ok(s.events.every((e) => e.date >= "2026-10-01"));
});

test("classifyEvent и mentions", () => {
  assert.equal(classifyEvent("cbr_forecast", "Заседание Совета директоров Банка России"), "macro");
  assert.equal(classifyEvent("investor_day", "День инвестора: новая дивидендная политика"), "corporate");
  assert.equal(classifyEvent("record", "Дата закрытия реестра"), "dividend");
  assert.equal(classifyEvent("lenta.q3_2026", "Лента: результаты"), "report");
  assert.equal(classifyEvent(null, "ВОСА о дивидендах"), "dividend");
  assert.equal(classifyEvent(null, "МРОТ на 2027 год"), "macro");
  assert.equal(mentions("АО «Тандер»: РСБУ", "Тандер"), true);
  assert.equal(mentions("Результаты X5 за 3 кв.", "X5"), true);
  assert.equal(mentions("Валента: отчёт", "Лента"), false, "слово целиком, не часть другого");
});

test("пустой выпуск не роняет сводку, а неполный даёт null, не 0", () => {
  const entry = registry.models[0];
  const c = summarize(entry, { schema: "x-v1", meta: {}, fair_value: {} }, { others, today: "2026-10-02" });
  assert.equal(c.fair.median, null);
  assert.equal(c.upside, null);
  assert.deepEqual(c.events, []);
  assert.throws(() => summarize(entry, null));
});
