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
 * mortality-estate-basis.test.mjs
 *
 * Tests for design/27 Increment 4 — estate basis step-up on death.
 *
 *  EB-1: US-resident-at-death produces HOLDING_SET_BASIS actions for each holding
 *  EB-2: AU-resident-at-death produces no HOLDING_SET_BASIS actions
 *  EB-3: Basis set to marketValue (step-up), not the old costBasis
 *  EB-4: AU-resident widow inheriting from US-resident deceased still gets step-up
 *        (rule keys off deceased's taxJurisdiction, not survivor's)
 *  EB-5: HOLDING_SET_BASIS actions appear before ACCOUNT_RETITLE_APPLY in the chain
 *  EB-6: Account with no holdings array emits no HOLDING_SET_BASIS actions
 */

import { test }  from 'node:test';
import assert     from 'node:assert/strict';

import { MortalityHandler } from '../../src/finance/handlers/mortality-handler.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeState({ deceasedResidency = 'US', survivorResidency = 'US', holdings = null } = {}) {
  const state = {
    people: {
      primary: { residency: deceasedResidency, socialSecurityMonthly: 1000 },
      spouse:  { residency: survivorResidency, socialSecurityMonthly: 800  },
    },
    expenses: { essential: 4000, discretionary: 2000 },
  };

  if (holdings !== false) {
    // Default: one account owned by the deceased with two holdings
    state.iraAccount = {
      ownerId:  'primary',
      balance:  200_000,
      holdings: holdings ?? [
        { id: 'h1', marketValue: 120_000, costBasis:  80_000 },
        { id: 'h2', marketValue:  80_000, costBasis: 100_000 },
      ],
    };
  }

  return state;
}

function callHandler(state, personId = 'primary') {
  const handler = new MortalityHandler();
  const event   = { type: 'PERSON_DIED', date: new Date('2045-06-01'), data: { personId } };
  return handler.call({ state, event });
}

// ── EB-1 ──────────────────────────────────────────────────────────────────────

test('EB-1: US-resident-at-death produces HOLDING_SET_BASIS actions for each holding', () => {
  const actions = callHandler(makeState({ deceasedResidency: 'US' }));
  const basisActions = actions.filter(a => a.type === 'HOLDING_SET_BASIS');
  assert.strictEqual(basisActions.length, 2, 'should emit one action per holding');
  assert.ok(basisActions.some(a => a.holdingId === 'h1'), 'h1 should be stepped up');
  assert.ok(basisActions.some(a => a.holdingId === 'h2'), 'h2 should be stepped up');
});

// ── EB-2 ──────────────────────────────────────────────────────────────────────

test('EB-2: AU-resident-at-death produces no HOLDING_SET_BASIS actions', () => {
  const actions = callHandler(makeState({ deceasedResidency: 'AUS' }));
  const basisActions = actions.filter(a => a.type === 'HOLDING_SET_BASIS');
  assert.strictEqual(basisActions.length, 0, 'AU CGT cost-base carries over; no step-up');
});

// ── EB-3 ──────────────────────────────────────────────────────────────────────

test('EB-3: HOLDING_SET_BASIS sets costBasis to the holding marketValue', () => {
  const actions = callHandler(makeState({ deceasedResidency: 'US' }));
  const h1Action = actions.find(a => a.type === 'HOLDING_SET_BASIS' && a.holdingId === 'h1');
  const h2Action = actions.find(a => a.type === 'HOLDING_SET_BASIS' && a.holdingId === 'h2');
  assert.strictEqual(h1Action.costBasis, 120_000, 'h1 costBasis stepped up to marketValue');
  assert.strictEqual(h2Action.costBasis,  80_000, 'h2 costBasis stepped up to marketValue (even if below old basis)');
  assert.strictEqual(h1Action.stateKey, 'iraAccount', 'stateKey correct');
});

// ── EB-4 ──────────────────────────────────────────────────────────────────────

test('EB-4: AU-resident widow inheriting from US-resident deceased still gets step-up', () => {
  // The rule keys off deceased taxJurisdiction (US), not survivor's residency (AUS)
  const actions = callHandler(makeState({ deceasedResidency: 'US', survivorResidency: 'AUS' }));
  const basisActions = actions.filter(a => a.type === 'HOLDING_SET_BASIS');
  assert.strictEqual(basisActions.length, 2, 'step-up applies regardless of survivor residency');
});

// ── EB-5 ──────────────────────────────────────────────────────────────────────

test('EB-5: HOLDING_SET_BASIS actions appear before ACCOUNT_RETITLE_APPLY in the action chain', () => {
  const actions = callHandler(makeState({ deceasedResidency: 'US' }));
  const lastBasisIdx  = actions.map(a => a.type).lastIndexOf('HOLDING_SET_BASIS');
  const retitleIdx    = actions.findIndex(a => a.type === 'ACCOUNT_RETITLE_APPLY');
  assert.ok(lastBasisIdx !== -1, 'should have HOLDING_SET_BASIS actions');
  assert.ok(retitleIdx   !== -1, 'should have ACCOUNT_RETITLE_APPLY');
  assert.ok(lastBasisIdx < retitleIdx, 'all basis step-ups must precede account retitle');
});

// ── EB-6 ──────────────────────────────────────────────────────────────────────

test('EB-6: account with no holdings array emits no HOLDING_SET_BASIS actions', () => {
  const state = makeState({ holdings: false });
  // Add an account with ownerId but no holdings array
  state.savingsAccount = { ownerId: 'primary', balance: 50_000 };

  const actions = callHandler(state);
  const basisActions = actions.filter(a => a.type === 'HOLDING_SET_BASIS');
  assert.strictEqual(basisActions.length, 0, 'non-holding accounts skipped silently');
});
