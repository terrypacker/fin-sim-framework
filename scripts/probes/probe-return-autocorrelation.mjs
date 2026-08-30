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
 * probe-return-autocorrelation.mjs — design 97 §20.9.
 *
 * "Do not sell equity in a down market; sell after the recovery" is a bet on ONE number: the
 * lag-1 autocorrelation of annual equity returns. The rule pays only if a down year predicts
 * an UP year (ρ < 0). If ρ = 0 there is nothing to wait for and the policy is leverage; if
 * ρ > 0 a down year predicts ANOTHER down year and the rule holds the household through a
 * continuing decline — actively wrong, not merely useless.
 *
 * So before scoring any arm, measure ρ in the worlds the engine can actually produce.
 *
 * ─── what this found, and it decides design 97 §20 ───────────────────────────────────
 *
 * `EquityReturnTickHandler` reuses `FX_PROCESS_MODELS`, whose OU step is
 *
 *     dev_t = dev_{t-1} · e^(−k·dt) + σ·√dt·z
 *
 * For FX that is applied to a RATE — a level — and is genuinely mean-reverting. For equity it
 * is applied to the DEVIATION OF A RETURN, which is already a rate of change, so what reverts
 * is the return itself and consecutive returns are correlated at e^(−k): **positively**.
 * `MEAN_REVERTING` on the equity path is a MOMENTUM process. The name describes the level's
 * behaviour and the units are one derivative apart.
 *
 * The generalizable statement: *an OU on a level mean-reverts; the same OU on a rate of change
 * is momentum.* Sharing one process library across the two is what hides it.
 *
 * Usage: node scripts/probes/probe-return-autocorrelation.mjs [--n 40] [--vol 0.18]
 */

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { openSim, quiet }         from '../lib/run.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const N   = flag('n', 40);
const VOL = flag('vol', 0.18);

/** The worlds worth naming: no memory, and the OU at three pull-back speeds. */
const WORLDS = [
  { model: 'WHITE_NOISE' },
  { model: 'MEAN_REVERTING', k: 0.15 },
  { model: 'MEAN_REVERTING', k: 0.5 },
  { model: 'MEAN_REVERTING', k: 0.9 },
];

function corr(pairs) {
  const n = pairs.length;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}

console.log(`\nANNUAL EQUITY RETURN — lag-1 autocorrelation   (${N} paths, vol ${(VOL * 100).toFixed(0)}%)\n`);
console.log('process                     ρ(1)     e^(−k)     mean      sd     n');
console.log('──────────────────────────────────────────────────────────────────────');

for (const { model, k } of WORLDS) {
  const pairs = [];
  for (let seed = 1; seed <= N; seed++) {
    const rates = [];
    const cfg = IntlRetirementScenario.buildDefaultConfig({
      fxProcessModel: 'NONE', equityReturnStochastic: true, equityReturnVol: VOL,
      randomSeed: seed, equityReturnModel: model,
      ...(k != null ? { equityReturnReversionSpeed: k } : {}),
    });
    quiet(() => {
      const s = openSim(cfg, {
        telemetry: 'off', samplerCadence: 'year-boundary',
        sampler: (st) => { rates.push(st?.effectiveGrowthRates?.EQUITY_US ?? 0); return null; },
      });
      s.stepTo(new Date(cfg.simEnd));
    });
    for (let i = 1; i < rates.length; i++) pairs.push([rates[i - 1], rates[i]]);
  }
  const mean = pairs.reduce((s, [x]) => s + x, 0) / pairs.length;
  const sd   = Math.sqrt(pairs.reduce((s, [x]) => s + (x - mean) ** 2, 0) / pairs.length);
  const pred = k != null ? Math.exp(-k) : 0;
  console.log(`${`${model}${k != null ? ` k=${k}` : ''}`.padEnd(24)} ${corr(pairs).toFixed(4).padStart(7)}`
    + `   ${pred.toFixed(4).padStart(7)}  ${(mean * 100).toFixed(2).padStart(6)}%  ${(sd * 100).toFixed(2).padStart(6)}%  ${String(pairs.length).padStart(5)}`);
}

console.log(`
ρ < 0 is the world "wait for the recovery before selling" is a bet on. NEITHER process
produces one: WHITE_NOISE has no memory, and MEAN_REVERTING is POSITIVELY autocorrelated at
e^(−k) — a down year predicts another down year. A lower k is MORE persistent, not less.

The only rebound the engine can produce is a dated shock's recovery curve, which is declared
in advance rather than drawn.
`);
