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
 * evt-hedged-equity.test.mjs — design 120, currency-hedged and unhedged foreign equity.
 *
 * Phase 1 (§5.3) — the FX process lives in ECONOMIC_REGIMES:
 * EVT-HDG-1  An AU-only plan with the model at NONE carries no FX state and no FX tick, as
 *            before the move.
 * EVT-HDG-2  An AU-only plan can switch the FX process on: the rate walks.
 * EVT-HDG-3  A cross-border plan with both toolsets schedules the FX tick and its reducers
 *            exactly once.
 *
 * Phase 2 (§5.1, §5.6, §5.7 ALIGNED) — the overlay:
 * EVT-HDG-4  Overlay identities on one lot (§7): h = 0 with a flat rate is today exactly;
 *            h = 1 with a flat rate is today plus carry less cost; h = 0 with a moving rate
 *            is (1+g)(1+f)−1 to the cent; a silent security and a domestic market get none.
 * EVT-HDG-5  On AU Single Homeowner, VGS at h = 0 with FX off grows exactly as the silent
 *            VGS does; at h = 1 its lots gain carry − cost a year and nothing else moves.
 * EVT-HDG-6  The year-end FX mark: the reducer is pure, and a run with FX on and a hedged
 *            security stamps every 31 Dec's rate, so f is measured year to year.
 * EVT-HDG-7  A security's hedge ratio and tax treatment are validated where it is built.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { runGolden }                 from '../helpers/golden-harness.js';
import { AuSingleHomeownerScenario } from '../../src/scenarios/au-single-homeowner-scenario.js';
import { IntlRetirementScenario }    from '../../src/scenarios/intl-retirement-scenario.js';
import { computeHoldingsGrowth }     from '../../src/finance/holdings/holdings-earnings.js';
import { buildSecurityRegistry, makeSecurity } from '../../src/finance/holdings/security.js';
import { HedgeFxMarkReducer }        from '../../src/finance/fx/hedge-fx-mark.js';

const AU_SPEC = {
  name: 'hdg-au', cls: AuSingleHomeownerScenario,
  simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2031, 0, 1)),
};

const withParams = (spec, params) => ({
  ...spec, mutateCfg: cfg => Object.assign(cfg.parameters, params),
});

test('EVT-HDG-1: an AU-only plan with FX at NONE carries no FX state and no FX tick', () => {
  const run = runGolden(AU_SPEC);
  for (const key of ['baseExchangeRates', 'effectiveExchangeRates', 'fxDeviation', 'baseFxVol']) {
    assert.equal(run.state[key], undefined, `${key} should be absent`);
  }
  assert.ok(!run.firedActionTypes.has('FX_STEP_APPLY'));
});

test('EVT-HDG-2: an AU-only plan can switch the FX process on, and the rate walks', () => {
  const run = runGolden(withParams(AU_SPEC, { fxProcessModel: 'MEAN_REVERTING', randomSeed: 7 }));
  assert.ok(run.firedActionTypes.has('FX_STEP_APPLY'), 'the FX tick fired');
  assert.notEqual(run.state.fxDeviation.USD_AUD, 0);
  assert.ok(Math.abs(run.state.effectiveExchangeRates.USD_AUD - 1.55) > 1e-9,
    'the composed rate moved off its anchor');
  // No transfer layer without the cross-border toolset.
  assert.equal(run.state.baseFxFees, undefined);
});

test('EVT-HDG-3: a cross-border plan schedules the FX tick and its reducers once', () => {
  const run = runGolden({
    name: 'hdg-intl', cls: IntlRetirementScenario,
    simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2027, 0, 1)),
    params: { fxProcessModel: 'MEAN_REVERTING' },
  });
  const count = type => (run.cfg.reducers ?? []).filter(r => r.__type === type).length;
  for (const type of ['FxRefreshReducer', 'FxProcessReducer', 'FxStepApplyReducer', 'FxTransferApplyReducer']) {
    assert.equal(count(type), 1, `${type} registered once`);
  }
  assert.equal((run.cfg.events ?? []).filter(e => e.type === 'FX_TICK').length, 1);
  assert.equal((run.cfg.handlers ?? []).filter(h => h.__type === 'FxTickHandler').length, 1);
  assert.ok(run.state.baseFxFees, 'the transfer layer is still there');
  assert.ok(run.firedActionTypes.has('FX_STEP_APPLY'));
});

// ── Phase 2 ──────────────────────────────────────────────────────────────────────────

/** One AUD account holding one ex-AU lot of security `s`, plus the overlay's state. */
function lotState({ security = {}, rate = 1.5, mark = 1.5, rateKey = 'EQUITY_INTL_EX_AU' } = {}) {
  return {
    acct: {
      currency: { code: 'AUD' },
      holdings: [{ id: 'h1', allocation: 'EQUITY', rateKey, securityId: 's', marketValue: 100_000 }],
    },
    securities:             buildSecurityRegistry([{ id: 's', rateKey, ...security }]),
    effectiveGrowthRates:   { [rateKey]: 0.07 },
    marketDividendYields:   { [rateKey]: 0.02 },
    effectiveInterestRates: { PRIME_AU: 0.05, PRIME_US: 0.03 },
    effectiveExchangeRates: { USD_AUD: rate },
    hedgeOverlay:           { foreignCashRate: 0.04, cost: 0.00025, fxMark: { USD_AUD: mark } },
  };
}

const grow = state => computeHoldingsGrowth({
  state, stateKey: 'acct', fallbackRateKey: 'EQUITY_AU', yieldPaidSeparately: true,
}).amount;

test('EVT-HDG-4: overlay identities on one lot', () => {
  const today = grow(lotState());                                   // silent security
  assert.equal(today, 5000);                                        // price rate 0.07 − 0.02

  // h = 0, flat rate: exactly today.
  assert.equal(grow(lotState({ security: { hedgeRatio: 0 } })), today);

  // h = 1, flat rate: today plus carry (PRIME_AU − PRIME_US) less cost.
  assert.equal(grow(lotState({ security: { hedgeRatio: 1 } })),
    +(100_000 * (0.05 + 0.05 - 0.03 - 0.00025)).toFixed(2));

  // h = 0, rate up 10%: (1+g)(1+f)−1 with f the basket-scaled move.
  const f = Math.exp(0.86 * Math.log(1.65 / 1.5)) - 1;
  assert.equal(grow(lotState({ security: { hedgeRatio: 0 }, rate: 1.65 })),
    +(100_000 * ((1.05) * (1 + f) - 1)).toFixed(2));

  // h = 1 is indifferent to the rate's move.
  assert.equal(grow(lotState({ security: { hedgeRatio: 1 }, rate: 1.65 })),
    grow(lotState({ security: { hedgeRatio: 1 } })));

  // A silent security ignores the move; a domestic market gets no overlay at all.
  assert.equal(grow(lotState({ rate: 1.65 })), today);
  assert.equal(grow(lotState({ security: { hedgeRatio: 0 }, rate: 1.65, rateKey: 'EQUITY_AU' })),
    grow(lotState({ rateKey: 'EQUITY_AU' })));

  // No US prime in the plan: the foreign cash rate stands in.
  const noUs = lotState({ security: { hedgeRatio: 1 } });
  delete noUs.effectiveInterestRates.PRIME_US;
  assert.equal(grow(noUs), +(100_000 * (0.05 + 0.05 - 0.04 - 0.00025)).toFixed(2));
});

const withVgs = (spec, fields, params = {}) => ({
  ...spec,
  mutateCfg: cfg => {
    cfg.securities = cfg.securities.map(s => (s.id === 'sec-vgs' ? { ...s, ...fields } : s));
    Object.assign(cfg.parameters, params);
  },
});

const vgsValue = state => state.auStockAccount.holdings
  .filter(h => h.securityId === 'sec-vgs').reduce((a, h) => a + h.marketValue, 0);

test('EVT-HDG-5: VGS unhedged at FX off is today; hedged gains carry − cost a year', () => {
  const silent = runGolden(AU_SPEC).state;
  const h0     = runGolden(withVgs(AU_SPEC, { hedgeRatio: 0 })).state;
  const h1     = runGolden(withVgs(AU_SPEC, { hedgeRatio: 1 })).state;

  // h = 0 with no FX layer: every account balance is unchanged to the cent.
  for (const key of ['auStockAccount', 'superAccount', 'auSavingsAccount', 'checkingAccount']) {
    assert.equal(h0[key].balance, silent[key].balance, `${key} unchanged at h = 0`);
  }
  assert.equal(vgsValue(h0), vgsValue(silent));
  assert.ok(h0.hedgeOverlay, 'the overlay state is seeded once a security declares a ratio');
  assert.equal(h0.effectiveExchangeRates, undefined, 'no FX layer is switched on by it');

  // h = 1: the gap is the carry the plan's own rates give, less cost, compounding.
  const carry = h1.effectiveInterestRates.PRIME_AU - h1.hedgeOverlay.foreignCashRate - h1.hedgeOverlay.cost;
  const diff  = vgsValue(h1) - vgsValue(silent);
  assert.notEqual(diff, 0);
  assert.equal(Math.sign(diff), Math.sign(carry), 'VGS moves the way the carry points');
  // Super holds no hedged security, so it does not move.
  assert.equal(h1.superAccount.balance, silent.superAccount.balance);
});

test('EVT-HDG-6: the year-end FX mark', () => {
  // Isolated: a pure write, input untouched.
  const before = Object.freeze({ hedgeOverlay: Object.freeze({ cost: 0.1, fxMark: { USD_AUD: 1 } }) });
  const after  = new HedgeFxMarkReducer().reduce(before, { type: 'HEDGE_FX_MARK_APPLY', rates: { USD_AUD: 1.7 } });
  assert.equal(after.hedgeOverlay.fxMark.USD_AUD, 1.7);
  assert.equal(after.hedgeOverlay.cost, 0.1);
  assert.equal(before.hedgeOverlay.fxMark.USD_AUD, 1);

  // In a run: the mark is the rate as of the last 31 Dec, and FX moves VGS.
  const fxOn = { fxProcessModel: 'MEAN_REVERTING', randomSeed: 11 };
  const run  = runGolden(withVgs(AU_SPEC, { hedgeRatio: 0 }, fxOn));
  assert.ok(run.firedActionTypes.has('HEDGE_FX_MARK_APPLY'));
  const marks = run.sim.journal.journal.filter(e => e.action?.type === 'HEDGE_FX_MARK_APPLY');
  assert.equal(marks.length, 5, 'one mark per year-end');
  for (const e of marks) {
    const d = new Date(e.date);
    assert.deepEqual([d.getUTCMonth(), d.getUTCDate()], [11, 31], 'stamped on 31 Dec');
  }
  assert.deepEqual(run.state.hedgeOverlay.fxMark, marks.at(-1).action.data.rates);
  // Each mark is a different rate: the year's f is measured from the one before.
  assert.equal(new Set(marks.map(e => e.action.data.rates.USD_AUD)).size, 5);
  // The first year's VGS growth: the silent lot ignores the AUD's move, the unhedged lot
  // takes it. (The plan sells its VGS early, so a terminal balance would not show it.)
  const vgsGrowth2026 = r => r.sim.journal.journal.find(e => e.action?.type === 'HOLDING_TRANSACT'
    && e.action.data?.holdingId === 'h-vgs' && e.event?.type === 'INTL_AU_STOCK_EARNINGS').action.data.marketValueDelta;
  const silentFx = runGolden(withParams(AU_SPEC, fxOn));
  assert.notEqual(vgsGrowth2026(run), vgsGrowth2026(silentFx), 'an unhedged lot now carries the AUD move');
});

test('EVT-HDG-7: hedge fields are validated where the security is built', () => {
  assert.throws(() => makeSecurity({ id: 'x', hedgeRatio: 1.5 }), /between 0 and 1/);
  assert.throws(() => makeSecurity({ id: 'x', hedgeRatio: -0.1 }), /between 0 and 1/);
  assert.throws(() => makeSecurity({ id: 'x', hedgeTaxTreatment: 'CAPITAL' }), /ALIGNED or INCOME/);
  assert.equal(makeSecurity({ id: 'x', hedgeRatio: 0.255, hedgeTaxTreatment: 'INCOME' }).hedgeRatio, 0.255);
});
