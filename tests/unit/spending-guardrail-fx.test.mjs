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
import { computeNetWorth }                from '../../src/finance/derived-metrics/net-worth.js';

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

// ── The {code} descriptor shape a REAL run produces (design 82 §5.3) ─────────
//
// Every test above builds `currency` as a bare string. No real run does: an
// account projected into state carries the `{code, symbol}` descriptor from
// `Account#currency`. Guardrail's private FX copy compared that object against a
// bare code, so the base-currency short-circuit never matched, the pair id came
// out `USD_[object Object]`, and the missing-rate fallback of 1 valued every
// FOREIGN drawdown account at FACE — an AUD super balance counted as if it were
// USD, inflating the portfolio the guardrail rate is measured against by the FX
// rate. USD accounts were right by accident, which is why nothing looked wrong.
//
// These two pin the descriptor shape specifically, because a string-only fixture
// is what let the drift live. See src/finance/fx/to-base-currency.js.

const USD_DESC = { code: 'USD', symbol: '$'  };
const AUD_DESC = { code: 'AUD', symbol: 'A$' };

test('SPEND-GR-FX-8: {code} descriptor currencies convert identically to bare codes', () => {
  const state = {
    effectiveExchangeRates: { USD_AUD: FX_RATE },
    usSavings: { stateKey: 'usSavings', balance: 500_000, currency: USD_DESC, drawdownPriority: 1 },
    auSuper:   { stateKey: 'auSuper',   balance: 310_000, currency: AUD_DESC, drawdownPriority: 2 },
  };
  const v = computeGuardrailPortfolioValue(state, 'USD');
  // 500_000 USD + 310_000 AUD / 1.55 = 700_000 USD — NOT 810_000, which is what
  // the unconverged copy returned.
  assert.ok(Math.abs(v - 700_000) < 0.01, `got ${v}`);
});

test('SPEND-GR-FX-9: guardrail agrees with computeNetWorth on the same accounts', () => {
  // The tie the convergence buys: two metrics quoted side by side cannot hold
  // different opinions about what a dollar is.
  const state = {
    effectiveExchangeRates: { USD_AUD: FX_RATE },
    usSavings: { stateKey: 'usSavings', balance: 500_000, currency: USD_DESC, drawdownPriority: 1 },
    auSuper:   { stateKey: 'auSuper',   balance: 310_000, currency: AUD_DESC, drawdownPriority: 2 },
  };
  assert.ok(Math.abs(computeGuardrailPortfolioValue(state, 'USD') - computeNetWorth(state, 'USD')) < 1e-9);
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
