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
 * capital-loss-netting-au.test.mjs — ITAA 1997 s102-5 / s102-10 / s102-15 (design 90 §5).
 *
 * The AU half of the working-detector control (design 90 §10). Same reason as its US
 * sibling: the reference plans realize losses worth 0.006% of gross gains, so the golden
 * fixtures move by nothing and a pool that is written but never READ would pass the whole
 * suite. These tests construct losses big enough that a broken path cannot hide.
 *
 * The Act, verbatim, from `docs/au-tax/ITAA-1997/C2026C00324VOL03.txt`:
 *
 *   s102-5(1) Step 1 — "Reduce the *capital gains you made during the income year by the
 *                       *capital losses (if any) you made during the income year"
 *   s102-5(1) Step 2 — "Apply any previously unapplied *net capital losses from earlier
 *                       income years to further reduce the amounts (if any) remaining
 *                       after the reduction of *capital gains under step 1."
 *   s102-5(1) Step 5 — "Reduce by the *discount percentage each amount of any *discount
 *                       capital gain remaining after the application of steps 1 to 4."
 *   s102-10(2)       — "You cannot deduct from your assessable income a *net capital loss
 *                       for any income year."
 *   s102-15          — "your *net capital losses are applied in the order in which you
 *                       made them."
 *
 * Run with: node --test tests/unit/capital-loss-netting-au.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AuTaxRates2025 } from '../../src/finance/tax/au/au-tax-rates-2025.js';

const au = new AuTaxRates2025();

/** A resident taxpayer's slice, with every AU accumulator explicit. */
const st = (o = {}) => ({
  auOrdinaryIncomeYTD: 0, auCapitalGainsYTD: 0, auDiscountableGainsYTD: 0,
  auDiscountApportionedBaseYTD: 0, auDiscountAllowanceYTD: 0,
  auCapitalLossPool: 0, auTaxLossPool: 0, auFrankingCreditYTD: 0, auSuperTaxYTD: 0,
  people: { primary: { residency: 'AU' } },
  ...o,
});

const net = (o) => au._applyCapitalLosses(st(o));

// ─── s102-5 Step 1: current-year losses, and the ordering choice ─────────────

test('s102-5 Step 1: a current-year loss reduces the current-year gain', () => {
  // A year holding a 100k discountable gain and a 40k non-discountable LOSS. The
  // accumulators carry the signed total (60k) and the discountable slice (100k), which
  // is what the classifiers now book — the loss lives in the difference between them.
  const r = net({ auCapitalGainsYTD: 60_000, auDiscountableGainsYTD: 100_000 });

  assert.equal(r.total, 60_000, 'the 40k loss has already met 40k of the gain');
  assert.equal(r.discountable, 60_000, 'and it came off the discountable slice, there being no other');
  assert.equal(r.closing, 0, 'nothing left to carry');
});

test('s102-5 Step 1 Note 3: losses are applied to NON-discountable gains first', () => {
  // 100k of gain, half discountable, met by a 50k loss. Spending the loss on the
  // NON-discount half leaves the discount half intact, which is worth twice as much.
  // Getting this backwards is SILENT: the total is 50k either way, only the split moves
  // — which is exactly why the discountable figure is asserted and not just the total.
  const r = net({ auCapitalGainsYTD: 100_000, auDiscountableGainsYTD: 50_000,
                  auCapitalLossPool: 50_000 });

  assert.equal(r.total, 50_000, 'half the gain survives');
  assert.equal(r.discountable, 50_000, 'and ALL of it is the discountable half');

  // The money: 50k discountable ⇒ 25k taxable. Backwards it would be 50k taxable.
  const a = au._assessResidentPreFito(st({
    auCapitalGainsYTD: 100_000, auDiscountableGainsYTD: 50_000, auCapitalLossPool: 50_000,
  }));
  assert.equal(a.netTaxableGain, 25_000);
});

test('s102-5: the discount is applied to what REMAINS, never before the netting', () => {
  // The ordering question the ticket raised. Gains 100k, all discountable, loss 60k.
  //   Correct   (Step 1 then Step 5): (100k − 60k) × 50% = 20k taxable.
  //   Backwards (discount then net):  (100k × 50%) − 60k = 0 taxable — and 10k of loss
  //                                   wasted, since only 50k of base existed to absorb.
  const a = au._assessResidentPreFito(st({
    auCapitalGainsYTD: 100_000, auDiscountableGainsYTD: 100_000, auCapitalLossPool: 60_000,
  }));
  assert.equal(a.netTaxableGain, 20_000);
});

// ─── s102-10(2): capital losses NEVER touch ordinary income ─────────────────

test('s102-10(2): a net capital loss does not reduce ordinary income', () => {
  const withLoss = au._assessResidentPreFito(st({
    auOrdinaryIncomeYTD: 90_000, auCapitalGainsYTD: -50_000,
  }));
  const without = au._assessResidentPreFito(st({ auOrdinaryIncomeYTD: 90_000 }));

  assert.equal(withLoss.assessableIncome, without.assessableIncome,
    'the wage is assessed identically — the loss is quarantined to the CGT schedule');
  assert.equal(withLoss.netLiabilityPreFito, without.netLiabilityPreFito);
});

test('s102-10(2): the capital-loss pool is SEPARATE from the Div 36 pool', () => {
  // A 50k capital loss and a 50k Div 36 revenue loss must not be interchangeable.
  // Merging them would let the capital loss shelter the wage, which s102-10(2) forbids.
  const capital = au._assessResidentPreFito(st({
    auOrdinaryIncomeYTD: 80_000, auCapitalLossPool: 50_000,
  }));
  const revenue = au._assessResidentPreFito(st({
    auOrdinaryIncomeYTD: 80_000, auTaxLossPool: 50_000,
  }));

  assert.equal(capital.assessableIncome, 80_000, 'capital pool cannot touch the wage');
  assert.equal(revenue.assessableIncome, 30_000, 'Div 36 pool can, and does');
  assert.equal(capital.capitalLoss.closing, 50_000, 'and the capital pool survives intact');
});

test('s102-10(2): an unused capital loss carries forward rather than expiring', () => {
  const r = net({ auCapitalGainsYTD: -40_000 });
  assert.equal(r.total, 0);
  assert.equal(r.closing, 40_000, 'the whole loss survives — no annual allowance, unlike the US');
  assert.equal(r.applied, 0);
});

// ─── s102-5 Step 2: the carried-forward pool ────────────────────────────────

test('s102-5 Step 2: a carried-forward pool reduces a later year\'s gain', () => {
  const r = net({ auCapitalGainsYTD: 30_000, auDiscountableGainsYTD: 30_000,
                  auCapitalLossPool: 20_000 });
  assert.equal(r.total, 10_000);
  assert.equal(r.closing, 0, 'pool spent');
  assert.equal(r.applied, 20_000);
});

test('s102-5 Step 2: a pool larger than the gain survives, undiminished by any allowance', () => {
  // The US would take $3,000 against ordinary income here. Australia takes nothing:
  // s102-10(2) has no equivalent, so the whole remainder carries.
  const r = net({ auCapitalGainsYTD: 10_000, auDiscountableGainsYTD: 10_000,
                  auCapitalLossPool: 50_000 });
  assert.equal(r.total, 0);
  assert.equal(r.closing, 40_000);
});

test('current-year losses and the pool combine into one Step 1 + Step 2 reduction', () => {
  const r = net({ auCapitalGainsYTD: 100_000 - 30_000, auDiscountableGainsYTD: 100_000,
                  auCapitalLossPool: 25_000 });
  // Gross 70k net of a 30k current-year loss, then the 25k pool ⇒ 45k.
  assert.equal(r.total, 45_000);
  assert.equal(r.closing, 0);
});

// ─── The s115-115 apportionment must shrink with the base it sizes ──────────

test('design 83 G7: apportioned discount relief is scaled down with the gain it relieves', () => {
  // 100k discountable with 20k of apportioned relief, then a 50k loss halves the base.
  // Leaving the allowance at 20k would relieve a gain the loss had already removed.
  const r = net({ auCapitalGainsYTD: 100_000, auDiscountableGainsYTD: 100_000,
                  auDiscountApportionedBaseYTD: 100_000, auDiscountAllowanceYTD: 20_000,
                  auCapitalLossPool: 50_000 });

  assert.equal(r.discountable, 50_000);
  assert.equal(r.apportionedBase, 50_000);
  assert.equal(r.apportionedAllowance, 10_000, 'relief halves with its base');
});

// ─── Absence semantics: the old-save fallback that must not regress ─────────

test('an absent auDiscountableGainsYTD still means "all of it qualifies"', () => {
  // _cgtRelief has always treated the missing key as full eligibility (old saves,
  // synthetic states). This function now materializes the key for _cgtRelief, so it has
  // to reproduce that rule itself — defaulting to 0 silently withdrew the discount.
  const withKey    = au._applyCapitalLosses({ auCapitalGainsYTD: 100_000, auDiscountableGainsYTD: 100_000 });
  const withoutKey = au._applyCapitalLosses({ auCapitalGainsYTD: 100_000 });
  assert.equal(withoutKey.discountable, withKey.discountable);
  assert.equal(withoutKey.discountable, 100_000);
});

test('an empty state nets to zero rather than throwing', () => {
  const r = au._applyCapitalLosses({});
  assert.equal(r.total, 0);
  assert.equal(r.closing, 0);
});

// ─── The gain path is untouched ─────────────────────────────────────────────

test('a pure gain year with no losses is identical to the pre-design-90 computation', () => {
  const r = net({ auCapitalGainsYTD: 80_000, auDiscountableGainsYTD: 60_000 });
  assert.equal(r.total, 80_000);
  assert.equal(r.discountable, 60_000);
  assert.equal(r.applied, 0);
  assert.equal(r.closing, 0);
});

test('the 50% discount still lands on the surviving discountable slice', () => {
  // Gains 80k of which 60k discountable, 20k loss eats the NON-discountable 20k first.
  // Taxable = 60k × 50% = 30k.
  const a = au._assessResidentPreFito(st({
    auCapitalGainsYTD: 80_000, auDiscountableGainsYTD: 60_000, auCapitalLossPool: 20_000,
  }));
  assert.equal(a.netTaxableGain, 30_000);
  assert.equal(a.cgtDiscount, 30_000);
});

// ─── The multi-year narrative ───────────────────────────────────────────────

test('s102-15 end to end: a loss year funds later years until it is exhausted', () => {
  const y1 = net({ auCapitalGainsYTD: -60_000 });
  assert.equal(y1.closing, 60_000, 'nothing is allowed against ordinary income (s102-10(2))');

  const y2 = net({ auCapitalGainsYTD: 25_000, auDiscountableGainsYTD: 25_000,
                   auCapitalLossPool: y1.closing });
  assert.equal(y2.total, 0);
  assert.equal(y2.closing, 35_000);

  const y3 = net({ auCapitalGainsYTD: 50_000, auDiscountableGainsYTD: 50_000,
                   auCapitalLossPool: y2.closing });
  assert.equal(y3.total, 15_000);
  assert.equal(y3.closing, 0);

  // Conserved: 60k = 25k + 35k sheltered.
  assert.equal(25_000 + 35_000, 60_000);
});
