/**
 * GET /api/card/<slug> — сводная карточка одной модели.
 *
 * По запросу на модель, а не один на все: так каждый вызов делает 1–3
 * подзапроса и разбирает один выпуск (≈ 1–2 мс CPU) — укладывается в лимиты
 * бесплатного тарифа и при 60 моделях; браузер просит карточки параллельно.
 *
 * Порядок: свежая карточка из кэша края (CARD_TTL) → выпуск модели
 * (functions/_lib/sources.js) → сводка (functions/_lib/summarize.js) →
 * в кэш свежей и «последней годной» (30 дней). Модель недоступна — последняя
 * годная карточка с `stale: true`; нет и её — `ok: false` с причиной (502).
 */

import { loadRegistry } from "../../_lib/registry.js";
import { fetchPayload, fetchScreens } from "../../_lib/sources.js";
import { summarize, CARD_VERSION } from "../../_lib/summarize.js";

const CARD_TTL = 120;
const LAST_GOOD_TTL = 30 * 24 * 3600;

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const slug = String(params.slug || "");
  const registry = await loadRegistry(env);
  const entry = registry.models.find((m) => m.slug === slug);
  if (!entry) return json(404, { ok: false, slug, error: "unknown model" });
  if (entry.status === "planned") return json(200, base(entry, { ok: false, planned: true }), 300);

  const cache = edgeCache();
  const freshKey = cacheKey(request, "card", slug);
  const lastKey = cacheKey(request, "last", slug);
  const hit = cache ? await cache.match(freshKey).catch(() => null) : null;
  if (hit) return json(200, { ...(await hit.json()), cache: "edge" });

  const others = registry.models.map((m) => ({ slug: m.slug, aliases: m.aliases }));
  const [payload, screens] = await Promise.all([fetchPayload(entry), fetchScreens(entry)]);
  if (payload.ok) {
    let card;
    try {
      card = summarize(entry, payload.data, { others, screens });
    } catch (error) {
      return failure(context, cache, lastKey, entry, [`summarize: ${String(error && error.message).slice(0, 120)}`]);
    }
    card.source = payload.source;
    card.fetched_at = new Date().toISOString();
    if (cache) {
      const text = JSON.stringify(card);
      const save = Promise.all([
        cache.put(freshKey, cached(text, CARD_TTL)),
        cache.put(lastKey, cached(text, LAST_GOOD_TTL)),
      ]).catch(() => {});
      if (typeof context.waitUntil === "function") context.waitUntil(save);
    }
    return json(200, card);
  }
  return failure(context, cache, lastKey, entry, payload.errors);
}

async function failure(context, cache, lastKey, entry, errors) {
  const last = cache ? await cache.match(lastKey).catch(() => null) : null;
  if (last) return json(200, { ...(await last.json()), stale: true, errors, cache: "last-good" });
  return json(502, base(entry, { ok: false, errors }));
}

function base(entry, extra) {
  return {
    v: CARD_VERSION,
    slug: entry.slug,
    name: entry.name,
    tickers: entry.tickers,
    ticker: entry.tickers[0] || null,
    sector: entry.sector,
    url: entry.url,
    ...extra,
  };
}

function edgeCache() {
  return typeof caches !== "undefined" && caches.default ? caches.default : null;
}

function cacheKey(request, kind, slug) {
  return new Request(new URL(`/__hub-cache/${kind}/${slug}?v=${CARD_VERSION}`, request.url).toString());
}

function cached(text, ttl) {
  return new Response(text, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": `max-age=${ttl}` } });
}

function json(status, body, maxAge = 60) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": `private, max-age=${status === 200 ? maxAge : 0}` },
  });
}
