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
 * spending-guardrail-fx.test.mjs
 *
 * Tests for design/26 §9 — Guardrail FX multi-currency portfolio summing.
 *
 *   - USD+AUD drawdown accounts are summed in USD using the stored exchange rate
 *   - AUD-only portfolio converts correctly
 *   - Missing exchange rate falls back to 1:1
 *   - computeGuardrailPortfolioValue utility tests
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { computeGuardrailPortfolioValue } from '../../src/finance/spending/guardrail-portfolio-value.js';
import { RetirementDateHandler }          from '../../src/finance/spending/strategies/retirement-date-handler.js';
import { GuardrailAnnualCheckReducer }    from '../../src/finance/spending/strategies/guardrail-annual-check-reducer.js';

// USD_AUD = 1.55 → 1 USD = 1.55 AUD
const FX_RATE = 1.55;

function makeState({ usdBalance = 0, audBalance = 0, fxRate = FX_RATE } = {}) {
  const state = {
    monthlyExpenses: 10_000,
    effectiveExchangeRates: { USD_AUD: fxRate },
  };
  if (usdBalance > 0) {
    state.usSavings = { stateKey: 'usSavings', balance: usdBalance, currency: 'USD', drawdownPriority: 1 };
  }
  if (audBalance > 0) {
    state.auSuper = { stateKey: 'auSuper', balance: audBalance, currency: 'AUD', drawdownPriority: 2 };
  }
  return state;
}

// ── computeGuardrailPortfolioValue ────────────────────────────────────────────

test('SPEND-GR-FX-1: USD-only portfolio sums directly', () => {
  const s = makeState({ usdBalance: 500_000 });
  const v = computeGuardrailPortfolioValue(s, 'USD');
  assert.ok(Math.abs(v - 500_000) < 0.01);
});

test('SPEND-GR-FX-2: AUD account converted to USD via effectiveExchangeRates', () => {
  // 310_000 AUD / 1.55 = 200_000 USD
  const s = makeState({ audBalance: 310_000 });
  const v = computeGuardrailPortfolioValue(s, 'USD');
  assert.ok(Math.abs(v - 200_000) < 0.01);
});

test('SPEND-GR-FX-3: USD + AUD accounts sum in USD correctly', () => {
  // 500_000 USD + 310_000 AUD / 1.55 = 500_000 + 200_000 = 700_000 USD
  const s = makeState({ usdBalance: 500_000, audBalance: 310_000 });
  const v = computeGuardrailPortfolioValue(s, 'USD');
  assert.ok(Math.abs(v - 700_000) < 0.01);
});

test('SPEND-GR-FX-4: accounts without drawdownPriority are excluded', () => {
  const state = {
    ...makeState({ usdBalance: 500_000 }),
    checkingAcct: { stateKey: 'checking', balance: 50_000, currency: 'USD', drawdownPriority: null },
  };
  const v = computeGuardrailPortfolioValue(state, 'USD');
  assert.ok(Math.abs(v - 500_000) < 0.01);
});

test('SPEND-GR-FX-5: fallback rate 1:1 when exchange rate absent', () => {
  const state = {
    monthlyExpenses: 10_000,
    // no effectiveExchangeRates
    auSuper: { stateKey: 'auSuper', balance: 200_000, currency: 'AUD', drawdownPriority: 1 },
  };
  const v = computeGuardrailPortfolioValue(state, 'USD');
  // fallback rate = 1 → 200_000 / 1 = 200_000
  assert.ok(Math.abs(v - 200_000) < 0.01);
});

// ── RetirementDateHandler with FX state ──────────────────────────────────────

test('SPEND-GR-FX-6: RetirementDateHandler computes portfolioValue in baseCurrency=USD from mixed accounts', () => {
  const state = makeState({ usdBalance: 500_000, audBalance: 310_000 });
  state.people = {};
  const handler = new RetirementDateHandler({ baseCurrency: 'USD' });
  const actions = handler.call({ state, date: new Date() });
  assert.strictEqual(actions.length, 1);
  assert.ok(Math.abs(actions[0].portfolioValue - 700_000) < 0.01);
});

// ── GuardrailAnnualCheckReducer with FX state ─────────────────────────────────

test('SPEND-GR-FX-7: GuardrailAnnualCheckReducer uses FX-converted portfolio for rate comparison', () => {
  // monthly = 10_000; annual = 120_000; initialRate = 120_000 / 700_000 ≈ 0.1714
  // If US portfolio drops to 400_000 (AUD unchanged): total = 400_000 + 200_000 = 600_000
  // currentRate = 120_000 / 600_000 = 0.2 > 0.1714 * 1.20 = 0.2057 → NOT above threshold yet
  // To trigger: reduce to 500_000 total → 0.24 > 0.2057 → cut
  const initialPortfolio = 700_000;
  const annualSpending   = 120_000;
  const initialRate      = annualSpending / initialPortfolio;

  const state = {
    ...makeState({ usdBalance: 300_000, audBalance: 310_000 }),  // total USD = 300_000 + 200_000 = 500_000
    expenses: { essential: 7_000, discretionary: 3_000 },
    monthlyExpenses: 10_000,
    guardrail: {
      initialWithdrawalRate: initialRate,
      currentAdjustmentMultiplier: 1.0,
    },
  };

  const checker = new GuardrailAnnualCheckReducer({
    cutThreshold: 0.20, raiseThreshold: 0.20, cutPct: 0.10, raisePct: 0.10,
    baseCurrency: 'USD',
  });
  const next = checker.reduce(state, { type: 'US_PERIOD_ADVANCE' });

  // currentRate = 120_000 / 500_000 = 0.24 > initialRate * 1.20 = 0.2057 → cut
  assert.strictEqual((next.next ?? []).length, 1);
  assert.strictEqual(next.next[0].cause, 'cut');
});
