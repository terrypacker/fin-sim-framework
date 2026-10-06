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
 * fx-equity-correlation.mjs — how the AUD moves with the US share market, on the model's
 * own horizon (design 120 §3.6).
 *
 * Design 120 correlates the FX path with the annual equity market draw. Its sources give
 * the correlation on MONTHLY data, or as a forecast; the model's equity draw is ANNUAL. This
 * measures the annual figure from two series already on disk:
 *
 *   - f: the year's change in the AUD price of one USD, from the packaged H.10 month-end
 *     series (`src/finance/fx/data/usd-aud-h10-monthly.js`, the same series calibrate-fx
 *     fits `fxVolatility` to);
 *   - local: the S&P 500's nominal total return, December to December, from Shiller's
 *     monthly file (`docs/economic-shocks/data/Shiller-SP500-monthly.csv`; real total-return
 *     index × CPI). Shiller's price is a MONTHLY AVERAGE, the FX value a month END. On annual
 *     returns the mismatch is small; on monthly returns it smooths the equity side, so the
 *     monthly row is printed as indicative only.
 *
 * For each window it prints corr(f, local), the two volatilities, the unhedged AUD return's
 * volatility, and the minimum-variance hedge ratio h* = 1 + ρ·σ_local/σ_f (RBA 2025 fn 9).
 *
 * Usage:
 *   node scripts/lab/fx-equity-correlation.mjs
 *   node scripts/lab/fx-equity-correlation.mjs --json
 */

import { readFileSync }        from 'node:fs';
import { fileURLToPath }       from 'node:url';
import { USD_AUD_H10_MONTHLY } from '../../src/finance/fx/data/usd-aud-h10-monthly.js';
import { parseFlags }          from '../lib/cli.mjs';

const SHILLER = fileURLToPath(new URL('../../docs/economic-shocks/data/Shiller-SP500-monthly.csv', import.meta.url));

/** Post-float windows (the AUD floated in December 1983), each with why it is here. */
const WINDOWS = [
  { from: 1984, to: 2023, label: 'post-float',   why: 'every floating year with both series' },
  { from: 1984, to: 2003, label: '1984-2003',    why: 'first half' },
  { from: 2004, to: 2023, label: '2004-2023',    why: 'second half' },
  { from: 1988, to: 2008, label: '1988-2008',    why: 'RBA 2009 Bulletin window (monthly ρ −0.4)' },
  { from: 2012, to: 2023, label: '2012-2023',    why: 'overlap with the MSCI factsheet years (design 120 §3.2)' },
];

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/lab/fx-equity-correlation.mjs [--json]\n\n'
       + 'fx-equity-correlation — annual correlation of USD/AUD with US equity, by window.',
  json: { type: 'flag', help: 'machine-readable output' },
});

/** 'YYYY-MM' → AUD per USD at month end. */
const fx = new Map(USD_AUD_H10_MONTHLY.months.map((m, i) => [m, USD_AUD_H10_MONTHLY.audPerUsd[i]]));

/** 'YYYY-MM' → nominal total-return index level. */
const tr = new Map();
const [header, ...rows] = readFileSync(SHILLER, 'utf8').trim().split(/\r?\n/);
const col = Object.fromEntries(header.split(',').map((h, i) => [h, i]));
for (const line of rows) {
  const c = line.split(',');
  const real = Number(c[col.real_total_return_price]);
  const cpi  = Number(c[col.CPI]);
  if (c[col.real_total_return_price] && c[col.CPI] && real > 0 && cpi > 0) {
    tr.set(c[col.observation_date].slice(0, 7), real * cpi);
  }
}

const key = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

function stats(f, l) {
  const n  = f.length;
  const mf = f.reduce((a, b) => a + b, 0) / n;
  const ml = l.reduce((a, b) => a + b, 0) / n;
  let sff = 0, sll = 0, sfl = 0;
  for (let i = 0; i < n; i++) {
    sff += (f[i] - mf) ** 2; sll += (l[i] - ml) ** 2; sfl += (f[i] - mf) * (l[i] - ml);
  }
  const sdF = Math.sqrt(sff / (n - 1));
  const sdL = Math.sqrt(sll / (n - 1));
  return { n, rho: sfl / Math.sqrt(sff * sll), sdF, sdL };
}

function summarise(f, l, periodsPerYear) {
  const s  = stats(f, l);
  const u  = f.map((x, i) => (1 + x) * (1 + l[i]) - 1);
  const su = stats(u, u).sdF;
  const a  = Math.sqrt(periodsPerYear);
  return {
    n: s.n, rho: s.rho,
    sdFx: s.sdF * a, sdLocal: s.sdL * a, sdUnhedged: su * a,
    hStar: 1 + s.rho * s.sdL / s.sdF,
  };
}

function annual({ from, to }) {
  const f = [], l = [];
  for (let y = from; y <= to; y++) {
    const a = key(y - 1, 12), b = key(y, 12);
    if (!fx.has(a) || !fx.has(b) || !tr.has(a) || !tr.has(b)) continue;
    f.push(fx.get(b) / fx.get(a) - 1);
    l.push(tr.get(b) / tr.get(a) - 1);
  }
  return summarise(f, l, 1);
}

function monthly(fromYear, toYear) {
  const f = [], l = [];
  for (let y = fromYear; y <= toYear; y++) {
    for (let m = 1; m <= 12; m++) {
      const a = m === 1 ? key(y - 1, 12) : key(y, m - 1), b = key(y, m);
      if (!fx.has(a) || !fx.has(b) || !tr.has(a) || !tr.has(b)) continue;
      f.push(fx.get(b) / fx.get(a) - 1);
      l.push(tr.get(b) / tr.get(a) - 1);
    }
  }
  return summarise(f, l, 12);
}

const results = WINDOWS.map((w) => ({ ...w, ...annual(w) }));
const month   = { label: 'monthly 1984-2023', why: 'INDICATIVE: average equity price vs month-end FX', ...monthly(1984, 2023) };

if (opts.json) {
  console.log(JSON.stringify({ annual: results, monthly: month }, null, 2));
} else {
  const pct = (v) => `${(v * 100).toFixed(2)}%`.padStart(9);
  console.log('\nUSD/AUD vs S&P 500 nominal total return — f = change in AUD per USD (rises as the AUD falls)');
  console.log(`  FX     ${USD_AUD_H10_MONTHLY.id} (month end)`);
  console.log('  equity Shiller S&P 500, real total return × CPI (monthly average)\n');
  console.log('  window               n     ρ(f,local)   σ_f      σ_local  σ_unhedged   h*     note');
  console.log('  ' + '─'.repeat(104));
  for (const r of [...results, month]) {
    console.log(
      `  ${r.label.padEnd(18)}${String(r.n).padStart(4)}`
      + `${r.rho.toFixed(3).padStart(12)}`
      + `${pct(r.sdFx)}${pct(r.sdLocal)}${pct(r.sdUnhedged)}`
      + `${r.hStar.toFixed(2).padStart(8)}   ${r.why}`,
    );
  }
  console.log(
    '\n  Annual rows are December to December. An annual correlation from 20 years has a standard'
    + '\n  error near (1 − ρ²)/√19 ≈ 0.2, so read the halves as regimes, not as decimals.\n',
  );
}
