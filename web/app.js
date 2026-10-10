/* Модели 850 — хаб справедливых стоимостей.
 *
 * Ванильный JS без сборки (как витрины семейства). Данные — две двери хаба:
 *   /api/registry       — список моделей (registry.json);
 *   /api/card/<slug>    — сводная карточка модели из её выпуска.
 * Экраны: Обзор (таблица «полосы против рынка»), Карта (потенциал ×
 * неопределённость), Календарь (события всех моделей), Модели (каталог и
 * свежесть). Все суждения о стоимости — из выпусков моделей; хаб ничего не
 * пересчитывает, кроме потенциала «медиана / рынок − 1» и сводных медиан.
 */
"use strict";

const API_REGISTRY = "/api/registry";
const API_CARD = (slug) => `/api/card/${encodeURIComponent(slug)}`;
const STALE_HOURS = 96;
const CONCURRENCY = 6;
const AUTO_REFRESH_MIN = 15;
const PREFS_KEY = "hub846-prefs";
const SCREENS = ["overview", "map", "calendar", "models"];
const CLS_TITLES = { report: "Отчёт", dividend: "Дивиденды", macro: "Макро", corporate: "Компания" };
const DEFAULT_SCREENS = [
  { id: "overview", title: "Оценка" }, { id: "market", title: "Что в цене" }, { id: "model", title: "Расчёт" },
  { id: "report", title: "Ближайший отчёт" }, { id: "book", title: "Допущения" },
];

const state = {
  registry: null,
  cards: new Map(),
  screen: "overview",
  expanded: new Set(),
  loadedAt: 0,
  loading: false,
  prefs: loadPrefs(),
};

/* ── утилиты ── */

const $ = (sel, root = document) => root.querySelector(sel);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const list = (v) => (Array.isArray(v) ? v : []);

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function svgEl(tag, attrs, ...children) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function loadPrefs() {
  const base = { sort: "upside", dir: -1, sector: "all", query: "", group: false, calCls: "all", calDays: 90, calMinor: false };
  try {
    const raw = JSON.parse(window.localStorage.getItem(PREFS_KEY) || "{}");
    return { ...base, ...obj(raw), query: "" };
  } catch (e) {
    return base;
  }
}

function savePrefs() {
  try {
    const { query, ...rest } = state.prefs;
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(rest));
  } catch (e) { /* приватный режим: настройки живут до перезагрузки */ }
}

/* ── форматы (ru-RU, МСК) ── */

const NBSP = " ";
const nf = {};
function numFmt(digits) {
  const key = String(digits);
  if (!nf[key]) nf[key] = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return nf[key];
}
// Половина — вверх (как печать витрин X5 и Сбера), а не банковское округление.
function roundHalfUp(v, digits) {
  const m = 10 ** digits;
  return Math.sign(v) * Math.round(Math.abs(v) * m + 1e-9) / m;
}
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTHS_NOM = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MONTHS_SHORT_NOM = ["янв.", "февр.", "март", "апр.", "май", "июнь", "июль", "авг.", "сент.", "окт.", "нояб.", "дек."];
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

const fmt = {
  num(v, digits = 0) { return isNum(v) ? numFmt(digits).format(roundHalfUp(v, digits)).replace(/ /g, NBSP) : "—"; },
  price(v) {
    if (!isNum(v)) return "—";
    const digits = Math.abs(v) < 1000 && Math.round(v) !== v ? 2 : 0;
    return `${fmt.num(v, digits)}${NBSP}₽`;
  },
  rub(v, digits = 0) { return isNum(v) ? `${fmt.num(v, digits)}${NBSP}₽` : "—"; },
  signedRub(v) { return isNum(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt.num(Math.abs(v), 0)}${NBSP}₽` : "—"; },
  pct(v, digits = 0) { return isNum(v) ? `${fmt.num(v * 100, digits)}${NBSP}%` : "—"; },
  signedPct(v, digits = 0) {
    if (!isNum(v)) return "—";
    const r = roundHalfUp(v * 100, digits);
    const sign = r > 0 ? "+" : r < 0 ? "−" : "";
    return `${sign}${fmt.num(Math.abs(r), digits)}${NBSP}%`;
  },
  mult(v) { return isNum(v) ? `${fmt.num(v, v < 10 ? 2 : 1)}×` : "—"; },
  bn(v) {
    if (!isNum(v)) return "—";
    return v >= 1000 ? `${fmt.num(v / 1000, 2)}${NBSP}трлн${NBSP}₽` : `${fmt.num(v, v < 100 ? 1 : 0)}${NBSP}млрд${NBSP}₽`;
  },
  range(pair, f = fmt.price) {
    if (!Array.isArray(pair)) return "—";
    return `${f(pair[0]).replace(`${NBSP}₽`, "")}–${f(pair[1])}`;
  },
  // Даты выпусков — календарные (без времени): разбираем как есть, без сдвига пояса.
  dayMonth(iso) {
    const d = parseDay(iso);
    return d ? `${d.d}${NBSP}${MONTHS_SHORT[d.m]}` : "—";
  },
  date(iso) {
    const d = parseDay(iso);
    return d ? `${String(d.d).padStart(2, "0")}.${String(d.m + 1).padStart(2, "0")}.${d.y}` : "—";
  },
  monthYear(iso) {
    const d = parseDay(iso);
    return d ? `${MONTHS_SHORT_NOM[d.m]}${NBSP}${d.y}` : "—";
  },
  // Моменты (published_at и т. п.) — по Москве.
  stamp(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "—";
    const p = mskParts(t);
    return `${p.d}${NBSP}${MONTHS_SHORT[p.m]}, ${p.hh}:${p.mm}${NBSP}МСК`;
  },
  days(n) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    const word = a > 10 && a < 20 ? "дней" : b === 1 ? "день" : b >= 2 && b <= 4 ? "дня" : "дней";
    return `${n}${NBSP}${word}`;
  },
};

function parseDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
}

function mskParts(t) {
  const d = new Date(t + 3 * 3600 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), hh: String(d.getUTCHours()).padStart(2, "0"), mm: String(d.getUTCMinutes()).padStart(2, "0") };
}

function mskToday() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysUntil(iso) {
  const a = Date.parse(`${mskToday()}T00:00:00Z`);
  const b = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(b) ? Math.round((b - a) / 86400000) : null;
}

function countdown(iso) {
  const n = daysUntil(iso);
  if (n === null) return "";
  if (n === 0) return "сегодня";
  if (n === 1) return "завтра";
  if (n < 0) return `${fmt.days(-n)} назад`;
  return `через ${fmt.days(n)}`;
}

// Дата события с учётом точности: день, окно или месяц.
function eventDate(e) {
  if (e.precision === "month") return fmt.monthYear(e.date);
  const approx = e.precision === "window" || e.precision === "estimate" || e.confirmed === false;
  return `${approx ? "≈" + NBSP : ""}${fmt.dayMonth(e.date)}`;
}

function eventPrecisionNote(e) {
  if (e.precision === "window" && e.earliest && e.latest) return `окно ${fmt.dayMonth(e.earliest)} – ${fmt.dayMonth(e.latest)}`;
  if (e.precision === "month") return "дата — с точностью до месяца";
  if (e.confirmed === false || e.precision === "estimate") return "дата — оценка";
  return "";
}

function upperFirst(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/* ── данные ── */

async function getJson(url, fresh) {
  const response = await fetch(url, { headers: { accept: "application/json" }, cache: fresh ? "no-cache" : "default", credentials: "same-origin" });
  if (response.status === 401) {
    window.location.reload();
    throw new Error("unauthorized");
  }
  let body = null;
  try { body = await response.json(); } catch (e) { body = null; }
  if (!body) throw new Error(`HTTP ${response.status}`);
  return body;
}

async function loadAll(fresh = false) {
  if (state.loading) return;
  state.loading = true;
  $("#refresh") && $("#refresh").classList.add("is-busy");
  try {
    state.registry = await getJson(API_REGISTRY, fresh);
  } catch (e) {
    state.loading = false;
    $("#refresh") && $("#refresh").classList.remove("is-busy");
    if (!state.registry) return fatal("Реестр моделей недоступен", String(e && e.message || e));
    return;
  }
  const live = liveModels();
  for (const m of live) if (!state.cards.has(m.slug)) state.cards.set(m.slug, { slug: m.slug, loading: true });
  render();
  let i = 0;
  let pendingRender = null;
  const scheduleRender = () => {
    if (pendingRender) return;
    pendingRender = setTimeout(() => { pendingRender = null; render(); }, 60);
  };
  const worker = async () => {
    while (i < live.length) {
      const m = live[i++];
      try {
        const card = await getJson(API_CARD(m.slug), fresh);
        state.cards.set(m.slug, card);
      } catch (e) {
        const prev = state.cards.get(m.slug);
        if (!prev || prev.loading) state.cards.set(m.slug, { slug: m.slug, ok: false, errors: [String(e && e.message || e)] });
      }
      scheduleRender();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, live.length) }, worker));
  state.loadedAt = Date.now();
  state.loading = false;
  $("#refresh") && $("#refresh").classList.remove("is-busy");
  render();
}

function liveModels() { return list(obj(state.registry).models).filter((m) => m.status !== "planned"); }
function plannedModels() { return list(obj(state.registry).models).filter((m) => m.status === "planned"); }
function entryOf(slug) { return list(obj(state.registry).models).find((m) => m.slug === slug) || null; }

// Строка хаба: запись реестра + карточка (если пришла).
function rows() {
  return liveModels().map((m) => {
    const c = state.cards.get(m.slug) || { loading: true };
    const ok = c.ok === true;
    return { entry: m, card: c, ok, loading: Boolean(c.loading) };
  });
}

function freshness(card) {
  if (!card || card.loading) return { state: "loading", label: "загружается" };
  if (!card.ok) return { state: "down", label: "данные недоступны" };
  const t = Date.parse(obj(card.release).published_at);
  const age = Number.isFinite(t) ? (Date.now() - t) / 3.6e6 : null;
  if (card.stale) return { state: "stale", label: "витрина модели не отвечает — показан последний принятый выпуск", age };
  if (isNum(age) && age > STALE_HOURS) return { state: "stale", label: `выпуску ${fmt.days(Math.floor(age / 24))}`, age };
  if (obj(card.health).warn) return { state: "warn", label: "есть предупреждения выпуска", age };
  return { state: "ok", label: "выпуск свежий", age };
}

/* ── фильтр и сортировка ── */

function sectors() {
  const counts = new Map();
  for (const m of liveModels()) counts.set(m.sector, (counts.get(m.sector) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
}

function matches(r) {
  const p = state.prefs;
  if (p.sector !== "all" && r.entry.sector !== p.sector) return false;
  const q = p.query.trim().toLowerCase();
  if (!q) return true;
  const hay = [r.entry.name, r.entry.sector, ...list(r.entry.tickers), ...list(r.entry.aliases)].join(" ").toLowerCase();
  return hay.includes(q);
}

const SORTS = {
  upside: { title: "по потенциалу", key: (r) => r.card.upside, dir: -1 },
  name: { title: "по названию", key: (r) => r.entry.name.toLowerCase(), dir: 1 },
  p_below: { title: "по вероятности «ниже рынка»", key: (r) => obj(r.card.fair).p_below, dir: 1 },
  floor: { title: "по нижней границе полосы 80 %", key: (r) => lowEdge(r.card), dir: -1 },
  brokers: { title: "по разрыву с брокерами", key: (r) => vsBrokers(r.card), dir: -1 },
  dividend: { title: "по дивидендной доходности", key: (r) => obj(r.card.dividend).yield, dir: -1 },
  report: { title: "по дате отчёта", key: (r) => obj(r.card.next_report).date || null, dir: 1 },
  release: { title: "по свежести выпуска", key: (r) => obj(r.card.release).published_at || null, dir: -1 },
};

function lowEdge(card) {
  const b = obj(card.fair).band80;
  const px = obj(card.price).value;
  return Array.isArray(b) && isNum(px) && px > 0 ? b[0] / px - 1 : null;
}

function vsBrokers(card) {
  const med = obj(card.fair).median;
  const br = obj(card.brokers).median;
  return isNum(med) && isNum(br) && br > 0 ? med / br - 1 : null;
}

function sortRows(items) {
  const s = SORTS[state.prefs.sort] || SORTS.upside;
  const dir = state.prefs.dir || s.dir;
  return items.slice().sort((a, b) => {
    const ka = a.ok ? s.key(a) : null;
    const kb = b.ok ? s.key(b) : null;
    const na = ka === null || ka === undefined;
    const nb = kb === null || kb === undefined;
    if (na && nb) return a.entry.name.localeCompare(b.entry.name, "ru");
    if (na) return 1;
    if (nb) return -1;
    if (ka < kb) return -dir;
    if (ka > kb) return dir;
    return a.entry.name.localeCompare(b.entry.name, "ru");
  });
}

function setSort(key) {
  if (state.prefs.sort === key) state.prefs.dir = -(state.prefs.dir || SORTS[key].dir);
  else { state.prefs.sort = key; state.prefs.dir = SORTS[key].dir; }
  savePrefs();
  render();
}

/* ── сводные числа ── */

function median(values) {
  const v = values.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/* ── график под реальную ширину: SVG рисуется в пикселях контейнера (иначе
   на телефоне viewBox сжимает и подписи до нечитаемых) ── */

function responsive(draw, cls) {
  const host = el("div", { class: `rs${cls ? ` ${cls}` : ""}` });
  let lastW = 0;
  const ro = new ResizeObserver(() => {
    if (!host.isConnected) { ro.disconnect(); return; }
    const w = Math.round(host.clientWidth);
    if (!w || Math.abs(w - lastW) < 8) return;
    lastW = w;
    host.replaceChildren(draw(w));
  });
  ro.observe(host);
  return host;
}

/* ── плитка компании: знак и цвет из реестра (mark, color, ink); хаб рисует её
   сам, без запросов к витринам. Нет цвета — нейтральная плитка. ── */

function coIcon(entry) {
  const mark = entry.mark || (list(entry.tickers)[0] || entry.name || "?").slice(0, 2).toUpperCase();
  const box = el("span", { class: "co-icon", "aria-hidden": "true", "data-len": [...mark].length }, mark);
  if (entry.color) {
    box.classList.add("is-brand");
    box.style.background = entry.color;
    box.style.color = entry.ink || contrastInk(entry.color);
  }
  return box;
}

// Белый или чёрный знак — что контрастнее к цвету плитки (яркость WCAG).
function contrastInk(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.05 ? "#ffffff" : "#121211";
}

function modelLink(entry, screen) {
  return entry.url ? `${entry.url}/${screen ? `#${screen}` : ""}` : null;
}

/* ── подсказки ── */

const tipState = { node: null };

function tipContent(spec) {
  if (typeof spec === "string") return [el("div", {}, spec)];
  const out = [];
  if (spec.title) out.push(el("div", { class: "tip-title" }, spec.title));
  for (const [k, v] of list(spec.rows)) out.push(el("div", { class: "tip-row" }, el("span", { class: "k" }, k), el("span", { class: "v" }, v)));
  if (spec.note) out.push(el("div", { class: "tip-note" }, spec.note));
  return out;
}

function attachTip(node, spec) {
  node._tip = spec;
  node.setAttribute("data-tip", "");
  return node;
}

function showTip(target, x, y) {
  const tip = $("#tip");
  if (!tip || !target._tip) return;
  tip.replaceChildren(...tipContent(typeof target._tip === "function" ? target._tip() : target._tip));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 14;
  let top = y + 16;
  if (left + r.width > window.innerWidth - 8) left = Math.max(8, x - r.width - 14);
  if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height - 12);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideTip() { const tip = $("#tip"); if (tip) tip.hidden = true; tipState.node = null; }

function bindTips() {
  document.addEventListener("pointermove", (e) => {
    const t = e.target instanceof Element ? e.target.closest("[data-tip]") : null;
    if (!t || !t._tip || e.pointerType === "touch") { if (tipState.node) hideTip(); return; }
    tipState.node = t;
    showTip(t, e.clientX, e.clientY);
  });
  document.addEventListener("focusin", (e) => {
    const t = e.target instanceof Element ? e.target.closest("[data-tip]") : null;
    if (!t || !t._tip) return;
    const r = t.getBoundingClientRect();
    showTip(t, r.left + r.width / 2, r.bottom);
  });
  document.addEventListener("focusout", hideTip);
  window.addEventListener("scroll", hideTip, { passive: true });
}

/* ── шкала «% к рынку» ── */

function stripDomain(items) {
  let lo = 0;
  let hi = 0;
  for (const r of items) {
    if (!r.ok) continue;
    const b = obj(r.card.fair).band80;
    const px = obj(r.card.price).value;
    if (!Array.isArray(b) || !isNum(px) || px <= 0) continue;
    lo = Math.min(lo, b[0] / px - 1);
    hi = Math.max(hi, b[1] / px - 1);
  }
  lo = Math.max(lo, -1);
  hi = Math.min(hi, 3);
  const span = Math.max(hi - lo, 0.4);
  const step = [0.1, 0.2, 0.25, 0.5, 1].find((s) => span / s <= 6) || 1;
  lo = Math.floor((lo - span * 0.04) / step) * step;
  hi = Math.ceil((hi + span * 0.04) / step) * step;
  lo = Math.max(lo, -1);
  const ticks = [];
  for (let t = lo; t <= hi + 1e-9; t += step) ticks.push(Math.round(t * 1000) / 1000);
  return { lo, hi, ticks, step };
}

// Подписи шкалы: при шести и более делениях — через одно (ноль, «рынок», подписан всегда).
function labelledTicks(dom) {
  if (dom.ticks.length <= 5) return dom.ticks;
  return dom.ticks.filter((t) => Math.round(t / dom.step) % 2 === 0);
}

const pos = (dom, v) => ((Math.min(Math.max(v, dom.lo), dom.hi) - dom.lo) / (dom.hi - dom.lo)) * 100;

function axisRow(dom) {
  return el("div", { class: "axis", "aria-hidden": "true" },
    labelledTicks(dom).map((t) => label(t === 0 ? "zero" : "", pos(dom, t),
      t === 0 ? "рынок" : `${t > 0 ? "+" : "−"}${fmt.num(Math.abs(t) * 100)}${NBSP}%`)));
}

function strip(card, dom) {
  const f = obj(card.fair);
  const px = obj(card.price).value;
  if (!Array.isArray(f.band80) || !isNum(f.median) || !isNum(px) || px <= 0) return el("div", { class: "strip-empty" }, "оценки нет в выпуске");
  const rel = (v) => v / px - 1;
  const node = el("div", { class: "strip", role: "img", "aria-label": `Полоса 80 %: ${fmt.signedPct(rel(f.band80[0]))} … ${fmt.signedPct(rel(f.band80[1]))} к рынку, медиана ${fmt.signedPct(rel(f.median))}` });
  for (const t of dom.ticks) if (t !== 0) node.append(el("i", { class: "g", style: { left: `${pos(dom, t)}%` } }));
  const bar = (cls, pair) => {
    const a = pos(dom, rel(pair[0]));
    const b = pos(dom, rel(pair[1]));
    return el("i", { class: cls, style: { left: `${a}%`, width: `${Math.max(b - a, 0.6)}%` } });
  };
  node.append(bar("b80", f.band80));
  if (Array.isArray(f.band50)) node.append(bar("b50", f.band50));
  node.append(el("i", { class: "mk", style: { left: `${pos(dom, 0)}%` } }));
  node.append(el("i", { class: "md", style: { left: `${pos(dom, rel(f.median))}%` } }));
  if (rel(f.band80[0]) < dom.lo - 1e-9) node.append(el("i", { class: "clip l" }));
  if (rel(f.band80[1]) > dom.hi + 1e-9) node.append(el("i", { class: "clip r" }));
  attachTip(node, () => ({
    title: `${card.name}: модель против рынка`,
    rows: [
      ["медиана", `${fmt.price(f.printed_median ?? f.median)} · ${fmt.signedPct(rel(f.median))}`],
      ["полоса 50 %", `${fmt.range(f.printed_band50 || f.band50)}`],
      ["полоса 80 %", `${fmt.range(f.printed_band80 || f.band80)}`],
      ["рынок", `${fmt.price(px)} · ${fmt.dayMonth(obj(card.price).date)}`],
    ],
    note: isNum(f.p_below) ? `Вероятность, что справедливая цена ниже рынка, — ${fmt.pct(f.p_below)}` : null,
  }));
  return node;
}

function upsidePill(v) {
  if (!isNum(v)) return el("span", { class: "upside none" }, "—");
  const r = roundHalfUp(v * 100, 0);
  return el("span", { class: `upside ${r > 0 ? "pos" : r < 0 ? "neg" : "zero"}` }, fmt.signedPct(v));
}

/* ── экран «Обзор» ── */

function overviewScreen() {
  const all = rows();
  const ok = all.filter((r) => r.ok);
  const visible = sortRows(all.filter(matches));
  const dom = stripDomain(visible.length ? visible : all);
  const reg = obj(state.registry);

  const head = el("div", { class: "screen-head" },
    el("span", { class: "eyebrow" }, `Покрытие · ${modelsWord(all.length)} · ${fmt.date(mskToday())}`),
    el("h1", {}, "Справедливая стоимость против рынка"),
    el("p", {}, "Медиана каждой модели и её полосы 50 и 80 % — в процентах к рыночной цене акции. Правее оранжевой линии рынка — модель видит стоимость выше цены. Строка раскрывается: оценка, рынок, дивиденды, ближайшие события и ссылки на экраны модели."));

  return el("section", { class: "screen" }, head, statusBelt(all), tiles(all, ok, reg), board(visible, dom, all.length));
}

function modelsWord(n) {
  const a = n % 100;
  const b = n % 10;
  return `${n}${NBSP}${a > 10 && a < 20 ? "моделей" : b === 1 ? "модель" : b >= 2 && b <= 4 ? "модели" : "моделей"}`;
}

function statusBelt(all) {
  const down = all.filter((r) => !r.loading && !r.ok);
  const stale = all.filter((r) => r.ok && freshness(r.card).state === "stale");
  const out = [];
  if (down.length) out.push(el("div", { class: "banner banner-stale" }, el("span", { class: "banner-icon" }, "!"),
    el("div", {}, el("strong", {}, "Нет данных: "), down.map((r) => r.entry.name).join(", "), ". Витрина модели и запасные источники не ответили; строка остаётся в списке без чисел.")));
  if (stale.length) out.push(el("div", { class: "banner banner-degraded" }, el("span", { class: "banner-icon" }, "!"),
    el("div", {}, el("strong", {}, "Устаревшие выпуски: "), stale.map((r) => `${r.entry.name} (${freshness(r.card).label})`).join("; "), ". Числа этих строк — не сегодняшние.")));
  return out.length ? el("div", { class: "belt", style: { paddingTop: "0", marginBottom: "20px" } }, out) : null;
}

function tiles(all, ok, reg) {
  const ups = ok.map((r) => r.card.upside).filter(isNum);
  const med = median(ups);
  const above = ups.filter((u) => u > 0).length;
  const best = ok.filter((r) => isNum(r.card.upside)).sort((a, b) => b.card.upside - a.card.upside)[0];
  const worst = ok.filter((r) => isNum(r.card.upside)).sort((a, b) => a.card.upside - b.card.upside)[0];
  const target = reg.target;
  const planned = plannedModels().length;

  const coverage = el("div", { class: "card tile" },
    el("span", { class: "tile-label" }, "Моделей в хабе"),
    el("span", { class: "tile-value" }, String(all.length), target ? el("span", { class: "unit" }, `из ≈${NBSP}${target}`) : null),
    target ? el("div", { class: "progress", role: "img", "aria-label": `${all.length} из ${target}` }, el("i", { style: { width: `${Math.min(100, (all.length / target) * 100)}%` } })) : null,
    el("span", { class: "tile-note" }, sectorsLine(), planned ? el("span", { class: "muted" }, ` · в работе ещё ${planned}`) : null));

  const typical = el("div", { class: "card tile" },
    el("span", { class: "tile-label" }, "Медианный потенциал"),
    el("span", { class: "tile-value" }, isNum(med) ? fmt.signedPct(med) : "—"),
    el("span", { class: "tile-note" }, ups.length ? `медиана выше рынка у ${above} из ${ups.length}; потенциал — медиана модели к цене` : "ждём выпуски моделей"));

  const gap = el("div", { class: "card tile" },
    el("span", { class: "tile-label" }, "Наибольший потенциал"),
    best ? el("span", { class: "tile-value" }, el("a", { href: `#overview/${best.entry.slug}` }, el("span", { class: "name" }, best.entry.name)), el("span", {}, fmt.signedPct(best.card.upside))) : el("span", { class: "tile-value" }, "—"),
    el("span", { class: "tile-note" }, worst && best && worst !== best
      ? [worst.card.upside < 0 ? "ниже рынка сильнее всех — " : "ближе всех к рынку — ", el("a", { href: `#overview/${worst.entry.slug}`, style: { color: "inherit" } }, worst.entry.name), ` (${fmt.signedPct(worst.card.upside)})`]
      : best ? `P(ниже рынка) ${fmt.pct(obj(best.card.fair).p_below)}` : ""));

  const next = nextReports(ok)[0];
  const soon = el("div", { class: "card tile" },
    el("span", { class: "tile-label" }, "Ближайший отчёт"),
    next ? el("span", { class: "tile-value" }, el("a", { href: `#overview/${next.slug}` }, el("span", { class: "name" }, next.name)), el("span", { class: "unit" }, eventDate(next.ev))) : el("span", { class: "tile-value" }, "—"),
    el("span", { class: "tile-note" }, next ? [shorten(next.ev.title, 70), el("span", { class: "muted" }, ` · ${countdown(next.ev.date)}`)] : "в выпусках нет дат"));

  return el("div", { class: "tiles", style: { marginBottom: "24px" } }, coverage, typical, gap, soon);
}

function sectorsLine() {
  return sectors().map(([s, n]) => `${s}${NBSP}${n}`).join(" · ");
}

function nextReports(ok) {
  return ok.map((r) => ({ slug: r.entry.slug, name: r.entry.name, ev: r.card.next_report }))
    .filter((x) => x.ev && x.ev.date >= mskToday())
    .sort((a, b) => (a.ev.date < b.ev.date ? -1 : a.ev.date > b.ev.date ? 1 : 0));
}

function shorten(s, n) { return s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; }

function board(visible, dom, total) {
  const p = state.prefs;
  const sectorBtns = [["all", "Все", total], ...sectors().map(([s, n]) => [s, s, n])].map(([key, title, n]) =>
    el("button", { class: "pill-btn", type: "button", "aria-pressed": String(p.sector === key), onclick: () => { p.sector = key; savePrefs(); render(); } },
      title, el("span", { class: "count" }, String(n))));
  const search = el("input", {
    class: "search", type: "search", placeholder: "Компания или тикер", "aria-label": "Поиск по компании или тикеру", value: p.query,
    oninput: (e) => { p.query = e.target.value; renderBoardOnly(); },
  });
  const sortSel = el("select", { class: "select", "aria-label": "Сортировка", onchange: (e) => { p.sort = e.target.value; p.dir = SORTS[p.sort].dir; savePrefs(); render(); } },
    Object.entries(SORTS).map(([k, s]) => el("option", { value: k, selected: k === p.sort }, upperFirst(s.title))));
  const group = el("label", { class: "toggle" },
    el("input", { type: "checkbox", checked: p.group, onchange: (e) => { p.group = e.target.checked; savePrefs(); render(); } }), "по отраслям");

  const card = el("div", { class: "card", id: "board" },
    el("div", { class: "board-head" },
      el("div", {}, el("h2", {}, "Все модели"), el("p", { class: "sub" }, `${upperFirst(SORTS[p.sort].title)}${(p.dir || SORTS[p.sort].dir) !== SORTS[p.sort].dir ? " (обратный порядок)" : ""} · строка раскрывается по клику`)),
      el("div", { class: "controls" }, el("div", { class: "seg", role: "group", "aria-label": "Отрасль" }, sectorBtns), search, sortSel, group)),
    el("div", { class: "board-wrap" }, el("div", { class: "mobile-axis" }, axisRow(dom)), boardTable(visible, dom)),
    el("div", { class: "board-legend" },
      el("div", { class: "legend" },
        el("span", {}, el("i", { class: "key key-b80" }), "полоса 80 % прогонов"),
        el("span", {}, el("i", { class: "key key-b50" }), "полоса 50 %"),
        el("span", {}, el("i", { class: "key key-median" }), "медиана"),
        el("span", {}, el("i", { class: "key key-market" }), "рыночная цена")),
      el("span", { class: "muted small" }, "Шкала — % к рыночной цене, общая для всех строк; полоса за краем шкалы помечена стрелкой.")));
  return card;
}

function renderBoardOnly() {
  const host = $("#board .board-wrap");
  if (!host) return render();
  const all = rows();
  const visible = sortRows(all.filter(matches));
  const dom = stripDomain(visible.length ? visible : all);
  host.replaceChildren(el("div", { class: "mobile-axis" }, axisRow(dom)), boardTable(visible, dom));
}

function boardTable(visible, dom) {
  const p = state.prefs;
  const th = (label, key, cls, title) => {
    const active = p.sort === key;
    const dir = p.dir || (SORTS[key] && SORTS[key].dir);
    const content = key
      ? el("button", { class: "sort-btn", type: "button", "aria-sort": active ? (dir > 0 ? "ascending" : "descending") : null, onclick: () => setSort(key), title: title || null },
        label, el("span", { class: "arrow", "aria-hidden": "true" }, dir > 0 ? "↑" : "↓"))
      : label;
    return el("th", { class: cls || null, scope: "col" }, content);
  };
  const thead = el("thead", {}, el("tr", {},
    th("Компания", "name"),
    th("Рынок", null, "r c-price"),
    th("Медиана", null, "r"),
    th("Потенциал", "upside", "r"),
    el("th", { class: "strip-head", scope: "col" }, el("span", { class: "sr" }, "Полоса к рынку"), axisRow(dom)),
    th("P(ниже)", "p_below", "r col-p", "Вероятность, что справедливая цена ниже рыночной"),
    th("Брокеры", "brokers", "r col-brokers", "Медиана целевых цен брокеров; ниже — насколько медиана модели выше или ниже"),
    th("Дивиденд", "dividend", "r col-div", "Следующий ожидаемый дивиденд и его доходность к цене"),
    th("Отчёт", "report", null, "Ближайший существенный отчёт компании"),
    el("th", { class: "c-chev", scope: "col" }, el("span", { class: "sr" }, "Подробнее"))));

  const tbody = el("tbody", {});
  if (!visible.length) {
    tbody.append(el("tr", {}, el("td", { colspan: 10, class: "empty" }, "Ничего не нашлось — смените отрасль или запрос.")));
  } else if (p.group) {
    const groups = new Map();
    for (const r of visible) { if (!groups.has(r.entry.sector)) groups.set(r.entry.sector, []); groups.get(r.entry.sector).push(r); }
    const order = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length || a.localeCompare(b, "ru"));
    for (const s of order) {
      const g = groups.get(s);
      const med = median(g.filter((r) => r.ok).map((r) => r.card.upside));
      tbody.append(el("tr", { class: "group" }, el("td", { colspan: 10 }, s,
        el("span", { class: "group-meta" }, `${modelsWord(g.length)}${isNum(med) ? ` · медианный потенциал ${fmt.signedPct(med)}` : ""}`))));
      for (const r of g) appendRow(tbody, r, dom);
    }
  } else {
    for (const r of visible) appendRow(tbody, r, dom);
  }
  return el("table", { class: "board" }, el("caption", { class: "sr" }, "Модели: медиана, полосы и потенциал к рынку"), thead, tbody);
}

function appendRow(tbody, r, dom) {
  const { entry, card } = r;
  const open = state.expanded.has(entry.slug);
  const fr = freshness(card);
  const tickers = list(entry.tickers).join(" · ");
  const dot = attachTip(el("span", { class: "dot", "data-state": fr.state, role: "img", "aria-label": fr.label }), () => releaseTip(card, fr));
  const co = el("td", { class: "c-co" }, el("div", { class: "co" }, coIcon(entry),
    el("div", { style: { minWidth: "0" } }, el("span", { class: "co-name" }, entry.name, " ", dot),
      el("span", { class: "co-meta" }, tickers ? el("span", { class: "tick" }, tickers) : null, tickers ? " · " : "", entry.sector))));

  if (r.loading) {
    const tr = el("tr", { class: "row is-loading", "aria-busy": "true" }, co,
      el("td", { class: "r c-price" }, el("span", { class: "shimmer", style: { width: "56px", marginLeft: "auto" } })),
      el("td", { class: "r c-fair" }, el("span", { class: "shimmer", style: { width: "64px", marginLeft: "auto" } })),
      el("td", { class: "r c-up" }, el("span", { class: "shimmer", style: { width: "48px", marginLeft: "auto" } })),
      el("td", { class: "strip-cell" }, el("span", { class: "shimmer", style: { width: "100%", height: "12px" } })),
      el("td", { class: "col-p" }), el("td", { class: "col-brokers" }), el("td", { class: "col-div" }), el("td", { class: "c-report" }),
      el("td", { class: "c-chev" }));
    tbody.append(tr);
    return;
  }

  if (!r.ok) {
    const tr = el("tr", { class: "row is-down", tabindex: "0", "aria-expanded": String(open) }, co,
      el("td", { class: "r c-price" }, "—"), el("td", { class: "r c-fair" }, "—"), el("td", { class: "r c-up" }, upsidePill(null)),
      el("td", { class: "strip-cell" }, el("span", { class: "down-note" }, "нет данных: витрина модели не ответила")),
      el("td", { class: "col-p" }), el("td", { class: "col-brokers" }), el("td", { class: "col-div" }), el("td", { class: "c-report" }),
      el("td", { class: "c-chev" }, chevron()));
    bindRow(tr, entry.slug);
    tbody.append(tr);
    if (open) tbody.append(detailRow(r));
    return;
  }

  const f = obj(card.fair);
  const price = obj(card.price);
  const br = obj(card.brokers);
  const dv = card.dividend;
  const rep = card.next_report;
  const vsB = vsBrokers(card);

  const tr = el("tr", { class: "row", tabindex: "0", "aria-expanded": String(open), "data-slug": entry.slug }, co,
    el("td", { class: "r num c-price" }, fmt.price(price.value), el("span", { class: "cell-sub" }, fmt.dayMonth(price.date))),
    el("td", { class: "r num c-fair" }, el("span", { class: "fair" }, el("span", { class: "approx" }, "≈"), fmt.price(f.printed_median ?? f.median)),
      el("span", { class: "cell-sub" }, isNum(f.median) ? `точно ${fmt.num(f.median, f.median < 1000 ? 1 : 0)}` : "")),
    el("td", { class: "r c-up" }, upsidePill(card.upside)),
    el("td", { class: "strip-cell" }, strip(card, dom)),
    el("td", { class: "r num col-p" }, isNum(f.p_below)
      ? attachTip(el("span", { class: "pbar" }, el("span", { class: "meter", "aria-hidden": "true" }, el("i", { style: { width: `${f.p_below * 100}%` } })), fmt.pct(f.p_below)),
        { title: "P(справедливая < рынка)", note: `Доля прогонов модели, в которых справедливая цена ниже рыночной (${fmt.price(price.value)}).` })
      : "—"),
    el("td", { class: "r num col-brokers" }, isNum(br.median) ? [fmt.price(br.median), el("span", { class: "cell-sub" }, isNum(vsB) ? `модель ${fmt.signedPct(vsB)}` : "")] : el("span", { class: "muted" }, "—")),
    el("td", { class: "r num col-div" }, dividendCell(dv)),
    el("td", { class: "c-report" }, rep ? [el("span", { class: "nowrap" }, eventDate(rep)), el("span", { class: "cell-sub" }, countdown(rep.date))] : el("span", { class: "muted" }, "—")),
    el("td", { class: "c-chev" }, chevron()));
  if (rep) attachTip(tr.querySelector(".c-report"), { title: rep.title, note: [eventPrecisionNote(rep), rep.kind === obj(card.next_fact).kind && rep.date === obj(card.next_fact).date ? "этот отчёт ждёт модель" : ""].filter(Boolean).join(" · ") || null });
  bindRow(tr, entry.slug);
  tbody.append(tr);
  if (open) tbody.append(detailRow(r));
}

function releaseTip(card, fr) {
  const rel = obj(card.release);
  if (!card.ok) return { title: upperFirst(fr.label), note: list(card.errors).join(" · ") || null };
  return {
    title: `Выпуск: ${fr.label}`,
    rows: [["опубликован", fmt.stamp(rel.published_at)], ["оценка на", fmt.date(rel.valuation_date)], ["факты на", fmt.date(rel.facts_date)], ["книга допущений", rel.book_version || "—"]],
    note: [card.stale ? "Витрина модели не отвечает — показан последний принятый выпуск" : null, ...list(obj(card.health).notes).map((n) => n.text)].filter(Boolean).join(" · ") || null,
  };
}

function dividendCell(dv) {
  if (!dv) return el("span", { class: "muted" }, "—");
  if (isNum(dv.from_year)) return el("span", { class: "muted small" }, `с${NBSP}${dv.from_year}`);
  return [isNum(dv.yield) ? fmt.pct(dv.yield, 1) : fmt.rub(dv.dps, 2), el("span", { class: "cell-sub" }, dv.record_date ? `${dv.record_estimated ? "≈" + NBSP : ""}${fmt.monthYear(dv.record_date)}` : "")];
}

function shortStamp(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const p = mskParts(t);
  return `${p.d}${NBSP}${MONTHS_SHORT[p.m]}, ${p.hh}:${p.mm}`;
}

function chevron() {
  return el("span", { class: "chev", "aria-hidden": "true" }, svgEl("svg", { viewBox: "0 0 24 24" }, svgEl("path", { d: "m6 9 6 6 6-6" })));
}

function bindRow(tr, slug) {
  const toggle = () => {
    if (state.expanded.has(slug)) state.expanded.delete(slug); else state.expanded.add(slug);
    hideTip();
    renderBoardOnly();
    const again = document.querySelector(`tr.row[data-slug="${CSS.escape(slug)}"]`);
    if (again) again.focus({ preventScroll: true });
  };
  tr.addEventListener("click", (e) => { if (!(e.target instanceof Element) || !e.target.closest("a, button, input, select")) toggle(); });
  tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
}

/* раскрытая строка */

function detailRow(r) {
  const { entry, card } = r;
  const body = el("div", { class: "detail-body" });
  if (!r.ok) {
    body.append(el("div", { class: "panel", style: { gridColumn: "1 / -1" } }, el("h4", {}, "Нет данных"),
      el("p", { class: "small ink-2" }, "Хаб не получил выпуск ни от витрины модели, ни из запасных источников. Причина:"),
      el("pre", { class: "small", style: { whiteSpace: "pre-wrap", margin: "8px 0 0", fontFamily: "var(--mono)" } }, list(card.errors).join("\n") || "—")));
    body.append(linksRow(entry, card));
    return el("tr", { class: "detail" }, el("td", { colspan: 10 }, body));
  }
  body.append(valuationPanel(card), marketPanel(card), nextPanel(card), historyPanel(card), linksRow(entry, card));
  return el("tr", { class: "detail" }, el("td", { colspan: 10 }, body));
}

/* история оценки: копит хаб (tools/snapshot.mjs), грузится при раскрытии строки */

const histories = new Map();

function loadHistory(slug) {
  if (histories.has(slug)) return histories.get(slug);
  const rec = { status: "loading", data: null };
  histories.set(slug, rec);
  getJson(`/api/history/${encodeURIComponent(slug)}`)
    .then((d) => { rec.status = d && Array.isArray(d.d) ? "ok" : "error"; rec.data = d; })
    .catch(() => { rec.status = "error"; })
    .finally(() => {
      for (const node of document.querySelectorAll(`[data-history="${CSS.escape(slug)}"]`)) node.replaceWith(historyPanel(state.cards.get(slug)));
    });
  return rec;
}

function historyPanel(card) {
  const rec = loadHistory(card.slug);
  const panel = el("div", { class: "panel hist", "data-history": card.slug, style: { gridColumn: "1 / -1" } });
  const head = el("div", { class: "hist-head" }, el("h4", {}, "Медиана и рынок во времени"));
  panel.append(head);
  if (rec.status === "loading") { panel.append(el("span", { class: "shimmer", style: { width: "100%", height: "90px", borderRadius: "10px" } })); return panel; }
  const h = obj(rec.data);
  const n = list(h.d).length;
  if (rec.status !== "ok" || !n) {
    panel.append(el("p", { class: "small muted" }, rec.status === "ok"
      ? "История ещё не началась: хаб записывает медиану, полосы и цену каждой модели дважды в день, первая точка появится после ближайшего снимка."
      : "История сейчас недоступна."));
    return panel;
  }
  const first = h.d[0];
  head.append(el("span", { class: "small muted" }, n < 2 ? `копится с ${fmt.date(first)} · пока ${n} точка` : `${fmt.date(first)} — ${fmt.date(h.d[n - 1])} · ${n} ${plural(n, "точка", "точки", "точек")}`));
  panel.append(responsive((w) => historyChart(h, w)), el("div", { class: "legend", style: { marginTop: "6px" } },
    el("span", {}, el("i", { class: "key key-b80" }), "полоса 80 %"),
    el("span", {}, el("i", { class: "key key-b50" }), "полоса 50 %"),
    el("span", {}, el("i", { class: "key key-line-ink" }), "медиана"),
    el("span", {}, el("i", { class: "key key-line-market" }), "рыночная цена")));
  return panel;
}

function plural(n, one, few, many) {
  const a = n % 100;
  const b = n % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}

function historyChart(h, W) {
  const H = W < 560 ? 150 : 180;
  const M = { l: 52, r: 12, t: 12, b: 26 };
  const n = h.d.length;
  const t = h.d.map((d) => Date.parse(`${d}T00:00:00Z`));
  const vals = [...h.lo80, ...h.hi80, ...h.med, ...h.px].filter(isNum);
  let y0 = Math.min(...vals);
  let y1 = Math.max(...vals);
  const pad = (y1 - y0) * 0.08 || y1 * 0.05 || 1;
  y0 -= pad; y1 += pad;
  const tMin = t[0];
  const tMax = n > 1 ? t[n - 1] : t[0] + 86400000;
  const X = (i) => (n > 1 ? M.l + ((t[i] - tMin) / (tMax - tMin)) * (W - M.l - M.r) : (M.l + W - M.r) / 2);
  const Y = (v) => M.t + (1 - (v - y0) / (y1 - y0)) * (H - M.t - M.b);
  const svg = svgEl("svg", { class: "hist-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `История: медиана ${fmt.price(h.med[n - 1])}, рынок ${fmt.price(h.px[n - 1])} на ${fmt.date(h.d[n - 1])}` });
  for (const v of niceTicks(y0, y1, 4)) {
    svg.append(svgEl("line", { class: "gridline", x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v) }));
    svg.append(svgEl("text", { class: "tick", x: M.l - 8, y: Y(v) + 4, "text-anchor": "end" }, fmt.num(v)));
  }
  const area = (lo, hi, cls) => {
    const idx = [...Array(n).keys()].filter((i) => isNum(lo[i]) && isNum(hi[i]));
    if (!idx.length) return;
    if (idx.length === 1) { const i = idx[0]; svg.append(svgEl("rect", { class: cls, x: X(i) - 5, y: Y(hi[i]), width: 10, height: Math.max(1, Y(lo[i]) - Y(hi[i])), rx: 2 })); return; }
    const top = idx.map((i) => `${X(i).toFixed(1)},${Y(hi[i]).toFixed(1)}`);
    const bottom = idx.slice().reverse().map((i) => `${X(i).toFixed(1)},${Y(lo[i]).toFixed(1)}`);
    svg.append(svgEl("polygon", { class: cls, points: [...top, ...bottom].join(" ") }));
  };
  area(h.lo80, h.hi80, "h-b80");
  area(h.lo50, h.hi50, "h-b50");
  const line = (arr, cls) => {
    const idx = [...Array(n).keys()].filter((i) => isNum(arr[i]));
    if (idx.length > 1) svg.append(svgEl("polyline", { class: cls, points: idx.map((i) => `${X(i).toFixed(1)},${Y(arr[i]).toFixed(1)}`).join(" ") }));
    const last = idx[idx.length - 1];
    if (last !== undefined) svg.append(svgEl("circle", { class: `${cls}-dot`, cx: X(last), cy: Y(arr[last]), r: 4 }));
  };
  line(h.px, "h-px");
  line(h.med, "h-med");
  svg.append(svgEl("text", { class: "tick", x: M.l, y: H - 6 }, fmt.date(h.d[0])));
  if (n > 1) svg.append(svgEl("text", { class: "tick", x: W - M.r, y: H - 6, "text-anchor": "end" }, fmt.date(h.d[n - 1])));
  const step = n > 1 ? (W - M.l - M.r) / (n - 1) : 40;
  for (let i = 0; i < n; i++) {
    const hit = svgEl("rect", { class: "hist-hit", x: X(i) - Math.max(step / 2, 6), y: M.t, width: Math.max(step, 12), height: H - M.t - M.b });
    attachTip(hit, {
      title: fmt.date(h.d[i]),
      rows: [["медиана", fmt.price(h.med[i])], ["полоса 80 %", isNum(h.lo80[i]) ? fmt.range([h.lo80[i], h.hi80[i]]) : "—"], ["рынок", fmt.price(h.px[i])],
        ["потенциал", isNum(h.med[i]) && isNum(h.px[i]) && h.px[i] > 0 ? fmt.signedPct(h.med[i] / h.px[i] - 1) : "—"]],
      note: h.sha[i] ? `выпуск ${h.sha[i]}` : "из журнала модели",
    });
    svg.append(hit);
  }
  return svg;
}

function niceTicks(lo, hi, count) {
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

function valuationPanel(card) {
  const f = obj(card.fair);
  const px = obj(card.price).value;
  const panel = el("div", { class: "panel" }, el("h4", {}, "Оценка модели"),
    el("div", { class: "big-fair" }, el("span", { class: "approx", style: { fontSize: "22px" } }, "≈"), el("span", { class: "v" }, fmt.num(f.printed_median ?? f.median, (f.printed_median ?? f.median) < 1000 && !Number.isInteger(f.printed_median ?? f.median) ? 2 : 0)), el("span", { class: "u" }, "₽")),
    el("p", { class: "small muted" }, `медиана по суждениям книги · точно ${fmt.rub(f.median, f.median < 1000 ? 2 : 0)}${isNum(f.draws) ? ` · ${fmt.num(f.draws)} прогонов` : ""}`),
    distChart(f, px));
  const dl = el("dl", { class: "kv" });
  const kv = (k, v) => dl.append(el("dt", {}, k), el("dd", {}, v));
  kv("Полоса 50 %", fmt.range(f.printed_band50 || f.band50));
  kv("Полоса 80 %", fmt.range(f.printed_band80 || f.band80));
  if (isNum(f.point)) kv("Точка при центральных значениях", fmt.price(f.printed_point ?? f.point));
  if (isNum(f.mean)) kv("Среднее прогонов", fmt.rub(f.mean));
  if (isNum(f.p_below)) kv("P(справедливая < рынка)", fmt.pct(f.p_below));
  if (isNum(f.rates_view_rub)) kv("Вклад своего взгляда на ставки", fmt.signedRub(f.rates_view_rub));
  for (const o of list(card.others)) kv(`К ${o.ticker} (${fmt.price(o.value)})`, `${fmt.signedPct(o.upside)}${isNum(o.p_below) ? ` · P ${fmt.pct(o.p_below)}` : ""}`);
  const worlds = list(card.worlds);
  if (worlds.length) {
    dl.append(el("div", { class: "sep" }));
    for (const w of worlds) kv(el("span", {}, `Мир ${w.key} `, el("span", { class: "muted" }, `· ${w.title}`)), fmt.price(w.price));
  }
  panel.append(dl);
  return panel;
}

// Распределение в рублях: полосы, медиана, точка и рынок — как у героя витрин.
function distChart(f, px) {
  if (!Array.isArray(f.band80) || !isNum(f.median)) return null;
  const pts = [f.band80[0], f.band80[1], f.median, px, f.point].filter(isNum);
  let lo = Math.min(...pts);
  let hi = Math.max(...pts);
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad; hi += pad;
  const x = (v) => ((v - lo) / (hi - lo)) * 100;
  const node = el("div", { class: "dist", role: "img", "aria-label": `Полоса 80 % ${fmt.range(f.band80)}, медиана ${fmt.price(f.median)}, рынок ${fmt.price(px)}` },
    el("i", { class: "b80", style: { left: `${x(f.band80[0])}%`, width: `${x(f.band80[1]) - x(f.band80[0])}%` } }),
    Array.isArray(f.band50) ? el("i", { class: "b50", style: { left: `${x(f.band50[0])}%`, width: `${x(f.band50[1]) - x(f.band50[0])}%` } }) : null,
    isNum(px) ? el("i", { class: "mk", style: { left: `${x(px)}%` } }) : null,
    el("i", { class: "md", style: { left: `${x(f.median)}%` } }),
    isNum(f.point) ? el("i", { class: "pt", style: { left: `${x(f.point)}%` } }) : null,
    isNum(px) ? label("lab mk-lab", x(px), `рынок ${fmt.price(px)}`, 16) : null,
    label("lab end", x(f.band80[0]), fmt.num(f.printed_band80 ? f.printed_band80[0] : f.band80[0]), 8),
    label("lab end", x(f.band80[1]), fmt.num(f.printed_band80 ? f.printed_band80[1] : f.band80[1]), 8));
  return node;
}

// Подпись у края шкалы прижимается к своей метке, а не центрируется за край.
function label(cls, at, text, edge = 6) {
  const shift = at < edge ? "0" : at > 100 - edge ? "-100%" : "-50%";
  return el("span", { class: cls, style: { left: `${at}%`, transform: `translateX(${shift})` } }, text);
}

function marketPanel(card) {
  const price = obj(card.price);
  const m = obj(card.multiples);
  const br = card.brokers;
  const dv = card.dividend;
  const panel = el("div", { class: "panel" }, el("h4", {}, "Рынок"));
  const dl = el("dl", { class: "kv" });
  const kv = (k, v) => dl.append(el("dt", {}, k), el("dd", {}, v));
  kv(`Цена ${price.ticker || ""}`.trim(), fmt.price(price.value));
  kv("На дату", [fmt.date(price.date), price.time ? el("span", { class: "muted" }, ` ${price.time.slice(0, 5)}`) : null]);
  if (price.source || price.status) kv("Источник", el("span", { class: "muted" }, [price.source, price.status === "live" ? "живая" : price.status].filter(Boolean).join(" · ")));
  if (isNum(card.cap)) kv("Капитализация", fmt.bn(card.cap));
  if (isNum(m.pe)) kv("P/E LTM", fmt.mult(m.pe));
  if (isNum(m.pe_fwd)) kv("P/E вперёд", fmt.mult(m.pe_fwd));
  if (isNum(m.ev_ebitda)) kv("EV/EBITDA LTM", fmt.mult(m.ev_ebitda));
  if (isNum(m.pb)) kv("P/B", fmt.mult(m.pb));
  if (isNum(card.yield_ltm)) kv("Дивдоходность LTM", fmt.pct(card.yield_ltm, 1));
  dl.append(el("div", { class: "sep" }));
  if (br) {
    kv("Брокеры: медиана целей", fmt.price(br.median));
    if (isNum(vsBrokers(card))) kv("Медиана модели к ней", fmt.signedPct(vsBrokers(card)));
    if (isNum(br.n) || (isNum(br.min) && isNum(br.max))) kv("Целей · разброс", `${isNum(br.n) ? br.n : "—"} · ${isNum(br.min) && isNum(br.max) ? fmt.range([br.min, br.max], (v) => fmt.rub(v)) : "—"}`);
    if (br.as_of) kv("Сведения на", fmt.date(br.as_of));
    if (br.recs) kv("Покупать / держать / продавать", `${br.recs.buy} / ${br.recs.hold} / ${br.recs.sell}`);
  } else {
    kv("Брокеры", el("span", { class: "muted" }, "в выпуске нет"));
  }
  dl.append(el("div", { class: "sep" }));
  if (dv && isNum(dv.dps)) {
    kv(`Дивиденд${dv.label ? ` ${dv.label}` : ""}`, fmt.rub(dv.dps, 2));
    if (isNum(dv.yield)) kv("Доходность к цене", fmt.pct(dv.yield, 1));
    if (dv.record_date) kv("Отсечка", `${dv.record_estimated ? "≈ " : ""}${fmt.date(dv.record_date)}`);
    kv("Статус", el("span", { class: "muted" }, `${dv.status === "model" ? "по модели, не объявлен" : dv.status}${isNum(dv.p_cancel) ? ` · риск отмены ${fmt.pct(dv.p_cancel)}` : ""}`));
  } else if (dv && isNum(dv.from_year)) {
    kv("Дивиденды", `по модели с ${dv.from_year} г.`);
  } else {
    kv("Дивиденды", el("span", { class: "muted" }, "в выпуске нет"));
  }
  panel.append(dl);
  return panel;
}

function nextPanel(card) {
  const panel = el("div", { class: "panel" }, el("h4", {}, "Дальше"));
  const nf = card.next_fact;
  const today = mskToday();
  const own = list(card.events).filter((e) => e.company === card.slug && e.date >= today).slice(0, 5);
  const ul = el("ul", { class: "ev-list" });
  if (nf && !own.some((e) => e.date === nf.date && e.title === nf.title)) own.push(nf);
  own.sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const e of own.slice(0, 5)) {
    const isFact = nf && e.date === nf.date && e.title === nf.title;
    ul.append(el("li", {}, el("span", { class: "ev-date" }, eventDate(e)),
      el("span", { class: "ev-title" }, e.title, isFact ? el("strong", { style: { color: "var(--model-ink)", fontSize: "12.5px", marginLeft: "6px" } }, "· факт модели") : null)));
  }
  if (!own.length) ul.append(el("li", {}, el("span", { class: "ev-date" }, "—"), el("span", { class: "ev-title muted" }, "в календаре модели нет событий компании")));
  panel.append(ul);

  const rel = obj(card.release);
  const dl = el("dl", { class: "kv", style: { marginTop: "14px" } });
  const kv = (k, v) => dl.append(el("dt", {}, k), el("dd", {}, v));
  dl.append(el("div", { class: "sep" }));
  const fr = freshness(card);
  kv("Выпуск", el("span", { class: "rel" }, el("span", { class: "dot", "data-state": fr.state }), fmt.stamp(rel.published_at)));
  kv("Книга допущений", rel.book_version ? `${rel.book_version}${rel.book_date ? ` от ${fmt.date(rel.book_date)}` : ""}` : "—");
  kv("Оценка на · факты на", `${fmt.date(rel.valuation_date)} · ${fmt.date(rel.facts_date)}`);
  kv("Контракт · выпуск", el("span", { class: "muted" }, `${card.schema || "—"} · ${rel.sha || "—"}`));
  panel.append(dl);
  const notes = list(obj(card.health).notes);
  if (card.stale) notes.unshift({ level: "warn", text: "Витрина модели сейчас не отвечает — показан последний принятый хабом выпуск" });
  if (notes.length) panel.append(el("ul", { class: "notes" }, notes.map((n) => el("li", { class: n.level === "info" ? "info" : "" }, n.text))));
  return panel;
}

function linksRow(entry, card) {
  const screens = list(card.screens).length ? card.screens : DEFAULT_SCREENS;
  return el("div", { class: "links" },
    entry.url ? el("a", { class: "btn", href: modelLink(entry), target: "_blank", rel: "noopener noreferrer" }, `Открыть модель ${entry.name}`, el("span", { "aria-hidden": "true" }, "↗")) : null,
    entry.url ? screens.map((s) => el("a", { class: "link-chip", href: modelLink(entry, s.id), target: "_blank", rel: "noopener noreferrer" }, s.title)) : null);
}

/* ── экран «Карта» ── */

function mapScreen() {
  const all = rows();
  const ok = all.filter((r) => r.ok && isNum(r.card.upside) && Array.isArray(obj(r.card.fair).band80) && isNum(obj(r.card.fair).median) && r.card.fair.median > 0);
  const head = el("div", { class: "screen-head" },
    el("span", { class: "eyebrow" }, "Карта"),
    el("h1", {}, "Потенциал и неопределённость"),
    el("p", {}, "По горизонтали — насколько медиана модели выше или ниже рынка. По вертикали — ширина полосы 80 % относительно медианы: чем ниже точка, тем увереннее модель. Правый нижний угол — разрыв с рынком при узкой полосе; правый верхний — разрыв есть, но модель сама в нём не уверена."));
  const chartCard = el("div", { class: "card" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", {}, "Все модели на одной плоскости"), el("p", { class: "sub" }, "Размер точки — капитализация (логарифмическая шкала); точка ведёт к строке в обзоре.")),
      sectorFilter()),
    ok.length ? responsive((w) => scatter(ok, w)) : el("p", { class: "empty" }, "Нет моделей с оценкой — ждём выпуски."),
    el("div", { class: "legend", style: { marginTop: "10px" } },
      el("span", {}, el("i", { class: "key key-dot" }), "модель (тикер)"),
      el("span", {}, el("i", { class: "key key-market" }), "рынок: медиана = цене")));
  return el("section", { class: "screen" }, head, chartCard, el("div", { class: "section" }, sectorTable(all)));
}

function sectorFilter() {
  const p = state.prefs;
  return el("div", { class: "seg", role: "group", "aria-label": "Отрасль" },
    [["all", "Все"], ...sectors().map(([s]) => [s, s])].map(([key, title]) =>
      el("button", { class: "pill-btn", type: "button", "aria-pressed": String(p.sector === key), onclick: () => { p.sector = key; savePrefs(); render(); } }, title)));
}

function scatter(items, W) {
  const narrow = W < 560;
  const H = Math.round(Math.min(540, Math.max(300, W * 0.52)));
  const M = narrow ? { l: 70, r: 14, t: 24, b: 50 } : { l: 96, r: 28, t: 28, b: 56 };
  const pts = items.map((r) => {
    const f = r.card.fair;
    return { r, x: r.card.upside, y: (f.band80[1] - f.band80[0]) / f.median };
  });
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  let x0 = Math.min(0, ...xs);
  let x1 = Math.max(0, ...xs);
  const xpad = Math.max((x1 - x0) * 0.12, 0.1);
  x0 -= xpad; x1 += xpad;
  const xstep = [0.1, 0.2, 0.25, 0.5, 1].find((s) => (x1 - x0) / s <= (narrow ? 4 : 8)) || 1;
  x0 = Math.floor(x0 / xstep) * xstep; x1 = Math.ceil(x1 / xstep) * xstep;
  let y1 = Math.max(...ys) * 1.12;
  const ystep = [0.1, 0.2, 0.25, 0.5, 1].find((s) => y1 / s <= (narrow ? 4 : 6)) || 1;
  y1 = Math.max(Math.ceil(y1 / ystep) * ystep, ystep);
  const X = (v) => M.l + ((v - x0) / (x1 - x0)) * (W - M.l - M.r);
  const Y = (v) => H - M.b - (v / y1) * (H - M.t - M.b);
  const rOf = (cap) => (isNum(cap) && cap > 0 ? Math.min(16, Math.max(6, 6 + 3.2 * Math.log10(Math.max(cap, 10) / 30))) : 7);

  const svg = svgEl("svg", { class: "map-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Карта: потенциал к рынку по горизонтали, ширина полосы 80 % по вертикали" });
  for (let t = 0; t <= y1 + 1e-9; t += ystep) {
    svg.append(svgEl("line", { class: "gridline", x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t) }));
    svg.append(svgEl("text", { class: "tick", x: M.l - 10, y: Y(t) + 4, "text-anchor": "end" }, fmt.pct(t)));
  }
  for (let t = x0; t <= x1 + 1e-9; t += xstep) {
    const v = Math.round(t * 1000) / 1000;
    if (Math.abs(v) > 1e-9) svg.append(svgEl("line", { class: "gridline", x1: X(v), x2: X(v), y1: M.t, y2: H - M.b }));
    svg.append(svgEl("text", { class: "tick", x: X(v), y: H - M.b + 20, "text-anchor": "middle" }, Math.abs(v) < 1e-9 ? "0" : fmt.signedPct(v)));
  }
  svg.append(svgEl("line", { class: "axisline", x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b }));
  svg.append(svgEl("line", { class: "zero", x1: X(0), x2: X(0), y1: M.t - 6, y2: H - M.b }));
  svg.append(svgEl("text", { class: "zero-label", x: X(0) + 6, y: M.t + 4 }, "рынок"));
  svg.append(svgEl("text", { class: "axis-title", x: (M.l + W - M.r) / 2, y: H - 10, "text-anchor": "middle" }, narrow ? "Потенциал к рынку" : "Потенциал: медиана модели к рыночной цене"));
  svg.append(svgEl("text", { class: "axis-title", x: 16, y: (M.t + H - M.b) / 2, transform: `rotate(-90 16 ${(M.t + H - M.b) / 2})`, "text-anchor": "middle" }, narrow ? "Ширина полосы 80 %" : "Ширина полосы 80 %, % медианы"));
  if (!narrow && x1 > 0.05) svg.append(svgEl("text", { class: "quad", x: W - M.r - 8, y: H - M.b - 10, "text-anchor": "end" }, "выше рынка · узкая полоса"));
  if (!narrow && x1 > 0.05) svg.append(svgEl("text", { class: "quad", x: W - M.r - 8, y: M.t + 14, "text-anchor": "end" }, "выше рынка · широкая полоса"));
  if (!narrow && x0 < -0.05) svg.append(svgEl("text", { class: "quad", x: M.l + 8, y: H - M.b - 10 }, "ниже рынка · узкая полоса"));

  const sector = state.prefs.sector;
  const placed = [];
  pts.sort((a, b) => rOf(b.r.card.cap) - rOf(a.r.card.cap));
  for (const p of pts) {
    const cx = X(p.x);
    const cy = Y(p.y);
    const rad = rOf(p.r.card.cap);
    const dim = sector !== "all" && p.r.entry.sector !== sector;
    const label = list(p.r.entry.tickers)[0] || p.r.entry.name;
    let ly = cy + 4;
    let lx = cx + rad + 5;
    let anchor = "start";
    if (lx + label.length * 8 > W - M.r) { lx = cx - rad - 5; anchor = "end"; }
    for (const q of placed) if (Math.abs(q.y - ly) < 13 && Math.abs(q.x - lx) < 60) ly = q.y + 14;
    placed.push({ x: lx, y: ly });
    svg.append(svgEl("circle", { class: `dot${dim ? " dim" : ""}`, cx, cy, r: rad }));
    svg.append(svgEl("text", { class: `lbl${dim ? " dim" : ""}`, x: lx, y: ly, "text-anchor": anchor }, label));
    const f = p.r.card.fair;
    const hit = svgEl("circle", { class: "hit", cx, cy, r: Math.max(rad + 6, 14), tabindex: "0", role: "link", "aria-label": `${p.r.entry.name}: потенциал ${fmt.signedPct(p.x)}, ширина полосы ${fmt.pct(p.y)}` });
    attachTip(hit, {
      title: `${p.r.entry.name} · ${p.r.entry.sector}`,
      rows: [["потенциал", fmt.signedPct(p.x)], ["медиана · рынок", `${fmt.price(f.printed_median ?? f.median)} · ${fmt.price(p.r.card.price.value)}`],
        ["полоса 80 %", fmt.range(f.printed_band80 || f.band80)], ["ширина полосы", fmt.pct(p.y)], ["P(ниже рынка)", fmt.pct(f.p_below)], ["капитализация", fmt.bn(p.r.card.cap)]],
      note: "Клик — строка модели в обзоре",
    });
    const go = () => { state.expanded.add(p.r.entry.slug); location.hash = `#overview/${p.r.entry.slug}`; };
    hit.addEventListener("click", go);
    hit.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    svg.append(hit);
  }
  return svg;
}

function sectorTable(all) {
  const groups = new Map();
  for (const r of all) { if (!groups.has(r.entry.sector)) groups.set(r.entry.sector, []); groups.get(r.entry.sector).push(r); }
  const tbody = el("tbody", {});
  const order = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length || a.localeCompare(b, "ru"));
  for (const s of order) {
    const g = groups.get(s);
    const ok = g.filter((r) => r.ok);
    const ups = ok.map((r) => r.card.upside).filter(isNum);
    const ps = ok.map((r) => obj(r.card.fair).p_below).filter(isNum);
    const best = ok.filter((r) => isNum(r.card.upside)).sort((a, b) => b.card.upside - a.card.upside)[0];
    tbody.append(el("tr", {},
      el("td", {}, el("strong", {}, s)),
      el("td", { class: "r num" }, String(g.length)),
      el("td", { class: "r num" }, isNum(median(ups)) ? fmt.signedPct(median(ups)) : "—"),
      el("td", { class: "r num" }, ups.length ? `${fmt.signedPct(Math.min(...ups))} … ${fmt.signedPct(Math.max(...ups))}` : "—"),
      el("td", { class: "r num" }, isNum(median(ps)) ? fmt.pct(median(ps)) : "—"),
      el("td", {}, best ? `${best.entry.name} ${fmt.signedPct(best.card.upside)}` : "—")));
  }
  return el("div", { class: "card" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", {}, "По отраслям"), el("p", { class: "sub" }, "Табличный двойник карты: медианы по моделям отрасли."))),
    el("div", { style: { overflowX: "auto" } }, el("table", { class: "data" },
      el("thead", {}, el("tr", {}, el("th", {}, "Отрасль"), el("th", { class: "r" }, "Моделей"), el("th", { class: "r" }, "Медианный потенциал"),
        el("th", { class: "r" }, "Разброс потенциала"), el("th", { class: "r" }, "Медиана P(ниже рынка)"), el("th", {}, "Наибольший разрыв"))),
      tbody)));
}

/* ── экран «Календарь» ── */

function calendarEvents() {
  const today = mskToday();
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + state.prefs.calDays * 86400000).toISOString().slice(0, 10);
  const loaded = new Set(rows().filter((r) => r.ok).map((r) => r.entry.slug));
  const out = new Map();
  for (const r of rows()) {
    if (!r.ok) continue;
    const nf = r.card.next_fact;
    const evs = list(r.card.events).slice();
    if (nf && !evs.some((e) => e.date === nf.date && e.title === nf.title)) evs.push(nf);
    for (const e of evs) {
      if (e.date < today || e.date > horizon) continue;
      if (e.company && e.company !== r.entry.slug && loaded.has(e.company)) continue; // свой календарь у той модели
      const company = e.cls === "macro" ? null : e.company || r.entry.slug;
      const key = e.cls === "macro" ? `${e.date}|macro|${macroTopic(e.title)}` : `${e.date}|${company}|${e.title}`;
      const isFact = Boolean(nf && nf.date === e.date && nf.title === e.title && company === r.entry.slug);
      const prev = out.get(key);
      if (prev) {
        if (!prev.sources.includes(r.entry.name)) prev.sources.push(r.entry.name);
        if (isFact) prev.isFact = true;
        if (e.cls === "macro" && precisionRank(e) > precisionRank(prev)) Object.assign(prev, { precision: e.precision, confirmed: e.confirmed, earliest: e.earliest, latest: e.latest, title: e.title });
        else if (e.cls === "macro" && precisionRank(e) === precisionRank(prev) && e.title.length > prev.title.length) prev.title = e.title;
        continue;
      }
      out.set(key, { ...e, company, sources: [r.entry.name], isFact });
    }
  }
  return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.cls === "macro") - (b.cls === "macro")));
}

function precisionRank(e) {
  return e.precision === "day" && e.confirmed !== false ? 3 : e.precision === "day" ? 2 : e.precision === "window" ? 1 : 0;
}

function macroTopic(title) {
  const t = String(title).toLowerCase();
  if (/ключев|ставк/.test(t) && /заседан|решени|опорн/.test(t)) return "cbr-rate";
  if (/резюме обсуждения/.test(t)) return "cbr-summary";
  return t.replace(/[^a-zа-яё0-9]+/g, " ").trim().slice(0, 40);
}

function calendarScreen() {
  const p = state.prefs;
  const evs = calendarEvents().filter((e) => (p.calCls === "all" || e.cls === p.calCls) && (p.calMinor || !e.minor))
    .filter((e) => p.sector === "all" || e.cls === "macro" || obj(entryOf(e.company)).sector === p.sector);
  const head = el("div", { class: "screen-head" },
    el("span", { class: "eyebrow" }, "Календарь"),
    el("h1", {}, "Что впереди"),
    el("p", {}, "События из календарей всех моделей: отчёты компаний, дивиденды, решения Банка России и другие макро-входы. Повторы между моделями склеены; метка «факт модели» — отчёт, которого модель ждёт для следующего пересчёта."));
  const clsBtns = [["all", "Все"], ["report", "Отчёты"], ["dividend", "Дивиденды"], ["macro", "Макро"], ["corporate", "Компания"]].map(([k, t]) =>
    el("button", { class: "pill-btn", type: "button", "aria-pressed": String(p.calCls === k), onclick: () => { p.calCls = k; savePrefs(); render(); } }, t));
  const daysBtns = [[30, "30 дней"], [90, "90 дней"], [182, "полгода"], [400, "год"]].map(([k, t]) =>
    el("button", { class: "pill-btn", type: "button", "aria-pressed": String(p.calDays === k), onclick: () => { p.calDays = k; savePrefs(); render(); } }, t));
  const minor = el("label", { class: "toggle" }, el("input", { type: "checkbox", checked: p.calMinor, onchange: (e) => { p.calMinor = e.target.checked; savePrefs(); render(); } }), "мелкие: месячные релизы, формы ЦБ");

  const months = new Map();
  for (const e of evs) { const k = e.date.slice(0, 7); if (!months.has(k)) months.set(k, []); months.get(k).push(e); }
  const body = el("div", {});
  if (!evs.length) body.append(el("p", { class: "empty" }, rows().some((r) => r.loading) ? "Загружаем календари моделей…" : "В выбранном окне событий нет."));
  for (const [k, items] of months) {
    const d = parseDay(`${k}-01`);
    body.append(el("div", { class: "cal-month" }, el("h3", {}, `${upperFirst(MONTHS_NOM[d.m])} ${d.y}`), el("ul", { class: "cal-list" }, items.map(calItem))));
  }
  return el("section", { class: "screen" }, head,
    el("div", { class: "card" }, el("div", { class: "card-head" }, el("div", { class: "controls" }, el("div", { class: "seg" }, clsBtns), el("div", { class: "seg" }, daysBtns), minor), sectorFilter()), body));
}

function calItem(e) {
  const d = parseDay(e.date);
  const approx = e.precision !== "day" || e.confirmed === false;
  const n = daysUntil(e.date);
  const entry = e.company ? entryOf(e.company) : null;
  const meta = el("div", { class: "cal-meta" });
  if (entry) meta.append(el("a", { class: "cal-co", href: `#overview/${entry.slug}` }, coIcon(entry), entry.name));
  else meta.append(el("span", {}, "Макро"));
  const note = eventPrecisionNote(e);
  if (note) meta.append(el("span", {}, note));
  if (e.cls === "macro" || (entry && !e.sources.includes(entry.name))) meta.append(el("span", {}, `из моделей: ${e.sources.join(", ")}`));
  return el("li", { class: `cal-item${e.isFact ? " is-fact" : ""}` },
    el("div", { class: `cal-day${approx ? " approx" : ""}` }, el("b", {}, e.precision === "month" ? MONTHS_SHORT[d.m] : String(d.d)), el("span", {}, e.precision === "month" ? "месяц" : WEEKDAYS[new Date(Date.UTC(d.y, d.m, d.d)).getUTCDay()])),
    el("span", { class: `badge ${e.cls}` }, CLS_TITLES[e.cls] || "Событие"),
    el("div", { class: "cal-body" }, el("div", { class: "cal-title" }, e.title), meta),
    el("div", { class: `cal-when${isNum(n) && n <= 7 ? " soon" : ""}` }, countdown(e.date)));
}

/* ── экран «Модели» ── */

function modelsScreen() {
  const all = rows();
  const planned = plannedModels();
  const reg = obj(state.registry);
  const fresh = all.filter((r) => r.ok && freshness(r.card).state === "ok").length;
  const head = el("div", { class: "screen-head" },
    el("span", { class: "eyebrow" }, "Каталог"),
    el("h1", {}, "Модели и их выпуски"),
    el("p", {}, `${modelsWord(all.length)} в хабе${reg.target ? ` из ≈${NBSP}${reg.target} задуманных` : ""}; свежих выпусков — ${fresh}. Выпуск считается устаревшим через ${STALE_HOURS} часов: конвейеры моделей обновляют витрины каждый будний день.`));
  const grid = el("div", { class: "catalog" });
  for (const r of all.slice().sort((a, b) => a.entry.sector.localeCompare(b.entry.sector, "ru") || a.entry.name.localeCompare(b.entry.name, "ru"))) grid.append(modelCard(r));
  for (const m of planned) grid.append(plannedCard(m));
  return el("section", { class: "screen" }, head, grid, howTo());
}

function modelCard(r) {
  const { entry, card } = r;
  const fr = freshness(card);
  const rel = obj(card.release);
  const f = obj(card.fair);
  const node = el("div", { class: "card mcard" },
    el("div", { class: "mcard-top" }, coIcon(entry),
      el("div", { class: "mcard-title" }, el("b", {}, entry.name), el("span", { class: "co-meta" }, el("span", { class: "tick" }, list(entry.tickers).join(" · ")), ` · ${entry.sector}`)),
      el("span", { class: "state" }, el("span", { class: "dot", "data-state": fr.state }), stateWord(fr.state))));
  if (r.ok) {
    node.append(el("div", { class: "mcard-fig" }, el("span", { class: "v" }, `≈${NBSP}${fmt.price(f.printed_median ?? f.median)}`), upsidePill(card.upside), el("span", { class: "muted small" }, `рынок ${fmt.price(obj(card.price).value)}`)));
    const dl = el("dl", { class: "kv" });
    const kv = (k, v) => dl.append(el("dt", {}, k), el("dd", {}, v));
    kv("Выпуск", fmt.stamp(rel.published_at));
    kv("Книга", rel.book_version || "—");
    kv("Факты на", fmt.date(rel.facts_date));
    kv("Ждёт отчёт", card.next_fact ? eventDate(card.next_fact) : "—");
    kv("Контракт", el("span", { class: "muted" }, card.schema || "—"));
    node.append(dl);
    const notes = list(obj(card.health).notes).filter((n) => n.level === "warn");
    if (notes.length || card.stale) node.append(el("ul", { class: "notes", style: { marginTop: "0" } }, [card.stale ? el("li", {}, "Витрина не отвечает — последний принятый выпуск") : null, ...notes.map((n) => el("li", {}, n.text))]));
  } else if (r.loading) {
    node.append(el("span", { class: "shimmer", style: { width: "60%" } }));
  } else {
    node.append(el("p", { class: "down-note" }, "Нет данных: витрина модели и запасные источники не ответили."));
  }
  if (entry.note) node.append(el("p", { class: "small muted" }, entry.note));
  node.append(linksRow(entry, card));
  return node;
}

function plannedCard(m) {
  return el("div", { class: "card mcard is-planned" },
    el("div", { class: "mcard-top" }, coIcon(m),
      el("div", { class: "mcard-title" }, el("b", {}, m.name), el("span", { class: "co-meta" }, el("span", { class: "tick" }, list(m.tickers).join(" · ")), m.tickers && m.tickers.length ? " · " : "", m.sector)),
      el("span", { class: "state" }, el("span", { class: "dot", "data-state": "planned" }), "в работе")),
    el("p", { class: "small muted" }, m.note || (m.added ? `в планах с ${fmt.date(m.added)}` : "модель ещё строится")));
}

function stateWord(s) {
  return { ok: "свежий", warn: "внимание", stale: "устарел", down: "нет связи", loading: "загрузка", planned: "в работе" }[s] || s;
}

function howTo() {
  return el("details", { class: "card howto" },
    el("summary", { style: { cursor: "pointer", fontWeight: "620" } }, "Как добавить новую модель в хаб"),
    el("ol", {},
      el("li", {}, "Опубликуйте дашборд модели как обычно — у него должна быть дверь данных ", el("code", {}, "/api/model"), "."),
      el("li", {}, "Добавьте запись в ", el("code", {}, "registry.json"), " репозитория хаба (ветка main):"),
      el("li", { style: { listStyle: "none", marginLeft: "-20px" } }, el("pre", {}, `{
  "slug": "gazp",
  "name": "Газпром",
  "tickers": ["GAZP"],
  "sector": "Нефть и газ",
  "url": "https://tzi-850-gazp.pages.dev",
  "aliases": ["Газпром"],
  "status": "live"
}`)),
      el("li", {}, "Хаб читает реестр с GitHub — строка появится в течение ~5 минут, без перевыкладки. Пока модель строится, можно поставить ", el("code", {}, "\"status\": \"planned\""), " — она будет видна в каталоге как «в работе».")));
}

/* ── каркас: вкладки, шапка, тема ── */

function render() {
  const app = $("#app");
  if (!app || !state.registry) return;
  const scrollY = window.scrollY;
  const focusSlug = document.activeElement && document.activeElement.closest ? (document.activeElement.closest("tr.row") || {}).dataset : null;
  const screen = state.screen === "map" ? mapScreen() : state.screen === "calendar" ? calendarScreen() : state.screen === "models" ? modelsScreen() : overviewScreen();
  app.replaceChildren(screen);
  for (const tab of document.querySelectorAll(".tab")) {
    const sel = tab.dataset.screen === state.screen;
    tab.setAttribute("aria-selected", String(sel));
    tab.tabIndex = sel ? 0 : -1;
  }
  statusChip();
  colophon();
  window.scrollTo(0, scrollY);
  if (focusSlug && focusSlug.slug) {
    const again = document.querySelector(`tr.row[data-slug="${CSS.escape(focusSlug.slug)}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}

function statusChip() {
  const chip = $("#status-chip");
  if (!chip) return;
  const all = rows();
  const states = all.map((r) => freshness(r.card).state);
  const loading = states.filter((s) => s === "loading").length;
  const bad = states.filter((s) => s === "down" || s === "stale").length;
  const warn = states.filter((s) => s === "warn").length;
  chip.dataset.state = loading ? "loading" : bad ? "stale" : warn ? "warn" : "ok";
  const latest = all.filter((r) => r.ok).map((r) => Date.parse(obj(r.card.release).published_at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const text = loading ? `загружаем ${loading} из ${all.length}…`
    : bad ? `${bad} без свежих данных` : warn ? `${warn} с предупреждениями` : "все выпуски свежие";
  $(".chip-text", chip).replaceChildren(
    el("span", { class: "chip-short" }, loading ? "загрузка…" : modelsWord(all.length)),
    el("span", { class: "chip-long" }, `${loading ? "" : `${modelsWord(all.length)} · `}${text}`),
    latest && !loading ? el("span", { class: "chip-extra" }, ` · последний выпуск ${shortStamp(new Date(latest).toISOString())}`) : null);
  chip.setAttribute("aria-label", `${text}. Свежесть выпусков — экран «Модели»`);
  chip.title = "Свежесть выпусков — экран «Модели»";
}

function colophon() {
  const node = $("#colophon");
  if (!node) return;
  const reg = obj(state.registry);
  const loaded = state.loadedAt ? `данные собраны ${shortStamp(new Date(state.loadedAt).toISOString())} МСК` : "данные загружаются";
  node.textContent = `Модели 850 · хаб справедливых стоимостей · ${modelsWord(liveModels().length)} · реестр: ${reg.source === "live" ? "живой (GitHub)" : "вшитый в выкладку"} · ${loaded}. Числа — из выпусков моделей; потенциал — медиана модели к рыночной цене выпуска.`;
}

function fatal(title, detail) {
  $("#app").replaceChildren(el("div", { class: "fatal" }, el("h1", {}, title), el("p", {}, "Обновите страницу через минуту; если не помогает — проверьте реестр и функции хаба."), detail ? el("pre", {}, detail) : null));
  const chip = $("#status-chip");
  if (chip) { chip.dataset.state = "stale"; $(".chip-text", chip).textContent = "данные недоступны"; }
}

function readHash() {
  const [screen, slug] = String(location.hash || "").replace(/^#/, "").split("/");
  state.screen = SCREENS.includes(screen) ? screen : "overview";
  if (slug && state.screen === "overview") state.expanded.add(slug);
  return slug || null;
}

function onHash() {
  const slug = readHash();
  render();
  if (slug) {
    const row = document.querySelector(`tr.row[data-slug="${CSS.escape(slug)}"]`);
    if (row) { row.scrollIntoView({ block: "center", behavior: "smooth" }); row.focus({ preventScroll: true }); }
  } else {
    window.scrollTo(0, 0);
  }
}

function bindTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => { if (location.hash !== `#${tab.dataset.screen}`) location.hash = `#${tab.dataset.screen}`; else onHash(); });
    tab.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(tab);
      const to = e.key === "ArrowRight" ? tabs[(i + 1) % tabs.length] : e.key === "ArrowLeft" ? tabs[(i - 1 + tabs.length) % tabs.length] : null;
      if (to) { e.preventDefault(); to.focus(); to.click(); }
    });
  }
}

function bindTheme() {
  const btn = $("#theme-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    if (window.__theme) window.__theme.remember(next);
  });
}

function bindRefresh() {
  const btn = $("#refresh");
  if (btn) btn.addEventListener("click", () => loadAll(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.loadedAt && Date.now() - state.loadedAt > AUTO_REFRESH_MIN * 60000) loadAll(true);
  });
}

function boot() {
  readHash();
  bindTabs();
  bindTheme();
  bindRefresh();
  bindTips();
  window.addEventListener("hashchange", onHash);
  loadAll(false).then(() => {
    const slug = readHash();
    if (slug) onHash();
  });
}

boot();
