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
 * change-state-residency.test.mjs (design 34 §9 — Phase 3 state move)
 *
 * Verifies CHANGE_STATE_RESIDENCY_APPLY:
 *   - Sets residencyState = destination on every person
 *   - Does NOT mutate citizenship or the residency country
 *   - Handles a null/empty destination (clears the state) and missing people
 *
 * Run with: node --test tests/unit/change-state-residency.test.mjs
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { ChangeStateResidencyApplyReducer }
  from '../../src/finance/reducers/change-state-residency-apply-reducer.js';
import { ChangeStateResidencyHandler }
  from '../../src/finance/handlers/change-state-residency-handler.js';

function makeState(peopleOverrides = {}) {
  return {
    people: {
      primary: { citizen: ['US'],       residency: 'US', residencyState: null, ...peopleOverrides.primary },
      spouse:  { citizen: ['US', 'AU'], residency: 'US', residencyState: null, ...peopleOverrides.spouse  },
    },
  };
}

test('CHANGE_STATE_RESIDENCY_APPLY: sets residencyState to the destination on every person', () => {
  const reducer = new ChangeStateResidencyApplyReducer();
  const next    = reducer.reduce(makeState(), { type: 'CHANGE_STATE_RESIDENCY_APPLY', destination: 'HI' });
  assert.strictEqual(next.people.primary.residencyState, 'HI');
  assert.strictEqual(next.people.spouse.residencyState,  'HI');
});

test('CHANGE_STATE_RESIDENCY_APPLY: does NOT change citizenship or residency country', () => {
  const reducer = new ChangeStateResidencyApplyReducer();
  const next    = reducer.reduce(makeState(), { type: 'CHANGE_STATE_RESIDENCY_APPLY', destination: 'NE' });
  assert.deepStrictEqual(next.people.primary.citizen, ['US']);
  assert.deepStrictEqual(next.people.spouse.citizen,  ['US', 'AU']);
  assert.strictEqual(next.people.primary.residency, 'US');
  assert.strictEqual(next.people.spouse.residency,  'US');
});

test('CHANGE_STATE_RESIDENCY_APPLY: moving between states overwrites the prior state', () => {
  const reducer = new ChangeStateResidencyApplyReducer();
  const state   = makeState({ primary: { residencyState: 'NE' }, spouse: { residencyState: 'NE' } });
  const next    = reducer.reduce(state, { type: 'CHANGE_STATE_RESIDENCY_APPLY', destination: 'SD' });
  assert.strictEqual(next.people.primary.residencyState, 'SD');
  assert.strictEqual(next.people.spouse.residencyState,  'SD');
});

test('CHANGE_STATE_RESIDENCY_APPLY: empty destination clears the state to null', () => {
  const reducer = new ChangeStateResidencyApplyReducer();
  const state   = makeState({ primary: { residencyState: 'HI' }, spouse: { residencyState: 'HI' } });
  const next    = reducer.reduce(state, { type: 'CHANGE_STATE_RESIDENCY_APPLY', destination: '' });
  assert.strictEqual(next.people.primary.residencyState, null);
  assert.strictEqual(next.people.spouse.residencyState,  null);
});

test('CHANGE_STATE_RESIDENCY_APPLY: state without people is handled gracefully', () => {
  const reducer = new ChangeStateResidencyApplyReducer();
  const next    = reducer.reduce({}, { type: 'CHANGE_STATE_RESIDENCY_APPLY', destination: 'NE' });
  assert.ok(next);
});

test('ChangeStateResidencyHandler: emits CHANGE_STATE_RESIDENCY_APPLY carrying the event destination', () => {
  const handler = new ChangeStateResidencyHandler();
  const actions = handler.call({ data: { destination: 'HI' } });
  const apply   = actions.find(a => a.type === 'CHANGE_STATE_RESIDENCY_APPLY');
  assert.ok(apply, 'should emit CHANGE_STATE_RESIDENCY_APPLY');
  assert.strictEqual(apply.destination, 'HI');
  assert.ok(actions.some(a => a.type === 'RECORD_BALANCE'), 'should also emit RECORD_BALANCE');
});
