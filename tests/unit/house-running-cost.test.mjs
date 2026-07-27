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
 * house-running-cost.test.mjs — design 75 Phase 2 (regular, inflating house running cost).
 *
 * Unit under test: HouseRunningCostHandler — a residence-aware monthly essential debit that
 * sums each property's inflated base cost (+ optional value% + real growth), converts from the
 * property's currency into the residence account currency, and joins the REPLENISH_SAVINGS →
 * EXPENSE_DEBIT path. Deterministic, no RNG, no master flag: inert when every property's cost
 * is 0 (or the property is sold, value 0).
 *
 * Maps to §6.2 exit criteria: inertness (0 ⇒ no debit / byte-identical), inflation compounding,
 * currency conversion, and cessation at sale.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { HouseRunningCostHandler } from '../../src/finance/handlers/house-running-cost-handler.js';
import { loadScenarioSim }         from '../helpers/scenario-harness.js';


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

// Minimal stateRegistry that always resolves the US pool key (residency US) or AU pool key.
const mkRegistry = (usKey = 'usCash', auKey = 'auCash') => ({
  resolveTransactionAccountKey: (country) => (country === 'AU' ? auKey : usKey),
  getStateKey: (_role) => usKey,
});

const START = Date.UTC(2026, 0, 1);

// A state with one US person (US resident), a US cash pool, and a US house.
const baseState = (over = {}) => ({
  people: { p1: { id: 'p1', residency: 'US' } },
  inflationAccumulator: { US: 1.0, AU: 1.0 },
  effectiveExchangeRates: { USD_AUD: 1.5, AUD_USD: 1 / 1.5 },
  usCash: { balance: 100000, minimumBalance: 0, currency: { code: 'USD' } },
  auCash: { balance: 100000, minimumBalance: 0, currency: { code: 'AUD' } },
  house:  { value: 500000, currency: { code: 'USD' }, country: 'US', annualRunningCost: 12000, runningCostValuePct: 0, runningCostGrowth: 0 },
  ...over,
});

const mkHandler = (over = {}) => new HouseRunningCostHandler({
  stateRegistry: mkRegistry(),
  propertyKeys:  ['house'],
  usRole: 'US_SAVINGS', usOwnerId: 'p1',
  auRole: 'AU_SAVINGS', auOwnerId: 'p1',
  startDate: START,
  ...over,
});

const debitOf = (actions) => actions.find(a => a.type === 'EXPENSE_DEBIT')?.amount;

describe('HouseRunningCostHandler', () => {
  test('debits the monthly share of the annual base cost from the residence pool', () => {
    const out = mkHandler().call({ state: baseState(), date: new Date(START) });
    // 12000 / 12 = 1000, price level 1.0, same currency ⇒ 1000.
    assert.ok(Math.abs(debitOf(out) - 1000) < 1e-9);
    assert.ok(out.some(a => a.type === 'RECORD_METRIC'));
  });

  test('zero cost on every property ⇒ no actions (inert)', () => {
    const st = baseState({ house: { value: 500000, currency: { code: 'USD' }, country: 'US', annualRunningCost: 0, runningCostValuePct: 0 } });
    assert.deepEqual(mkHandler().call({ state: st, date: new Date(START) }), []);
  });

  test('a SOLD property (value 0) incurs no cost', () => {
    const st = baseState({ house: { value: 0, currency: { code: 'USD' }, country: 'US', annualRunningCost: 12000 } });
    assert.deepEqual(mkHandler().call({ state: st, date: new Date(START) }), []);
  });

  test('the base cost inflates with inflationAccumulator[cc]', () => {
    const st = baseState({ inflationAccumulator: { US: 1.25, AU: 1.0 } });
    // 1000 × 1.25 = 1250.
    assert.ok(Math.abs(debitOf(mkHandler().call({ state: st, date: new Date(START) })) - 1250) < 1e-9);
  });

  test('runningCostValuePct rides the current value, on top of the fixed base', () => {
    const st = baseState({ house: { value: 500000, currency: { code: 'USD' }, country: 'US', annualRunningCost: 12000, runningCostValuePct: 0.006 } });
    // fixed 1000/mo + value term (0.006 × 500000)/12 = 250 ⇒ 1250.
    assert.ok(Math.abs(debitOf(mkHandler().call({ state: st, date: new Date(START) })) - 1250) < 1e-9);
  });

  test('runningCostGrowth compounds real growth over elapsed years', () => {
    const st = baseState({ house: { value: 500000, currency: { code: 'USD' }, country: 'US', annualRunningCost: 12000, runningCostGrowth: 0.03 } });
    const date = new Date(Date.UTC(2036, 0, 1)); // ~10 years later
    const expected = 1000 * Math.pow(1.03, (date.getTime() - START) / (365.25 * 24 * 3600 * 1000));
    assert.ok(Math.abs(debitOf(mkHandler().call({ state: st, date })) - expected) < 1e-6);
  });

  test('an AUD house is converted into the residence account currency (USD)', () => {
    const st = baseState({ house: { value: 500000, currency: { code: 'AUD' }, country: 'AU', annualRunningCost: 15000 } });
    // 15000/12 = A$1250 → USD at AUD_USD 1/1.5 ⇒ ~833.33.
    assert.ok(Math.abs(debitOf(mkHandler().call({ state: st, date: new Date(START) })) - 1250 / 1.5) < 1e-6);
  });

  test('prepends REPLENISH_SAVINGS when the debit would break the minimum balance', () => {
    const st = baseState({ usCash: { balance: 500, minimumBalance: 0, currency: { code: 'USD' } } });
    const out = mkHandler().call({ state: st, date: new Date(START) });
    assert.equal(out[0].type, 'REPLENISH_SAVINGS');
  });

  test('round-trips through toJSON/fromJSON (preserves startMs)', () => {
    const h = mkHandler();
    const clone = HouseRunningCostHandler.fromJSON(h.toJSON(), { stateRegistry: mkRegistry() });
    assert.equal(clone.startMs, h.startMs);
    assert.deepEqual(
      clone.call({ state: baseState(), date: new Date(START) }),
      h.call({ state: baseState(), date: new Date(START) }),
    );
  });
});

// ─── e2e: inertness + it actually costs money ─────────────────────────────────────

describe('house running cost — e2e', () => {
  const END = Date.UTC(2040, 0, 1);
  const nw = (sim) => Math.round(sim.state.metrics?.netWorth ?? 0);
  const addCost = (amount) => (cfg) => { for (const p of cfg.realProperties) p.annualRunningCost = amount; };

  test('no running cost ⇒ two default runs are byte-identical, no event scheduled', () => {
    const a = loadSim({ simEnd: END, stepTo: END }).sim;
    const b = loadSim({ simEnd: END, stepTo: END }).sim;
    assert.equal(nw(a), nw(b));
    assert.equal(a.queue.data.some(e => e.type === 'HOUSE_RUNNING_COST'), false);
  });

  test('a positive running cost schedules the event and lowers ending net worth', () => {
    const off = loadSim({ simEnd: END, stepTo: END }).sim;
    const on  = loadSim({ mutateCfg: addCost(24000), simEnd: END, stepTo: END });
    assert.equal(on.sim.queue.data.some(e => e.type === 'HOUSE_RUNNING_COST'), true);
    assert.ok(nw(on.sim) < nw(off), 'running costs should reduce ending net worth');
  });
});
