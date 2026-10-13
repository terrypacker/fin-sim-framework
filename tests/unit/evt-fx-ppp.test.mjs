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
 * evt-fx-ppp.test.mjs — the USD_AUD anchor follows the AU/US inflation gap (design 122).
 *
 * PPP-1  equal inflation in both countries: the rate never moves and no fxPppIndex key is
 *        written, so the run is byte-identical to one without the reducer
 * PPP-2  AU 5% / US 3%: after each sampling advance the index is exactly AU ÷ US accumulator
 *        and the rate is the authored rate × that index (NONE process); a plan starting in
 *        January samples on the US advance, one starting in July–December on the AU one
 * PPP-3  fxPurchasingPowerParity false: the same gap leaves the rate at the authored level
 * PPP-4  a fresh anchor is (base + regime drift) × index, so regime drift scales with the
 *        level; an FX_STEP_APPLY reads the stored anchor back without scaling it twice
 * PPP-5  FxPppReducer stores the index only (the rate is composed in one place), and writes
 *        nothing when an accumulator is missing or the index is unchanged
 * PPP-6  the move freezes expenseRebaseRates = authored rate × index (design 122 §3.3);
 *        with no index, or an index of exactly 1, nothing is stamped
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';
import { FxProcessReducer } from '../../src/finance/fx/fx-process-reducer.js';
import { FxPppReducer, pppIndexUsdAud, pppSampleAdvance } from '../../src/finance/fx/fx-ppp-reducer.js';
import { ChangeResidencyApplyReducer } from '../../src/finance/reducers/change-residency-apply-reducer.js';

beforeEach(() => ServiceRegistry.resetAll());

function loadScenario(config) {
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(config.simStart),
    simEnd:   new Date(config.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(structuredClone(config), services);
  return scenario.sim;
}

function makeConfig({ us = 0.03, au = 0.03, ppp } = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER', 'ECONOMIC_REGIMES'],
    simStart: '2026-01-01',
    simEnd:   '2032-01-01',
    parameters: {
      monthlyExpenses: 0, inflationRate: us, auInflationRate: au,
      usSavingsInterestRate: 0, auSavingsInterestRate: 0,
      exchangeRateUsdToAud: 1.55, intlTransferFeeUsd: 15, fxProcessModel: 'NONE',
      ...(ppp === undefined ? {} : { fxPurchasingPowerParity: ppp }),
    },
    persons: [{
      __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1966-01-01',
      citizen: ['US', 'AU'], lifeExpectancy: 90, monthlyWage: 0,
      retirementDate: '2025-01-01', socialSecurityMonthly: 0,
    }],
    accounts: [
      {
        __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings',
        role: 'us-savings', stateKey: 'usSavingsAccount',
        initialValue: 10000, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
      },
      {
        __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings',
        role: 'au-savings', stateKey: 'auSavingsAccount',
        initialValue: 0, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: '$' },
      },
    ],
  };
}

/** Step month by month; record the rate, the index and both accumulators. */
function walk(sim, months = 70) {
  const out = [];
  for (let m = 1; m <= months; m++) {
    sim.stepTo(new Date(Date.UTC(2026, m, 1)));
    const s = sim.state;
    out.push({ m, rate: s.effectiveExchangeRates?.USD_AUD, idx: s.fxPppIndex?.USD_AUD,
      au: s.inflationAccumulator?.AU, us: s.inflationAccumulator?.US });
  }
  return out;
}

test('PPP-1: equal inflation never moves the rate and writes no index', () => {
  for (const simStart of ['2026-01-01', '2026-09-04']) {
  ServiceRegistry.resetAll();
  const path = walk(loadScenario({ ...makeConfig({ us: 0.03, au: 0.03 }), simStart }));
  assert.ok(path.at(-1).au > 1.1 && path.at(-1).us > 1.1, 'both accumulators advanced');
  for (const p of path) {
    assert.equal(p.rate, 1.55, `month ${p.m}`);
    assert.equal(p.idx, undefined, `start ${simStart} month ${p.m}: no fxPppIndex key`);
  }
  }
});

test('PPP-2: a gap moves the rate by exactly the accumulator ratio, sampled once a year', () => {
  assert.equal(pppSampleAdvance(new Date('2026-01-01')), 'US_PERIOD_ADVANCE');
  assert.equal(pppSampleAdvance(new Date('2026-06-30')), 'US_PERIOD_ADVANCE');
  assert.equal(pppSampleAdvance(new Date('2026-07-01')), 'AU_PERIOD_ADVANCE');
  assert.equal(pppSampleAdvance(new Date('2026-09-04')), 'AU_PERIOD_ADVANCE');
  const path = walk(loadScenario(makeConfig({ us: 0.03, au: 0.05 })));
  // Jan start: sampled after each 1 Jan US advance, applied at the next fresh anchor (1 Jul)
  const febs = path.filter(p => (p.m % 12) === 1 && p.m > 1);
  assert.ok(febs.length >= 4);
  for (const p of febs) assert.equal(p.idx, p.au / p.us, `month ${p.m}: index is AU ÷ US`);
  for (const p of path.filter(p => (p.m % 12) === 7 && p.m > 12)) {
    const idx = path.find(q => q.m === p.m - 6).idx;
    assert.equal(p.rate, 1.55 * idx, `month ${p.m}: authored × the January index`);
  }
  assert.ok(path.at(-1).rate > 1.55 * 1.08, `AUD weakened: ${path.at(-1).rate}`);
  // a step function: constant between the fresh anchors that apply a new index
  const y = path.filter(p => p.m >= 31 && p.m <= 41);   // Aug 2028 .. Jun 2029
  assert.ok(y.every(p => p.rate === y[0].rate), 'no movement between applications');
});

test('PPP-3: the switch off pins the rate', () => {
  const path = walk(loadScenario(makeConfig({ us: 0.03, au: 0.05, ppp: false })));
  for (const p of path) {
    assert.equal(p.rate, 1.55, `month ${p.m}`);
    assert.equal(p.idx, undefined);
  }
});

test('PPP-4: a fresh anchor is (base + drift) × index; a step reads the stored anchor back', () => {
  const r = new FxProcessReducer();
  const fresh = r.reduce({
    effectiveExchangeRates: { USD_AUD: 1.55 + 0.25 },   // base + a regime fxAdjustment
    fxPppIndex: { USD_AUD: 2 }, fxDeviation: { USD_AUD: 0.1 },
  }, { type: 'RECOMPUTE_REGIMES' });
  assert.equal(fresh.fxAnchorRates.USD_AUD, (1.55 + 0.25) * 2);
  assert.equal(fresh.effectiveExchangeRates.USD_AUD, (1.55 + 0.25) * 2 * Math.exp(0.1));

  const stepped = r.reduce({ ...fresh, fxDeviation: { USD_AUD: -0.05 } }, { type: 'FX_STEP_APPLY' });
  assert.equal(stepped.fxAnchorRates, fresh.fxAnchorRates, 'a step does not recapture the anchor');
  assert.equal(stepped.effectiveExchangeRates.USD_AUD, (1.55 + 0.25) * 2 * Math.exp(-0.05));
});

test('PPP-5: FxPppReducer stores the index only, and is silent when nothing changed', () => {
  const r = new FxPppReducer({ sampleOn: 'US_PERIOD_ADVANCE' });
  assert.deepEqual(r.reducedActionTypes, ['US_PERIOD_ADVANCE']);
  assert.equal(FxPppReducer.fromJSON(r.toJSON()).sampleOn, 'US_PERIOD_ADVANCE');
  const state = {
    inflationAccumulator: { US: 1.2, AU: 1.5 },
    fxPppIndex: { USD_AUD: 1.1 }, fxAnchorRates: { USD_AUD: 1.7 }, effectiveExchangeRates: { USD_AUD: 1.8 },
  };
  const next = r.reduce(state, { type: 'US_PERIOD_ADVANCE' });
  assert.equal(next.fxPppIndex.USD_AUD, 1.25);
  assert.equal(next.fxAnchorRates, state.fxAnchorRates);
  assert.equal(next.effectiveExchangeRates, state.effectiveExchangeRates);

  assert.equal(pppIndexUsdAud({ inflationAccumulator: { AU: 1.3 } }), null);
  const noUs = r.reduce({ ...state, inflationAccumulator: { AU: 1.3 } }, { type: 'US_PERIOD_ADVANCE' });
  assert.equal(noUs.fxPppIndex, state.fxPppIndex, 'single-country: untouched');
  const same = r.reduce({ ...state, inflationAccumulator: { US: 1.25, AU: 1.375 } }, { type: 'US_PERIOD_ADVANCE' });
  assert.equal(same.fxPppIndex, state.fxPppIndex, 'unchanged index: untouched');
});

test('PPP-6: the move freezes the expense conversion rate at authored × index', () => {
  const r = new ChangeResidencyApplyReducer({
    accountService: { recordResidencyChange: () => {} },
    stateRegistry:  { getAccounts: () => [] },
  });
  const base = { baseExchangeRates: { USD_AUD: 1.55 }, people: { primary: { residency: 'US' } } };
  const moved = r.reduce({ ...base, fxPppIndex: { USD_AUD: 1.2 } }, { type: 'CHANGE_RESIDENCY_APPLY' }, new Date('2031-07-01'));
  assert.equal(moved.expenseRebaseRates.USD_AUD, 1.55 * 1.2);
  assert.equal(moved.people.primary.residency, 'AU');

  for (const s of [base, { ...base, fxPppIndex: { USD_AUD: 1 } }]) {
    const out = r.reduce(s, { type: 'CHANGE_RESIDENCY_APPLY' }, new Date('2031-07-01'));
    assert.equal(out.expenseRebaseRates, undefined, 'no gap: converts at the authored rate');
  }
});
