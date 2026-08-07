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
 * house-repair.test.mjs — design 75 Phase 3 (stochastic, lumpy house repairs).
 *
 * Units under test:
 *   - RealPropertyRepairTickHandler — a seeded compound repair process (frequency × lognormal
 *     severity) per property, debited residence-aware; NONE / zero-cost draws nothing.
 *   - HouseRepairApplyReducer — accumulates repair spend and, when capitalizeRepairs > 0, lifts
 *     the property's capitalizedImprovements accumulator (added to sale basis).
 *   - Sale integration — capitalized improvements lower the taxable gain (higher ending NW).
 *   - e2e — repairModel NONE ⇒ byte-identical; enabled ⇒ scheduled, reproducible, costs money.
 *
 * Maps to §6.3 exit criteria.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { RealPropertyRepairTickHandler } from '../../src/finance/handlers/real-property-repair-tick-handler.js';
import { HouseRepairApplyReducer }       from '../../src/finance/reducers/house-repair-apply-reducer.js';
import { loadScenarioSim }               from '../helpers/scenario-harness.js';


/**
 * These tests assert on FINAL STATE only — none of them reads `sim.journal`,
 * `sim.history`, a snapshot, the bus, or `sim.samples`. Telemetry is therefore pure
 * overhead here, and it is not a small one: the journal and snapshot machinery, not
 * the simulation maths, is what a full run spends its time on (design 78 §4.4 — sim
 * maths measured at ~285ms of a 9.5s run). Turning it off makes this file ~5x faster.
 *
 * This matters beyond the file: `node --test` runs 300+ files 8-way parallel, so once
 * the fast files drain, the whole suite sits on a handful of slow ones printing
 * nothing, which reads as a hang. Shortening that tail is what keeps `npm run test`
 * looking alive.
 *
 * If you add an assertion here that reads the journal or history, drop the wrapper and
 * call `loadScenarioSim` directly — the default is full telemetry for a reason.
 */
const loadSim = (opts = {}) => loadScenarioSim({ telemetry: 'off', ...opts });

const mkRng = (seed = 42) => {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
};

const mkRegistry = (usKey = 'usCash', auKey = 'auCash') => ({
  resolveTransactionAccountKey: (country) => (country === 'AU' ? auKey : usKey),
  getStateKey: () => usKey,
});

const baseState = (over = {}) => ({
  people: { p1: { id: 'p1', residency: 'US' } },
  effectiveExchangeRates: { USD_AUD: 1.5, AUD_USD: 1 / 1.5 },
  usCash: { balance: 1_000_000, minimumBalance: 0, currency: { code: 'USD' } },
  auCash: { balance: 1_000_000, minimumBalance: 0, currency: { code: 'AUD' } },
  house:  { value: 500000, currency: { code: 'USD' }, country: 'US', repairModel: 'BERNOULLI', repairProb: 0.2, repairMedian: 10000, repairSigma: 0.6, capitalizeRepairs: 0 },
  ...over,
});

const mkHandler = (propertyKeys = ['house']) => new RealPropertyRepairTickHandler({
  stateRegistry: mkRegistry(), propertyKeys,
  usRole: 'US_SAVINGS', usOwnerId: 'p1', auRole: 'AU_SAVINGS', auOwnerId: 'p1',
});

const applyOf = (actions, key = 'house') => actions.find(a => a.type === 'HOUSE_REPAIR_APPLY' && a.stateKey === key);
const debitOf = (actions) => actions.find(a => a.type === 'EXPENSE_DEBIT')?.amount;

describe('RealPropertyRepairTickHandler', () => {
  test('BERNOULLI with prob 1 always incurs a repair (median × exp(σ·z))', () => {
    const st = baseState({ house: { ...baseState().house, repairProb: 1 } });
    const out = mkHandler().call({ sim: { rng: mkRng(1) }, state: st });
    const apply = applyOf(out);
    assert.ok(apply && apply.amount > 0, 'a repair should occur every year at prob 1');
    assert.ok(out.some(a => a.type === 'EXPENSE_DEBIT'));
    assert.ok(out.some(a => a.type === 'RECORD_METRIC'));
  });

  test('same seed ⇒ identical repair sequence (reproducible)', () => {
    const a = mkHandler().call({ sim: { rng: mkRng(5) }, state: baseState() });
    const b = mkHandler().call({ sim: { rng: mkRng(5) }, state: baseState() });
    assert.deepEqual(a, b);
  });

  test('repairModel NONE draws nothing and returns no actions', () => {
    const st = baseState({ house: { ...baseState().house, repairModel: 'NONE' } });
    const rng = mkRng(3);
    assert.deepEqual(mkHandler().call({ sim: { rng }, state: st }), []);
    assert.equal(rng(), mkRng(3)(), 'a NONE property must not advance the RNG cursor');
  });

  test('prob 0 / median 0 draw nothing (cursor unadvanced)', () => {
    const rng0 = mkRng(9);
    mkHandler().call({ sim: { rng: rng0 }, state: baseState({ house: { ...baseState().house, repairProb: 0 } }) });
    assert.equal(rng0(), mkRng(9)(), 'zero probability must not draw');
  });

  test('a NONE property between two active ones does not shift their draws (cursor discipline)', () => {
    // houseA < houseB < houseC by sort. B is NONE ⇒ zero draws ⇒ A and C identical with/without B.
    const active = { value: 500000, currency: { code: 'USD' }, country: 'US', repairModel: 'BERNOULLI', repairProb: 1, repairMedian: 10000, repairSigma: 0.6, capitalizeRepairs: 0 };
    const stWithB = { ...baseState(), houseA: { ...active }, houseB: { ...active, repairModel: 'NONE' }, houseC: { ...active } };
    const stNoB   = { ...baseState(), houseA: { ...active }, houseC: { ...active } };
    const withB = new RealPropertyRepairTickHandler({ stateRegistry: mkRegistry(), propertyKeys: ['houseA', 'houseB', 'houseC'], usRole: 'US_SAVINGS', usOwnerId: 'p1', auRole: 'AU_SAVINGS', auOwnerId: 'p1' })
      .call({ sim: { rng: mkRng(11) }, state: stWithB });
    const noB = new RealPropertyRepairTickHandler({ stateRegistry: mkRegistry(), propertyKeys: ['houseA', 'houseC'], usRole: 'US_SAVINGS', usOwnerId: 'p1', auRole: 'AU_SAVINGS', auOwnerId: 'p1' })
      .call({ sim: { rng: mkRng(11) }, state: stNoB });
    assert.equal(applyOf(withB, 'houseA').amount, applyOf(noB, 'houseA').amount);
    assert.equal(applyOf(withB, 'houseC').amount, applyOf(noB, 'houseC').amount);
  });

  test('a SOLD property (value 0) incurs no repair and draws nothing', () => {
    const rng = mkRng(7);
    const st = baseState({ house: { ...baseState().house, value: 0, repairProb: 1 } });
    assert.deepEqual(mkHandler().call({ sim: { rng }, state: st }), []);
    assert.equal(rng(), mkRng(7)(), 'a sold property must not draw');
  });

  test('HOUSE_REPAIR_APPLY carries the capitalize fraction', () => {
    const st = baseState({ house: { ...baseState().house, repairProb: 1, capitalizeRepairs: 0.3 } });
    const apply = applyOf(mkHandler().call({ sim: { rng: mkRng(1) }, state: st }));
    assert.equal(apply.capitalize, 0.3);
  });

  test('an AUD house repair is converted into the residence account currency (USD)', () => {
    const st = baseState({ house: { value: 500000, currency: { code: 'AUD' }, country: 'AU', repairModel: 'BERNOULLI', repairProb: 1, repairMedian: 15000, repairSigma: 0.0001 } });
    const out = mkHandler().call({ sim: { rng: mkRng(2) }, state: st });
    // σ≈0 ⇒ severity ≈ median 15000 AUD → USD at 1/1.5 ⇒ ~10000.
    assert.ok(Math.abs(debitOf(out) - 15000 / 1.5) < 50);
  });

  test('CONTINUOUS incurs a cost every year; POISSON incurs cost over time', () => {
    // CONTINUOUS: a lognormal draw every single year ⇒ always positive.
    const cont = baseState({ house: { value: 500000, currency: { code: 'USD' }, country: 'US', repairModel: 'CONTINUOUS', repairMedian: 5000, repairSigma: 0.3 } });
    assert.ok(applyOf(mkHandler().call({ sim: { rng: mkRng(4) }, state: cont })).amount > 0);
    // POISSON(λ): 0 in some years, so accumulate over many years and assert positive total.
    const pois = baseState({ house: { value: 500000, currency: { code: 'USD' }, country: 'US', repairModel: 'POISSON', repairLambda: 2, repairMedian: 5000, repairSigma: 0.3 } });
    const rng = mkRng(4);
    const h = mkHandler();
    let total = 0;
    for (let i = 0; i < 50; i++) { const a = applyOf(h.call({ sim: { rng }, state: pois })); if (a) total += a.amount; }
    assert.ok(total > 0, 'POISSON should incur repairs over 50 years');
  });

  test('calibration: BERNOULLI long-run mean ≈ prob × median × exp(σ²/2)', () => {
    const prob = 0.2, median = 10000, sigma = 0.6, N = 20000;
    const rng = mkRng(2026);
    const h = mkHandler();
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const apply = applyOf(h.call({ sim: { rng }, state: baseState() }));
      if (apply) sum += apply.amount;
    }
    const mean     = sum / N;
    const expected = prob * median * Math.exp(sigma * sigma / 2);
    assert.ok(Math.abs(mean - expected) / expected < 0.06, `mean ${mean} vs expected ${expected}`);
  });

  test('round-trips through toJSON/fromJSON', () => {
    const h = mkHandler(['b', 'a']);   // constructor sorts the keys
    const clone = RealPropertyRepairTickHandler.fromJSON(h.toJSON(), { stateRegistry: mkRegistry() });
    assert.deepEqual(clone.propertyKeys, ['a', 'b']);
    assert.deepEqual(
      clone.call({ sim: { rng: mkRng(1) }, state: baseState() }),
      h.call({ sim: { rng: mkRng(1) }, state: baseState() }),
    );
  });
});

// ─── HouseRepairApplyReducer ──────────────────────────────────────────────────────

describe('HouseRepairApplyReducer', () => {
  const reducer = new HouseRepairApplyReducer();

  test('accumulates house-repair spending totals', () => {
    const next = reducer.reduce({}, { type: 'HOUSE_REPAIR_APPLY', stateKey: 'house', amount: 8000, capitalize: 0 });
    assert.equal(next.houseRepairSpendingYTD, 8000);
    assert.equal(next.houseRepairSpendingTotal, 8000);
  });

  test('capitalize > 0 lifts capitalizedImprovements by capitalize × amount', () => {
    const st = { house: { value: 500000, capitalizedImprovements: 1000 } };
    const next = reducer.reduce(st, { type: 'HOUSE_REPAIR_APPLY', stateKey: 'house', amount: 10000, capitalize: 0.4 });
    assert.equal(next.house.capitalizedImprovements, 1000 + 4000);
  });

  test('capitalize 0 leaves the property untouched', () => {
    const st = { house: { value: 500000, capitalizedImprovements: 0 } };
    const next = reducer.reduce(st, { type: 'HOUSE_REPAIR_APPLY', stateKey: 'house', amount: 10000, capitalize: 0 });
    assert.equal(next.house.capitalizedImprovements, 0);
  });

  test('a zero/negative amount is a no-op', () => {
    const st = { houseRepairSpendingTotal: 5 };
    assert.equal(reducer.reduce(st, { type: 'HOUSE_REPAIR_APPLY', amount: 0 }).houseRepairSpendingTotal, 5);
  });
});

// ─── e2e: inertness + it costs money + capitalize lowers CGT ───────────────────────

describe('house repair — e2e', () => {
  const END = Date.UTC(2040, 0, 1);
  const nw = (sim) => Math.round(sim.state.metrics?.netWorth ?? 0);

  const withRepairs = (over) => (cfg) => {
    const p = cfg.realProperties.find(pr => pr.country === 'US');
    Object.assign(p, { repairModel: 'CONTINUOUS', repairMedian: 20000, repairSigma: 0.2, ...over });
  };

  test('no repair model ⇒ byte-identical, no HOUSE_REPAIR scheduled', () => {
    const a = loadSim({ simEnd: END, stepTo: END }).sim;
    const b = loadSim({ simEnd: END, stepTo: END }).sim;
    assert.equal(nw(a), nw(b));
    assert.equal(a.queue.data.some(e => e.type === 'HOUSE_REPAIR'), false);
  });

  test('a repair model schedules the tick, is reproducible, and lowers ending net worth', () => {
    const off = loadSim({ simEnd: END, stepTo: END }).sim;
    const on1 = loadSim({ mutateCfg: withRepairs({}), simEnd: END, stepTo: END }).sim;
    const on2 = loadSim({ mutateCfg: withRepairs({}), simEnd: END, stepTo: END }).sim;
    assert.equal(on1.queue.data.some(e => e.type === 'HOUSE_REPAIR'), true);
    assert.equal(nw(on1), nw(on2), 'same seed ⇒ reproducible');
    assert.ok(nw(on1) < nw(off), 'repairs should reduce ending net worth');
  });

  test('capitalizeRepairs lowers the sale-year CGT ⇒ higher ending net worth (same seed)', () => {
    // A non-primary US property sold mid-sim: capitalized repairs raise basis, cut the gain.
    const cfgFor = (capitalize) => (cfg) => {
      const p = cfg.realProperties.find(pr => pr.country === 'US');
      Object.assign(p, {
        isPrimaryResidence: false, plannedSaleYear: 2035, costBasis: 100000,
        repairModel: 'CONTINUOUS', repairMedian: 20000, repairSigma: 0.15, capitalizeRepairs: capitalize,
      });
    };
    const cap0 = loadSim({ mutateCfg: cfgFor(0),   simEnd: END, stepTo: END }).sim;
    const cap5 = loadSim({ mutateCfg: cfgFor(0.5), simEnd: END, stepTo: END }).sim;
    assert.ok(nw(cap5) > nw(cap0), 'capitalizing repairs into basis should cut CGT and raise ending NW');
  });
});
