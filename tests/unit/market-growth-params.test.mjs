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
 * What the params govern, and what they deliberately do NOT:
 *   - a holding whose `rateKey` names a market OUTSIDE its account's seeded pair (an
 *     EQUITY_AU lot in a US brokerage) falls through to the bare market key — the param
 *     sets its rate;
 *   - an account of a known role seeds `<market>::<stateKey>` for its domestic AND
 *     international market from its own/role rate, which outranks the bare key — the
 *     param does not reach it. That is the precedence design 90 §7.3 chose, not a gap.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ECONOMIC_REGIMES }        from '../../src/scenarios/toolsets/economic-regimes-toolset.js';
import { IntlRetirementScenario }  from '../../src/scenarios/intl-retirement-scenario.js';
import { RATE_KEYS }               from '../../src/finance/economic-regimes/rate-keys.js';
import { computeHoldingsGrowth }   from '../../src/finance/holdings/holdings-earnings.js';
import { runGolden }               from '../helpers/golden-harness.js';

const MARKET = [
  ['usEquityGrowthRate',       RATE_KEYS.EQUITY_US,         0.07],
  ['auEquityGrowthRate',       RATE_KEYS.EQUITY_AU,         0.06],
  ['intlExUsEquityGrowthRate', RATE_KEYS.EQUITY_INTL_EX_US, 0.07],
  ['intlExAuEquityGrowthRate', RATE_KEYS.EQUITY_INTL_EX_AU, 0.07],
];

/** A one-year run of the reference plan — enough for the toolset to seed its rate maps. */
const SPEC = {
  name:     'market-growth-params',
  simStart: new Date(Date.UTC(2026, 0, 1)),
  simEnd:   new Date(Date.UTC(2027, 0, 1)),
};

// ── Declared ───────────────────────────────────────────────────────────────────

test('W1-1: the four market growth params are declared, at the constants they replace', () => {
  const byKey = new Map(ECONOMIC_REGIMES.paramSchema({}).map(e => [e.key, e]));
  for (const [key, , def] of MARKET) {
    const e = byKey.get(key);
    assert.ok(e, `${key} is declared`);
    assert.strictEqual(e.defaultValue, def, `${key} default`);
    assert.strictEqual(e.type, 'Number');
    assert.strictEqual(e.group, 'Market Rates');
    // Plan inputs, not sweep axes: an account of a known role overrides them at the seed,
    // so sweeping one would reach almost nothing (design 98 §W1).
    assert.strictEqual(e.mc, false, `${key} is not an MC axis`);
    assert.strictEqual(e.opt, false, `${key} is not an Opt axis`);
    assert.ok(e.description?.length > 0, `${key} has a description`);
  }
});

test('W1-2: each appears exactly once in the full scenario schema', () => {
  const keys = IntlRetirementScenario.buildFullParamSchema().map(e => e.key);
  for (const [key] of MARKET) {
    assert.strictEqual(keys.filter(k => k === key).length, 1, `${key} once`);
  }
});

// ── Reaches the seeded rate map ────────────────────────────────────────────────

test('W1-3: unset ⇒ the seeded bare market rates are exactly the old constants', () => {
  const rates = runGolden(SPEC).state.baseGrowthRates;
  for (const [, rateKey, def] of MARKET) assert.strictEqual(rates[rateKey], def, rateKey);
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
  assert.strictEqual(lotGrowth(base,  RATE_KEYS.EQUITY_AU), 6_000);
  assert.strictEqual(lotGrowth(moved, RATE_KEYS.EQUITY_AU), 9_000);
});

test('W1-7: a lot on the account\'s own markets keeps the account rate — the param does not reach it', () => {
  const moved = runGolden({
    ...SPEC, params: { usEquityGrowthRate: 0.11, intlExUsEquityGrowthRate: 0.11 },
  }).state.baseGrowthRates;
  // The US brokerage seeds EQUITY_US and EQUITY_INTL_EX_US at its role rate (5%), which
  // outranks the bare market key.
  assert.strictEqual(lotGrowth(moved, RATE_KEYS.EQUITY_US),         5_000);
  assert.strictEqual(lotGrowth(moved, RATE_KEYS.EQUITY_INTL_EX_US), 5_000);
});
