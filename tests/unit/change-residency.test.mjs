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
 * change-residency.test.mjs
 *
 * Verifies that CHANGE_RESIDENCY_APPLY:
 *   - Flips every person's residency to 'AUS'
 *   - Does NOT mutate citizen arrays
 *   - A US-only citizen who moves stays citizen: ['US']
 *
 * Run with: node --test tests/unit/change-residency.test.mjs
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { ChangeResidencyApplyReducer } from '../../src/finance/reducers/change-residency-apply-reducer.js';

function makeReducer() {
  // Minimal stubs — recordResidencyChange is a no-op; getAccounts returns []
  const accountService = { recordResidencyChange: () => {} };
  const stateRegistry  = { getAccounts: () => [] };
  return new ChangeResidencyApplyReducer({ accountService, stateRegistry });
}

function makeState(peopleOverrides = {}) {
  return {
    people: {
      primary: { citizen: ['US'],       residency: 'US', ...peopleOverrides.primary },
      spouse:  { citizen: ['US', 'AUS'], residency: 'US', ...peopleOverrides.spouse  },
    },
  };
}

test('CHANGE_RESIDENCY_APPLY: flips every person residency to AUS', () => {
  const reducer = makeReducer();
  const state   = makeState();
  const next    = reducer.reduce(state);
  assert.strictEqual(next.people.primary.residency, 'AUS');
  assert.strictEqual(next.people.spouse.residency,  'AUS');
});

test('CHANGE_RESIDENCY_APPLY: does NOT add AUS to citizen arrays', () => {
  const reducer = makeReducer();
  const state   = makeState();
  const next    = reducer.reduce(state);
  assert.deepStrictEqual(next.people.primary.citizen, ['US']);
  assert.deepStrictEqual(next.people.spouse.citizen,  ['US', 'AUS']);
});

test('CHANGE_RESIDENCY_APPLY: US-only citizen who moves stays citizen [US]', () => {
  const reducer = makeReducer();
  const state   = makeState({ primary: { citizen: ['US'], residency: 'US' } });
  const next    = reducer.reduce(state);
  assert.deepStrictEqual(next.people.primary.citizen, ['US']);
  assert.strictEqual(next.people.primary.residency, 'AUS');
});

test('CHANGE_RESIDENCY_APPLY: idempotent — applying twice keeps residency AUS', () => {
  const reducer = makeReducer();
  const state   = makeState();
  const once    = reducer.reduce(state);
  const twice   = reducer.reduce(once);
  assert.strictEqual(twice.people.primary.residency, 'AUS');
});

test('CHANGE_RESIDENCY_APPLY: state without people is handled gracefully', () => {
  const reducer = makeReducer();
  const next    = reducer.reduce({});
  assert.ok(next);
});
