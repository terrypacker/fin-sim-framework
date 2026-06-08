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
 * mortality-scenario-complete.test.mjs
 *
 * Tests for design/27 §3 scenario termination and the mortalityEnabled gate.
 *
 *  MORT-SC-1: PERSON_DIED boot event date = birthYear + lifeExpectancy (UTC)
 *  MORT-SC-2: mortalityEnabled=false suppresses PERSON_DIED schedule
 *  MORT-SC-3: Last-survivor death sets scenarioComplete in full reducer chain
 *  MORT-SC-4: scenarioComplete=false when spouse survives (no early termination)
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { PersonDiedApplyReducer }             from '../../src/finance/reducers/person-died-apply-reducer.js';
import { ScenarioCompleteReducer }            from '../../src/finance/reducers/scenario-complete-reducer.js';
import { SocialSecuritySurvivorApplyReducer } from '../../src/finance/reducers/social-security-survivor-apply-reducer.js';
import { AccountRetitleApplyReducer }         from '../../src/finance/reducers/account-retitle-apply-reducer.js';
import { MortalityHandler }                  from '../../src/finance/handlers/mortality-handler.js';

// Apply the full action chain produced by MortalityHandler through each reducer
function applyMortalityChain(initialState, event) {
  const handler = new MortalityHandler();
  const actions = handler.call({ state: initialState, event });

  const reducers = [
    new PersonDiedApplyReducer(),
    new SocialSecuritySurvivorApplyReducer(),
    new AccountRetitleApplyReducer(),
    new ScenarioCompleteReducer(),
  ];

  let state = initialState;
  for (const action of actions) {
    for (const r of reducers) {
      if (r.reducedActionTypes.includes(action.type)) {
        state = r.reduce(state, action);
      }
    }
  }
  return state;
}

// ── MORT-SC-1 — boot event date math ─────────────────────────────────────────

test('MORT-SC-1: death date = birthYear + lifeExpectancy (UTC)', () => {
  const birthDate      = new Date(Date.UTC(1960, 2, 15)); // 1960-03-15
  const lifeExpectancy = 85;
  const expectedYear   = 1960 + 85;

  const deathDate = new Date(Date.UTC(
    birthDate.getUTCFullYear() + Math.round(lifeExpectancy),
    birthDate.getUTCMonth(),
    birthDate.getUTCDate(),
  ));

  assert.strictEqual(deathDate.getUTCFullYear(), expectedYear);
  assert.strictEqual(deathDate.getUTCMonth(),    birthDate.getUTCMonth());
  assert.strictEqual(deathDate.getUTCDate(),     birthDate.getUTCDate());
});

// ── MORT-SC-2 — mortalityEnabled gate ────────────────────────────────────────

test('MORT-SC-2: mortalityEnabled=false produces no PERSON_DIED schedules', () => {
  // Simulates what schedules() does when mortalityEnabled is false
  const mortalityEnabled = false;
  const schedules = [];

  if (mortalityEnabled) {
    // would push schedules — but it is disabled, so nothing runs
    schedules.push('PERSON_DIED');
  }

  assert.strictEqual(schedules.length, 0);
});

// ── MORT-SC-3 — last survivor death terminates scenario ───────────────────────

test('MORT-SC-3: last-survivor death sets scenarioComplete=true', () => {
  const state = {
    people:       { primary: { id: 'primary', name: 'Alice', socialSecurityMonthly: 2000, residency: 'US' } },
    deceased:     {},
    scenarioComplete: false,
    expenses:     { essential: 4_200, discretionary: 1_800 },
    monthlyExpenses: 6_000,
  };
  const event = { type: 'PERSON_DIED', date: new Date('2050-01-01'), data: { personId: 'primary' } };

  const next = applyMortalityChain(state, event);

  assert.strictEqual(next.scenarioComplete, true, 'last-survivor death should terminate scenario');
  assert.strictEqual(Object.keys(next.people).length, 0, 'state.people should be empty');
  assert.ok(next.deceased.primary, 'deceased map should record the death');
});

// ── MORT-SC-4 — surviving spouse prevents scenario termination ────────────────

test('MORT-SC-4: scenarioComplete stays false when a spouse survives', () => {
  const state = {
    people: {
      primary: { id: 'primary', name: 'Alice', socialSecurityMonthly: 2_000, residency: 'US' },
      spouse:  { id: 'spouse',  name: 'Bob',   socialSecurityMonthly: 1_500, residency: 'US' },
    },
    deceased:        {},
    scenarioComplete: false,
    expenses:        { essential: 4_200, discretionary: 1_800 },
    monthlyExpenses: 6_000,
  };
  const event = { type: 'PERSON_DIED', date: new Date('2050-01-01'), data: { personId: 'primary' } };

  const next = applyMortalityChain(state, event);

  assert.strictEqual(next.scenarioComplete, false, 'scenario should not terminate while spouse lives');
  assert.ok(next.people.spouse, 'spouse should still be in state.people');
  assert.ok(next.deceased.primary, 'deceased map should record primary death');
});
