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
 * evt-person-died.test.mjs
 *
 * Tests for design/27 Increment 1 — deterministic mortality + survivor core.
 *
 *  MORT-1: PersonDiedApplyReducer records death and removes person from state.people
 *  MORT-2: SocialSecuritySurvivorApplyReducer sets survivor SS to max(self, deceased)
 *  MORT-3: SocialSecuritySurvivorApplyReducer keeps survivor SS when it's already higher
 *  MORT-4: AccountRetitleApplyReducer retitles solo-owned accounts to survivor
 *  MORT-5: AccountRetitleApplyReducer does NOT retitle accounts owned by survivor
 *  MORT-6: MortalityHandler emits full action chain when a spouse survives
 *  MORT-7: MortalityHandler emits only PERSON_DIED_APPLY + SCENARIO_COMPLETE_CHECK when no spouse
 *  MORT-8: MortalityHandler captures expense deltas per-slice (essential + discretionary)
 *  MORT-9: ScenarioCompleteReducer sets scenarioComplete when state.people is empty
 *  MORT-10: ScenarioCompleteReducer does NOT set scenarioComplete when a survivor remains
 */

import { test }   from 'node:test';
import assert      from 'node:assert/strict';

import { PersonDiedApplyReducer }             from '../../src/finance/reducers/person-died-apply-reducer.js';
import { SocialSecuritySurvivorApplyReducer } from '../../src/finance/reducers/social-security-survivor-apply-reducer.js';
import { AccountRetitleApplyReducer }         from '../../src/finance/reducers/account-retitle-apply-reducer.js';
import { ScenarioCompleteReducer }            from '../../src/finance/reducers/scenario-complete-reducer.js';
import { MortalityHandler }                  from '../../src/finance/handlers/mortality-handler.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function basePeople() {
  return {
    primary: { id: 'primary', name: 'Alice', socialSecurityMonthly: 2_000, residency: 'US' },
    spouse:  { id: 'spouse',  name: 'Bob',   socialSecurityMonthly: 1_500, residency: 'US' },
  };
}

function baseState(overrides = {}) {
  return {
    people:        basePeople(),
    deceased:      {},
    scenarioComplete: false,
    expenses: { essential: 4_200, discretionary: 1_800 },
    monthlyExpenses: 6_000,
    ...overrides,
  };
}

function makeEvent(personId) {
  return { type: 'PERSON_DIED', date: new Date('2050-01-01'), data: { personId } };
}

// ── Reducer instances ─────────────────────────────────────────────────────────

const personDiedR   = new PersonDiedApplyReducer();
const ssR           = new SocialSecuritySurvivorApplyReducer();
const retitleR      = new AccountRetitleApplyReducer();
const completeR     = new ScenarioCompleteReducer();

// ── MORT-1 ────────────────────────────────────────────────────────────────────

test('MORT-1: PersonDiedApplyReducer records death and removes person from state.people', () => {
  const state = baseState();
  const action = {
    type: 'PERSON_DIED_APPLY', personId: 'primary',
    date: new Date('2050-01-01'), taxJurisdiction: 'US',
  };
  const next = personDiedR.reduce(state, action);

  assert.ok(next.deceased.primary, 'deceased map should have primary entry');
  assert.strictEqual(next.deceased.primary.taxJurisdiction, 'US');
  assert.ok(next.deceased.primary.date instanceof Date);
  assert.strictEqual(next.people.primary, undefined, 'primary should be removed from state.people');
  assert.ok(next.people.spouse, 'spouse should still be in state.people');
});

// ── MORT-2 ────────────────────────────────────────────────────────────────────

test('MORT-2: SocialSecuritySurvivorApplyReducer sets survivor SS to deceased SS when deceased is higher', () => {
  const state  = baseState();
  const action = {
    type: 'SOCIAL_SECURITY_SURVIVOR_APPLY',
    survivorId: 'spouse', deceasedSocialSecurityMonthly: 2_000,
  };
  const next = ssR.reduce(state, action);
  assert.strictEqual(next.people.spouse.socialSecurityMonthly, 2_000);
});

// ── MORT-3 ────────────────────────────────────────────────────────────────────

test('MORT-3: SocialSecuritySurvivorApplyReducer keeps survivor SS when it is already higher', () => {
  const state = baseState({
    people: {
      ...basePeople(),
      spouse: { ...basePeople().spouse, socialSecurityMonthly: 3_000 },
    },
  });
  const action = {
    type: 'SOCIAL_SECURITY_SURVIVOR_APPLY',
    survivorId: 'spouse', deceasedSocialSecurityMonthly: 2_000,
  };
  const next = ssR.reduce(state, action);
  assert.strictEqual(next.people.spouse.socialSecurityMonthly, 3_000);
});

// ── MORT-4 ────────────────────────────────────────────────────────────────────

test('MORT-4: AccountRetitleApplyReducer retitles solo-owned accounts to survivor', () => {
  const state = baseState({
    iraAccount: { balance: 100_000, stateKey: 'iraAccount', ownerId: 'primary' },
    rothAccount: { balance: 50_000, stateKey: 'rothAccount', ownerId: 'primary' },
  });
  const action = { type: 'ACCOUNT_RETITLE_APPLY', deceasedId: 'primary', survivorId: 'spouse' };
  const next   = retitleR.reduce(state, action);

  assert.strictEqual(next.iraAccount.ownerId, 'spouse', 'IRA should transfer to spouse');
  assert.strictEqual(next.rothAccount.ownerId, 'spouse', 'Roth should transfer to spouse');
});

// ── MORT-5 ────────────────────────────────────────────────────────────────────

test('MORT-5: AccountRetitleApplyReducer does NOT touch accounts owned by survivor or no-one', () => {
  const state = baseState({
    spouseRoth: { balance: 30_000, stateKey: 'spouseRoth', ownerId: 'spouse' },
    savings:    { balance: 20_000, stateKey: 'savings',    ownerId: null     },
  });
  const action = { type: 'ACCOUNT_RETITLE_APPLY', deceasedId: 'primary', survivorId: 'spouse' };
  const next   = retitleR.reduce(state, action);

  assert.strictEqual(next.spouseRoth.ownerId, 'spouse', "survivor's account should be unchanged");
  assert.strictEqual(next.savings.ownerId, null, 'null-owner account should be unchanged');
});

// ── MORT-6 ────────────────────────────────────────────────────────────────────

test('MORT-6: MortalityHandler emits full action chain when a spouse survives', () => {
  const handler = new MortalityHandler({ survivorEssentialMultiplier: 0.85, survivorDiscretionaryMultiplier: 0.50 });
  const state   = baseState();
  const event   = makeEvent('primary');

  const actions = handler.call({ state, data: event.data, date: event.date });

  const types = actions.map(a => a.type);
  assert.ok(types.includes('PERSON_DIED_APPLY'));
  assert.ok(types.includes('ACCOUNT_RETITLE_APPLY'));
  assert.ok(types.includes('SOCIAL_SECURITY_SURVIVOR_APPLY'));
  assert.ok(types.includes('SCENARIO_COMPLETE_CHECK'));
  const ssaActions = actions.filter(a => a.type === 'SPENDING_STRATEGY_APPLY');
  assert.strictEqual(ssaActions.length, 2, 'should emit two SPENDING_STRATEGY_APPLY deltas');
});

// ── MORT-7 ────────────────────────────────────────────────────────────────────

test('MORT-7: MortalityHandler emits only PERSON_DIED_APPLY + SCENARIO_COMPLETE_CHECK when no spouse', () => {
  const handler = new MortalityHandler();
  const state   = baseState({ people: { primary: basePeople().primary } });
  const event   = makeEvent('primary');

  const actions = handler.call({ state, data: event.data, date: event.date });
  const types   = actions.map(a => a.type);

  assert.ok(types.includes('PERSON_DIED_APPLY'));
  assert.ok(types.includes('SCENARIO_COMPLETE_CHECK'));
  assert.ok(!types.includes('ACCOUNT_RETITLE_APPLY'));
  assert.ok(!types.includes('SOCIAL_SECURITY_SURVIVOR_APPLY'));
  assert.strictEqual(actions.filter(a => a.type === 'SPENDING_STRATEGY_APPLY').length, 0);
});

// ── MORT-8 ────────────────────────────────────────────────────────────────────

test('MORT-8: MortalityHandler per-slice expense deltas match multipliers', () => {
  const handler = new MortalityHandler({ survivorEssentialMultiplier: 0.85, survivorDiscretionaryMultiplier: 0.50 });
  const state   = baseState(); // essential=4200, discretionary=1800
  const event   = makeEvent('primary');

  const actions    = handler.call({ state, data: event.data, date: event.date });
  const essAction  = actions.find(a => a.type === 'SPENDING_STRATEGY_APPLY' && a.slice === 'essential');
  const discAction = actions.find(a => a.type === 'SPENDING_STRATEGY_APPLY' && a.slice === 'discretionary');

  assert.ok(essAction,  'essential delta action should exist');
  assert.ok(discAction, 'discretionary delta action should exist');
  // delta = current * (multiplier - 1)  →  negative (reduction)
  assert.ok(Math.abs(essAction.delta  - 4_200 * (0.85 - 1)) < 0.01, 'essential delta correct');
  assert.ok(Math.abs(discAction.delta - 1_800 * (0.50 - 1)) < 0.01, 'discretionary delta correct');
  assert.strictEqual(essAction.reason,  'survivor');
  assert.strictEqual(discAction.reason, 'survivor');
});

// ── MORT-9 ────────────────────────────────────────────────────────────────────

test('MORT-9: ScenarioCompleteReducer sets scenarioComplete when state.people is empty', () => {
  const state = baseState({ people: {} });
  const next  = completeR.reduce(state, { type: 'SCENARIO_COMPLETE_CHECK' });
  assert.strictEqual(next.scenarioComplete, true);
});

// ── MORT-10 ───────────────────────────────────────────────────────────────────

test('MORT-10: ScenarioCompleteReducer does NOT set scenarioComplete when a survivor remains', () => {
  const state = baseState({ people: { spouse: basePeople().spouse } });
  const next  = completeR.reduce(state, { type: 'SCENARIO_COMPLETE_CHECK' });
  assert.strictEqual(next.scenarioComplete, false);
});
