/**
 * Реестр моделей — единственный список того, что показывает хаб.
 *
 * Источник правды — `registry.json` в корне репозитория. Он вшит в сборку
 * функций (запасной путь) и, если задана переменная REGISTRY_URL, читается
 * ещё и «живым» с GitHub: новая модель появляется в хабе через ~5 минут после
 * коммита в основную ветку, даже без новой выкладки. Битый или недоступный живой
 * реестр не роняет хаб — берётся вшитый.
 *
 * Запись модели (обязательные поля — slug, name, url):
 *   slug     латиница/цифры/дефис, ≤ 40 — ключ в адресах /api/card/<slug>;
 *   name     имя компании на витрине;
 *   tickers  тикеры, первый — основной (его цена — «рынок» строки);
 *   sector   отрасль — группы и фильтр хаба;
 *   url      адрес дашборда модели (https), у которого есть дверь /api/model;
 *   aliases  как компанию называют в заголовках событий чужих календарей;
 *   data     запасные адреса того же выпуска (raw/Pages репозитория данных);
 *   status   live | planned (planned — строка «в работе», без данных);
 *   added    дата появления в хабе (ГГГГ-ММ-ДД), необязательно;
 *   note     короткая пометка для каталога, необязательно;
 *   mark     знак компании на плитке, 1–3 символа («С», «X5»); нет — первые
 *            две буквы основного тикера;
 *   color    цвет плитки, с которым компанию узнают (#rrggbb); нет — нейтральная;
 *   ink      цвет знака (#rrggbb); нет — белый или чёрный по контрасту с плиткой.
 */

import bundled from "../../registry.json" with { type: "json" };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const LIVE_TIMEOUT_MS = 4000;
const LIVE_CACHE_SECONDS = 300;

/** Приводит сырой реестр к проверенному виду; негодные записи отбрасываются. */
export function normalizeRegistry(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.models)) throw new Error("registry: no models[]");
  const seen = new Set();
  const models = [];
  const rejected = [];
  for (const item of raw.models) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.slug)) {
      rejected.push(item && typeof item === "object" ? String(item.slug || item.name || "?").slice(0, 40) : "?");
      continue;
    }
    seen.add(entry.slug);
    models.push(entry);
  }
  if (!models.length) throw new Error("registry: empty");
  const target = Number.isFinite(raw.target) && raw.target > 0 ? Math.round(raw.target) : null;
  return { title: str(raw.title) || "Модели 850", target, models, rejected };
}

function normalizeEntry(item) {
  if (!item || typeof item !== "object") return null;
  const slug = str(item.slug);
  const name = str(item.name);
  const status = item.status === "planned" ? "planned" : "live";
  if (!slug || !SLUG_RE.test(slug) || !name) return null;
  const url = httpsUrl(item.url);
  if (status === "live" && !url) return null;
  const tickers = list(item.tickers).map(str).filter((t) => t && /^[A-Z0-9.]{1,12}$/.test(t));
  const aliases = list(item.aliases).map(str).filter((a) => a && a.length <= 40);
  if (!aliases.includes(name)) aliases.unshift(name);
  return {
    slug,
    name: name.slice(0, 60),
    tickers,
    sector: (str(item.sector) || "Прочее").slice(0, 40),
    url: url ? url.replace(/\/+$/, "") : null,
    aliases,
    data: list(item.data).map(httpsUrl).filter(Boolean).slice(0, 3),
    status,
    added: DATE_RE.test(str(item.added) || "") ? item.added : null,
    note: str(item.note) ? String(item.note).slice(0, 200) : null,
    mark: str(item.mark) && [...str(item.mark)].length <= 3 ? str(item.mark) : null,
    color: hex(item.color),
    ink: hex(item.ink),
  };
}

/** Реестр: живой (REGISTRY_URL) или вшитый. Возвращает { ...registry, source }. */
export async function loadRegistry(env) {
  const liveUrl = httpsUrl(env && env.REGISTRY_URL);
  if (liveUrl) {
    try {
      const response = await fetch(liveUrl, {
        headers: { accept: "application/json", "user-agent": "tzi-846-hub/1.0" },
        cf: { cacheTtl: LIVE_CACHE_SECONDS, cacheEverything: true },
        signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
      });
      if (response.ok) return { ...normalizeRegistry(JSON.parse(await response.text())), source: "live" };
    } catch (error) {
      /* живой реестр недоступен или битый — ниже вшитый */
    }
  }
  return { ...normalizeRegistry(bundled), source: "bundled" };
}

function str(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function hex(value) {
  const s = str(value);
  return s && HEX_RE.test(s) ? s.toLowerCase() : null;
}

function httpsUrl(value) {
  const s = str(value);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.pathname === "/" && !u.search ? u.origin : u.toString();
  } catch (error) {
    return null;
  }
}
