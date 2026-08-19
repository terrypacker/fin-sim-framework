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
 * fx-series-package.test.mjs — design 92 step 1 (package the published series).
 *
 * FXS-1  Generator sync: regenerating from the CSV reproduces the committed module byte
 *        for byte. A generated file that drifts from its source is a known failure here.
 * FXS-2  Direction: the packaged value for a known month is AUD per USD, asserted
 *        against the published USD-per-AUD figure explicitly. Swapping the two inverts
 *        every gain and no test of a zero case would notice — so this test states the
 *        convention rather than round-tripping it through the same helper that sets it.
 * FXS-3  Shape: months are contiguous, sorted, aligned with the values, and all finite
 *        and positive. Every mapping mode in design 92 §3 indexes this array by offset,
 *        so a gap would silently shift history rather than fail.
 * FXS-4  Provenance: the fields a run must stamp into its metadata are present and
 *        well-formed (design 92 §7). FRED revises history; an unpinned run is not
 *        reproducible.
 * FXS-5  Downsample rule: each month's value is the carry-forward resolution of that
 *        month's last calendar day — the SAME convention FxRateTable.resolve() applies,
 *        checked against the daily table rather than against the generator.
 *
 * These read the committed module and the committed CSV, so they are hermetic.
 */

import { test }        from 'node:test';
import assert          from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash }   from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { USD_AUD_H10_MONTHLY }        from '../../src/finance/fx/data/usd-aud-h10-monthly.js';
import { FxRateTable, toAudPerUsd }   from '../../scripts/lib/fx-rates.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('FXS-1 generated module is in sync with the daily CSV', () => {
  // --check re-renders from the CSV and diffs; exit 0 means byte-identical.
  execFileSync('node', ['scripts/dev/build-fx-series.mjs', '--check'], {
    cwd:   REPO,
    stdio: 'pipe',
  });
});

test('FXS-2 direction is AUD per USD, inverted exactly once from the published series', () => {
  const s = USD_AUD_H10_MONTHLY;
  assert.equal(s.direction, 'audPerUsd');

  // Published DEXUSAL (USD per AUD) at each month-end, transcribed from the pinned CSV
  // and stated as literals on purpose: deriving them here would let a generator that
  // inverts twice — or not at all — agree with itself.
  //
  // A plausibility BAND cannot do this job, and the temptation to write one is the trap.
  // The AUD has traded on both sides of parity (1.4875 USD in 1974, 0.4881 in 2001), so
  // the true audPerUsd range 0.67–2.05 overlaps the inverted range 0.49–1.49 almost
  // entirely. Only fixed points discriminate — hence months chosen on BOTH sides of
  // parity, so no single global flip can satisfy them all.
  const PUBLISHED_USD_PER_AUD = [
    ['1971-01', 1.1236],  // AUD above parity — audPerUsd must be < 1
    ['1984-01', 0.9172],  // first full post-float month
    ['1999-12', 0.6560],  // AUD below parity — audPerUsd must be > 1
    ['2011-07', 1.1001],  // above parity again
    ['2020-03', 0.6139],
    ['2026-07', 0.7026],  // last observation in the pinned file
  ];

  for (const [month, usdPerAud] of PUBLISHED_USD_PER_AUD) {
    const idx = s.months.indexOf(month);
    assert.ok(idx >= 0, `expected ${month} in the packaged series`);
    const expected = 1 / usdPerAud;
    assert.ok(
      Math.abs(s.audPerUsd[idx] - expected) < 1e-6,
      `${month}: expected ${expected.toFixed(6)} AUD per USD (published ${usdPerAud} `
      + `USD per AUD), got ${s.audPerUsd[idx]}`,
    );
  }
});

test('FXS-3 months are contiguous, sorted and aligned with the values', () => {
  const s = USD_AUD_H10_MONTHLY;
  assert.equal(s.months.length, s.audPerUsd.length);
  assert.ok(s.months.length > 600, `expected a long series, got ${s.months.length}`);
  assert.equal(s.months[0], s.firstMonth);
  assert.equal(s.months[s.months.length - 1], s.lastMonth);

  for (let i = 1; i < s.months.length; i++) {
    const [py, pm] = s.months[i - 1].split('-').map(Number);
    const expected = pm === 12
      ? `${py + 1}-01`
      : `${py}-${String(pm + 1).padStart(2, '0')}`;
    assert.equal(s.months[i], expected, `gap in the series at index ${i}`);
  }

  for (const v of s.audPerUsd) assert.ok(Number.isFinite(v) && v > 0);
});

test('FXS-4 provenance fields are present and well-formed', () => {
  const s = USD_AUD_H10_MONTHLY;
  assert.equal(s.id, 'USD_AUD.H10.monthly');
  assert.equal(s.pair, 'USD_AUD');
  assert.match(s.sourceSha256, /^[0-9a-f]{64}$/);
  assert.match(s.retrievedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(s.firstMonth, /^\d{4}-\d{2}$/);
  assert.match(s.lastMonth, /^\d{4}-\d{2}$/);

  // The hash must be of the CSV as committed, or a run stamping it proves nothing.
  const actual = createHash('sha256')
    .update(readFileSync(resolve(REPO, 'rates/DEXUSAL-daily.csv')))
    .digest('hex');
  assert.equal(s.sourceSha256, actual, 'sourceSha256 does not match the committed CSV');

  assert.ok(Object.isFrozen(s), 'series must be frozen — a mutated overlay is not a source');
});

test('FXS-5 each month is the carry-forward resolution of its last calendar day', () => {
  const s     = USD_AUD_H10_MONTHLY;
  const table = FxRateTable.load();

  // Spot-check across eras rather than all 667 rows: the generator uses resolve() and
  // this asserts the RULE, so a handful of months in different decades (including a
  // month-end that lands on a weekend) is enough to catch a changed convention.
  for (const month of ['1971-01', '1984-01', '1999-12', '2008-09', '2020-03', s.lastMonth]) {
    const idx = s.months.indexOf(month);
    assert.ok(idx >= 0, `expected ${month} in the series`);
    const [y, m]   = month.split('-').map(Number);
    const lastDay  = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const resolved = table.resolve(lastDay);
    assert.ok(resolved, `daily table could not resolve ${lastDay}`);
    assert.ok(
      Math.abs(s.audPerUsd[idx] - toAudPerUsd(resolved.usdPerAud)) < 1e-8,
      `${month}: packaged ${s.audPerUsd[idx]} != resolved ${toAudPerUsd(resolved.usdPerAud)}`,
    );
  }
});

test('FXS-6 no month past the last published observation was invented', () => {
  const s    = USD_AUD_H10_MONTHLY;
  const csv  = readFileSync(resolve(REPO, 'rates/DEXUSAL-daily.csv'), 'utf8');
  const rows = csv.trim().split(/\r?\n/).slice(1)
    .map((l) => l.split(','))
    .filter(([, v]) => Number.isFinite(Number.parseFloat(v)));
  const lastObserved = rows[rows.length - 1][0].trim();

  // H.10 publishes weekly in arrears, so a trailing partial month has no month-end rate.
  // Carrying the prior rate there would invent data at exactly the point the answer is
  // most uncertain — the distinction rates/README.md draws between HOLIDAY and UNPUBLISHED.
  const [y, m]        = s.lastMonth.split('-').map(Number);
  const lastMonthEnd  = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  assert.ok(
    lastMonthEnd <= lastObserved,
    `series ends ${s.lastMonth} whose month-end ${lastMonthEnd} is past the last `
    + `published observation ${lastObserved} — a partial month was carried`,
  );
});
