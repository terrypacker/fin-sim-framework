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
 * behavioral-contribution-suspension.test.mjs
 *
 * Tests for design/29 §3.2 ContributionSuspension and §3.7 CashBucketDrawdown (Increment 6).
 */

import { test, describe } from 'node:test';
import assert              from 'node:assert/strict';

import { REGIME_TAG }       from '../../src/finance/economic-regimes/regime-tag.js';
import { ContributionSuspensionToggleReducer } from '../../src/finance/behavioral/contribution-suspension-toggle-reducer.js';
import { CashBucketDrawdownReducer }           from '../../src/finance/behavioral/cash-bucket-drawdown-reducer.js';

function regime(shockId, tags) {
  return { id: `r-${shockId}`, shockId, tags, currentFactor: 0.2 };
}

// ─── ContributionSuspensionToggleReducer ─────────────────────────────────────

describe('ContributionSuspensionToggleReducer', () => {

  const reducer = new ContributionSuspensionToggleReducer();

  test('CS-1: sets contributionsSuspended=true when ECONOMIC_STRESS regime active', () => {
    const state = {
      contributionsSuspended: false,
      activeRegimes: [regime('s1', [REGIME_TAG.ECONOMIC_STRESS])],
    };
    const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    assert.strictEqual(result.contributionsSuspended, true);
  });

  test('CS-2: clears contributionsSuspended when no ECONOMIC_STRESS regime', () => {
    const state = {
      contributionsSuspended: true,
      activeRegimes: [],
    };
    const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    assert.strictEqual(result.contributionsSuspended, false);
  });

  test('CS-3: no-op when state already matches regime presence (avoids unnecessary clone)', () => {
    const state = {
      contributionsSuspended: false,
      activeRegimes: [],
    };
    const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    // Value unchanged — reducer should not mutate
    assert.strictEqual(result.contributionsSuspended, false);
  });

  test('CS-4: forward-only — no missed-contribution tracking', () => {
    // Suspend then resume; no contributionsMissed field expected
    const stateStressed = {
      contributionsSuspended: false,
      activeRegimes: [regime('s1', [REGIME_TAG.ECONOMIC_STRESS])],
    };
    const stressed = reducer.reduce(stateStressed, { type: 'AU_PERIOD_ADVANCE' });
    assert.strictEqual(stressed.contributionsSuspended, true);
    assert.ok(!('contributionsMissed' in stressed), 'no missed-contribution tracking');

    const stateCalm = { contributionsSuspended: true, activeRegimes: [] };
    const calmed = reducer.reduce(stateCalm, { type: 'US_PERIOD_ADVANCE' });
    assert.strictEqual(calmed.contributionsSuspended, false);
    assert.ok(!('contributionsMissed' in calmed), 'no missed-contribution tracking on resume');
  });

});

// ─── K401ContributionHandler short-circuit (integration check) ───────────────
// We test the handler directly to confirm the state guard works.

describe('Contribution handler short-circuit (ContributionSuspension)', () => {

  test('CS-H1: K401ContributionHandler returns [] when contributionsSuspended=true', async () => {
    const { K401ContributionHandler } = await import('../../src/finance/account-rules/us/k401-classes.js');
    const h = new K401ContributionHandler();
    const actions = h.call({ data: { amount: 1000 }, state: { contributionsSuspended: true } });
    assert.deepStrictEqual(actions, []);
  });

  test('CS-H2: K401ContributionHandler returns actions when contributionsSuspended=false', async () => {
    const { K401ContributionHandler } = await import('../../src/finance/account-rules/us/k401-classes.js');
    const h = new K401ContributionHandler();
    const actions = h.call({ data: { amount: 500 }, state: { contributionsSuspended: false } });
    assert.ok(actions.length > 0, 'should return actions when not suspended');
    assert.strictEqual(actions[0].type, 'K401_CONTRIBUTION_APPLY');
  });

  test('CS-H3: IraContributionHandler returns [] when suspended', async () => {
    const { IraContributionHandler } = await import('../../src/finance/account-rules/us/ira-classes.js');
    const h = new IraContributionHandler();
    const actions = h.call({ data: { amount: 700 }, state: { contributionsSuspended: true } });
    assert.deepStrictEqual(actions, []);
  });

  test('CS-H4: RothContributionHandler returns [] when suspended', async () => {
    const { RothContributionHandler } = await import('../../src/finance/account-rules/us/roth-classes.js');
    const h = new RothContributionHandler();
    const actions = h.call({ data: { amount: 200 }, state: { contributionsSuspended: true } });
    assert.deepStrictEqual(actions, []);
  });

  test('CS-H5: SuperContributionHandler returns [] when suspended', async () => {
    const { SuperContributionHandler } = await import('../../src/finance/account-rules/au/au-super-classes.js');
    const h = new SuperContributionHandler();
    const actions = h.call({ data: { amount: 300 }, state: { contributionsSuspended: true } });
    assert.deepStrictEqual(actions, []);
  });

});

// ─── CashBucketDrawdownReducer ────────────────────────────────────────────────

describe('CashBucketDrawdownReducer', () => {

  const reducer = new CashBucketDrawdownReducer();

  test('CBD-1: activates override on PANIC_SELL_TRIGGER entry', () => {
    const state = {
      activeRegimes: [regime('s1', [REGIME_TAG.PANIC_SELL_TRIGGER])],
      regimeActions: {},
    };
    const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    assert.strictEqual(result.regimeActions.drawdown_source_override.active, true);
  });

  test('CBD-2: activates override on ECONOMIC_STRESS entry', () => {
    const state = {
      activeRegimes: [regime('s2', [REGIME_TAG.ECONOMIC_STRESS])],
      regimeActions: {},
    };
    const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    assert.strictEqual(result.regimeActions.drawdown_source_override.active, true);
  });

  test('CBD-3: reverts override when regime exits', () => {
    const state = {
      activeRegimes: [],
      regimeActions: { drawdown_source_override: { active: true } },
    };
    const result = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    assert.strictEqual(result.regimeActions.drawdown_source_override.active, false);
  });

  test('CBD-4: no-op when already in correct state', () => {
    const stateAlreadyActive = {
      activeRegimes: [regime('s1', [REGIME_TAG.PANIC_SELL_TRIGGER])],
      regimeActions: { drawdown_source_override: { active: true } },
    };
    const r1 = reducer.reduce(stateAlreadyActive, { type: 'US_PERIOD_ADVANCE' });
    // Should return newState but drawdown_source_override unchanged
    assert.strictEqual(r1.regimeActions.drawdown_source_override.active, true);

    const stateAlreadyCalm = {
      activeRegimes: [],
      regimeActions: { drawdown_source_override: { active: false } },
    };
    const r2 = reducer.reduce(stateAlreadyCalm, { type: 'US_PERIOD_ADVANCE' });
    assert.strictEqual(r2.regimeActions?.drawdown_source_override?.active ?? false, false);
  });

});
