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
 * stock-bond-correlation.mjs — the annual stock–bond correlation by era (design 129 §1).
 *
 * The model's stochastic bond noise is the yield-curve tick's level change (design 67 §6),
 * one draw a year, and a bond's return on it is ≈ −duration × Δyield. So the correlation that
 * matters is between the year's equity return and −Δyield, on annual data. Both series are
 * already packaged:
 *
 *   - equity: Shiller S&P 500 real total return, January to January
 *     (`HISTORICAL_EQUITY_RETURNS`, design 102);
 *   - Δyield: the US 10-year (GS10) change, January to January (`HISTORICAL_JOINT_WINDOW.gs10`,
 *     design 103 §5.1; re-centred, which a correlation ignores).
 *
 * Usage:  node scripts/lab/stock-bond-correlation.mjs
 */

import { HISTORICAL_JOINT_WINDOW as J } from '../../src/finance/economic-regimes/inflation-tick-handler.js';
import { HISTORICAL_EQUITY_RETURNS as E } from '../../src/finance/economic-regimes/historical-equity-returns.js';

const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
const corr = (x, y) => {
  const mx = mean(x), my = mean(y);
  let s = 0, a = 0, b = 0;
  x.forEach((v, i) => { s += (v - mx) * (y[i] - my); a += (v - mx) ** 2; b += (y[i] - my) ** 2; });
  return s / Math.sqrt(a * b);
};

const equity = (y) => E.returns[y - E.firstYear];
const dYield = (y) => J.gs10.shocks[y - J.firstYear];

const WINDOWS = [
  ['post-war, before the inflation', 1952, 1972],
  ['1970s stagflation',              1973, 1982],
  ['high-inflation era',             1966, 1997],
  ['disinflation',                   1983, 1999],
  ['low inflation, 2000s–2010s',     2000, 2020],
  ['2000 to the end of the series',  2000, 2023],
  ['whole post-war window',          1952, 2023],
];

console.log('\nAnnual correlation of US equity real total return with −Δ(10-year yield)');
console.log('(a bond return is ≈ −duration × Δyield, so this is the stock–bond return correlation)\n');
console.log('window                              years       n    ρ');
for (const [name, from, to] of WINDOWS) {
  const ys = [];
  for (let y = from; y <= to; y++) if (equity(y) != null && dYield(y) != null) ys.push(y);
  const rho = -corr(ys.map(equity), ys.map(dYield));
  console.log(`${name.padEnd(34)}  ${from}–${to}  ${String(ys.length).padStart(3)}  ${rho >= 0 ? '+' : ''}${rho.toFixed(2)}`);
}
// Fisher z: atanh(ρ) ± 1.96/√(n − 3). For +0.42 on n = 10 that is about −0.28 to +0.83.
console.log('\nSmall windows are noisy: +0.42 on ten annual points has a 95% interval of about −0.3 to +0.8.');
