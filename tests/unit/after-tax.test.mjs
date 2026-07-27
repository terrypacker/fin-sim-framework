/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  TAX_CLASS, taxClassForRole, defaultRateProvider, liquidationRateProvider,
  computeAfterTaxValue, computeAfterTaxNetWorth, computeAfterTaxNetLiquidity,
  deriveAfterTaxNetWorth, deriveAfterTaxNetLiquidity,
} from '../../src/finance/derived-metrics/after-tax.js';
import { computeNetLiquidity } from '../../src/finance/derived-metrics/net-liquidity.js';
import { OptimizationProblem } from '../../src/finance/optimization/optimization-problem.js';
import { OPT_PARAM_TYPES }     from '../../src/finance/optimization/optimization-objectives.js';

// A person old enough that every age-gated account is accessible.
const PEOPLE = { primary: { birthDate: new Date('1950-01-01'), residency: 'US' } };
const LATE   = new Date('2040-01-01');   // primary is 90 — past all minimumAge gates

function acct(role, balance, extra = {}) {
  return { role, balance, drawdownPriority: 1, currency: 'USD', ...extra };
}

describe('taxClassForRole', () => {
  test('maps roles to classes; unknown → CASH (par, never over-discounted)', () => {
    assert.equal(taxClassForRole('ira'),             TAX_CLASS.PRE_TAX);
    assert.equal(taxClassForRole('k401'),            TAX_CLASS.PRE_TAX);
    assert.equal(taxClassForRole('roth-ira'),        TAX_CLASS.ROTH);
    assert.equal(taxClassForRole('us-stock'),        TAX_CLASS.TAXABLE_BASIS);
    assert.equal(taxClassForRole('au-fixed-income'), TAX_CLASS.TAXABLE_BASIS);
    assert.equal(taxClassForRole('us-savings'),      TAX_CLASS.CASH);
    assert.equal(taxClassForRole('super'),           TAX_CLASS.SUPER);
    assert.equal(taxClassForRole('something-new'),   TAX_CLASS.CASH);
  });
});

describe('computeAfterTaxValue — per-class discount', () => {
  const rp = defaultRateProvider({ ordinaryRate: 0.25, ordinaryRateAu: 0.15, capGainsRate: 0.20 });

  test('PRE_TAX (IRA) discounted by the ordinary rate', () => {
    assert.equal(computeAfterTaxValue(acct('ira', 100_000), {}, LATE, { rateProvider: rp }), 75_000);
  });

  test('ROTH and CASH are at par', () => {
    assert.equal(computeAfterTaxValue(acct('roth-ira', 100_000), {}, LATE, { rateProvider: rp }), 100_000);
    assert.equal(computeAfterTaxValue(acct('us-savings', 50_000), {}, LATE, { rateProvider: rp }), 50_000);
  });

  test('SUPER without basis info taxes the whole balance (back-compat)', () => {
    const a = acct('super', 100_000, { currency: 'AUD' });
    assert.equal(computeAfterTaxValue(a, {}, LATE, { rateProvider: rp }), 85_000);
  });

  test('SUPER with earningsBasis: contribution is par, only earnings are taxed (design 40 Phase 2)', () => {
    const a = acct('super', 100_000, { currency: 'AUD', earningsBasis: 40_000 });
    // contribution 60k (par) + earnings 40k·(1 − 0.15) = 60k + 34k = 94k
    assert.equal(computeAfterTaxValue(a, {}, LATE, { rateProvider: rp }), 94_000);
  });

  test('TAXABLE_BASIS discounts only the UNREALIZED GAIN, from holdings', () => {
    const a = acct('us-stock', 100_000, {
      holdings: [{ marketValue: 100_000, costBasis: 60_000 }],   // 40k gain
    });
    // 100k − 0.20·40k = 92k
    assert.equal(computeAfterTaxValue(a, {}, LATE, { rateProvider: rp }), 92_000);
  });

  test('TAXABLE_BASIS falls back to assumedGainFraction when no holdings', () => {
    const a = acct('us-stock', 100_000);   // no holdings
    // gain = 100k·0.5 = 50k; 100k − 0.20·50k = 90k
    assert.equal(
      computeAfterTaxValue(a, {}, LATE, { rateProvider: rp, assumedGainFraction: 0.5 }), 90_000);
  });

  test('rates clamp to [0,1]; a degenerate provider never inflates value', () => {
    const bad = { ordinaryLiquidationRate: () => 5, capGainsLiquidationRate: () => -1 };
    assert.equal(computeAfterTaxValue(acct('ira', 100), {}, LATE, { rateProvider: bad }), 0);
    const a = acct('us-stock', 100, { holdings: [{ marketValue: 100, costBasis: 0 }] });
    assert.equal(computeAfterTaxValue(a, {}, LATE, { rateProvider: bad }), 100); // cg clamped to 0
  });
});

describe('computeAfterTaxNetWorth / NetLiquidity', () => {
  const state = {
    people: PEOPLE,
    ira:      acct('ira',      100_000),                 // pre-tax
    roth:     acct('roth-ira', 100_000),                 // par
    house:    { kind: 'real-property', value: 500_000, mortgageBalance: 200_000, currency: 'USD' },
    locked:   acct('us-stock', 100_000, { drawdownPriority: null }), // excluded from drawdown
  };
  const rp = defaultRateProvider({ ordinaryRate: 0.30, capGainsRate: 0 });
  const opts = { rateProvider: rp, assumedGainFraction: 0 };   // no cap-gains to isolate ordinary

  test('worth includes all assets + real-property equity at par (Phase 1)', () => {
    // ira 70k + roth 100k + house equity 300k + locked stock 100k (gain 0) = 570k
    assert.equal(computeAfterTaxNetWorth(state, LATE, opts), 570_000);
  });

  test('liquidity is the drawdownable pool only (no house, no drawdownPriority=null)', () => {
    // ira 70k + roth 100k = 170k  (house has no balance; locked excluded)
    assert.equal(computeAfterTaxNetLiquidity(state, LATE, opts), 170_000);
  });

  test('after-tax liquidity reuses the exact net-liquidity include-predicate', () => {
    // Anything net liquidity excludes, after-tax liquidity must also exclude.
    const nominalLiquid = computeNetLiquidity(state, LATE);   // ira 100k + roth 100k = 200k
    assert.equal(nominalLiquid, 200_000);
    // Same membership, only the pre-tax dollar is re-priced (100k→70k).
    assert.equal(computeAfterTaxNetLiquidity(state, LATE, opts), 170_000);
  });

  test('FX-normalizes foreign balances to USD like computeNetWorth', () => {
    const fx = {
      people: PEOPLE,
      effectiveExchangeRates: { USD_AUD: 1.5 },   // 1 USD = 1.5 AUD
      auCash: acct('au-savings', 150_000, { currency: 'AUD' }),  // par; 150k AUD / 1.5 = 100k USD
    };
    assert.equal(computeAfterTaxNetWorth(fx, LATE, opts), 100_000);
  });
});

describe('age-gating', () => {
  test('an age-locked account drops out of liquidity until accessible (date-driven)', () => {
    const young = { primary: { birthDate: new Date('1990-01-01'), residency: 'US' } };
    const state = {
      people: young,
      super: acct('super', 100_000, { currency: 'AUD', minimumAge: 60, allowsEarlyWithdrawal: false }),
    };
    const at2030 = new Date('2030-01-01');   // age 40 — super locked
    assert.equal(computeAfterTaxNetLiquidity(state, at2030), 0, 'locked super excluded from liquid pool');
    // ...but always counts toward worth.
    assert.ok(computeAfterTaxNetWorth(state, at2030) > 0, 'super still in net worth');
  });
});

describe('derive writers', () => {
  test('write state.metrics.afterTaxNetWorth / afterTaxNetLiquidity', () => {
    const state = { people: PEOPLE, ira: acct('ira', 100_000) };
    deriveAfterTaxNetWorth(state, LATE);
    deriveAfterTaxNetLiquidity(state, LATE);
    assert.ok(Number.isFinite(state.metrics.afterTaxNetWorth));
    assert.ok(Number.isFinite(state.metrics.afterTaxNetLiquidity));
  });
});

// ─── The end-to-end gate (design/40 §6): the Roth lever gains a gradient ──────
//
// The reported bug: on a flat objective the Roth lever recommends "max" with an
// identical terminal regardless of the conversion. The after-tax metric fixes
// this by pricing the embedded deferred-tax liability — so the *sign* of the
// conversion's effect is controlled by the assumed liability rate. This is a
// real IntlRetirement rollout (slower), proving the wiring end-to-end.
describe('after-tax net worth gives the Roth conversion lever a real gradient', () => {
  const KEY = 'rothConversionSchedule[0].incomeTarget';
  // NB horizon = 20y (to 2046), NOT full-life-to-death. A terminal *stock* only
  // re-prices balances that EXIST at the terminal; over a full-life spend-down
  // the pre-tax pile is consumed by death, so after-tax ≡ nominal there and this
  // gradient vanishes (design/40 §5.1 — verified in the browser). The 20y window
  // keeps the IRA alive at the terminal, which is exactly the bequest/windowed
  // framing in which after-tax terminal worth is the right anchor.
  const evalAt = (afterTaxOrdinaryRate, target) => {
    const problem = new OptimizationProblem({
      variables: [{ paramKey: KEY, type: OPT_PARAM_TYPES.CONTINUOUS, min: 0, max: 400_000, step: 1_000 }],
      baseParams: {
        rothConversionEnabled:  true,
        rothConversionSchedule: [{ year: 2030, incomeTarget: 0 }],
        afterTaxOrdinaryRate,
      },
      simStart: new Date(Date.UTC(2026, 0, 1)),
      simEnd:   new Date(Date.UTC(2046, 0, 1)),
    });
    return problem.evaluate({ [KEY]: target }).result;
  };

  test('converting genuinely moves IRA→Roth (the lever actuates)', () => {
    const off = evalAt(0.22, 0), on = evalAt(0.22, 300_000);
    assert.ok(on.rothFinalBalance > off.rothFinalBalance,
      `conversion should raise terminal Roth balance: on=${on.rothFinalBalance} off=${off.rothFinalBalance}`);
  });

  test('nominal net worth FALLS with conversion (the old MAX_NET_WORTH degeneracy), but after-tax net worth RISES', () => {
    const off = evalAt(0.22, 0), on = evalAt(0.22, 300_000);
    // Nominal sums balances at par → a conversion is pure tax loss → "convert nothing".
    assert.ok(on.finalNetWorthUsd < off.finalNetWorthUsd,
      `nominal NW should fall (tax paid): on=${on.finalNetWorthUsd} off=${off.finalNetWorthUsd}`);
    // After-tax prices the embedded liability → the conversion is net-positive → a gradient.
    assert.ok(on.finalAfterTaxNetWorth > off.finalAfterTaxNetWorth,
      `after-tax NW should rise: on=${on.finalAfterTaxNetWorth} off=${off.finalAfterTaxNetWorth}`);
  });

  test('the embedded-liability rate controls the sign — proof the metric prices the liability', () => {
    const delta = (rate) => evalAt(rate, 300_000).finalAfterTaxNetWorth - evalAt(rate, 0).finalAfterTaxNetWorth;
    const d0  = delta(0.0);    // pre-tax priced at par → no liability removed → conversion only costs tax
    const d22 = delta(0.22);
    const d40 = delta(0.40);
    assert.ok(d0 < 0,  `with no embedded liability, conversion should NOT be rewarded: Δ=${d0}`);
    assert.ok(d22 > 0, `with a 22% liability, conversion should be rewarded: Δ=${d22}`);
    assert.ok(d40 > d22 && d22 > d0,
      `reward should grow with the assumed liability: d40=${d40} d22=${d22} d0=${d0}`);
  });
});

describe('afterTaxRateMethod selects Option C (liquidation waterfall) end-to-end (design 40 Phase 3)', () => {
  const KEY = 'rothConversionSchedule[0].incomeTarget';
  const evalWith = (afterTaxRateMethod) => {
    const problem = new OptimizationProblem({
      variables: [{ paramKey: KEY, type: OPT_PARAM_TYPES.CONTINUOUS, min: 0, max: 400_000, step: 1_000 }],
      baseParams: {
        rothConversionEnabled: true, rothConversionSchedule: [{ year: 2030, incomeTarget: 0 }],
        afterTaxOrdinaryRate: 0.22, afterTaxRateMethod,
      },
      simStart: new Date(Date.UTC(2026, 0, 1)),
      simEnd:   new Date(Date.UTC(2046, 0, 1)),   // pre-tax pile survives to the terminal
      initialState: { kind: 'compile' },
    });
    return problem.evaluate({ [KEY]: 0 }).result.finalAfterTaxNetWorth;
  };

  test('liquidation method prices the pre-tax pile differently from a flat 22% (uses the real brackets)', () => {
    const configured = evalWith('configured');   // flat 22% on every pre-tax dollar
    const liquidation = evalWith('liquidation'); // bracket-stacked effective rate
    assert.ok(Number.isFinite(configured) && Number.isFinite(liquidation));
    assert.notEqual(Math.round(configured), Math.round(liquidation),
      'Option C should value the terminal pre-tax pile at a different (bracket-stacked) rate than flat 22%');
  });
});

describe('liquidationRateProvider (Option C) — the tax-engine waterfall', () => {
  const usIra = acct('ira', 100_000);                 // USD pre-tax
  const auSuper = acct('super', 100_000, { currency: 'AUD' });
  const usStock = acct('us-stock', 100_000);

  test('US ordinary: returns the engine effective rate, bracket-stacked on realized income', () => {
    const rp = liquidationRateProvider({ ordinaryRate: 0.99 });   // configured fallback would be 0.99
    const state = { usOrdinaryIncomeYTD: 50_000 };                // low realized income
    const r = rp.ordinaryLiquidationRate(usIra, 100_000, state, LATE);
    // Stacking $100k on $50k income fills the 10/12/22 brackets ⇒ an effective rate
    // well below the 22% top it touches and far from the bogus 0.99 fallback.
    assert.ok(r > 0.10 && r < 0.22, `effective rate in bracket-fill range, got ${r}`);
    assert.notEqual(r, 0.99, 'used the engine, not the configured fallback');
  });

  test('progressive: a larger liquidation lands a higher effective rate', () => {
    const rp = liquidationRateProvider();
    const state = { usOrdinaryIncomeYTD: 50_000 };
    const small = rp.ordinaryLiquidationRate(usIra, 20_000,  state, LATE);
    const big   = rp.ordinaryLiquidationRate(usIra, 400_000, state, LATE);
    assert.ok(big > small, `progressive: big=${big} small=${small}`);
  });

  test('US brokerage cap-gains go through the engine LTCG brackets', () => {
    const rp = liquidationRateProvider({ capGainsRate: 0.99 });
    const r = rp.capGainsLiquidationRate(usStock, 50_000, { usOrdinaryIncomeYTD: 40_000 }, LATE);
    assert.ok(r >= 0 && r <= 0.20, `LTCG effective rate in range, got ${r}`);
    assert.notEqual(r, 0.99);
  });

  test('super earnings route through the US ordinary engine (taxed as US ordinary income, §model)', () => {
    const rp = liquidationRateProvider({ ordinaryRateAu: 0.99 });   // fallback would be 0.99
    // $100k of super earnings stacked on $0 US income fills the low US brackets ⇒
    // an effective rate well under 0.22 and far from the bogus AU fallback.
    const r = rp.ordinaryLiquidationRate(auSuper, 100_000, { usOrdinaryIncomeYTD: 0 }, LATE);
    assert.ok(r > 0 && r < 0.20, `super earnings at the US effective rate, got ${r}`);
    assert.notEqual(r, 0.99, 'used the US engine, not the configured AU fallback');
  });

  test('AU brokerage cap-gains route through computeAuTax (post-2027 CGT reform)', () => {
    const rp = liquidationRateProvider({ capGainsRate: 0.99 });
    const auStock = acct('au-stock', 100_000, { currency: 'AUD' });
    const state = { auOrdinaryIncomeYTD: 0, people: { p: { residency: 'AU' } } };
    const r = rp.capGainsLiquidationRate(auStock, 100_000, state, LATE);
    // LATE (2040) is past the 1 Jul 2027 CGT reform (design 57): no 50% discount,
    // 30% minimum tax + Medicare ⇒ ~0.32 effective, not the 0.99 fallback.
    assert.ok(r >= 0.30 && r < 0.35, `AU CGT effective rate in reform range, got ${r}`);
    assert.notEqual(r, 0.99, 'used the AU engine, not the configured fallback');
  });

  test('graceful fallback: missing state / tiny amount → configured rate, never throws', () => {
    const rp = liquidationRateProvider({ ordinaryRate: 0.22 });
    assert.equal(rp.ordinaryLiquidationRate(usIra, 100_000, null, LATE), 0.22, 'no state → fallback');
    assert.equal(rp.ordinaryLiquidationRate(usIra, 0, { usOrdinaryIncomeYTD: 0 }, LATE), 0.22, 'tiny amount → fallback');
  });
});

describe('defaultRateProvider (Option A) — the C-shaped contract', () => {
  test('returns configured constants, AU split by currency, defaults when unset', () => {
    const rp = defaultRateProvider({ ordinaryRate: 0.22, ordinaryRateAu: 0.15, capGainsRate: 0.15 });
    assert.equal(rp.ordinaryLiquidationRate(acct('ira', 1)), 0.22);
    assert.equal(rp.ordinaryLiquidationRate(acct('super', 1, { currency: 'AUD' })), 0.15);
    assert.equal(rp.capGainsLiquidationRate(acct('us-stock', 1)), 0.15);
    // ignores amount/state/date (Option A); B/C use them — the contract passes them.
    assert.equal(rp.ordinaryLiquidationRate(acct('ira', 1), 999_999, { foo: 1 }, new Date()), 0.22);
    const dflt = defaultRateProvider();
    assert.ok(Number.isFinite(dflt.ordinaryLiquidationRate(acct('ira', 1))));
  });
});
