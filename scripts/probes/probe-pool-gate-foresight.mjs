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
 * probe-pool-gate-foresight.mjs — design 97 §20, integrity check 1.
 *
 * `gate.sourceReturnOver` is the mechanism every "do not sell equity in a down market"
 * candidate rests on (§19.3, §19.5). It reads `poolMarketReturn`, which reads
 * `state.effectiveGrowthRates` — and the two writers sit ONE PRIORITY STEP APART inside the
 * same period advance:
 *
 *     EquityReturnReducer   PRE_PROCESS + 1.5   folds this tick's deviation onto the rates
 *     PoolFlowReducer       PRE_PROCESS + 3     the gate reads them
 *
 * So the question this probe exists to answer is whether the gate is reading the return of
 * the year it is DECIDING IN (clairvoyance — it would pause equity sales in the year the
 * market is about to fall, and no household can do that), or the return of the year that has
 * just finished (a real, implementable rule).
 *
 * It matters more than it looks. A foresighted gate would make every arm of a bucket study
 * look brilliant for a reason that has nothing to do with buckets, and the failure is silent:
 * the number is believable either way. §19 spent three rounds mis-attributing a result for
 * exactly this class of reason.
 *
 * ─── the instrument ──────────────────────────────────────────────────────────────────
 *
 * `PoolFlowReducer.prototype._gateOpen` is patched to record what the gate SAW, at the moment
 * it saw it — not a year-boundary sample of the same state, which is a different instant and
 * would beg the question. At that same instant the equity pool's market value and cost basis
 * are recorded off the live state.
 *
 * TWO readings are recorded, because they are the whole point:
 *   · `acted`  — the value the gate actually gates on;
 *   · `live`   — `metrics[pool].marketReturn`, straight off `state.effectiveGrowthRates` at
 *                this instant, which is what the gate used to read.
 * `live` is kept after the fix so the probe still shows the hazard it was built to find: it
 * is a standing demonstration that the live rate table IS the coming year's return, which is
 * why no gate may read it.
 *
 * Ground truth for "what the market actually did in year t" is then the realized return over
 * [t, t+1) measured between two consecutive readings:
 *
 *     r_t ≈ (MV_{t+1} − MV_t − Δbasis) / MV_t
 *
 * Growth moves `marketValue` and never `costBasis`; only a transaction moves basis (the
 * convention of `probe-bucket-sequencing.mjs`). It is approximate where an APPRECIATED lot is
 * sold, so Δbasis is printed per year: a year with material trading is visible, not hidden.
 *
 * Every evaluation is kept, not one per year. The first version of this probe aggregated to
 * the first reading of each year and thereby hid half the defect it was built to find: the
 * reducer fires on both US_ and AU_PERIOD_ADVANCE, and the July advance read the stamp January
 * had just written. An instrument that aggregates over the axis a defect lives on cannot see it.
 *
 * The verdict is then which column the ACTED-ON reading matches:
 *   acted_t ≈ r_t      ⇒ FORESIGHT   — the gate sees the year it is deciding in
 *   acted_t ≈ r_{t−1}  ⇒ BACKWARD    — the gate reacts to the year just finished
 *
 * Both series sit a constant −2.00pp from the rate table: `brokerageDividendRate` is 0.02 and
 * `dividendReinvest` is false, so the dividend leaves the sleeve as cash and market value
 * compounds at (rate − yield). A constant offset does not move a correlation, and naming it
 * here is cheaper than re-deriving it the next time this probe is read.
 *
 * Usage: node scripts/probes/probe-pool-gate-foresight.mjs [--seed 7] [--vol 0.25]
 */

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { PoolFlowReducer }        from '../../src/finance/pools/pool-flow-reducer.js';
import { openSim, quiet }         from '../lib/run.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };
const SEED = flag('--seed', 7);
const VOL  = flag('--vol', 0.25);

const EQUITY_KEY = 'usStockAccount';

/**
 * Two pools and one gated edge. The edge is deliberately trivial in SIZE
 * (`fractionOfSource: 1e-6`) — the probe needs the gate to be EVALUATED every period, not to
 * move money. `_demand` returns Infinity for a triggerless, non-`toTarget` edge, so the gate
 * is exercised unconditionally and the transfer is rounding dust.
 */
const liquidityGraph = {
  pools: [
    { id: 'cash',   label: 'cash',   claims: [{ key: 'usSavingsAccount' }], spendOrder: 1 },
    { id: 'growth', label: 'growth', claims: [{ key: EQUITY_KEY, sleeves: ['EQUITY'] }], spendOrder: 2 },
  ],
  flows: [
    { id: 'g2c', from: 'growth', to: 'cash', gate: { sourceReturnOver: 0 }, amount: { fractionOfSource: 1e-6 } },
  ],
};

const cfg = IntlRetirementScenario.buildDefaultConfig({
  fxProcessModel:         'NONE',
  equityReturnStochastic: true,
  equityReturnVol:        VOL,
  equityReturnModel:      'WHITE_NOISE',
  randomSeed:             SEED,
  behavioralStrategies:   ['LIQUIDITY_POOLS'],
  liquidityGraph,
});

// ── the instrument ───────────────────────────────────────────────────────────────────
const seen = [];
const orig = PoolFlowReducer.prototype._gateOpen;
PoolFlowReducer.prototype._gateOpen = function patched(flow, ctx) {
  const out = orig.call(this, flow, ctx);
  if (flow.id === 'g2c') {
    const acct = ctx.state?.[EQUITY_KEY];
    let mv = 0, basis = 0;
    for (const h of acct?.holdings ?? []) {
      if (h?.allocation !== 'EQUITY') continue;
      mv    += h.marketValue ?? 0;
      basis += h.costBasis   ?? 0;
    }
    seen.push({
      ms:    ctx.asOfMs,
      acted: ctx.priorYearReturns?.growth ?? null,
      live:  ctx.metrics?.growth?.marketReturn ?? null,
      open:  out.open,
      mv, basis,
    });
  }
  return out;
};

const sim = quiet(() => {
  const s = openSim(cfg, { telemetry: 'off' });
  s.stepTo(new Date(cfg.simEnd));
  return s;
});

PoolFlowReducer.prototype._gateOpen = orig;

// EVERY evaluation, deliberately — not one per year.
//
// The first version of this probe kept the first reading of each calendar year, on the
// reasoning that the rate table only moves annually. That aggregation hid half the defect: the
// reducer fires on both US_ and AU_PERIOD_ADVANCE, and the July advance was reading the stamp
// the January one had just written, i.e. the current year's return. Keeping every evaluation is
// what makes a within-year leak visible at all, so the `n` column below is per ADVANCE and a
// year contributes as many rows as it has advances.
const rows = seen
  .map(r => ({ ...r, year: new Date(r.ms).getUTCFullYear(), date: new Date(r.ms).toISOString().slice(0, 10) }))
  .sort((a, b) => a.ms - b.ms);

// Realized return over the YEAR that follows each reading, measured between the readings a
// year apart (`STRIDE` advances). Between two advances inside one year the market has only
// moved part of a year, which would drag every correlation toward nothing and make the probe
// unable to distinguish anything.
const STRIDE = (() => {
  const perYear = new Map();
  for (const r of rows) perYear.set(r.year, (perYear.get(r.year) ?? 0) + 1);
  const counts = [...perYear.values()].filter((_, i, a) => i > 0 && i < a.length - 1); // drop partial first/last
  return counts.length ? counts[0] : 1;
})();
for (let i = 0; i + STRIDE < rows.length; i++) {
  const a = rows[i], b = rows[i + STRIDE];
  const dBasis = b.basis - a.basis;
  rows[i].realized = a.mv > 0 ? (b.mv - a.mv - dBasis) / a.mv : null;
  rows[i].dBasis   = dBasis;
}

const pct = (v) => v == null ? '     —' : `${(v * 100).toFixed(2).padStart(6)}%`;
const usd = (v) => v == null ? '—' : `$${Math.round(v).toLocaleString()}`;

console.log(`\nPOOL GATE FORESIGHT — seed ${SEED}, equity vol ${(VOL * 100).toFixed(0)}%, WHITE_NOISE`);
console.log(`readings: ${seen.length} gate evaluations, ${rows.length} calendar years\n`);
console.log(`advances per year: ${STRIDE}\n`);
console.log('date          acted on    live rate   realized(t)  realized(t-1)   gate     Δbasis(t)');
console.log('──────────────────────────────────────────────────────────────────────────────────────');
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const prev = i >= STRIDE ? rows[i - STRIDE].realized : null;
  console.log(
    `${r.date}  ${pct(r.acted)}      ${pct(r.live)}       ${pct(r.realized)}       ${pct(prev)}   `
    + `${(r.open ? 'open' : 'SHUT').padEnd(5)}  ${usd(r.dBasis).padStart(10)}`);
}

/** Pearson correlation over the pairs where both series are present. */
function corr(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
/** Correlate one recorded series against realized(t) and realized(t-1). */
function align(pick) {
  const same = [], lag = [];
  for (let i = 0; i < rows.length; i++) {
    const v = pick(rows[i]);
    if (v == null) continue;
    if (rows[i].realized != null) same.push([v, rows[i].realized]);
    if (i >= STRIDE && rows[i - STRIDE].realized != null) lag.push([v, rows[i - STRIDE].realized]);
  }
  return { same: corr(same), lag: corr(lag), n: same.length };
}
const acted = align(r => r.acted);
const live  = align(r => r.live);
const fmt = (c) => c == null ? '  n/a ' : c.toFixed(4).padStart(6);

console.log(`\n                          corr w/ realized(t)   corr w/ realized(t-1)`);
console.log(`  what the gate ACTS on         ${fmt(acted.same)}                ${fmt(acted.lag)}   (n=${acted.n})`);
console.log(`  the LIVE rate table           ${fmt(live.same)}                ${fmt(live.lag)}   (n=${live.n})`);
console.log('\nVERDICT:',
  acted.same == null || acted.lag == null ? 'INCONCLUSIVE — not enough years'
  : Math.abs(acted.same) > Math.abs(acted.lag)
    ? 'FORESIGHT — the gate reads the return of the year it is deciding in.'
    : 'BACKWARD-LOOKING — the gate reacts to the year that has just finished.');
console.log('\nThe LIVE row is the hazard, not a bug report: it is 1.0000 against realized(t) by');
console.log('construction, which is why a gate must never read the rate table directly.\n');
