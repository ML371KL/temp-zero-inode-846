/**
 * Сводная карточка модели: выпуск любой модели семейства → одна форма для хаба.
 *
 * Модели живут своими контрактами (magnit-v5.1, x5-v1, lenta-v1, sber-v1, …) и
 * хаб их не меняет. Здесь — чтение по известным путям с запасными: сначала
 * общий путь семейства (fair_value.headline — Магнит, Лента, Сбер), затем
 * вариант X5 (headline в корне). Новая модель, собранная по образцу Ленты или
 * Сбера, читается без правки этого файла; модель с иной формой — добавлением
 * пути в соответствующий `pick…`. Поле, которого в выпуске нет, остаётся null —
 * «не раскрыто», а не ноль (правило семейства null ≠ 0).
 *
 * Карточка — около 3–6 КБ против 140–420 КБ выпуска: хаб не таскает в
 * браузер распределения и сетки, только то, что показывает.
 */

export const CARD_VERSION = 1;

// Флаги выпусков, которые красят выпуск жёлтым (как фишка выпуска у моделей).
const WARN_FLAGS = new Set(["price_fallback", "report_fact", "book_update", "dividend_register", "ras_mismatch"]);
const WORLD_TITLES = { N: "Нормализация", H: "Высокие ставки надолго", M: "Рыночный как есть" };
const MAX_EVENTS = 40;
const EVENT_HORIZON_DAYS = 400;

/**
 * @param entry   запись реестра (normalizeRegistry)
 * @param d       выпуск модели (разобранный JSON)
 * @param options { others: [{slug, aliases}], today: "YYYY-MM-DD", screens: [{id,title}] }
 */
export function summarize(entry, d, options = {}) {
  if (!isObj(d)) throw new Error("payload is not an object");
  const meta = obj(d.meta);
  const market = obj(d.market);
  const fv = obj(d.fair_value);
  const company = obj(meta.company);
  const tickers = entry.tickers && entry.tickers.length ? entry.tickers
    : list(company.tickers).length ? list(company.tickers) : company.ticker ? [company.ticker] : [];
  const ticker = tickers[0] || company.main_ticker || null;
  const today = options.today || mskToday();

  const fair = pickFair(d, fv);
  const price = pickPrice(d, market, fair, ticker);
  const upside = isNum(fair.median) && isNum(price.value) && price.value > 0 ? fair.median / price.value - 1 : null;

  const events = pickEvents(d, entry, options.others || [], today);
  const nextFact = pickNextFact(d, entry, today);

  return {
    v: CARD_VERSION,
    slug: entry.slug,
    name: entry.name,
    tickers,
    ticker,
    sector: entry.sector,
    url: entry.url,
    ok: true,
    schema: str(d.schema),
    release: {
      published_at: str(meta.published_at) || str(meta.generated_at),
      generated_at: str(meta.generated_at),
      valuation_date: str(meta.valuation_date),
      facts_date: str(meta.facts_date),
      book_version: str(meta.book_version) || str(obj(d.book).version),
      book_date: str(meta.book_date) || str(obj(d.book).date),
      sha: str(meta.payload_sha256) ? meta.payload_sha256.slice(0, 12) : null,
      bytes: num(meta.bytes),
    },
    health: pickHealth(d, meta),
    price,
    others: pickOtherClasses(d, market, fair, tickers.slice(1)),
    fair,
    upside,
    worlds: pickWorlds(d, fv),
    brokers: pickBrokers(market),
    dividend: pickDividend(d, market, price, ticker),
    yield_ltm: pickYieldLtm(d, market, ticker),
    multiples: pickMultiples(market, fv),
    cap: num(market.market_cap) ?? num(market.cap),
    next_fact: nextFact,
    next_report: pickNextReport(events, nextFact, entry.slug, today),
    events,
    screens: list(options.screens),
  };
}

/* ── оценка ── */

function pickFair(d, fv) {
  const h = obj(fv.headline);
  const x = obj(d.headline);
  const printed = obj(fv.printed);
  return {
    median: num(h.median) ?? num(x.central),
    printed_median: num(h.printed_median) ?? num(x.printed_central),
    mean: num(h.mean) ?? num(x.mean),
    point: num(h.point) ?? (isObj(d.headline) ? num(fv.central) : null),
    printed_point: num(h.printed_point) ?? num(printed.central) ?? num(fv.printed_central),
    band80: pair(h.band80) ?? pair(x.band),
    band50: pair(h.band50) ?? pair(x.inner),
    printed_band80: pair(h.printed_band80) ?? pair(x.printed_band),
    printed_band50: pair(h.printed_band50) ?? pair(x.printed_inner),
    print_step: num(h.print_step) ?? num(x.print_step),
    p_below: num(h.p_below_market) ?? num(x.p_central_below_market),
    market: num(h.market) ?? num(x.market_price),
    draws: num(h.draws) ?? num(x.draws),
    rates_view_rub: num(obj(fv.rates_view).rub),
  };
}

function pickPrice(d, market, fair, ticker) {
  const byTicker = ticker ? obj(obj(market.prices)[ticker]) : {};
  const live = obj(d.live);
  const value = fair.market ?? num(byTicker.price) ?? num(market.price);
  return {
    value,
    ticker,
    date: str(byTicker.date) || str(market.price_date) || str(live.price_reference_date) || str(obj(d.meta).valuation_date),
    time: str(byTicker.time) || str(market.price_time),
    status: str(byTicker.status) || str(market.price_status),
    source: str(byTicker.source) || str(market.price_source),
  };
}

// Вторая категория акций (SBERP у Сбера): цена, потенциал и P(ниже рынка) — из выпуска.
function pickOtherClasses(d, market, fair, otherTickers) {
  const h = obj(obj(d.fair_value).headline);
  const prices = obj(market.prices);
  const out = [];
  for (const t of otherTickers) {
    const value = num(obj(h.market_by_ticker)[t]) ?? num(obj(prices[t]).price);
    if (!isNum(value)) continue;
    out.push({
      ticker: t,
      value,
      upside: num(obj(h.upside)[t]) ?? (isNum(fair.median) && value > 0 ? fair.median / value - 1 : null),
      p_below: num(obj(h.p_below_by_ticker)[t]),
    });
  }
  return out;
}

function pickWorlds(d, fv) {
  const byWorld = obj(fv.by_world);
  const defs = obj(d.worlds);
  const order = list(defs.order).length ? list(defs.order) : Object.keys(byWorld);
  const out = [];
  for (const key of order) {
    const raw = byWorld[key];
    const price = isNum(raw) ? raw : num(obj(raw).price);
    if (!isNum(price)) continue;
    const def = obj(defs[key]);
    out.push({ key, title: str(def.title) || str(def.name) || WORLD_TITLES[key] || key, price });
  }
  return out;
}

/* ── рынок ── */

function pickBrokers(market) {
  const s = obj(market.sellside);
  const b = obj(market.brokers);
  const src = isNum(s.median) ? s : b;
  const median = num(src.median);
  if (!isNum(median)) return null;
  const rows = list(src.rows).filter((r) => isObj(r) && r.in_median !== false && isNum(r.target));
  const targets = rows.map((r) => r.target);
  const recs = obj(src.recommendations);
  return {
    median,
    n: num(src.n) ?? num(src.median_n) ?? (rows.length || null),
    min: num(src.min) ?? (targets.length ? Math.min(...targets) : null),
    max: num(src.max) ?? (targets.length ? Math.max(...targets) : null),
    as_of: str(src.as_of),
    recs: isNum(recs.buy) ? { buy: recs.buy, hold: num(recs.hold) ?? 0, sell: num(recs.sell) ?? 0 } : null,
  };
}

function pickDividend(d, market, price, ticker) {
  const dv = obj(d.dividends);
  const ne = obj(dv.next_expected);
  const dps = num(ne.dps) ?? num(ne.dps_model);
  if (isNum(dps)) {
    const y = isObj(ne.yield) ? num(ne.yield[ticker]) : num(ne.yield);
    return {
      dps,
      label: str(ne.label) || (isNum(ne.year) ? `за ${ne.year} г.` : null),
      record_date: str(ne.record_date) || str(ne.record_date_est),
      record_estimated: !str(ne.record_date),
      yield: y ?? (isNum(price.value) && price.value > 0 ? dps / price.value : null),
      status: str(ne.status) || "model",
      p_cancel: num(ne.p_cancel),
    };
  }
  if (isNum(dv.dividends_from_year)) return { from_year: dv.dividends_from_year };
  return null;
}

function pickYieldLtm(d, market, ticker) {
  const fromMultiples = obj(obj(market.multiples).dividend_yield_ltm);
  const fromDividends = obj(d.dividends).yield_ltm;
  return num(market.dividend_yield_ltm)
    ?? num(fromMultiples[ticker])
    ?? (isObj(fromDividends) ? num(fromDividends[ticker]) : num(fromDividends));
}

function pickMultiples(market, fv) {
  const m = obj(market.multiples);
  const out = {
    pe: num(market.pe_ltm) ?? num(m.pe_ltm),
    pe_fwd: num(m.pe_fwd),
    ev_ebitda: num(market.ev_ebitda_ltm) ?? num(obj(fv.ev_comparison).ev_ebitda_market),
    pb: num(m.pb),
  };
  return Object.values(out).some(isNum) ? out : null;
}

/* ── состояние выпуска ── */

function pickHealth(d, meta) {
  const live = obj(d.live);
  const checks = obj(d.checks);
  const notes = [];
  const degraded = live.degraded_flag === true || live.degraded === true
    || (Array.isArray(live.degraded) && live.degraded.length > 0)
    || (isObj(live.errors) && Object.keys(live.errors).length > 0);
  if (degraded) notes.push({ level: "warn", text: "Часть входов выпуска не свежая" });
  for (const f of list(checks.flags)) {
    if (!isObj(f) || !f.raised) continue;
    const text = upperFirst(str(f.title) || str(f.name) || "флаг выпуска");
    notes.push({ level: WARN_FLAGS.has(f.name) ? "warn" : "info", text: text + (str(f.detail) ? `: ${f.detail}` : "") });
  }
  const broken = num(checks.invariants_broken);
  if (isNum(broken) && broken > 0) notes.push({ level: "warn", text: `Нарушено инвариантов: ${broken}` });
  if (meta.book_first_period_closed === true) {
    notes.push({ level: "warn", text: "Первый прогнозный период книги закрыт по календарю, а факты и книга прежние" });
  }
  return { warn: notes.some((n) => n.level === "warn"), notes: notes.slice(0, 8) };
}

/* ── календарь ── */

const MONTHS = "январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр";
const RE_MACRO = /(^|[^a-z])(cbr|key_rate|mrot|budget|tariff|minfin|cpi)/i;
const RE_MACRO_RU = /ключев\S* ставк|банк\S* росси|(^|[^а-яё])цб([^а-яё]|$)|мрот|федеральн\S* бюджет|тариф|инфляц|минфин/i;
const RE_DIVIDEND = /dividend|record|(^|[^a-z])(agm|egm)|дивиденд|отсечк|реестр|собрани|(^|[^а-яё])(воса|госа)([^а-яё]|$)/i;
const RE_REPORT = /ifrs|(^|[^a-z])ras|rsbu|trading|result|report|(^|[^a-z])(fy|q|h)\d|form\d|мсфо|рсбу|результат|отч[её]т|форм\S* 04|датабук/i;
const RE_CORPORATE = /investor|strategy|capital_markets|buyback|split|(^|[^a-z])(spo|ipo|ir)([^a-z]|$)/i;
const RE_MINOR_KIND = /^(ras|form\d+)([-._]|$)/i;
const RE_MINOR_TITLE = new RegExp(`форм\\S* 0409|рсбу[^.]*за (${MONTHS})\\S* \\d{4}`, "i");

// Сначала вид события (у X5 и Сбера — чистое перечисление, у Магнита и Ленты —
// идентификатор вида «lenta.q3_2026»), затем заголовок.
export function classifyEvent(kind, title) {
  const k = String(kind || "");
  const t = String(title || "");
  if (RE_MACRO.test(k)) return "macro";
  if (RE_DIVIDEND.test(k)) return "dividend";
  if (RE_REPORT.test(k)) return "report";
  if (RE_CORPORATE.test(k)) return "corporate";
  if (RE_MACRO_RU.test(t)) return "macro";
  if (RE_DIVIDEND.test(t)) return "dividend";
  if (RE_REPORT.test(t)) return "report";
  return "corporate";
}

function normalizeEvent(e) {
  if (!isObj(e)) return null;
  const date = isoDate(e.date) || isoDate(e.when);
  const title = str(e.title);
  if (!date || !title) return null;
  const kind = str(e.kind) || str(e.id) || null;
  const cls = classifyEvent(kind, title);
  const precision = str(e.precision) || (e.confirmed === false ? "estimate" : "day");
  return {
    date,
    title: title.slice(0, 200),
    kind,
    cls,
    minor: cls === "report" && (RE_MINOR_KIND.test(String(kind || "")) || RE_MINOR_TITLE.test(title)),
    precision,
    confirmed: e.confirmed === true || (e.confirmed !== false && precision === "day"),
    earliest: isoDate(e.earliest),
    latest: isoDate(e.latest),
  };
}

/** Упоминает ли заголовок компанию: слово целиком, без учёта регистра. */
export function mentions(title, alias) {
  const t = String(title).toLowerCase();
  const a = String(alias).toLowerCase().replace(/[«»"]/g, "");
  if (!a) return false;
  let from = 0;
  for (;;) {
    const i = t.indexOf(a, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : t[i - 1];
    const after = t[i + a.length] || "";
    if (!/[a-zа-яё0-9]/i.test(before) && !/[a-zа-яё0-9]/i.test(after)) return true;
    from = i + 1;
  }
}

function attribute(ev, entry, others) {
  if (ev.cls === "macro") return null;
  if (entry.aliases.some((a) => mentions(ev.title, a))) return entry.slug;
  const other = others.find((o) => o.slug !== entry.slug && list(o.aliases).some((a) => mentions(ev.title, a)));
  return other ? other.slug : entry.slug;
}

function pickEvents(d, entry, others, today) {
  const cal = obj(d.calendar);
  const raw = list(cal.events).length ? list(cal.events) : list(obj(d.next_report).events);
  const horizon = addDays(today, EVENT_HORIZON_DAYS);
  const out = [];
  const seen = new Set();
  for (const e of raw) {
    const ev = normalizeEvent(e);
    if (!ev || ev.date < addDays(today, -1) || ev.date > horizon) continue;
    const key = `${ev.date}|${ev.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...ev, company: attribute(ev, entry, others) });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out.slice(0, MAX_EVENTS);
}

// Отчёт, которого ждёт модель (экран «Ближайший отчёт»): calendar.next_fact
// у Магнита, Ленты и Сбера, next_report.closing у X5.
function pickNextFact(d, entry, today) {
  const closing = obj(obj(d.next_report).closing);
  const raw = isObj(obj(d.calendar).next_fact) ? d.calendar.next_fact : closing.published === true ? null : closing;
  const nf = normalizeEvent(obj(raw));
  if (!nf || nf.date < addDays(today, -1)) return null;
  return { ...nf, cls: "report", minor: false, company: entry.slug };
}

// Ближайший существенный отчёт своей компании: факт модели или событие календаря.
function pickNextReport(events, nextFact, slug, today) {
  const candidates = events.filter((e) => e.company === slug && e.cls === "report" && !e.minor && e.date >= today);
  if (nextFact && nextFact.date >= today) candidates.push(nextFact);
  candidates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return candidates[0] || null;
}

/* ── мелочи ── */

export function mskToday(now = Date.now()) {
  return new Date(now + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

function isoDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

function pair(v) {
  return Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) ? [v[0], v[1]] : null;
}

function upperFirst(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function num(v) {
  return isNum(v) ? v : null;
}

function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function obj(v) {
  return isObj(v) ? v : {};
}

function list(v) {
  return Array.isArray(v) ? v : [];
}
