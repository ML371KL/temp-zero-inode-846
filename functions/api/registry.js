/**
 * GET /api/registry — список моделей хаба (реестр без служебных адресов).
 * Источник — живой реестр с GitHub или вшитый (functions/_lib/registry.js);
 * откуда взят — поле `source`.
 */

import { loadRegistry } from "../_lib/registry.js";

export async function onRequestGet({ env }) {
  const registry = await loadRegistry(env);
  const body = {
    title: registry.title,
    target: registry.target,
    source: registry.source,
    rejected: registry.rejected,
    models: registry.models.map(({ data, ...rest }) => rest),
  };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=60" },
  });
}
