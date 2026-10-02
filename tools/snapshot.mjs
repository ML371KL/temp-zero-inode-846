#!/usr/bin/env node
/**
 * Снимок истории оценок: для каждой модели реестра — медиана, полосы, точка и
 * цена её текущего выпуска в файл <dir>/<slug>.json (functions/_lib/history.js).
 *
 * Запуск — .github/workflows/snapshot.yml дважды в день (каталог — рабочая
 * копия ветки `history`). Вручную:
 *     node tools/snapshot.mjs --dir history
 *     node tools/snapshot.mjs --dir history --from-dir payloads   # выпуски из файлов <slug>.json
 *
 * Код чтения и сводки — тот же, что у функций хаба (functions/_lib/*): хаб и
 * история видят выпуск одинаково. Модель без ответа пропускается, её история
 * не трогается; код выхода 0, если записана хотя бы одна модель.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRegistry } from "../functions/_lib/registry.js";
import { fetchPayload } from "../functions/_lib/sources.js";
import { summarize } from "../functions/_lib/summarize.js";
import { emptyHistory, historyProblem, mergeHistory, rowFromCard, rowsFromPayload } from "../functions/_lib/history.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    return null;
  }
}

async function main() {
  const dir = path.resolve(arg("--dir", "history"));
  const fromDir = arg("--from-dir");
  const registry = normalizeRegistry(JSON.parse(await fs.readFile(path.join(root, "registry.json"), "utf8")));
  const others = registry.models.map((m) => ({ slug: m.slug, aliases: m.aliases }));
  await fs.mkdir(dir, { recursive: true });

  let written = 0;
  for (const entry of registry.models.filter((m) => m.status === "live")) {
    let payload = null;
    if (fromDir) {
      payload = await readJson(path.join(path.resolve(fromDir), `${entry.slug}.json`));
    } else {
      const result = await fetchPayload(entry);
      if (result.ok) payload = result.data;
      else console.error(`${entry.slug}: нет выпуска (${result.errors.join("; ")})`);
    }
    if (!payload) continue;
    let card;
    try {
      card = summarize(entry, payload, { others });
    } catch (error) {
      console.error(`${entry.slug}: сводка не собралась (${error.message})`);
      continue;
    }
    const file = path.join(dir, `${entry.slug}.json`);
    const prev = await readJson(file);
    const base = prev && !historyProblem(prev, entry.slug) ? prev : emptyHistory(entry.slug);
    const rows = [...rowsFromPayload(payload, card.ticker), rowFromCard(card)];
    const next = mergeHistory(base, entry.slug, rows);
    await fs.writeFile(file, `${JSON.stringify(next)}\n`);
    written += 1;
    console.log(`${entry.slug}: ${next.d.length} строк, последняя ${next.d[next.d.length - 1]} (медиана ${card.fair.median}, рынок ${card.price.value})`);
  }
  // Оглавление — по всем файлам каталога: модель, не ответившая сейчас, в нём остаётся.
  const index = [];
  for (const name of (await fs.readdir(dir)).filter((n) => n.endsWith(".json") && n !== "index.json").sort()) {
    const h = await readJson(path.join(dir, name));
    if (h && Array.isArray(h.d)) index.push({ slug: h.slug, rows: h.d.length, first: h.d[0] || null, last: h.d[h.d.length - 1] || null });
  }
  await fs.writeFile(path.join(dir, "index.json"), `${JSON.stringify({ updated_at: new Date().toISOString(), models: index }, null, 1)}\n`);
  if (!written) {
    console.error("ни одной модели не записано");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
