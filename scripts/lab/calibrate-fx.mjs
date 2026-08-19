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
 * calibrate-fx.mjs — estimate the FX process parameters from the packaged historical
 * series instead of guessing them (design 92 §8.1).
 *
 * `fxVolatility` and `fxReversionSpeed` are the two knobs the existing stochastic FX
 * models read. Both shipped as guesses (0.06 and 0.5), and the series on disk can
 * replace both with estimates. This adds no enum value, no new in-loop code path and no
 * new failure mode — it makes two parameters that already exist honest, which is the
 * cheapest way to get most of the value of design 92.
 *
 * The estimator itself lives in `scripts/lib/fx-calibration.mjs` so it can be pointed at
 * a synthetic path with known parameters and checked for recovery; this file is the
 * window selection and the presentation.
 *
 * ─── why the window matters, and why it is printed next to every number ─────────────
 *
 * The AUD was pegged and then managed before December 1983, so pre-float returns are not
 * draws from the same process. A window spanning the float mixes two regimes and yields
 * a reversion estimate that describes neither — visible below as k̂ halving and the
 * half-life nearly tripling once 1971–1983 is included. The default window is therefore
 * post-float, and the tool always reports which window produced which number so
 * "historical" is never read as "assumption-free".
 *
 * Usage:
 *   node scripts/lab/calibrate-fx.mjs
 *   node scripts/lab/calibrate-fx.mjs --from 2000-01 --to 2026-07
 *   node scripts/lab/calibrate-fx.mjs --compare        # the standard window set
 *   node scripts/lab/calibrate-fx.mjs --json
 */

import { USD_AUD_H10_MONTHLY } from '../../src/finance/fx/data/usd-aud-h10-monthly.js';
import { calibrateWindow, POST_FLOAT_MONTH } from '../lib/fx-calibration.mjs';

const POST_FLOAT = POST_FLOAT_MONTH;

/** Windows worth seeing side by side: post-float, whole series, and the modern era. */
const COMPARE_WINDOWS = [
  { from: POST_FLOAT, label: 'post-float (default)' },
  { from: null,       label: 'whole series'         },
  { from: '2000-01',  label: 'modern era'           },
];

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: calibrate-fx.mjs [--from YYYY-MM] [--to YYYY-MM] [--compare] [--json]');
  process.exit(0);
}

const calibrate = (from, to) => calibrateWindow(USD_AUD_H10_MONTHLY, from, to);

const pct = (v) => `${(v * 100).toFixed(2)}%`;
const num = (v, d = 4) => (v == null ? '   n/a' : v.toFixed(d));

function report(rows) {
  const series = USD_AUD_H10_MONTHLY;
  console.log(`\nFX calibration — ${series.id}`);
  console.log(`  source     ${series.sourceFile} (${series.source})`);
  console.log(`  retrieved  ${series.retrievedAt}  sha256 ${series.sourceSha256.slice(0, 16)}…`);
  console.log(`  coverage   ${series.firstMonth} → ${series.lastMonth}  (${series.months.length} months, direction ${series.direction})`);

  console.log('\n  window                  n     σ̂ (fxVolatility)   k̂ (fxReversionSpeed)   half-life      μ̂ drift');
  console.log('  ' + '─'.repeat(100));
  for (const { label, r } of rows) {
    console.log(
      `  ${label.padEnd(22)}${String(r.months).padStart(4)}`
      + `${num(r.sigmaAnnual).padStart(18)}`
      + `${num(r.reversionSpeed, 3).padStart(23)}`
      + `${(r.halfLifeYears == null ? 'n/a' : `${r.halfLifeYears.toFixed(1)} yr`).padStart(14)}`
      + `${pct(r.driftAnnual).padStart(13)}`,
    );
    console.log(
      `  ${''.padEnd(22)}${r.from} → ${r.to}`
      + `   [lag-1 AR(1) k would be ${num(r.ar1ReversionSpeed, 3)}`
      + `, half-life ${r.ar1HalfLifeYears == null ? 'n/a' : `${r.ar1HalfLifeYears.toFixed(1)} yr`}]`,
    );
  }

  // The fit that produced k, horizon by horizon. Printed because the whole argument for
  // this estimator is visible here and nowhere else: if `fitted` tracks `observed`, the
  // process will reproduce multi-year FX dispersion; if it does not, k is wrong however
  // confident the single number above looks.
  for (const { label, r } of rows) {
    if (!r.term) { console.log(`\n  ${label}: window too short for a term-structure fit.`); continue; }
    const t = r.term;
    console.log(`\n  ${label} — term-structure fit (RMSE ${t.rmse.toFixed(4)}), horizons with 4+ independent windows:`);
    console.log('    horizon ' + t.horizonsYears.map((h) => `${h}y`.padStart(9)).join(''));
    console.log('    observed' + t.empirical.map((v) => v.toFixed(4).padStart(9)).join(''));
    console.log('    fitted  ' + t.fitted.map((v) => v.toFixed(4).padStart(9)).join(''));
  }

  console.log(
    '\n  k̂ is fitted to the TERM STRUCTURE of dispersion, not to the lag-1 autocorrelation'
    + '\n  (design 92 §8.1 specified the latter; it over-reverts and understates 44-year FX'
    + '\n  dispersion by ~40%). Horizons with fewer than 4 non-overlapping windows are excluded'
    + '\n  — an overlapping 20-year estimate is one observation wearing a decimal point.'
    + '\n'
    + '\n  μ̂ is REPORTED ONLY. It is the window\'s realised drift in AUD per USD — positive'
    + '\n  means the AUD weakened against the USD over the window. Choosing a window is'
    + '\n  choosing a currency view (design 92 §5); put drift in the anchor'
    + '\n  (exchangeRateUsdToAud) or the regime FX lever, where it is visible, not in σ.\n',
  );
}

const rows = argv.includes('--compare')
  ? COMPARE_WINDOWS.map(({ from, label }) => ({ label, r: calibrate(from, flag('to')) }))
  : [{ label: 'selected', r: calibrate(flag('from', POST_FLOAT), flag('to')) }];

if (argv.includes('--json')) {
  console.log(JSON.stringify({
    series: {
      id:           USD_AUD_H10_MONTHLY.id,
      sourceSha256: USD_AUD_H10_MONTHLY.sourceSha256,
      retrievedAt:  USD_AUD_H10_MONTHLY.retrievedAt,
    },
    windows: rows.map(({ label, r }) => ({ label, ...r })),
  }, null, 2));
} else {
  report(rows);
}
