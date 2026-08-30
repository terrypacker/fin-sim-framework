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
 * run-deterministic.mjs — design 97 §20.6/§20.7, the readable case.
 *
 * One dated crash, applied identically to every arm, on the minimal scenario. This is not the
 * study — a single path proves nothing about a distribution — it is the mechanism check the
 * MC run has no way to do, and the order matters: §19 spent three rounds on economic verdicts
 * for a mechanism that was never doing what its author thought.
 *
 * Three things it has to establish before any MC arm is worth running:
 *
 *   1. **B lands on A.** By §20.5's equivalence, spending the offset and refilling it ungated
 *      from equity is the same policy as spending equity. If they differ materially the graph
 *      is doing something other than what the arm says, and C's number would be measuring it.
 *   2. **C actually defers.** In the crash year, C must sell less equity than B, and the
 *      offset must fall by roughly the year's spending. A gate that shuts and changes nothing
 *      is §19.2(2) all over again: a pool cannot intercept a draw that does not pass it.
 *   3. **The price is visible.** Interest paid must rise in C relative to B, by the interest
 *      on the drawn balance. A deferral with no cost is a modelling error, not a free lunch.
 *
 * Usage:
 *   node scripts/lab/sequence-risk/run-deterministic.mjs [--crash 2032] [--shock MARKET_CRASH_2008_LITE]
 *                                                        [--no-shock] [--from 2030] [--to 2040]
 */

import { buildScenario, GROWTH, OFFSET, LOAN, CASH, DEFAULTS } from './scenario.mjs';
import { arms } from './arms.mjs';
import { openSim, quiet } from '../../lib/run.mjs';
import { computeAfterTaxNetWorth, afterTaxOptionsFromParams } from '../../../src/finance/derived-metrics/after-tax.js';
import { SHOCK_LIBRARY } from '../../../src/finance/economic-shocks/shock-library.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const CRASH    = Number(flag('crash', 2032));
const SHOCK    = flag('shock', 'MARKET_CRASH_2008_LITE');
const NO_SHOCK = argv.includes('--no-shock');
const FROM     = Number(flag('from', CRASH - 2));
const TO       = Number(flag('to', CRASH + 6));

if (!NO_SHOCK && !SHOCK_LIBRARY[SHOCK]) {
  console.error(`unknown --shock '${SHOCK}'. Known: ${Object.keys(SHOCK_LIBRARY).join(', ')}`);
  process.exit(1);
}

/**
 * Gross equity disposals over a year, measured PER LOT on cost basis.
 *
 * §19.2(1), which this design got wrong twice: growth moves `marketValue` and never
 * `costBasis`, so a lot whose basis FELL was sold out of. Summing the negative deltas gives
 * gross disposals even where a net measure reads zero — a year that sells and rebuys nets to
 * nothing and still realized at the bottom.
 *
 * It is a DIAGNOSTIC here and nothing else. §19.2c's whole lesson is that a mechanism metric
 * may select a candidate and must never validate one.
 */
function grossDisposals(prevLots, lots) {
  let gross = 0;
  for (const [id, basis] of prevLots) {
    const now = lots.get(id) ?? 0;
    if (now < basis) gross += basis - now;
  }
  return gross;
}

const lotsOf = (state) => new Map(
  (state?.[GROWTH]?.holdings ?? [])
    .filter(h => h.allocation === 'EQUITY')
    .map(h => [h.id, h.costBasis ?? 0]));

function runArm(arm) {
  const cfg = buildScenario({
    params: {
      liquidityGraph: arm.graph,
      shocks: NO_SHOCK ? [] : [{ preset: SHOCK, startDate: `${CRASH}-01-01` }],
    },
  });

  // §19.6: the pool study's standing hygiene is `shocks: []`, which is why the veto went
  // three rounds without ever meeting a crash. Assert the override LANDED rather than trust it.
  const declared = cfg.parameters?.shocks ?? [];
  if (!NO_SHOCK && declared.length !== 1) {
    throw new Error(`arm ${arm.key}: the shock override did not land (${declared.length} shocks declared)`);
  }

  const rows = [];
  let prevLots = null;
  const sim = quiet(() => {
    const s = openSim(cfg, {
      telemetry: 'full',
      samplerCadence: 'year-boundary',
      sampler: (state, date) => {
        const lots = lotsOf(state);
        const row = {
          year:   new Date(date).getUTCFullYear(),
          equity: (state?.[GROWTH]?.holdings ?? []).filter(h => h.allocation === 'EQUITY')
                    .reduce((t, h) => t + (h.marketValue ?? 0), 0),
          offset: state?.[OFFSET]?.balance ?? 0,
          loan:   state?.[LOAN]?.balance ?? 0,
          cash:   state?.[CASH]?.balance ?? 0,
          gross:  prevLots ? grossDisposals(prevLots, lots) : 0,
        };
        prevLots = lots;
        rows.push(row);
        return row;
      },
    });
    s.stepTo(new Date(cfg.simEnd));
    return s;
  });

  // The PRICE term. `LOAN_PAYMENT_APPLY` carries the month's interest on the EFFECTIVE
  // principal, which is the loan net of the offset — so this is exactly "what drawing the
  // facility cost", and it is zero for as long as the offset stays full.
  const interestByYear = new Map();
  for (const entry of sim.journal?.journal ?? []) {
    if (entry.action?.type !== 'LOAN_PAYMENT_APPLY') continue;
    const y = new Date(entry.date ?? entry.action?.date ?? 0).getUTCFullYear();
    interestByYear.set(y, (interestByYear.get(y) ?? 0) + (entry.action.data?.interest ?? entry.action.interest ?? 0));
  }
  for (const r of rows) r.interest = interestByYear.get(r.year) ?? 0;

  const atnw = computeAfterTaxNetWorth(sim.state, afterTaxOptionsFromParams(cfg.parameters ?? {}));
  const oof = (sim.journal?.journal ?? []).find(e => e.action?.type === 'OUT_OF_FUNDS');
  return {
    arm, rows,
    oof: oof ? new Date(oof.date ?? oof.action?.date ?? 0).toISOString().slice(0, 10) : null,
    interestTotal: [...interestByYear.values()].reduce((a, b) => a + b, 0),
    failed: !!sim.state.scenarioFailed,
    nw:     Math.round(sim.state.metrics?.netWorth ?? 0),
    afterTaxNW: Math.round(typeof atnw === 'number' ? atnw : (atnw?.total ?? 0)),
  };
}

const results = arms().map(runArm);

const usd = (v) => v == null ? '—' : `$${Math.round(v).toLocaleString()}`;
const k   = (v) => v == null ? '     —' : `${(v / 1000).toFixed(0).padStart(6)}k`;

console.log(`\nSEQUENCE RISK — the readable case (design 97 §20)`);
console.log(`crash: ${NO_SHOCK ? 'NONE' : `${SHOCK} @ ${CRASH}`}   `
  + `equity ${usd(DEFAULTS.equity)} · facility ${usd(DEFAULTS.facility)} @ ${(DEFAULTS.loanRate * 100).toFixed(1)}% IO · `
  + `spend ${usd(DEFAULTS.monthlySpend)}/mo\n`);

for (const res of results) {
  console.log(`── ${res.arm.key}: ${res.arm.label}`);
  console.log(`   ${res.arm.note}`);
  console.log('   year    equity     offset   gross sold   interest');
  for (const r of res.rows) {
    if (r.year < FROM || r.year > TO) continue;
    console.log(`   ${r.year}  ${k(r.equity)}    ${k(r.offset)}    ${k(r.gross)}   ${usd(r.interest).padStart(9)}`);
  }
  console.log(`   terminal: net worth ${usd(res.nw)} · after-tax ${usd(res.afterTaxNW)}`
    + ` · interest paid ${usd(res.interestTotal)}${res.failed ? ` · FAILED${res.oof ? ` @ ${res.oof}` : ''}` : ''}\n`);
}

// ── the three checks §20.7 says must pass before an MC arm is worth running ──────────
const by = Object.fromEntries(results.map(r => [r.arm.key, r]));
const rel = (x, y) => y === 0 ? (x === 0 ? 0 : Infinity) : (x - y) / Math.abs(y);
const crashRow = (r) => r.rows.find(x => x.year === CRASH + 1) ?? {};

console.log('CHECKS');
const ab = rel(by.B.afterTaxNW, by.A.afterTaxNW);
console.log(`  1. B lands on A                 ${(ab * 100).toFixed(2)}%`
  + `   ${Math.abs(ab) < 0.01 ? 'OK' : 'INVESTIGATE — the equivalence (§20.5) does not hold here'}`);
const deferred = crashRow(by.B).gross - crashRow(by.C).gross;
console.log(`  2. C defers a crash-year sale   ${usd(deferred)} less equity sold in ${CRASH + 1}`
  + `   ${deferred > 0 ? 'OK' : 'INVESTIGATE — the gate shut and nothing changed'}`);
const price = by.C.interestTotal - by.B.interestTotal;
console.log(`  3. the deferral has a price     ${usd(price)} more interest over the run`
  + `   ${price > 0 ? 'OK' : 'INVESTIGATE — a costless deferral is a modelling error'}`);
console.log();
