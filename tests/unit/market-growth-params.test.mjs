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
 * market-growth-params.test.mjs — design 98 W1.
 *
 * `collectBaseGrowthRates` read four per-MARKET growth params (design 90 §7.2) that no
 * `paramSchema()` declared, so the market axis ran at four constants nobody could set —
 * while the Rate Key picker let a user put a lot on any of those series.
 *
 * Design 99 P2 made them the ONLY equity rates: each is a market's TOTAL return, beside
 * the dividend yield inside it, and every equity holding tracking the market earns it in
 * any account — no role or account rate outranks it any more.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ECONOMIC_REGIMES }        from '../../src/scenarios/toolsets/economic-regimes-toolset.js';
import { IntlRetirementScenario }  from '../../src/scenarios/intl-retirement-scenario.js';
import { RATE_KEYS }               from '../../src/finance/economic-regimes/rate-keys.js';
import { computeHoldingsGrowth }   from '../../src/finance/holdings/holdings-earnings.js';
import { runGolden }               from '../helpers/golden-harness.js';

// Design 99 P2: these are TOTAL returns, and each market also declares the dividend yield
// inside it. Design 99 P5b: the defaults are sourced — docs/market-returns/SOURCES.md.
const MARKET = [
  ['usEquityGrowthRate',       RATE_KEYS.EQUITY_US,         0.070, 'usEquityDividendYield',       0.0110],
  ['auEquityGrowthRate',       RATE_KEYS.EQUITY_AU,         0.067, 'auEquityDividendYield',       0.0343],
  ['intlExUsEquityGrowthRate', RATE_KEYS.EQUITY_INTL_EX_US, 0.069, 'intlExUsEquityDividendYield', 0.0253],
  ['intlExAuEquityGrowthRate', RATE_KEYS.EQUITY_INTL_EX_AU, 0.075, 'intlExAuEquityDividendYield', 0.0147],
];

/** A one-year run of the reference plan — enough for the toolset to seed its rate maps. */
const SPEC = {
  name:     'market-growth-params',
  simStart: new Date(Date.UTC(2026, 0, 1)),
  simEnd:   new Date(Date.UTC(2027, 0, 1)),
};

// ── Declared ───────────────────────────────────────────────────────────────────

test('W1-1: each market declares a total return and a yield', () => {
  const byKey = new Map(ECONOMIC_REGIMES.paramSchema({}).map(e => [e.key, e]));
  for (const [key, , def, yieldKey, yieldDef] of MARKET) {
    for (const [k, d] of [[key, def], [yieldKey, yieldDef]]) {
      const e = byKey.get(k);
      assert.ok(e, `${k} is declared`);
      assert.strictEqual(e.defaultValue, d, `${k} default`);
      assert.strictEqual(e.type, 'Number');
      assert.strictEqual(e.group, 'Market Rates');
      // Design 99 P2: the market rates are the ONLY equity rates, so they are MC axes now
      // (design 98 W1 had them off because an account's own rate outranked them). A
      // market's return is an uncertainty, not a decision: not an Opt lever.
      assert.strictEqual(e.mc, true, `${k} is an MC axis`);
      assert.strictEqual(e.opt, false, `${k} is not an Opt axis`);
      assert.ok(e.description?.length > 0, `${k} has a description`);
    }
  }
});

test('W1-2: each appears exactly once in the full scenario schema', () => {
  const keys = IntlRetirementScenario.buildFullParamSchema().map(e => e.key);
  for (const [key, , , yieldKey] of MARKET) {
    assert.strictEqual(keys.filter(k => k === key).length, 1, `${key} once`);
    assert.strictEqual(keys.filter(k => k === yieldKey).length, 1, `${yieldKey} once`);
  }
});

// ── Reaches the seeded rate map ────────────────────────────────────────────────

test('W1-3: unset ⇒ the seeded bare market rates and yields are the defaults', () => {
  const { state } = runGolden(SPEC);
  for (const [, rateKey, def, , yieldDef] of MARKET) {
    assert.strictEqual(state.baseGrowthRates[rateKey], def, rateKey);
    assert.strictEqual(state.marketDividendYields[rateKey], yieldDef, `${rateKey} yield`);
  }
});

test('W1-4: set through buildDefaultConfig (toolset passthrough) ⇒ the bare key moves', () => {
  const rates = runGolden({ ...SPEC, params: { auEquityGrowthRate: 0.09 } }).state.baseGrowthRates;
  assert.strictEqual(rates[RATE_KEYS.EQUITY_AU], 0.09);
  assert.strictEqual(rates[RATE_KEYS.EQUITY_US], 0.07, 'other markets untouched');
});

test('W1-5: set in cfg.parameters (the MC/Opt layer) ⇒ the bare key moves', () => {
  const rates = runGolden({
    ...SPEC, mutateCfg: cfg => { cfg.parameters.intlExUsEquityGrowthRate = 0.03; },
  }).state.baseGrowthRates;
  assert.strictEqual(rates[RATE_KEYS.EQUITY_INTL_EX_US], 0.03);
});

// ── What it governs: holding-level precedence, on the real seeded map ────────────

/** One-year growth of a 100k lot on `rateKey` inside the reference US brokerage. */
function lotGrowth(rates, rateKey) {
  const stateKey = 'usStockAccount';
  const state = {
    [stateKey]: { holdings: [
      { id: 'lot', marketValue: 100_000, costBasis: 100_000, allocation: 'EQUITY', rateKey },
    ] },
    effectiveGrowthRates: rates,
  };
  // The brokerage earnings handler's own series and fallback (IntlUsStockEarningsHandler).
  return computeHoldingsGrowth({
    state, stateKey, fallbackRateKey: RATE_KEYS.EQUITY_US, fallbackRate: 0.05,
  }).amount;
}

test('W1-6: an EQUITY_AU lot in a US brokerage takes auEquityGrowthRate', () => {
  const base  = runGolden(SPEC).state.baseGrowthRates;
  const moved = runGolden({ ...SPEC, params: { auEquityGrowthRate: 0.09 } }).state.baseGrowthRates;
  // The TOTAL return (this helper does not split out a paid dividend).
  assert.strictEqual(lotGrowth(base,  RATE_KEYS.EQUITY_AU), 6_700);   // the sourced AU default (P5b)
  assert.strictEqual(lotGrowth(moved, RATE_KEYS.EQUITY_AU), 9_000);
});

test('W1-7: a lot on the account\'s own markets takes the market param too — nothing outranks it', () => {
  const moved = runGolden({
    ...SPEC, params: { usEquityGrowthRate: 0.11, intlExUsEquityGrowthRate: 0.11 },
  }).state.baseGrowthRates;
  // Design 99 P2: the brokerage no longer seeds `<market>::usStockAccount` from a role
  // rate (it was 5% and outranked this), so its lots earn the market's own total.
  assert.strictEqual(lotGrowth(moved, RATE_KEYS.EQUITY_US),         11_000);
  assert.strictEqual(lotGrowth(moved, RATE_KEYS.EQUITY_INTL_EX_US), 11_000);
});
