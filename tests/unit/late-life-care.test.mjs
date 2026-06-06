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
 * late-life-care.test.mjs
 *
 * Tests for design/27 Increment 2 — late-life care window.
 *
 *  LLC-1: BEGIN event multiplies both expense slices by the care factor
 *  LLC-2: monthlyExpenses is synced after BEGIN
 *  LLC-3: END event divides both slices back out cleanly (no float drift)
 *  LLC-4: Handler emits active=true on BEGIN, active=false on END
 *  LLC-5: Care window composes with an active RegimeAware cut (order-independent)
 *  LLC-6: Care window composes with survivor multiplier without compounding drift
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { LateLifeCareHandler }       from '../../src/finance/spending/strategies/late-life-care-handler.js';
import { LateLifeCareApplyReducer }  from '../../src/finance/spending/strategies/late-life-care-apply-reducer.js';
import { SpendingStrategyApplyReducer } from '../../src/finance/spending/spending-strategy-apply-reducer.js';

const llcR     = new LateLifeCareApplyReducer();
const ssaR     = new SpendingStrategyApplyReducer();
const handler  = new LateLifeCareHandler();

function baseState(essential = 4_200, discretionary = 1_800) {
  return {
    expenses:        { essential, discretionary },
    monthlyExpenses: essential + discretionary,
    lateLifeCare:    {},
  };
}

function beginEvent(personId = 'primary', factor = 2.0) {
  return { type: 'LATE_LIFE_CARE_BEGIN', date: new Date(), data: { personId, factor } };
}

function endEvent(personId = 'primary') {
  return { type: 'LATE_LIFE_CARE_END', date: new Date(), data: { personId } };
}

// ── LLC-1 ─────────────────────────────────────────────────────────────────────

test('LLC-1: BEGIN multiplies both expense slices by the care factor', () => {
  const s    = baseState();
  const act  = { type: 'LATE_LIFE_CARE_APPLY', active: true, factor: 2.0, personId: 'primary' };
  const next = llcR.reduce(s, act);

  assert.ok(Math.abs(next.expenses.essential     - 4_200 * 2) < 0.01);
  assert.ok(Math.abs(next.expenses.discretionary - 1_800 * 2) < 0.01);
});

// ── LLC-2 ─────────────────────────────────────────────────────────────────────

test('LLC-2: monthlyExpenses is synced after BEGIN', () => {
  const s   = baseState();
  const act = { type: 'LATE_LIFE_CARE_APPLY', active: true, factor: 2.0, personId: 'primary' };
  const next = llcR.reduce(s, act);

  assert.ok(Math.abs(next.monthlyExpenses - (next.expenses.essential + next.expenses.discretionary)) < 0.01);
  assert.ok(Math.abs(next.monthlyExpenses - 12_000) < 0.01);
});

// ── LLC-3 ─────────────────────────────────────────────────────────────────────

test('LLC-3: END divides both slices back, restoring original values', () => {
  const s0    = baseState();
  const begin = { type: 'LATE_LIFE_CARE_APPLY', active: true,  factor: 2.0, personId: 'primary' };
  const end   = { type: 'LATE_LIFE_CARE_APPLY', active: false, personId: 'primary' };

  const s1 = llcR.reduce(s0, begin);
  const s2 = llcR.reduce(s1, end);

  assert.ok(Math.abs(s2.expenses.essential     - 4_200) < 0.01, 'essential restored');
  assert.ok(Math.abs(s2.expenses.discretionary - 1_800) < 0.01, 'discretionary restored');
  assert.ok(Math.abs(s2.monthlyExpenses - 6_000) < 0.01, 'monthlyExpenses restored');
});

// ── LLC-4 ─────────────────────────────────────────────────────────────────────

test('LLC-4: Handler emits active=true on BEGIN, active=false on END', () => {
  const startActions = handler.call({ event: beginEvent('primary', 2.0) });
  const endActions   = handler.call({ event: endEvent('primary') });

  assert.strictEqual(startActions[0].active, true);
  assert.strictEqual(startActions[0].factor, 2.0);
  assert.strictEqual(endActions[0].active,   false);
});

// ── LLC-5 ─────────────────────────────────────────────────────────────────────

test('LLC-5: care window composes with prior RegimeAware cut (apply BEGIN on top)', () => {
  // Simulate: RegimeAware already cut discretionary by 20% → discretionary = 1440
  const s    = baseState(4_200, 1_440);
  const act  = { type: 'LATE_LIFE_CARE_APPLY', active: true, factor: 2.0, personId: 'primary' };
  const next = llcR.reduce(s, act);

  // Both slices doubled; the RA cut was already baked into the state value
  assert.ok(Math.abs(next.expenses.essential     - 4_200 * 2) < 0.01);
  assert.ok(Math.abs(next.expenses.discretionary - 1_440 * 2) < 0.01);
});

// ── LLC-6 ─────────────────────────────────────────────────────────────────────

test('LLC-6: END after care + survivor multiplier restores to post-survivor baseline', () => {
  // Start: essential=3570 (= 4200 * 0.85), discretionary=900 (= 1800 * 0.50) — survivor applied
  const s0    = baseState(3_570, 900);
  const begin = { type: 'LATE_LIFE_CARE_APPLY', active: true,  factor: 2.0, personId: 'primary' };
  const end   = { type: 'LATE_LIFE_CARE_APPLY', active: false, personId: 'primary' };

  const s1 = llcR.reduce(s0, begin);
  const s2 = llcR.reduce(s1, end);

  assert.ok(Math.abs(s2.expenses.essential     - 3_570) < 0.01, 'essential returns to survivor baseline');
  assert.ok(Math.abs(s2.expenses.discretionary - 900)   < 0.01, 'discretionary returns to survivor baseline');
});
