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
 * build-fx-series.mjs — derive the engine-readable monthly FX series from the pinned
 * daily published file (design 92 §7).
 *
 *   reads   rates/DEXUSAL-daily.csv        via scripts/lib/fx-rates.mjs — one resolver
 *   writes  src/finance/fx/data/usd-aud-h10-monthly.js
 *
 * ─── why a generated module and not a read at runtime ───────────────────────────────
 *
 * The engine runs in the browser as well as in node. `scripts/lib/fx-rates.mjs` uses
 * `node:fs` and cannot be imported by the bundle, so the series has to arrive as an ES
 * module. Deriving it here rather than in the engine also puts the downsampling rule in
 * a diffable artifact where it can be reviewed against `rates/README.md`, instead of
 * inside a code path nobody re-reads.
 *
 * ─── the downsample rule is the existing carry-forward rule, not an average ──────────
 *
 * For month *m*: the most recent published observation at or before the last calendar
 * day of *m* — exactly `FxRateTable.resolve()`'s convention, reused rather than
 * reinvented. A monthly *average* would be a second convention, and `§1.988-1(d)(2)`
 * wants one source consistently applied. (Averages are separately unavailable to a
 * household pool under `§1.988-1(d)(3)`; that binds the tax path rather than this one,
 * but there is no reason to hold two conventions when one will do.)
 *
 * A trailing partial month is DROPPED, not carried. `resolve()` returns null past the
 * last observation because H.10 publishes weekly in arrears, and carrying there would
 * invent data at exactly the moment the answer is most uncertain.
 *
 * ─── direction: inverted exactly once, here ─────────────────────────────────────────
 *
 * `DEXUSAL` is USD per AUD (~0.70); the engine's `USD_AUD` is AUD per USD (~1.42). The
 * generated module exports `audPerUsd` and nothing else, so no consumer is ever in a
 * position to guess. Silently swapping these inverts every gain and no test of a zero
 * case would notice.
 *
 * Usage:
 *   node scripts/dev/build-fx-series.mjs           # regenerate in place
 *   node scripts/dev/build-fx-series.mjs --check   # verify in sync, write nothing
 */

import { createHash }                 from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath }              from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import { FxRateTable, DEFAULT_RATE_FILE, toAudPerUsd } from '../lib/fx-rates.mjs';

const HERE      = dirname(fileURLToPath(import.meta.url));
const REPO      = resolvePath(HERE, '../..');
const README    = resolvePath(REPO, 'rates/README.md');
const OUT_DIR   = resolvePath(REPO, 'src/finance/fx/data');
const OUT_FILE  = resolvePath(OUT_DIR, 'usd-aud-h10-monthly.js');

const SERIES_ID = 'USD_AUD.H10.monthly';

/**
 * The retrieval date lives in `rates/README.md` prose and is updated by hand after
 * `fetch-fx-rates.mjs` runs. Parsing it (rather than adding a second field that could
 * disagree) makes that prose machine-checked: forget to update it and the generator
 * still carries the old date, but delete or reshape it and this fails loudly.
 *
 * @returns {string} ISO date
 */
function readRetrievedAt() {
  const text  = readFileSync(README, 'utf8');
  const match = /Retrieved \*\*(\d{4}-\d{2}-\d{2})\*\*/.exec(text);
  if (!match) {
    throw new Error(
      `Could not find a retrieval date in ${README}. `
      + 'Expected a line matching: Retrieved **YYYY-MM-DD**. '
      + 'Add it (fetch-fx-rates.mjs prints a reminder) rather than removing this '
      + 'check — an undated published series is not pinned.',
    );
  }
  return match[1];
}

/** Last calendar day of a 'YYYY-MM' month, as an ISO date string. */
function lastDayOfMonth(month) {
  const [y, m] = month.split('-').map(Number);
  // Day 0 of the following month is the last day of this one.
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The 'YYYY-MM' one month after the given one. */
function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * Downsample the daily table to month-end observations, in the engine's direction.
 * @param {FxRateTable} table
 */
function downsample(table) {
  const months      = [];
  const audPerUsd   = [];
  let   carriedCount = 0;

  const stopAfter = table.lastDate.slice(0, 7);
  for (let month = table.firstDate.slice(0, 7); month <= stopAfter; month = nextMonth(month)) {
    const resolved = table.resolve(lastDayOfMonth(month));
    // Null here is the trailing partial month: the month-end has not been published yet.
    // Stop rather than carry — see the header.
    if (!resolved) break;
    months.push(month);
    audPerUsd.push(toAudPerUsd(resolved.usdPerAud));
    if (resolved.carriedFrom) carriedCount += 1;
  }

  if (months.length === 0) throw new Error('Downsample produced no months');
  return { months, audPerUsd, carriedCount };
}

/**
 * Round to a fixed number of significant digits so the generated file is stable across
 * platforms. The daily source carries 4 decimal places; the inverse of a 4dp number is
 * not representable exactly, and printing full float precision would make the file churn
 * on any change to V8's formatting. 10 significant digits is far more than the source
 * supports and well inside double precision.
 */
function fixed(value) {
  return Number(value.toPrecision(10));
}

function render({ months, audPerUsd, carriedCount, retrievedAt, sourceSha256 }) {
  const rows = months
    .map((m, i) => `  ['${m}', ${fixed(audPerUsd[i])}],`)
    .join('\n');

  return `/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * GENERATED FILE — do not edit by hand.
 *
 *   node scripts/dev/build-fx-series.mjs
 *
 * Monthly USD/AUD series derived from the pinned daily H.10 file (design 92 §7).
 * The daily file stays the source of truth for tax reconciliation; this derived
 * monthly file is the source of truth for the engine, and the two must not be
 * crossed — a monthly rate applied to a §988 disposition changes the answer
 * (design 92 §11 trap 9).
 *
 * DIRECTION: \`audPerUsd\` (~1.42), the engine's convention. The published series
 * is USD per AUD (~0.70) and was inverted once, in the generator.
 */

/** @type {ReadonlyArray<readonly [string, number]>} ['YYYY-MM', AUD per USD] */
const OBSERVATIONS = [
${rows}
];

export const USD_AUD_H10_MONTHLY = Object.freeze({
  /** What a run stamps into its metadata and a handler serializes (design 92 §2.2). */
  id:           '${SERIES_ID}',
  pair:         'USD_AUD',
  /** Stated, not implied. */
  direction:    'audPerUsd',
  firstMonth:   '${months[0]}',
  lastMonth:    '${months[months.length - 1]}',
  /** Retrieval date of the daily file this was generated from. */
  retrievedAt:  '${retrievedAt}',
  /** SHA-256 of rates/DEXUSAL-daily.csv at generation time. FRED revises history. */
  sourceSha256: '${sourceSha256}',
  source:       'DEXUSAL (H.10 via FRED)',
  sourceFile:   'rates/DEXUSAL-daily.csv',
  downsample:   'last published observation at or before the final calendar day of the month',
  /** Month-ends that fell on a non-publication day and carried a prior rate forward. */
  carriedMonths: ${carriedCount},
  months:       Object.freeze(OBSERVATIONS.map(([m]) => m)),
  audPerUsd:    Object.freeze(OBSERVATIONS.map(([, v]) => v)),
});
`;
}

function main() {
  const check = process.argv.includes('--check');

  const table        = FxRateTable.load();
  const csv          = readFileSync(DEFAULT_RATE_FILE);
  const sourceSha256 = createHash('sha256').update(csv).digest('hex');
  const retrievedAt  = readRetrievedAt();

  const { months, audPerUsd, carriedCount } = downsample(table);
  const rendered = render({ months, audPerUsd, carriedCount, retrievedAt, sourceSha256 });

  if (check) {
    let existing = null;
    try { existing = readFileSync(OUT_FILE, 'utf8'); } catch { /* missing */ }
    if (existing === rendered) {
      process.stdout.write(`fx series in sync (${months.length} months, ${months[0]} → ${months[months.length - 1]})\n`);
      return;
    }
    process.stderr.write(
      `fx series OUT OF SYNC with ${DEFAULT_RATE_FILE}.\n`
      + 'Run: node scripts/dev/build-fx-series.mjs\n',
    );
    process.exitCode = 1;
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, rendered);
  process.stdout.write(
    `wrote ${OUT_FILE}\n`
    + `  ${months.length} months  ${months[0]} → ${months[months.length - 1]}\n`
    + `  ${carriedCount} month-ends carried forward\n`
    + `  source sha256 ${sourceSha256}\n`
    + `  retrieved ${retrievedAt}\n`,
  );
}

main();
