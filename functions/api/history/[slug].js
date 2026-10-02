/**
 * GET /api/history/<slug> — история медианы, полос и цены модели, которую
 * копит хаб (tools/snapshot.mjs → ветка `history` репозитория хаба).
 *
 * Источник — HISTORY_BASE_URL (raw ветки history) + `<slug>.json`, кэш края
 * 10 минут. Файла ещё нет (модель новая, снимков не было) — 200 с пустой
 * историей: это не ошибка, история копится с первого снимка.
 */

import { loadRegistry } from "../../_lib/registry.js";
import { emptyHistory, historyProblem } from "../../_lib/history.js";
import { USER_AGENT } from "../../_lib/sources.js";

const TTL = 600;
const MAX_BYTES = 512 * 1024;

export async function onRequestGet({ env, params }) {
  const slug = String(params.slug || "");
  const registry = await loadRegistry(env);
  if (!registry.models.some((m) => m.slug === slug)) return json(404, { error: "unknown model", slug });
  const base = typeof env.HISTORY_BASE_URL === "string" && /^https:\/\//.test(env.HISTORY_BASE_URL) ? env.HISTORY_BASE_URL.replace(/\/?$/, "/") : null;
  if (!base) return json(200, { ...emptyHistory(slug), note: "history not configured" });
  try {
    const response = await fetch(`${base}${slug}.json`, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      cf: { cacheTtl: TTL, cacheEverything: true },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) return json(200, { ...emptyHistory(slug), note: "no snapshots yet" });
    if (!response.ok) return json(502, { error: `history http ${response.status}` });
    const text = await response.text();
    if (text.length > MAX_BYTES) return json(502, { error: "history too large" });
    const data = JSON.parse(text);
    const why = historyProblem(data, slug);
    if (why) return json(502, { error: `history ${why}` });
    return json(200, data, TTL);
  } catch (error) {
    return json(502, { error: `history ${String((error && error.name) || error).slice(0, 60)}` });
  }
}

function json(status, body, maxAge = 60) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": `private, max-age=${status === 200 ? maxAge : 0}` },
  });
}
