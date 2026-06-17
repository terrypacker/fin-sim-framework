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
 * spending-composition.test.mjs
 *
 * Tests for design/26 — composition of multiple spending strategies.
 *
 *   - RegimeAware + Guardrail both adjusting discretionary: additive, not clobbering
 *   - Guardrail cut then regime cut: both applied independently
 *   - Guardrail raise does not clobber prior regime cut
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { RegimeAwareSpendingReducer }    from '../../src/finance/spending/strategies/regime-aware-spending-reducer.js';
import { GuardrailAdjustApplyReducer }   from '../../src/finance/spending/strategies/guardrail-adjust-apply-reducer.js';
import { GuardrailAnnualCheckReducer }   from '../../src/finance/spending/strategies/guardrail-annual-check-reducer.js';
import { AgeBandedSpendingReducer }      from '../../src/finance/spending/strategies/age-banded-spending-reducer.js';
import { REGIME_TAG }                   from '../../src/finance/economic-regimes/regime-tag.js';

const US_ADV = { type: 'US_PERIOD_ADVANCE' };

const raReducer      = new RegimeAwareSpendingReducer({ regimeAwareCutPct: 0.20 });
const grAdjustReducer = new GuardrailAdjustApplyReducer();
const grCheckReducer  = new GuardrailAnnualCheckReducer({
  cutThreshold: 0.20, raiseThreshold: 0.20, cutPct: 0.10, raisePct: 0.10,
});

function fullState({
  essential      = 7_000,
  discretionary  = 3_000,
  activeRegimes  = [],
  regimeActions  = {},
  guardrail      = null,
  portfolioBalance = 1_000_000,
} = {}) {
  return {
    expenses: { essential, discretionary },
    monthlyExpenses: essential + discretionary,
    activeRegimes,
    regimeActions,
    guardrail: guardrail ?? { initialWithdrawalRate: null, currentAdjustmentMultiplier: 1.0 },
    savings: { stateKey: 'savings', balance: portfolioBalance, currency: 'USD', drawdownPriority: 1 },
  };
}

function stressRegime() {
  return { id: 'r1', shockId: 'r1', tags: [REGIME_TAG.ECONOMIC_STRESS] };
}

// ── Additive composition: RegimeAware + Guardrail ────────────────────────────

test('COMP-1: RegimeAware cut followed by Guardrail cut are both applied', () => {
  let s = fullState({ activeRegimes: [stressRegime()] });
  // Step 1: RegimeAware cuts discretionary by 20%
  s = raReducer.reduce(s, US_ADV);
  const afterRaCut = s.expenses.discretionary; // 3_000 * 0.80 = 2_400

  // Step 2: Apply a Guardrail cut of 10% on top
  s = grAdjustReducer.reduce(s, { type: 'GUARDRAIL_ADJUST_APPLY', multiplier: 0.90, cause: 'cut' });
  const afterBothCuts = s.expenses.discretionary; // 2_400 * 0.90 = 2_160

  assert.ok(Math.abs(afterRaCut - 2_400) < 0.01, 'RegimeAware cut should produce 2400');
  assert.ok(Math.abs(afterBothCuts - 2_160) < 0.01, 'Guardrail cut on top should produce 2160');
  assert.ok(Math.abs(s.expenses.essential - 7_000) < 0.01, 'essential unchanged');
});

test('COMP-2: Guardrail and RegimeAware adjustments do not clobber each other (additive)', () => {
  // Start with a Guardrail cut already applied (multiplier = 0.90)
  let s = fullState({
    discretionary: 3_000 * 0.90,  // already cut by guardrail
    guardrail: { initialWithdrawalRate: 0.12, currentAdjustmentMultiplier: 0.90 },
    regimeActions: {},
  });

  // Now regime activates — RegimeAware cuts independently by 20%
  s = { ...s, activeRegimes: [stressRegime()] };
  s = raReducer.reduce(s, US_ADV);

  // Should cut only from current discretionary value, not re-applying guardrail
  const expected = 3_000 * 0.90 * 0.80;
  assert.ok(Math.abs(s.expenses.discretionary - expected) < 0.01);
});

test('COMP-3: Guardrail raise does not affect RegimeAware cut tracking', () => {
  // RegimeAware cut applied first
  let s = fullState({ activeRegimes: [stressRegime()] });
  s = raReducer.reduce(s, US_ADV); // 3_000 → 2_400

  // Now apply a Guardrail raise
  s = grAdjustReducer.reduce(s, { type: 'GUARDRAIL_ADJUST_APPLY', multiplier: 1.10, cause: 'raise' });
  // 2_400 * 1.10 = 2_640
  assert.ok(Math.abs(s.expenses.discretionary - 2_640) < 0.01);

  // RegimeAware tracking should still be active (regime is still on)
  assert.strictEqual(s.regimeActions.spending_discretionary_cut?.active, true);
});

test('COMP-5: AgeBanded and RegimeAware both adjust discretionary multiplicatively (neither clobbers)', () => {
  // 20%/yr age decline band for clean math; primary born 1950, advance at age 66 → 0.80.
  const ageReducer = new AgeBandedSpendingReducer({
    bands: [
      { startAge: 0,  multiplier: 1.0, annualRealDrift:  0.0  },
      { startAge: 65, multiplier: 1.0, annualRealDrift: -0.20 },
    ],
  });
  const ageAdv = { type: 'US_PERIOD_ADVANCE', date: new Date(Date.UTC(2016, 0, 2)) }; // age 66

  let s = fullState({ activeRegimes: [stressRegime()] });
  s = { ...s, people: { primary: { residency: 'US', birthDate: new Date(Date.UTC(1950, 0, 1)) } },
        ageBandSpending: { appliedFactor: 1.0, currentBandStartAge: null } };

  // RegimeAware cut (20%) then age-band factor (0.80) — both fold into discretionary.
  s = raReducer.reduce(s, US_ADV);   // 3_000 → 2_400
  s = ageReducer.reduce(s, ageAdv);  // 2_400 × 0.80 = 1_920

  assert.ok(Math.abs(s.expenses.discretionary - 3_000 * 0.80 * 0.80) < 1e-3);
  assert.ok(Math.abs(s.expenses.essential - 7_000) < 1e-3, 'essential unchanged');
  // Each strategy keeps its own reconciled factor.
  assert.strictEqual(s.regimeActions.spending_discretionary_cut.active, true);
  assert.ok(Math.abs(s.ageBandSpending.appliedFactor - 0.80) < 1e-9);
});

test('COMP-4: Guardrail check fires after inflation (both strategies see inflated base)', () => {
  // initialRate = (10_000 * 12) / 1_000_000 = 0.12
  // After inflation, monthly = 10_300; annual = 123_600; rate = 0.1236 (in-band)
  // Drop portfolio to 800_000 to trigger cut
  const initialRate = (10_000 * 12) / 1_000_000;
  let s = fullState({
    portfolioBalance: 800_000,
    guardrail: { initialWithdrawalRate: initialRate, currentAdjustmentMultiplier: 1.0 },
  });
  // rate = 120_000 / 800_000 = 0.15 > 0.12 * 1.20 = 0.144 → cut
  const next = grCheckReducer.reduce(s, US_ADV);
  assert.strictEqual((next.next ?? []).length, 1);
  assert.strictEqual(next.next[0].cause, 'cut');
});
