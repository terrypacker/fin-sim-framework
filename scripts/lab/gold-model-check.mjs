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
 * gold-model-check.mjs — design 131 gate G2: does the MODEL's gold behave like history's?
 *
 * Runs the synthetic default plan in joint mode (equity bootstrap + HISTORICAL_JOINT
 * inflation + stochastic yields, the Monte Carlo default) for many seeds and recomputes, on
 * the model's own year-by-year rates, the statistics `gold-correlation.mjs` measures on
 * history (design 131 §2.2):
 *
 *   gold real  = (1 + effectiveGrowthRates.GOLD)      / (1 + effectiveInflationRates.US) − 1
 *   equity real= (1 + effectiveGrowthRates.EQUITY_US) / (1 + effectiveInflationRates.US) − 1
 *   Δreal      = this year's (FIXED_INCOME_US − US inflation) minus last year's
 *
 * read at 1 July, after the 1 January advance has folded the year's draws. Years are split by
 * whether the bootstrap replayed a year with a gold row (1969–). `--no-replay` runs the same
 * seeds with Replay Gold History off, the comparison arm.
 *
 * Usage:  node scripts/lab/gold-model-check.mjs [--seeds 40] [--no-replay] [--vol 0.29]
 */

import { parseFlags }      from '../lib/cli.mjs';
import { quiet }           from '../lib/run.mjs';
import { loadScenarioSim } from '../../tests/helpers/scenario-harness.js';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/lab/gold-model-check.mjs [--seeds 40] [--no-replay] [--vol 0.29]\n\n'
       + 'gold-model-check — design 131 G2: the model\'s gold statistics against history\'s.',
  seeds:      { type: 'number', default: 40, help: 'paths (seeds 1..n), 42 years each' },
  'no-replay': { type: 'flag', help: 'run with goldReplay off (the comparison arm)' },
  vol:        { type: 'number', help: 'goldReturnVol (default: the param default)' },
});

const JOINT = {
  equityReturnStochastic: true, equityReturnModel: 'HISTORICAL_BOOTSTRAP',
  inflationStochastic: true, inflationModel: 'HISTORICAL_JOINT', yieldCurveStochastic: true,
  rngStreams: true,
  goldReplay: !opts.noReplay,
  ...(opts.vol != null ? { goldReturnVol: opts.vol } : {}),
};

const rows = [];
for (let seed = 1; seed <= opts.seeds; seed++) {
  const { sim } = quiet(() => loadScenarioSim({ telemetry: 'off', simEnd: Date.UTC(2070, 0, 1), params: { ...JOINT, randomSeed: seed } }));
  let prevReal = null;
  for (let y = 2028; y < 2070; y++) {
    quiet(() => sim.stepTo(new Date(Date.UTC(y, 6, 1))));
    const s = sim.state;
    const i = s.effectiveInflationRates.US;
    const g = s.effectiveGrowthRates.GOLD, e = s.effectiveGrowthRates.EQUITY_US;
    const r = s.effectiveInterestRates?.FIXED_INCOME_US;
    const real = r - i;
    // The year the bootstrap replayed for THIS calendar year was drawn on 31 Dec of y − 1;
    // the cursor in state at 1 July is that draw.
    const histYear = s.equityReturnBootstrap?.year;
    rows.push({ seed, y, histYear, goldReplayed: histYear >= 1969 && histYear <= 2023,
      gold: (1 + g) / (1 + i) - 1, equity: (1 + e) / (1 + i) - 1, infl: i,
      dReal: prevReal == null ? null : real - prevReal });
    prevReal = real;
  }
}

const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
const sd   = (x) => { const m = mean(x); return Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / (x.length - 1)); };
const corr = (x, y) => { const mx = mean(x), my = mean(y); let s = 0, a = 0, b = 0; x.forEach((v, k) => { s += (v - mx) * (y[k] - my); a += (v - mx) ** 2; b += (y[k] - my) ** 2; }); return s / Math.sqrt(a * b); };
const geo  = (x) => Math.exp(mean(x.map(v => Math.log(1 + v)))) - 1;
const f    = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

console.log(`\ngold-model-check: ${opts.seeds} seeds × 42 years, joint mode, goldReplay ${JOINT.goldReplay}, goldReturnVol ${JOINT.goldReturnVol ?? 'default'}\n`);
console.log('subset              n     gold real geo  gold real sd   ρ(equity)  ρ(inflation)  ρ(Δreal)');
for (const [label, pick] of [['all years', () => true], ['gold-row years', r => r.goldReplayed], ['pre-1969 years', r => !r.goldReplayed]]) {
  const sub = rows.filter(pick);
  const withD = sub.filter(r => r.dReal != null);
  if (sub.length < 10) continue;
  const g = sub.map(r => r.gold);
  console.log(`${label.padEnd(18)} ${String(sub.length).padStart(4)}   ${f(100 * geo(g), 1).padStart(10)}%  ${(100 * sd(g)).toFixed(1).padStart(10)}%   ${f(corr(g, sub.map(r => r.equity))).padStart(8)}   ${f(corr(g, sub.map(r => r.infl))).padStart(10)}   ${f(corr(withD.map(r => r.gold), withD.map(r => r.dReal))).padStart(8)}`);
}
console.log('\nHistory (design 131 §2.2, 1969–2023): real geo +3.6%, sd 29.3%, ρ(equity) −0.13 [−0.4, +0.1], ρ(CPI) +0.35 [+0.1, +0.6], ρ(Δreal10) −0.48 [−0.7, −0.2].');
