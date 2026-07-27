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
 * spend-ceiling.mjs — how far over the open-loop affordable line did the harvest
 * land? (design/80 P1)
 *
 * `attribute-ruin.mjs` says SPENDING is the lever that broke the baked plan. This
 * quantifies it: scale every harvested spending band by a factor and bisect for
 * the largest scale that still ends solvent. The gap between 1.0 and that scale
 * is the **feedback premium** — how much extra consumption the closed-loop
 * controller was buying itself with the right to re-decide.
 *
 * Bands below the first MPC epoch are the preserved pre-run plan (§13.6.1) and
 * are NOT scaled: the run never decided them, so they are not the harvest's doing.
 *
 * Usage:
 *   node scripts/lab/spend-ceiling.mjs scenarios/fin-sim-die-with.json
 *   node scripts/lab/spend-ceiling.mjs <file> --from-age 47 --iters 7
 */

import { loadScenario, withParams, readParams, runCfg, fmtUsd } from '../lib/scenario-probe.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const file  = argv.find(a => !a.startsWith('--')) ?? 'scenarios/fin-sim-die-with.json';
const iters = Number(flag('iters', 7));

const cfg   = loadScenario(file, flag('scenario', null));
const bands = readParams(cfg, ['spendingExpenseBands']).spendingExpenseBands ?? [];
if (!bands.length) { console.error('no spendingExpenseBands in this scenario'); process.exit(2); }

// The MPC-decided bands start where the amounts stop matching the pre-run plan.
// Default: everything above the first band's amount. `--from-age` overrides.
const fromAge = flag('from-age', null);
const preAmt  = bands[0]?.monthlyAmount;
const isDecided = b => (fromAge != null ? b.startAge >= Number(fromAge) : b.monthlyAmount !== preAmt);

const scaleBands = k => bands.map(b =>
  isDecided(b) ? { ...b, monthlyAmount: Math.round(b.monthlyAmount * k) } : b);

const decided = bands.filter(isDecided);
const avg = decided.reduce((s, b) => s + b.monthlyAmount, 0) / (decided.length || 1);

console.log(`\n=== spend ceiling · ${file} ===`);
console.log(`  ${bands.length} bands · ${decided.length} MPC-decided (ages ${decided[0]?.startAge}–${decided.at(-1)?.startAge})`);
console.log(`  preserved pre-run band: ${fmtUsd(preAmt)}/mo · decided mean ${fmtUsd(avg)}/mo (real base-year USD)\n`);

const run = k => {
  const r = runCfg(withParams(cfg, { spendingExpenseBands: scaleBands(k) }));
  const tag = r.solvent ? '✅ solvent' : `❌ ruin ${r.outOfFundsDate}`;
  console.log(`  ×${k.toFixed(3)}  (mean ${fmtUsd(avg * k)}/mo)  ${tag.padEnd(24)} NW ${fmtUsd(r.netWorth)}`);
  return r.solvent;
};

// Bracket first: 1.0 is known-failing (that is why we are here); walk down until solvent.
let lo = null, hi = 1.0;
for (const k of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) {
  if (run(k)) { lo = k; break; }
  hi = k;
}
if (lo == null) { console.log('\n  even ×0.4 fails — the scenario is infeasible for reasons beyond spending.\n'); process.exit(0); }

// Bisect the [lo solvent, hi insolvent) bracket.
for (let i = 0; i < iters; i++) {
  const mid = (lo + hi) / 2;
  if (run(mid)) lo = mid; else hi = mid;
}

console.log('');
console.log(`  CEILING: ×${lo.toFixed(3)} — about ${fmtUsd(avg * lo)}/mo mean decided spend is the`);
console.log(`  largest open-loop-affordable version of this harvested plan.`);
console.log(`  FEEDBACK PREMIUM: the harvest baked ×1.000 (${fmtUsd(avg)}/mo), i.e. `
  + `${((1 / lo - 1) * 100).toFixed(1)}% more consumption`);
console.log(`  than the same plan can sustain without the right to re-decide.\n`);
