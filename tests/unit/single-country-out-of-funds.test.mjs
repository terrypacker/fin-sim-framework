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
 * A single-country plan that runs out of money must say so.
 *
 * The spending path and both tax-payment debits escalate an uncovered shortfall to
 * INTL_TRANSFER_APPLY, whose reducer is registered only by US_AU_CROSS_BORDER. On the
 * AU and US single-homeowner plans that escalation had no reducer and was dropped, so an
 * exhausted plan floored its cash account forever with scenarioFailed never set and no
 * cumulativeDeficit — MC reported 0 failures on paths that ran dry in the 2050s.
 * escalateShortfall now reports OUT_OF_FUNDS when there is no other country to draw from.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { runGolden } from '../helpers/golden-harness.js';
import { AuSingleHomeownerScenario } from '../../src/scenarios/au-single-homeowner-scenario.js';
import { UsSingleHomeownerScenario } from '../../src/scenarios/us-single-homeowner-scenario.js';
import { escalateShortfall } from '../../src/finance/account-rules/shortfall-escalation.js';

const run = (cls, params = {}) => runGolden({
  name: 'single-country-oof', cls, params, simStart: '2026-01-01', simEnd: '2066-01-01',
}).sim;

for (const [label, cls] of [['AU', AuSingleHomeownerScenario], ['US', UsSingleHomeownerScenario]]) {
  test(`${label} single homeowner: an unfundable expense load records the failure`, () => {
    const sim = run(cls, { monthlyExpenses: 40_000 });
    assert.equal(sim.state.scenarioFailed, true);
    assert.ok(sim.state.outOfFundsDate instanceof Date, 'outOfFundsDate stamped');
    assert.ok(sim.state.cumulativeDeficit > 1_000_000, `deficit ${sim.state.cumulativeDeficit}`);
    assert.ok(sim.state.deficitMonths > 100, `deficitMonths ${sim.state.deficitMonths}`);
    assert.deepEqual(Object.fromEntries(sim.unreducedActionTypes), {},
      'nothing — least of all the INTL_TRANSFER_APPLY escalation — may be dropped');
  });
}

test('AU single homeowner: a solvent run reads "not failed", not undefined', () => {
  const s = run(AuSingleHomeownerScenario).state;
  assert.equal(s.scenarioFailed, false);
  assert.equal(s.outOfFundsDate, null);
  assert.equal(s.cumulativeDeficit, 0);
  assert.equal(s.deficitMonths, 0);
});

test('escalateShortfall crosses the border only when the other country has an account', () => {
  const withUs = escalateShortfall({
    state: { usSavingsAccount: { balance: 0 } }, toCountry: 'AU', deficit: 500, dstKey: 'auTax',
  });
  assert.deepEqual(withUs, { crossBorder: true, actions: [
    { type: 'INTL_TRANSFER_APPLY', direction: 'US_TO_AU', targetDeficit: 500, dstKey: 'auTax' },
  ] });

  const auOnly = escalateShortfall({ state: { auSavingsAccount: {} }, toCountry: 'AU', deficit: 500 });
  assert.deepEqual(auOnly, { crossBorder: false, actions: [
    { type: 'OUT_OF_FUNDS', deficit: 500, currency: 'AUD' },
  ] });

  const flagged = escalateShortfall({
    state: { myUsChecking: {} }, toCountry: 'AU', deficit: 500,
    stateRegistry: { resolveTransactionAccountKey: c => (c === 'US' ? 'myUsChecking' : null) },
  });
  assert.equal(flagged.crossBorder, true, 'a flagged transaction account is a counterpart');

  assert.deepEqual(escalateShortfall({ state: {}, toCountry: 'US', deficit: 0.004 }),
    { crossBorder: false, actions: [] }, 'dust is not an insolvency');
});
