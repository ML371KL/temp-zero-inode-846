#!/usr/bin/env node
/**
 * Урезает выпуск модели до полей, которые читает хаб (functions/_lib/summarize.js,
 * functions/_lib/history.js), — фикстура тестов весит килобайты, а не сотни КБ.
 *
 *     node tools/trim-fixture.mjs <выпуск.json> > tests/fixtures/<slug>.json
 */

import fs from "node:fs";

const src = process.argv[2];
if (!src) {
  console.error("usage: node tools/trim-fixture.mjs <payload.json>");
  process.exit(2);
}
const d = JSON.parse(fs.readFileSync(src, "utf8"));
const pick = (o, keys) => (o && typeof o === "object" ? Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])) : undefined);
const drop = (o, keys) => (o && typeof o === "object" ? Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))) : undefined);

const fv = d.fair_value || {};
const out = {
  schema: d.schema,
  meta: drop(d.meta, ["engine_commit"]),
  market: drop(d.market, ["price_history", "peers", "peers_same_base"]),
  fair_value: {
    ...pick(fv, ["method", "low", "central", "high", "printed", "printed_low", "printed_central", "printed_high", "rates_view", "by_world", "ev_comparison"]),
    headline: drop(fv.headline, ["low_draws", "high_draws", "contributions", "by_lambda", "quantiles", "v0"]),
  },
  headline: d.headline,
  worlds: d.worlds && Object.fromEntries(Object.entries(d.worlds).map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? pick(v, ["title", "name"]) : v])),
  dividends: pick(d.dividends, ["next_expected", "yield_ltm", "dividends_from_year"]),
  calendar: d.calendar,
  checks: pick(d.checks, ["flags", "invariants_broken"]),
  live: pick(d.live, ["degraded", "degraded_flag", "errors", "price_reference_date"]),
  next_report: pick(d.next_report, ["period", "closing", "events"]),
  valuation_history: d.valuation_history,
  book: pick(d.book, ["version", "date"]),
};
for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
