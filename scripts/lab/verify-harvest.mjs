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
 * verify-harvest.mjs — does the baked scenario reproduce the run? (design/39 §13.7)
 *
 * Drives a real closed-loop cockpit run headlessly, harvests it back into params,
 * re-runs the result from t₀ at the SAME seed, and reports the drift on the goal's
 * own metric.
 *
 *   A = the MPC's committed closed-loop plan (what the cockpit showed)
 *   B = the harvested schedule re-run from t₀ (what a saved scenario does)
 *
 * Two distinct drifts live in A − B and the script names both:
 *   • discretization — band/anchor collapse, step-vs-smooth, POINT collapses.
 *     Bounded and reported; the plan's own warnings say where it happened.
 *   • loss of feedback — the MPC re-decided from realized state each epoch; the
 *     bake cannot react. On the SAME path a faithful bake tracks closely; on any
 *     other path it will not. That is the semantics of a saved scenario, not a bug.
 *
 * Fidelity goal (§13.7): schedule-form levers within ~1% of A. POINT levers are
 * unbounded by construction and labelled as such.
 *
 * Usage:
 *   node scripts/lab/verify-harvest.mjs                    # spending lever
 *   node scripts/lab/verify-harvest.mjs SPENDING,ROTH      # a joint lever set
 *   node scripts/lab/verify-harvest.mjs SPENDING --epochs 6 --budget 24
 *   node scripts/lab/verify-harvest.mjs --seeds 1,2        # out-of-sample check
 */

import { harvestLab, report, OBJECTIVES } from '../lib/harvest-lab.mjs';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt;
};
const levers = (argv.find(a => !a.startsWith('--') && !/^\d/.test(a)) ?? 'SPENDING')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2050, 0, 1));
// "Now" sits after the move (2031) and into retirement, where the levers actually
// change the outcome — the same regime verify-mpc-lever.mjs targets.
const NOW       = new Date(Date.UTC(2041, 0, 1));
const BIRTH     = flag('birth', '1978-04-15');

// EXPLICIT_BANDS so the SPENDING lever is live; a moderate spend so the plan stays
// solvent and the terminal is order-sensitive rather than floored.
const BASE = {
  spendingStrategy:     ['EXPLICIT_BANDS'],
  spendingExpenseBands: [{ startAge: 45, monthlyAmount: 9000 }],
  rothConversionEnabled: levers.includes('ROTH') ? true : undefined,
};
for (const k of Object.keys(BASE)) if (BASE[k] === undefined) delete BASE[k];

const objective = OBJECTIVES[flag('goal', 'MAX_NET_WORTH')] ?? OBJECTIVES.MAX_NET_WORTH;
const seeds  = String(flag('seeds', '1')).split(',').map(Number).filter(Number.isFinite);
const epochs = Number(flag('epochs', 5));
const budget = Number(flag('budget', 24));
const resolve = argv.includes('--votv') || argv.includes('--resolve');

for (const seed of seeds) {
  const out = await harvestLab({
    levers, baseParams: BASE, objective,
    simStart: SIM_START, simEnd: SIM_END, asOf: NOW, birthDate: BIRTH,
    solverKey: flag('solver', 'CEM'), budget, seed, epochs, resolve,
  });
  report({ title: `harvest verification · levers ${levers.join('+')} · seed ${seed}`, out });

  const { a, b } = out.terminals;
  if (Number.isFinite(a) && Number.isFinite(b) && a !== 0) {
    const drift = Math.abs((b - a) / a);
    const pointLevers = out.plan.entries.filter(e => e.form === 'POINT');
    const verdict = pointLevers.length
      ? `POINT levers present (${pointLevers.map(e => e.paramKey).join(', ')}) — drift is unbounded by construction; `
        + 'run with --votv to price the alternative.'
      : drift <= 0.01
        ? 'PASS — the baked schedule reproduces the run within 1%.'
        : `DRIFT ${(drift * 100).toFixed(2)}% — check the plan warnings above for where the approximation bit.`;
    console.log(`  VERDICT: ${verdict}\n`);
  }
}
