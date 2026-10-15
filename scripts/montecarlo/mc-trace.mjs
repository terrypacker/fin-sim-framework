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
 * mc-trace.mjs — replay ONE Monte Carlo path of one arm with the journal on.
 *
 * `mc-run` records a row per path: whether it failed, when, and what it ended with. When a
 * row needs explaining ("why does this world run out in 2064 when pools-off ends rich?"),
 * this rebuilds that exact path — same arm spec, same risk-model flags, same seed — at
 * telemetry 'journal' and writes what happened year by year.
 *
 * Usage:
 *   node scripts/montecarlo/mc-trace.mjs --arms <spec.json> --arm <key> --seed <n> [options]
 *
 *   --arms <file>       REQUIRED. the spec `mc-run` was given
 *   --arm <key>         REQUIRED. which arm
 *   --seed <n>          REQUIRED. the arm row's `seed` (1-based)
 *   --scenario, --index, --paths, --vol, --drift, --property-paths, --shock, --no-recentre
 *                       exactly as given to `mc-run` — the path is only the same path under
 *                       the same risk model
 *   --actions <types>   journal action types to list in full (default POOL_FLOW_APPLY,
 *                       REBALANCE_TO_TARGET_APPLY); one entry per action, not per reducer
 *   --check <file>      the arm's `mc-run` output: compare this path's failed / out-of-funds /
 *                       final net worth with its row, and exit 1 if they differ
 *   --out <file>        write the JSON here (default stdout)
 *
 * Output: `{ arm, seed, failed, oof, nw, params, years: [...], actions: { TYPE: [...] },
 * actionCounts }`. Each year is read at 1 January after it closes: net worth, real net
 * liquidity, the asset mix, every account balance and the liquidity pool cube.
 *
 * Why it can be trusted: the path is built by `buildArmPathSim`, which runs the MC runner's
 * own preparation and the worker's own `createIterationSimulation`. Telemetry only records,
 * so the traced run is the batch's run; `--check` proves it per path.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { loadBaseConfig } from '../lib/scenario-source.mjs';
import { buildVariant } from '../lib/variant.mjs';
import { buildMcConfig, mergeArmLevers, stochasticFromFlags, buildArmPathSim } from '../lib/mc.mjs';
import { parseFlags } from '../lib/cli.mjs';
import { quiet } from '../lib/run.mjs';
import { computeNetLiquidity } from '../../src/finance/derived-metrics/net-liquidity.js';
import { computeNetWorthUsd } from '../../src/finance/monte-carlo/mc-sampling.js';
import { buildAllocationCube } from '../../src/finance/allocation-reporting/allocation-cube.js';
import { mixPoint } from '../../src/finance/allocation-reporting/mix-distribution.js';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/montecarlo/mc-trace.mjs --arms <spec.json> --arm <key> --seed <n> [options]',
  arms:  { type: 'string', help: 'REQUIRED. the { base, arms } spec mc-run was given' },
  arm:   { type: 'string', help: 'REQUIRED. which arm' },
  seed:  { type: 'number', help: 'REQUIRED. the arm row\'s seed (1-based)' },
  scenario: { type: 'string', default: null, help: 'base scenario export; omitted => synthetic' },
  index:    { type: 'number', default: 0,    help: 'scenario index in that file' },
  paths:    { type: 'flag',   help: 'as mc-run: stochastic year-by-year equity returns' },
  vol:      { type: 'number', default: 0.18, help: 'as mc-run: equity return vol when --paths' },
  drift:    { type: 'string', default: 'GEOMETRIC', choices: ['GEOMETRIC', 'NONE'], help: 'as mc-run' },
  propertyPaths: { type: 'flag', help: 'as mc-run: stochastic property appreciation path' },
  shock:    { type: 'flag', help: 'as mc-run: manufactured single crash' },
  noRecentre: { type: 'flag', help: 'as mc-run: skip the MC-centre check' },
  actions:  { type: 'list', default: ['POOL_FLOW_APPLY', 'REBALANCE_TO_TARGET_APPLY'],
              help: 'journal action types to list in full' },
  check:    { type: 'string', default: null, help: 'the arm\'s mc-run output file, to verify this path against' },
  out:      { type: 'string', default: null, help: 'output file (default stdout)' },
});

if (!opts.arms || !opts.arm || !Number.isInteger(opts.seed)) {
  console.error('usage: mc-trace.mjs --arms <spec.json> --arm <key> --seed <n> [options]  (see file header)');
  process.exit(2);
}

const spec = JSON.parse(readFileSync(opts.arms, 'utf8'));
if (!spec.arms?.[opts.arm]) {
  console.error(`no arm '${opts.arm}' in ${opts.arms} (arms: ${Object.keys(spec.arms ?? {}).join(', ')})`);
  process.exit(2);
}

// The arm exactly as mc-run builds it — levers, then the risk-model block, then the MC config.
const base   = loadBaseConfig({ file: opts.scenario, index: opts.index });
const levers = mergeArmLevers(spec.base, spec.arms[opts.arm]);
const stochastic = stochasticFromFlags(opts);
if (stochastic) levers.stochastic = { ...(levers.stochastic ?? {}), ...stochastic };
const cfg = buildVariant(base.cfg, levers);
const { mcConfig, shocks } = buildMcConfig(cfg, { shock: opts.shock, recentre: !opts.noRecentre });
const { sim, params, simStart, simEnd } = buildArmPathSim({ cfg, mcConfig, shocks, seed: opts.seed });

const r0 = v => Math.round(v ?? 0);
const small = x => (Math.abs(x) < 100 ? +x.toFixed(4) : r0(x));
const balanceOf = a => a?.balance ?? a?.getBalance?.() ?? null;

const years = [];
quiet(() => {
  for (let y = simStart.getUTCFullYear() + 1; y <= simEnd.getUTCFullYear(); y++) {
    sim.stepTo(new Date(Date.UTC(y, 0, 1)));
    const s   = sim.state;
    const cpi = s.inflationAccumulator?.US ?? 1;
    const accounts = {};
    for (const [k, a] of Object.entries(s)) {
      if (!/Account$/.test(k) || !a || typeof a !== 'object') continue;
      const b = balanceOf(a);
      if (b) accounts[k] = r0(b);
    }
    const mix = mixPoint(buildAllocationCube(s, { date: sim.currentDate,
      includeNonHoldingAssets: false, includeLiabilities: false })).mix;
    years.push({
      year: y - 1,
      cpi: +cpi.toFixed(4),
      netWorth: r0(s.metrics?.netWorth),
      realNetLiquidity: r0(computeNetLiquidity(s, sim.currentDate) / cpi),
      failed: !!s.scenarioFailed,
      mix: Object.fromEntries(Object.entries(mix ?? {}).filter(([, v]) => v > 0.0005)
        .map(([k, v]) => [k, +v.toFixed(3)])),
      accounts,
      pools: Object.fromEntries(Object.entries(s.liquidityPools ?? {}).map(([id, p]) => [id,
        Object.fromEntries(Object.entries(p ?? {}).filter(([, x]) => typeof x === 'number')
          .map(([f, x]) => [f, small(x)]))])),
    });
  }
  sim.stepTo(simEnd);
});

// One entry per ACTION: the journal records one entry per reducer that handled it, so
// `getActions` alone double-counts a multi-reducer action.
const onePerAction = (list) => {
  const seen = new Set();
  return list.filter(e => {
    const k = e.action?.instanceId ?? e.action;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
const actions = {};
for (const type of opts.actions) {
  actions[type] = onePerAction(sim.journal.getActions(type) ?? [])
    .map(e => ({ date: e.date, reducer: e.reducer?.name ?? null, ...(e.action?.data ?? {}) }));
}
const actionCounts = {};
for (const type of sim.journal.getActionTypes?.() ?? []) {
  actionCounts[type] = onePerAction(sim.journal.getActions(type) ?? []).length;
}

const s = sim.state;
const result = {
  arm: opts.arm, seed: opts.seed,
  failed: !!s.scenarioFailed,
  oof: s.outOfFundsDate ? new Date(s.outOfFundsDate).toISOString().slice(0, 10) : null,
  nw: r0(computeNetWorthUsd(s)),
  params, years, actions, actionCounts,
};

let mismatch = null;
if (opts.check) {
  const armFile = JSON.parse(readFileSync(opts.check, 'utf8'));
  const row = (armFile.rows ?? []).find(r => r.seed === opts.seed);
  if (!row) mismatch = `seed ${opts.seed} has no row in ${opts.check}`;
  else {
    const diffs = ['failed', 'oof', 'nw'].filter(k => (row[k] ?? null) !== (result[k] ?? null))
      .map(k => `${k}: row ${JSON.stringify(row[k])} vs trace ${JSON.stringify(result[k])}`);
    if (diffs.length) mismatch = diffs.join('; ');
  }
  result.check = mismatch ? { ok: false, detail: mismatch } : { ok: true };
}

const json = JSON.stringify(result, null, 1);
if (opts.out) writeFileSync(opts.out, json); else process.stdout.write(json + '\n');

console.error(`${opts.arm} seed ${opts.seed}: ${result.failed ? `FAILED ${result.oof ?? ''}` : 'survived'}`
  + `  nw ${result.nw.toLocaleString('en-US')}`
  + (opts.check ? (mismatch ? `  ✗ does NOT match the arm row — ${mismatch}`
    + ' (an arm file run before a code change will not match; re-run the arm at a small --n to compare)'
    : '  ✓ matches the arm row') : '')
  + (opts.out ? `  → ${opts.out}` : ''));
if (mismatch) process.exit(1);
