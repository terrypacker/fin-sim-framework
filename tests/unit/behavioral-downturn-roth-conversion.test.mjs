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
 * behavioral-downturn-roth-conversion.test.mjs
 *
 * Tests for design/29 §3.6 DownturnRothConversionReducer (Increment 3):
 *   - Fires ROTH_CONVERSION_APPLY once on first regime-active period
 *   - Idempotent: subsequent period-advances with same regime → no extra fire
 *   - Fires only for PANIC_SELL_TRIGGER or ECONOMIC_STRESS tagged regimes
 *   - Skips when IRA balance = 0
 *   - Caps amount at IRA balance
 *   - Fires again for a NEW shock entry (different shockId)
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { DownturnRothConversionReducer } from '../../src/finance/behavioral/downturn-roth-conversion-reducer.js';
import { REGIME_TAG }                   from '../../src/finance/economic-regimes/regime-tag.js';

function regime(shockId, tags = [REGIME_TAG.PANIC_SELL_TRIGGER]) {
  return { id: `regime-${shockId}`, shockId, tags };
}

function makeState({ regimes = [], regimeActions = {}, iraBalance = 100000 } = {}) {
  return {
    activeRegimes: regimes,
    regimeActions,
    iraAccount:    { balance: iraBalance },
    rothAccount:   { balance: 50000 },
    people:        { primary: { residency: 'US' } },
  };
}

const reducer = new DownturnRothConversionReducer({ downturnConversionAmount: 20000 });

test('DRC-1: fires ROTH_CONVERSION_APPLY on first qualifying regime entry', () => {
  const state = makeState({ regimes: [regime('shock1')] });
  const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });

  const convActions = result.next.filter(a => a.type === 'ROTH_CONVERSION_APPLY');
  assert.strictEqual(convActions.length, 1);
  assert.strictEqual(convActions[0].amount, 20000);
  assert.strictEqual(convActions[0].iraKey,  'iraAccount');
  assert.strictEqual(convActions[0].rothKey, 'rothAccount');
});

test('DRC-2: idempotent — second period-advance with same regime does not fire again', () => {
  const state = makeState({
    regimes: [regime('shock1')],
    regimeActions: { downturn_roth_conversion: { firedForShocks: ['shock1'] } },
  });
  const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
  const convActions = result.next.filter(a => a.type === 'ROTH_CONVERSION_APPLY');
  assert.strictEqual(convActions.length, 0, 'should not fire again for same shock');
});

test('DRC-3: fires for ECONOMIC_STRESS tag as well', () => {
  const state = makeState({ regimes: [regime('shock2', [REGIME_TAG.ECONOMIC_STRESS])] });
  const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
  const convActions = result.next.filter(a => a.type === 'ROTH_CONVERSION_APPLY');
  assert.strictEqual(convActions.length, 1);
});

test('DRC-4: no-op when no active regimes', () => {
  const state = makeState({ regimes: [] });
  const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
  const convActions = result.next.filter(a => a.type === 'ROTH_CONVERSION_APPLY');
  assert.strictEqual(convActions.length, 0);
});

test('DRC-5: no-op when regime tags do not include PANIC_SELL_TRIGGER or ECONOMIC_STRESS', () => {
  const state = makeState({ regimes: [regime('shock3', ['SOME_OTHER_TAG'])] });
  const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
  const convActions = result.next.filter(a => a.type === 'ROTH_CONVERSION_APPLY');
  assert.strictEqual(convActions.length, 0);
});

test('DRC-6: no-op when IRA balance is zero', () => {
  const state = makeState({ regimes: [regime('shock4')], iraBalance: 0 });
  const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
  const convActions = result.next.filter(a => a.type === 'ROTH_CONVERSION_APPLY');
  assert.strictEqual(convActions.length, 0);
});

test('DRC-7: caps amount at IRA balance', () => {
  const state = makeState({ regimes: [regime('shock5')], iraBalance: 5000 });
  const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
  const convActions = result.next.filter(a => a.type === 'ROTH_CONVERSION_APPLY');
  assert.strictEqual(convActions.length, 1);
  assert.strictEqual(convActions[0].amount, 5000);  // capped at IRA balance
});

test('DRC-8: fires again for a NEW shock (different shockId)', () => {
  const state = makeState({
    regimes: [regime('shock6')],
    regimeActions: { downturn_roth_conversion: { firedForShocks: ['shock_old'] } },
  });
  const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
  const convActions = result.next.filter(a => a.type === 'ROTH_CONVERSION_APPLY');
  assert.strictEqual(convActions.length, 1, 'new shock should trigger conversion');
});

test('DRC-9: updates regimeActions.firedForShocks after firing', () => {
  const state = makeState({ regimes: [regime('shock7')] });
  const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
  const fired = result.regimeActions.downturn_roth_conversion.firedForShocks;
  assert.ok(fired.includes('shock7'), 'shockId should be recorded in firedForShocks');
});
