/**
 * История оценок хаба: по файлу на модель, столбцами (компактно).
 *
 *   { v: 1, slug, updated_at,
 *     d:   ["2026-10-01", …]   день выпуска по Москве (за день — последний выпуск),
 *     sha: ["f840111380eb", …] выпуск (12 знаков) или null для импортированной строки,
 *     med, lo80, hi80, lo50, hi50, pt, px: [числа | null, …] }
 *
 * Пишет её tools/snapshot.mjs (GitHub Actions, ветка `history`), читает
 * /api/history/<slug>. Правило прореживания — как журнал выпусков Сбера:
 * последняя строка дня; старше 180 дней — недели; старше двух лет — месяцы;
 * не больше 400 строк.
 */

export const HISTORY_VERSION = 1;
const COLS = ["d", "sha", "med", "lo80", "hi80", "lo50", "hi50", "pt", "px"];
const MAX_ROWS = 400;

export function emptyHistory(slug) {
  const h = { v: HISTORY_VERSION, slug, updated_at: null };
  for (const c of COLS) h[c] = [];
  return h;
}

export function historyRows(h) {
  const n = Array.isArray(h && h.d) ? h.d.length : 0;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const row = {};
    for (const c of COLS) row[c] = Array.isArray(h[c]) && i < h[c].length ? h[c][i] : null;
    if (typeof row.d === "string") rows.push(row);
  }
  return rows;
}

function fromRows(slug, rows, updatedAt) {
  const h = emptyHistory(slug);
  h.updated_at = updatedAt;
  for (const r of rows) for (const c of COLS) h[c].push(r[c] ?? null);
  return h;
}

const r2 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// День выпуска по Москве — ключ строки (как в журнале выпусков Сбера): за день
// остаётся последний выпуск.
function mskDay(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 3 * 3600 * 1000).toISOString().slice(0, 10) : null;
}

/** Строка истории из сводной карточки (functions/_lib/summarize.js). */
export function rowFromCard(card) {
  const f = card.fair || {};
  const b80 = f.band80 || [null, null];
  const b50 = f.band50 || [null, null];
  const rel = card.release || {};
  return {
    d: mskDay(rel.published_at) || rel.valuation_date || (card.price && card.price.date) || null,
    sha: (card.release && card.release.sha) || null,
    med: r2(f.median), lo80: r2(b80[0]), hi80: r2(b80[1]), lo50: r2(b50[0]), hi50: r2(b50[1]),
    pt: r2(f.point), px: r2(card.price && card.price.value),
  };
}

/** Строки из собственного журнала модели (valuation_history у Сбера), если он есть. */
export function rowsFromPayload(payload, ticker) {
  const vh = payload && payload.valuation_history;
  if (!vh || !Array.isArray(vh.date)) return [];
  const price = Array.isArray(vh.price) ? vh.price : vh.price && ticker && Array.isArray(vh.price[ticker]) ? vh.price[ticker] : [];
  const at = (arr, i) => (Array.isArray(arr) ? r2(arr[i]) : null);
  return vh.date.map((d, i) => ({
    d: typeof d === "string" ? d.slice(0, 10) : null,
    sha: Array.isArray(vh.sha) && typeof vh.sha[i] === "string" ? vh.sha[i].slice(0, 12) : null,
    med: at(vh.median, i), lo80: at(vh.p10, i), hi80: at(vh.p90, i), lo50: at(vh.p25, i), hi50: at(vh.p75, i),
    pt: at(vh.point, i), px: r2(price[i]),
  })).filter((r) => r.d && r.med !== null);
}

/** Добавляет строки: одна строка на дату (новая заменяет прежнюю), затем прореживание. */
export function mergeHistory(h, slug, newRows, now = new Date()) {
  const byDate = new Map(historyRows(h).map((r) => [r.d, r]));
  for (const r of newRows) {
    if (!r || !r.d || r.med === null) continue;
    const prev = byDate.get(r.d);
    // Импорт из журнала модели не затирает строку, записанную хабом с выпуска.
    if (prev && prev.sha && !r.sha) continue;
    byDate.set(r.d, { ...r });
  }
  const rows = thin([...byDate.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0)), now);
  return fromRows(slug, rows, now.toISOString());
}

function thin(rows, now) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const age = (d) => (today - Date.parse(`${d}T00:00:00Z`)) / 86400000;
  const keyOf = (d) => {
    const a = age(d);
    if (a > 730) return `m:${d.slice(0, 7)}`;
    if (a > 180) {
      const t = new Date(`${d}T00:00:00Z`);
      const monday = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86400000);
      return `w:${monday.toISOString().slice(0, 10)}`;
    }
    return `d:${d}`;
  };
  const last = new Map();
  for (const r of rows) last.set(keyOf(r.d), r);
  const out = [...last.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
  return out.slice(-MAX_ROWS);
}

/** Годна ли история к отдаче браузеру: null — да, иначе причина. */
export function historyProblem(h, slug) {
  if (!h || typeof h !== "object" || Array.isArray(h)) return "not an object";
  if (h.v !== HISTORY_VERSION) return "version";
  if (h.slug !== slug) return "slug";
  if (!Array.isArray(h.d) || COLS.some((c) => !Array.isArray(h[c]) || h[c].length !== h.d.length)) return "columns";
  return null;
}
