/**
 * Чтение выпуска модели и вкладок её дашборда.
 *
 * Основной путь — публичная дверь данных самой модели `<url>/api/model`
 * (у каждой витрины семейства она одна и та же). Запасные — адреса `data`
 * из реестра (raw/Pages репозитория данных модели): если витрина модели
 * лежит, хаб всё равно покажет её последний выпуск. Ответ принимается после
 * строгой проверки: JSON-объект с `meta` и оценкой, иначе — сбой источника.
 */

const UPSTREAM_TIMEOUT_MS = 8000;
const SCREENS_TIMEOUT_MS = 4000;
const MAX_PAYLOAD_BYTES = 3 * 1024 * 1024;
export const USER_AGENT = "tzi-846-hub/1.0";

/** { ok, data, source, url } или { ok:false, errors:[…] }. */
export async function fetchPayload(entry) {
  const urls = [`${entry.url}/api/model`, ...entry.data];
  const errors = [];
  for (const [i, url] of urls.entries()) {
    const result = await fetchRelease(url);
    if (result.ok) return { ok: true, data: result.data, source: i === 0 ? "model" : "data", url };
    errors.push(`${i === 0 ? "model" : `data#${i}`}: ${result.detail}`);
  }
  return { ok: false, errors };
}

async function fetchRelease(url) {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      cf: { cacheTtl: 60 },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, detail: `http ${response.status}` };
    const text = await response.text();
    if (text.length > MAX_PAYLOAD_BYTES) return { ok: false, detail: "too large" };
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return { ok: false, detail: "bad json" };
    }
    const why = releaseProblem(data);
    return why ? { ok: false, detail: why } : { ok: true, data };
  } catch (error) {
    const name = error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : String((error && error.name) || error);
    return { ok: false, detail: name.slice(0, 80) };
  }
}

/** Похоже ли на выпуск модели семейства: null — да, иначе причина. */
export function releaseProblem(data) {
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObj(data)) return "not an object";
  if (typeof data.schema !== "string") return "no schema";
  if (!isObj(data.meta)) return "no meta";
  if (!isObj(data.fair_value) && !isObj(data.headline)) return "no valuation";
  return null;
}

/** Вкладки дашборда модели из его index.html: [{ id, title }] (для глубоких ссылок). */
export async function fetchScreens(entry) {
  try {
    const response = await fetch(`${entry.url}/`, {
      headers: { accept: "text/html", "user-agent": USER_AGENT },
      cf: { cacheTtl: 3600 },
      signal: AbortSignal.timeout(SCREENS_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    return parseScreens(await response.text());
  } catch (error) {
    return [];
  }
}

export function parseScreens(html) {
  const out = [];
  const re = /<button\b[^>]*\bdata-screen="([a-z0-9_-]{1,32})"[^>]*>([^<]{1,60})<\/button>/gi;
  let m;
  while ((m = re.exec(String(html))) && out.length < 12) {
    const title = m[2].replace(/\s+/g, " ").trim();
    if (title && !out.some((s) => s.id === m[1])) out.push({ id: m[1], title });
  }
  return out;
}
