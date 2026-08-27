#!/usr/bin/env node
/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * probe-security-registry-clone-cost.mjs — design 94 §6.4's deciding measurement.
 *
 * Design 94 (equity as security positions) proposes a `securities` registry projected into
 * `state.securities`. Its first pass called that free — "a security that tracks a market
 * costs zero extra RNG draws and zero extra state". The RNG half is true. The STATE half
 * needed measuring, and measuring it the obvious way gives the WRONG ANSWER, which is why
 * this probe reports two tables instead of one.
 *
 * ─── the mechanism ──────────────────────────────────────────────────────────────────
 *
 * Reducers receive `(state, action, date)` and nothing else (`reducers.js`), so anything a
 * reducer must read has to live in state. State is deep-cloned — per event and per
 * untracked reducer when the run is observed, and for each history snapshot. Design 78
 * measured those clones as the entire remaining batch overhead after every other
 * optimization. So a registry that never changes gets copied over and over.
 *
 * ─── why one table is not enough ────────────────────────────────────────────────────
 *
 * Table 1 prices a single `deepClone`. On a real plan a 20-security registry makes each
 * clone ~35-50% more expensive, which sounds alarming and is the number a naive probe
 * would stop at.
 *
 * Table 2 prices a WHOLE RUN, and it is much smaller — because design 78 already took the
 * batch paths off the clone-per-event path. `TELEMETRY_LEVELS` (`simulation.js:119`) says
 * which levels clone at all:
 *
 *     off      silent, no snapshots   — scripts/ batch tooling and Monte Carlo   ⇒ no clones
 *     journal  silent, journal only   — ScenarioCompareRunner                    ⇒ no clones
 *     metrics  silent + snapshots     — the optimizer's MPC rollToSnapshot seam  ⇒ snapshot clones
 *     full     everything             — the workbench UI                         ⇒ per-event clones
 *
 * So the registry is charged to the interactive path and to MPC, and is free for the sweep
 * tooling. **Quote table 2, not table 1**, and say which level.
 *
 * A run-level cost near zero at `off`/`journal` would retire design 94 §6.4's `cloneState()`
 * recommendation for batch work; a material cost at `full`/`metrics` is what keeps it alive
 * for the workbench and the optimizer.
 *
 * Usage:
 *   node scripts/probes/probe-security-registry-clone-cost.mjs [--scenario plan.json] \
 *        [--step-to 2050-01-01] [--counts 5,20,50] [--iters 2000] \
 *        [--levels off,journal,metrics,full] [--reps 3] [--n 20] [--no-end-to-end]
 *
 * `--end-to-end` is ON by default and is the slow part: it runs the whole scenario twice
 * per level per rep. `--no-end-to-end` gives table 1 alone in a second or two — useful while
 * iterating, misleading if quoted on its own.
 *
 * With no `--scenario` this runs the synthetic default, which answers a question about the
 * ENGINE rather than about a plan. Say which you ran.
 */

import { loadBaseConfig, parseSourceArgs, describeSource } from '../lib/scenario-source.mjs';
import { openSim, quiet } from '../lib/run.mjs';
import { deepClone } from '../../src/simulation-framework/state-utils.js';

const argv = process.argv.slice(2);
const at   = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt; };
const has  = (flag) => argv.includes(flag);

const stepTo    = at('--step-to', '2035-01-01');
const iters     = Number(at('--iters', 2000));
const counts    = String(at('--counts', '5,20,50')).split(',').map(Number).filter(Boolean);
const levels    = String(at('--levels', 'off,journal,metrics,full')).split(',');
const reps      = Number(at('--reps', 3));
const endToEndN = Number(at('--n', 20));
const endToEnd  = !has('--no-end-to-end');

/**
 * One synthetic Security, shaped exactly like design 94 §4's entity — every field, so the
 * measurement is of the record the design actually proposes and not a trimmed stand-in.
 * (A 19-field draft measured ~10 points cheaper than the real 21-field one.)
 */
const makeSecurity = (i) => ({
  id: `sec-${i}`, symbol: `SYM${i}`, name: `Security number ${i}`,
  rateKey: 'EQUITY_US', beta: 1, idioVol: 0, dividendYield: 0.018,
  currency: 'USD', country: 'US', taxExemption: 'none', issuingState: null,
  qualifiedDividends: true, frankingCredit: 0, isGold: false, identityGroup: null,
  parPerUnit: null, couponRate: null, couponFrequency: 2, maturityDate: null,
  duration: null, zeroCoupon: false, inflationLinked: false,
});
const makeRegistry = (n) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`sec-${i}`, makeSecurity(i)]));

/** Mean µs per clone over `n`, after a warm-up that lets the JIT settle. */
function benchClone(obj, n) {
  for (let i = 0; i < Math.min(200, n); i++) deepClone(obj);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) deepClone(obj);
  return Number(process.hrtime.bigint() - t0) / n / 1000;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const src = loadBaseConfig(parseSourceArgs(argv));
const simEnd = new Date(src.cfg.simEnd);

/** One whole run, timed. The registry is spliced in AFTER load so the arms differ only here. */
function timeRun(telemetry, registry) {
  const t0 = process.hrtime.bigint();
  quiet(() => {
    const sim = openSim(src.cfg, { telemetry });
    if (registry) sim.state.securities = structuredClone(registry);
    sim.stepTo(simEnd);
  });
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

const sim = quiet(() => {
  const s = openSim(src.cfg, { telemetry: 'off' });
  s.stepTo(new Date(stepTo));
  return s;
});

const state = sim.state;
const bytes = JSON.stringify(state).length;

let accounts = 0, holdings = 0;
for (const v of Object.values(state)) {
  if (v && typeof v === 'object' && Array.isArray(v.holdings)) { accounts++; holdings += v.holdings.length; }
}

console.log('');
console.log('design 94 §6.4 — what a `state.securities` registry costs');
console.log('─'.repeat(78));
console.log(describeSource(src));
console.log(`state sampled at ${stepTo}: ${bytes.toLocaleString()} JSON bytes · ` +
            `${accounts} accounts with holdings · ${holdings} holdings`);
console.log('');
console.log(`TABLE 1 — per clone (${iters} clones per row).  Do NOT quote this on its own.`);
console.log('');

const base = benchClone(state, iters);
console.log('  registry        state bytes        µs/clone     vs baseline');
console.log(`  ${'none (today)'.padEnd(15)} ${String(bytes).padStart(11)} ${base.toFixed(1).padStart(13)}              —`);

for (const n of counts) {
  const withReg = { ...state, securities: makeRegistry(n) };
  const b = JSON.stringify(withReg).length;
  const t = benchClone(withReg, iters);
  console.log(`  ${`${n} securities`.padEnd(15)} ${String(b).padStart(11)} ${t.toFixed(1).padStart(13)}` +
              `      ${((t / base - 1) * 100).toFixed(0).padStart(4)}%   (bytes +${((b / bytes - 1) * 100).toFixed(0)}%)`);
}

if (!endToEnd) {
  console.log('');
  console.log('  (--no-end-to-end: table 2 skipped. Table 1 alone OVERSTATES the run-level cost —');
  console.log('   most run modes are silent and never clone. See the file header.)');
  console.log('');
  process.exit(0);
}

console.log('');
console.log(`TABLE 2 — per WHOLE RUN, ${endToEndN} securities, interleaved A/B, median of ${reps}.`);
console.log('This is the number that decides anything.');
console.log('');
console.log('  telemetry    who runs it                        without      with     delta');

const WHO = {
  off:     'scripts/ batch tooling, Monte Carlo',
  journal: 'ScenarioCompareRunner',
  metrics: 'optimizer MPC rollToSnapshot',
  full:    'the workbench UI',
};

const registry = makeRegistry(endToEndN);
for (const level of levels) {
  const A = [], B = [];
  timeRun(level, null); timeRun(level, registry);          // warm
  for (let i = 0; i < reps; i++) { A.push(timeRun(level, null)); B.push(timeRun(level, registry)); }
  const a = median(A), b = median(B);
  const delta = (b / a - 1) * 100;
  console.log(`  ${level.padEnd(12)} ${(WHO[level] ?? '').padEnd(34)} ${a.toFixed(0).padStart(6)}ms ` +
              `${b.toFixed(0).padStart(7)}ms   ${delta.toFixed(1).padStart(6)}%`);
}

console.log('');
console.log('Read it as: the clone-per-event levels pay; the silent levels do not. Design 78');
console.log('already moved the batch tooling off the clone path, and that win is untouched.');
console.log('');
