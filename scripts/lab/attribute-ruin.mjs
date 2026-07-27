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
 * attribute-ruin.mjs — WHICH harvested lever made the baked plan insolvent?
 * (design/80 P1, §9 "attribution is inferred, not measured")
 *
 * Takes a harvested scenario that fails and reverts ONE lever group at a time to
 * a neutral/pre-harvest setting, re-running each time. A lever whose reversion
 * restores solvency is a lever the harvest broke.
 *
 * This is deliberately the crude test. It cannot separate "the POINT collapse
 * chose badly" from "no single static value works here" — that is what design/80
 * P2 (RESOLVE with a margin floor) answers. What it CAN do is tell us whether the
 * drawdown levers are even implicated, before P2/P3 spend effort on the premise.
 *
 * Usage:
 *   node scripts/lab/attribute-ruin.mjs scenarios/fin-sim-die-with.json
 *   node scripts/lab/attribute-ruin.mjs <file> --only DRAWDOWN_WEIGHTS,SPENDING
 */

import { loadScenario, withParams, readParams, runCfg, reportArm, fmtUsd }
  from '../lib/scenario-probe.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const file = argv.find(a => !a.startsWith('--')) ?? 'scenarios/fin-sim-die-with.json';
const only = flag('only', null)?.split(',').map(s => s.trim().toUpperCase());

const cfg = loadScenario(file, flag('scenario', null));

/**
 * The reversion arms. Each names the harvested params it neutralises and the
 * value that turns the lever OFF — not "some other guess", but the setting that
 * removes the harvest's influence entirely, so a solvency flip is attributable to
 * the harvest rather than to a competing hand-tuned value.
 */
const ARMS = [
  {
    key: 'DRAWDOWN_WEIGHTS',
    label: 'drawdown order → TAX_EFFICIENT',
    // Leaving the weights in place but abandoning WEIGHTED reverts the ORDER to a
    // designed strategy. TAX_EFFICIENT is the honest revert: DEFAULT_DRAWDOWN_WEIGHTS
    // is seeded from it, so it is the order the lever started searching around.
    params: { drawdownStrategy: 'TAX_EFFICIENT' },
  },
  {
    key: 'DRAWDOWN_WEIGHTS_TF',
    label: 'drawdown order → TAXABLE_FIRST',
    // The scenario-default strategy (intl-retirement DEFAULTS). Second arm because
    // "which designed order" is itself informative when one survives and one doesn't.
    params: { drawdownStrategy: 'TAXABLE_FIRST' },
  },
  {
    key: 'DRAWDOWN_SLEEVE',
    label: 'sleeve order → FIFO',
    params: { drawdownSleeveOrder: 'FIFO' },
  },
  {
    key: 'DRAWDOWN_XBORDER',
    label: 'cross-border → AUTO',
    params: { crossBorderDrawdown: 'AUTO' },
  },
  {
    key: 'DRAWDOWN_WITHINTIER',
    label: 'within-tier → PROPORTIONAL',
    params: { withinTierDraw: 'PROPORTIONAL' },
  },
  {
    key: 'ALLOCATION_MIX',
    label: 'glidepath → static mix',
    params: { allocationSchedule: 'STATIC' },
  },
  {
    key: 'SPENDING',
    label: 'spending bands → flat pre-MPC',
    // The harvest PRESERVES pre-run bands below the first epoch age (§13.6.1), so
    // the first two entries are the untouched pre-MPC plan. Reverting to them is
    // the honest "what the user had before" arm.
    params: null,   // filled in below from the scenario's own first band
  },
  {
    key: 'ROTH',
    label: 'roth schedule → off',
    params: { rothConversionEnabled: false },
  },
  {
    key: 'BOND_LADDER',
    label: 'bond ladder rungs → 1',
    params: { bondLadderRungs: 1 },
  },
];

// SPENDING's revert value comes from the scenario itself: the preserved pre-run
// band(s) below the first harvested epoch (a jump in monthlyAmount marks the seam).
const bands = readParams(cfg, ['spendingExpenseBands']).spendingExpenseBands ?? [];
const preRun = bands.length > 1 ? [bands[0]] : null;
const spendArm = ARMS.find(a => a.key === 'SPENDING');
if (preRun) spendArm.params = { spendingExpenseBands: preRun };
else ARMS.splice(ARMS.indexOf(spendArm), 1);

// Only run arms whose params actually exist in this scenario.
const runnable = ARMS.filter(a => {
  if (only && !only.includes(a.key)) return false;
  try { withParams(cfg, a.params); return true; } catch { return false; }
});

console.log(`\n=== ruin attribution · ${file} ===`);
console.log(`  reverting one harvested lever group at a time; a flip to SOLVENT implicates that lever\n`);

const base = runCfg(cfg);
reportArm('BASELINE (as harvested)', base);
console.log('');

if (base.solvent) {
  console.log('  ⚠ the baseline is already solvent — nothing to attribute. Wrong scenario?\n');
  process.exit(0);
}

const flips = [];
for (const arm of runnable) {
  const r = runCfg(withParams(cfg, arm.params));
  reportArm(arm.label, r);
  if (r.solvent) flips.push({ arm, r });
  // A lever that does not restore solvency can still MOVE the ruin date; that is
  // partial implication and worth seeing.
  else if (r.outOfFundsDate !== base.outOfFundsDate) {
    console.log(`    ↳ ruin moves ${base.outOfFundsDate} → ${r.outOfFundsDate}`
      + ` (deficit ${fmtUsd(base.cumulativeDeficit)} → ${fmtUsd(r.cumulativeDeficit)})`);
  }
}

console.log('');
if (!flips.length) {
  console.log('  VERDICT: no single lever reversion restores solvency.');
  console.log('    → the failure is JOINT across levers, or the scenario is infeasible at this spend.');
  console.log('    → design/80 P2 (RESOLVE with a margin floor, solved jointly) is the right next test;');
  console.log('      a per-lever schedule form (P3) would not have helped.');
} else {
  console.log(`  VERDICT: ${flips.length} lever(s) individually restore solvency:`);
  for (const f of flips) console.log(`    · ${f.arm.key} — ${f.arm.label} → ${fmtUsd(f.r.netWorth)} NW, solvent`);
  console.log('    → design/80 §2.3/§2.4 attribution CONFIRMED for these levers.');
}
console.log('');
