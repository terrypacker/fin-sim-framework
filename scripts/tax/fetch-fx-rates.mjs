#!/usr/bin/env node
/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * fetch-fx-rates.mjs — refresh the pinned daily exchange-rate series in `rates/`.
 *
 * The series is committed to the repo on purpose (see `rates/README.md`): a §988
 * calculation reconciles to a filed return, and a rate source that moves under you is
 * not a source. This script exists so that pinning is *reproducible* rather than a
 * one-off download nobody can repeat.
 *
 * Source is the Federal Reserve H.10 release, which `Treas. Reg. §1.988-1(d)(1)` names
 * explicitly ("exchange rates published by the Board of Governors of the Federal
 * Reserve System pursuant to 31 U.S.C. section 5151"), redistributed by FRED.
 *
 * **A refresh revises history.** FRED restates recent observations as the Fed finalises
 * them, so `--check` exists to show you exactly which past dates moved before you
 * overwrite anything. Recompute and re-commit dependent figures alongside the rates.
 *
 * Usage:
 *   node scripts/tax/fetch-fx-rates.mjs            # rewrite in place
 *   node scripts/tax/fetch-fx-rates.mjs --check    # fetch, diff, write nothing
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RATES_DIR = resolve(HERE, '../../rates');

/** One entry per pinned series. Add here, not in the loader. */
const SERIES = [
  {
    id: 'DEXUSAL',
    file: 'DEXUSAL-daily.csv',
    description: 'US dollars per 1 Australian dollar, H.10 noon buying rate, daily',
  },
];

const fredUrl = (id) => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;

/** Parse the two-column FRED CSV into a Map<date, string>. Blank values are holidays. */
function parseSeries(text) {
  const out = new Map();
  const lines = text.trim().split(/\r?\n/);
  for (const line of lines.slice(1)) {
    const [date, value] = line.split(',');
    if (date) out.set(date.trim(), (value ?? '').trim());
  }
  return out;
}

/**
 * Compare old and new observations. Restatements matter far more than additions —
 * an appended row cannot change a figure you have already filed on, and a restated
 * one can.
 */
function diffSeries(before, after) {
  const restated = [];
  const added = [];
  const removed = [];
  for (const [date, value] of after) {
    if (!before.has(date)) added.push(date);
    else if (before.get(date) !== value) restated.push({ date, from: before.get(date), to: value });
  }
  for (const date of before.keys()) if (!after.has(date)) removed.push(date);
  return { restated, added, removed };
}

async function main() {
  const check = process.argv.includes('--check');

  for (const series of SERIES) {
    const target = resolve(RATES_DIR, series.file);
    process.stdout.write(`${series.id} — ${series.description}\n`);
    process.stdout.write(`  fetching ${fredUrl(series.id)}\n`);

    const res = await fetch(fredUrl(series.id));
    if (!res.ok) {
      process.stderr.write(`  FAILED: HTTP ${res.status}\n`);
      process.exitCode = 1;
      continue;
    }
    const text = await res.text();
    const after = parseSeries(text);
    if (after.size === 0) {
      process.stderr.write('  FAILED: parsed zero observations — refusing to write\n');
      process.exitCode = 1;
      continue;
    }

    const dates = [...after.keys()].sort();
    process.stdout.write(`  ${after.size} observations, ${dates[0]} → ${dates[dates.length - 1]}\n`);

    if (existsSync(target)) {
      const before = parseSeries(readFileSync(target, 'utf8'));
      const { restated, added, removed } = diffSeries(before, after);
      process.stdout.write(`  vs pinned: +${added.length} new, ${restated.length} restated, ${removed.length} removed\n`);
      for (const r of restated.slice(0, 20)) {
        process.stdout.write(`    RESTATED ${r.date}: ${r.from || '(blank)'} -> ${r.to || '(blank)'}\n`);
      }
      if (restated.length > 20) process.stdout.write(`    ... and ${restated.length - 20} more\n`);
      if (restated.length > 0 && !check) {
        process.stdout.write('    ^ figures computed from these dates must be recomputed\n');
      }
    }

    if (check) {
      process.stdout.write('  --check: nothing written\n');
    } else {
      writeFileSync(target, text);
      process.stdout.write(`  wrote ${target}\n`);
    }
  }

  process.stdout.write('\nRemember to update the retrieval date in rates/README.md.\n');
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
