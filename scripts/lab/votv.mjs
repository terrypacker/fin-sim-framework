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
 * votv.mjs — is time-variation actually worth anything? (design/39 §13.13.3)
 *
 * The representation question ("why are params static scalars instead of time
 * series?") should not be settled by argument. A harvest already produces every
 * artifact needed to settle it per lever, for free:
 *
 *   A = the MPC's committed closed-loop plan
 *   B = the baked SCHEDULE re-run from t₀
 *   C = the best STATIC value over the whole run (RESOLVE, §13.6.6)
 *
 *   VoTV = B − C   what time-variation is worth
 *   VoFB = A − B   what feedback is worth
 *
 * Reading:
 *   VoTV ≈ 0              → the lever wants to be a SCALAR. Ship RESOLVE; do not
 *                           build a schedule param type for it.
 *   VoTV large            → build the schedule form (Phase 3, §13.6.5); this
 *                           number is the justification.
 *   VoTV ≈ 0, VoFB large  → the variation is STATE-driven, not calendar-driven.
 *                           A state-conditioned RULE (rung 3, §13.13.2) is the
 *                           right upgrade; a schedule would just overfit.
 *
 * Run it over ≥2 seeds: a schedule whose advantage vanishes on seed 2 was fitted,
 * not found (§13.7's out-of-sample caveat made concrete).
 *
 * This gates Phase 3 rather than following it (design 39 §11 Step 12g / D7).
 *
 * Usage:
 *   node scripts/lab/votv.mjs                                  # spending
 *   node scripts/lab/votv.mjs DRAWDOWN_XBORDER --seeds 1,2,3
 *   node scripts/lab/votv.mjs SPENDING,DRAWDOWN_WEIGHTS --epochs 6
 */

import { harvestLab, report, OBJECTIVES } from '../lib/harvest-lab.mjs';
import { parseFlags } from '../lib/cli.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/lab/votv.mjs [LEVER[,LEVER…]] [options]\n\n'
       + 'votv — the value of the true value: what re-solving is worth per lever.',
  positional: { name: 'levers', type: 'list', default: ['SPENDING'],
                help: 'lever keys to price' },
  goal:   { type: 'string', default: 'MAX_NET_WORTH', help: 'optimization objective key' },
  seeds:  { type: 'list',   default: [1], help: 'RNG seeds' },
  epochs: { type: 'number', default: 5,  help: 'decision epochs' },
  budget: { type: 'number', default: 24, help: 'solver budget per epoch' },
  solver: { type: 'string', default: 'CEM', help: 'solver key' },
  birth:  { type: 'string', default: '1978-04-15', help: 'birth date the ages are taken from' },
});

const levers = opts.levers.map(s => s.toUpperCase()).filter(Boolean);

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2050, 0, 1));
const NOW       = new Date(Date.UTC(2041, 0, 1));

const BASE = {
  spendingStrategy:     ['EXPLICIT_BANDS'],
  spendingExpenseBands: [{ startAge: 45, monthlyAmount: 9000 }],
  // The design-58 weights only synthesize an order under WEIGHTED; without this
  // the lever is inert and VoTV would read 0 for the wrong reason.
  ...(levers.includes('DRAWDOWN_WEIGHTS') ? { drawdownStrategy: 'WEIGHTED' } : {}),
  ...(levers.includes('ROTH')             ? { rothConversionEnabled: true }  : {}),
};

const objective = OBJECTIVES[opts.goal] ?? OBJECTIVES.MAX_NET_WORTH;
const seeds  = opts.seeds.map(Number).filter(Number.isFinite);
const epochs = opts.epochs;
const budget = opts.budget;

const rows = [];
for (const seed of seeds) {
  const out = await harvestLab({
    levers, baseParams: BASE, objective,
    simStart: SIM_START, simEnd: SIM_END, asOf: NOW, birthDate: opts.birth,
    solverKey: opts.solver, budget, seed, epochs, resolve: true,
  });
  report({ title: `VoTV · levers ${levers.join('+')} · seed ${seed}`, out });
  rows.push({ seed, ...out.terminals, voTV: out.voTV, voFB: out.voFB });
}

if (rows.length > 1) {
  console.log('=== across seeds (the out-of-sample check) ===');
  for (const r of rows) {
    console.log(`  seed ${r.seed}: VoTV ${Math.round(r.voTV ?? 0).toLocaleString()}`
      + `   VoFB ${Math.round(r.voFB ?? 0).toLocaleString()}`);
  }
  const signs = new Set(rows.map(r => Math.sign(r.voTV ?? 0)));
  console.log(signs.size > 1
    ? '  ⚠ VoTV changes SIGN across seeds — the schedule was fitted to a path, not found.'
    : '  VoTV keeps its sign across seeds — the effect survives a different path.');
  console.log('');
}
