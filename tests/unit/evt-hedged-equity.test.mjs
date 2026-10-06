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
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { runGolden }                 from '../helpers/golden-harness.js';
import { AuSingleHomeownerScenario } from '../../src/scenarios/au-single-homeowner-scenario.js';
import { IntlRetirementScenario }    from '../../src/scenarios/intl-retirement-scenario.js';

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
