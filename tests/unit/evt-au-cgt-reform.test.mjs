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
 * evt-au-cgt-reform.test.mjs
 *
 * AU CGT reform (design 57):
 *   - the Age Pension / JobSeeker exemption from the 30% CGT minimum tax
 *   - cross-border resident real-bucket routing (§6.5)
 *   - residency step-up indexation base + FIFO indexation (§6.3)
 *   - Part 2: straddling lots apply the new regime to the WHOLE gain (the deemed
 *     1 Jul 2027 reset was removed — a lot held across the date keeps its
 *     residency-step-up AU basis and indexes from acquisition, so its full gain
 *     — incl. pre-2027 appreciation — is assessed, no 50% discount, 30% floor).
 *   - standalone Collectible (gold) indexation (Part 2, Item C)
 *
 * Run with: node --test tests/unit/evt-au-cgt-reform.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AuTaxRates2027 } from '../../src/finance/tax/au/au-tax-rates-2027.js';
import { AuTaxModule2027 } from '../../src/finance/tax/au/au-tax-module-2027.js';
import { UsTaxModule2026 } from '../../src/finance/tax/us/us-tax-module-2026.js';
import { InflationAdjustedAuTaxRates } from '../../src/finance/tax/inflation-adjusted-tax-rates.js';
import { AuTaxRates2026 } from '../../src/finance/tax/au/au-tax-rates-2026.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { CollectibleService } from '../../src/finance/services/collectible-service.js';
import { CollectibleSaleApplyReducer } from '../../src/finance/account-rules/us/us-collectible-classes.js';
import { Graph } from '../../src/graph/graph.js';
import { EventBus } from '../../src/simulation-framework/event-bus.js';
import { consumeHoldingsFifo } from '../../src/finance/holdings/holdings-fifo.js';
import { ACCOUNT_TYPE } from '../../src/finance/assets/account.js';
import { ALLOCATION } from '../../src/finance/holdings/allocation.js';

/** Extract a named reducer fn from a tax module instance. */
const getFn = (module, actionType) => module.getReducerFns().get(actionType);

// ─── Age Pension / JobSeeker minimum-tax exemption (design 57 §6.6) ──────────

const auResident = (overrides = {}) => ({
  people: { primary: { residency: 'AU' } },
  auOrdinaryIncomeYTD: 0, auCapitalGainsYTD: 0, auNonResidentWithholdingYTD: 0,
  auSuperTaxYTD: 0, auFrankingCreditYTD: 0,
  ...overrides,
});

test('EXEMPT: income-support recipient pays no 30% minimum-tax top-up', () => {
  const rates = new AuTaxRates2027();
  const gainState = { auCapitalGainsYTD: 100_000, auRealCapitalGainsYTD: 100_000 };

  const taxed  = rates.computeTax(auResident({ ...gainState }));
  const exempt = rates.computeTax(auResident({ ...gainState, auMinTaxExempt: true }));

  assert.ok(taxed.cgtMinimumTaxTopUp > 0, 'non-exempt gets a top-up');
  assert.strictEqual(exempt.cgtMinimumTaxTopUp, 0, 'exempt gets no top-up');
  assert.ok(exempt.netLiability < taxed.netLiability, 'exemption lowers the liability');
});

// ─── Bug 1: inflation wrapper must preserve the FY2027 reform (design 57 §6.1) ─

test('BUG1: inflation-adjusted FY2027 rates keep the reform (no reversion to 50% discount)', () => {
  const wrapped = new InflationAdjustedAuTaxRates(new AuTaxRates2027(), 1.25);
  // Real bucket populated by the classifier: the wrapper must remove the discount
  // (relief 0, reform label) rather than silently applying the base 50% discount.
  const relief = wrapped._cgtRelief({ auRealCapitalGainsYTD: 100_000 }, 100_000);
  assert.strictEqual(relief.netTaxableGain, 100_000, 'full real gain assessable (no 50% discount)');
  assert.strictEqual(relief.reliefAmount, 0);
  assert.strictEqual(relief.minTaxRate, AuTaxRates2027.MIN_CGT_RATE, '30% minimum tax preserved');
  assert.match(wrapped._cgtReliefLabel(), /Discount Removed/);
});

test('BUG1: inflation-wrapped FY2026 keeps the 50% discount (regression)', () => {
  const wrapped = new InflationAdjustedAuTaxRates(new AuTaxRates2026(), 1.1);
  const relief = wrapped._cgtRelief({}, 100_000);
  assert.strictEqual(relief.netTaxableGain, 50_000, 'FY2026 still discounts 50%');
  assert.strictEqual(relief.minTaxRate, 0);
});

// ─── Bug 2: cross-border resident gains populate the real bucket (§6.5) ──────

test('CROSS-BORDER: US-brokerage STOCK_WITHDRAWAL_TAX records indexed AUD gain for AU resident', () => {
  const fn = getFn(new AuTaxModule2027(), 'STOCK_WITHDRAWAL_TAX');
  const s0 = { auRealCapitalGainsYTD: 0 };
  // auIndexedGain (< auGain) is the reform real gain; 1:1 FX (no rate in state).
  const s1 = fn(s0, { residency: 'AU', gain: 100_000, auGain: 80_000, auIndexedGain: 70_000 });
  assert.strictEqual(s1.auRealCapitalGainsYTD, 70_000, 'indexed gain into shared real bucket');
});

test('CROSS-BORDER: STOCK_WITHDRAWAL_TAX no-ops for a non-AU resident', () => {
  const fn = getFn(new AuTaxModule2027(), 'STOCK_WITHDRAWAL_TAX');
  const s0 = { auRealCapitalGainsYTD: 0 };
  const s1 = fn(s0, { residency: 'US', gain: 100_000, auGain: 80_000, auIndexedGain: 70_000 });
  assert.strictEqual(s1.auRealCapitalGainsYTD, 0, 'no real gain for non-resident');
});

test('CROSS-BORDER: COMPANY_SALE_TAX records the full gain (no indexation) for AU resident', () => {
  const fn = getFn(new AuTaxModule2027(), 'COMPANY_SALE_TAX');
  const s1 = fn({ auRealCapitalGainsYTD: 0 }, { residency: 'AU', gain: 450_000 });
  assert.strictEqual(s1.auRealCapitalGainsYTD, 450_000);
});

test('CROSS-BORDER: COLLECTIBLE_SALE_TAX indexes gold but not true collectibles', () => {
  const fn = getFn(new AuTaxModule2027(), 'COLLECTIBLE_SALE_TAX');
  // Gold (isGold): the indexed gain is assessable.
  const gold = fn({ auRealCapitalGainsYTD: 0 },
    { residency: 'AU', isGold: true, gain: 20_000, auGain: 18_000, auIndexedGain: 15_000 });
  assert.strictEqual(gold.auRealCapitalGainsYTD, 15_000, 'gold indexes');
  // True collectible (no isGold): un-indexed AU gain.
  const art = fn({ auRealCapitalGainsYTD: 0 },
    { residency: 'AU', gain: 20_000, auGain: 18_000, auIndexedGain: 15_000 });
  assert.strictEqual(art.auRealCapitalGainsYTD, 18_000, 'true collectible is not indexed');
});

// ─── C3: residency step-up stamps the indexation base level (§6.3) ───────────

test('STEP-UP: residency change stamps costBaseByCountry.AU and acquisitionPriceLevel', () => {
  const svc = new AccountService(new Graph(), new EventBus());
  const account = {
    type: ACCOUNT_TYPE.BROKERAGE, balance: 1500, balanceAtResidencyChange: null,
    holdings: [
      { marketValue: 1000, costBasis: 600, costBaseByCountry: null, acquisitionPriceLevel: null },
      { marketValue: 500,  costBasis: 400, costBaseByCountry: null, acquisitionPriceLevel: null },
    ],
  };
  svc.recordResidencyChange(account, { country: 'AU', stepUp: true, priceLevel: 1.28 });
  assert.strictEqual(account.holdings[0].costBaseByCountry.AU, 1000, 'AU base = market value at move');
  assert.strictEqual(account.holdings[0].acquisitionPriceLevel, 1.28, 'indexation base = AU level at move');
  assert.strictEqual(account.holdings[1].acquisitionPriceLevel, 1.28);
});

test('STEP-UP: an already-stamped level is not overwritten on re-entry', () => {
  const svc = new AccountService(new Graph(), new EventBus());
  const account = {
    type: ACCOUNT_TYPE.BROKERAGE, balance: 1000, balanceAtResidencyChange: 999,
    holdings: [{ marketValue: 1000, costBasis: 600, costBaseByCountry: { AU: 700 }, acquisitionPriceLevel: 1.1 }],
  };
  svc.recordResidencyChange(account, { country: 'AU', stepUp: true, priceLevel: 1.5 });
  assert.strictEqual(account.holdings[0].costBaseByCountry.AU, 700, 'existing AU base kept');
  assert.strictEqual(account.holdings[0].acquisitionPriceLevel, 1.1, 'existing level kept');
});

// ─── C2/C4: FIFO indexes the gold (collectible) slice (§6.3) ─────────────────

test('FIFO: collectible (gold) slice is indexed from its acquisition level', () => {
  const holdings = [{
    marketValue: 1000, costBasis: 400, allocation: ALLOCATION.GOLD,
    costBaseByCountry: { AU: 500 }, acquisitionPriceLevel: 1.0,
    purchaseDate: new Date(Date.UTC(2020, 0, 1)),
  }];
  const r = consumeHoldingsFifo(holdings, 1000, { level: 1.2, asOfMs: Date.UTC(2028, 0, 1), country: 'AU' });
  assert.strictEqual(r.collectibleBasisByCountry.AU, 500, 'un-indexed AU collectible basis');
  assert.strictEqual(r.collectibleIndexedBasisByCountry.AU, 600, 'indexed = 500 × 1.2/1.0');
});

// ─── Item C: standalone Collectible (gold) indexation (design 57 Part 2) ─────

test('COLLECTIBLE-STEP-UP: gold gets an AU cost base + level at the move; non-gold does not', () => {
  const svc = new CollectibleService(new Graph(), null, new EventBus());
  const gold    = { isGold: true,  value: 100_000, balanceAtResidencyChange: null, costBaseByCountry: null, acquisitionPriceLevel: null };
  const artwork = { isGold: false, value:  50_000, balanceAtResidencyChange: null, costBaseByCountry: null, acquisitionPriceLevel: null };

  svc.recordResidencyChange(gold,    { country: 'AU', stepUp: true, priceLevel: 1.25 });
  svc.recordResidencyChange(artwork, { country: 'AU', stepUp: true, priceLevel: 1.25 });

  assert.strictEqual(gold.costBaseByCountry.AU, 100_000, 'gold AU base = value at move');
  assert.strictEqual(gold.acquisitionPriceLevel, 1.25, 'gold indexation base = AU level at move');
  assert.strictEqual(artwork.costBaseByCountry, null, 'true collectible is NOT stepped up (un-indexed)');
  assert.strictEqual(artwork.acquisitionPriceLevel, null);
});

/** Sale reducer with a stubbed cash credit; destinationKey short-circuits routing. */
function saleReducer() {
  return new CollectibleSaleApplyReducer({ accountService: { transaction() {} }, stateRegistry: {} });
}

test('COLLECTIBLE-SALE: stepped-up gold sold post-2027 (AU) yields an indexed real gain < auGain', () => {
  const r = saleReducer();
  const state = {
    people: { primary: { residency: 'AU' } },
    cpiAccumulator: { AU: 1.5 },   // sale-date level; acquisition level 1.25 ⇒ ratio 1.2
    usSavingsAccount: { balance: 0 },
    collectibleAccount: {
      value: 200_000, isGold: true,
      costBaseByCountry: { AU: 100_000 }, acquisitionPriceLevel: 1.25,
    },
  };
  const next = r.reduce(state, {
    salePrice: 200_000, costBasis: 60_000, residency: 'AU',
    stateKey: 'collectibleAccount', destinationKey: 'usSavingsAccount',
  });
  const [tax] = next.next.filter(a => a.type === 'COLLECTIBLE_SALE_TAX');
  assert.strictEqual(tax.isGold, true);
  assert.strictEqual(tax.gain, 140_000, 'US gain = 200k − 60k basis');
  assert.strictEqual(tax.auGain, 100_000, 'AU gain = 200k − 100k stepped-up AU base');
  // indexed AU base = 100k × 1.5/1.25 = 120k ⇒ indexed gain = 80k (< auGain).
  assert.strictEqual(tax.auIndexedGain, 80_000, 'indexed real gain = 200k − 120k');
  assert.ok(tax.auIndexedGain < tax.auGain, 'indexation relieves the inflationary slice');
});

test('COLLECTIBLE-SALE: a true collectible is not indexed (auIndexedGain === auGain === gain)', () => {
  const r = saleReducer();
  const state = {
    people: { primary: { residency: 'AU' } },
    cpiAccumulator: { AU: 1.5 },
    usSavingsAccount: { balance: 0 },
    collectibleAccount: { value: 80_000, isGold: false, costBaseByCountry: null, acquisitionPriceLevel: null },
  };
  const next = r.reduce(state, {
    salePrice: 80_000, costBasis: 50_000, residency: 'AU',
    stateKey: 'collectibleAccount', destinationKey: 'usSavingsAccount',
  });
  const [tax] = next.next.filter(a => a.type === 'COLLECTIBLE_SALE_TAX');
  assert.strictEqual(tax.isGold, false);
  assert.strictEqual(tax.gain, 30_000);
  assert.strictEqual(tax.auGain, 30_000, 'no AU step-up ⇒ auGain falls back to raw gain');
  assert.strictEqual(tax.auIndexedGain, 30_000, 'true collectibles are NOT indexed');
});

// ─── Item B: straddling lot applies the new regime to the WHOLE gain ─────────
// The deemed 1 Jul 2027 reset was removed (design 57 Part 2, Item B). A lot held
// by an AU resident across 1 Jul 2027 keeps its residency-step-up AU basis and
// acquisition level, so a post-2027 sale realizes its FULL AU gain (incl. pre-2027
// appreciation) via the indexation path — no 50% discount, 30% floor — rather than
// exempting the pre-2027 slice as the old deemed reset did.

test('STRADDLE: pre-2027 AU-resident lot sold post-2027 assesses the FULL indexed gain', () => {
  // Lot acquired via residency step-up in 2026 (pre-reform): AU basis 100k, level 1.0.
  // Sold 2028 at 200k with CPI now 1.10 (10% since the step-up).
  const auStockFn = getFn(new AuTaxModule2027(), 'AU_STOCK_WITHDRAWAL_TAX');

  // The AU brokerage sale reducer would compute, for the whole holding:
  //   auGain        = 200k − 100k              = 100k   (full gain, no reset carve-out)
  //   auIndexedGain = 200k − 100k×1.10         =  90k   (indexed from the acquisition level)
  const s0 = {
    people: { primary: { residency: 'AU' } },
    auRealCapitalGainsYTD: 0, auPersonRealCapitalGainsYTD: {},
    auCapitalGainsYTD: 0, auPersonCapitalGainsYTD: {},
    auStockAccount: { ownershipType: 'sole', ownerId: 'primary' },
  };
  const s1 = auStockFn(s0, {
    residency: 'AU', ownershipType: 'sole', ownerId: 'primary',
    gain: 100_000, auGain: 100_000, auIndexedGain: 90_000,
  });
  // The WHOLE indexed gain (incl. the pre-2027 slice) lands in the real bucket —
  // nothing is exempted. Owned by 'primary' ⇒ routed to the per-person map.
  assert.strictEqual(s1.auPersonRealCapitalGainsYTD.primary, 90_000);

  // And FY2027 rates assess it with no 50% discount + the 30% floor.
  const rates = new AuTaxRates2027();
  const tax = rates.computeTax({
    people: { primary: { residency: 'AU' } },
    auOrdinaryIncomeYTD: 0,
    auCapitalGainsYTD: 100_000, auRealCapitalGainsYTD: 90_000,
    auNonResidentWithholdingYTD: 0, auSuperTaxYTD: 0, auFrankingCreditYTD: 0,
  });
  assert.strictEqual(tax.discountedCapitalGains, 90_000, 'full indexed gain assessable (no 50% discount)');
  assert.ok(tax.cgtMinimumTaxTopUp > 0, '30% minimum tax floor applies to the whole gain');
  assert.match(tax.lineItems.find(l => l.amount === -tax.cgtDiscount)?.label ?? '', /Discount Removed/);
});

// ─── F5: the two CGT buckets must be a partition of the SAME disposals ────────
//
// au-house-sale F5. An AU-resident FY2031-32 return showed gross capital gains
// A$421,934 against an indexed ("real") gain of A$422,330 — the real bucket A$396
// LARGER than the nominal one it is a slice of, so `reliefAmount = gross − real` went
// negative and the return printed a "Cost-Base Indexation Relief" line that ADDED
// assessable income.
//
// The cause was not rounding. `COLLECTIBLE_SALE_TAX` is classified twice: the US
// module books the AU nominal buckets, the FY2027 AU module books the real one. The US
// module measured its AU booking on `action.gain` — the US-measured gain, from the
// original basis — while the AU module measured the real bucket on `action.auGain` /
// `auIndexedGain`, which are measured from Australia's own basis (the s855-45 step-up
// at the move, design 72 §3). Bullion held through a move has a HIGHER AU gain than US
// gain, so the real bucket outgrew the nominal one on every disposal. Every sibling
// classifier already derived `auGain ?? gain` for this; only the collectible one did not.

const US_FNS = new UsTaxModule2026().getReducerFns();

test('F5: COLLECTIBLE_SALE_TAX books the AU-measured gain into the AU nominal bucket', () => {
  const fn = US_FNS.get('COLLECTIBLE_SALE_TAX');
  // AU's basis is lower than the US one (post-move step-up), so auGain > gain — the
  // au-house-sale shape. No FX rate in state ⇒ 1:1, so the AUD figures are the USD ones.
  const s1 = fn({ usCollectibleGainsYTD: 0, auCapitalGainsYTD: 0, auDiscountableGainsYTD: 0 },
    { residency: 'AU', isGold: true, gain: 497.05, auGain: 588.89, auIndexedGain: 588.89,
      auShortTermGain: 588.89, auLongTermGain: 0 });

  assert.strictEqual(s1.usCollectibleGainsYTD, 497.05, 'US bucket keeps the US-measured gain');
  assert.strictEqual(s1.auCapitalGainsYTD, 588.89, 'AU bucket takes the AU-measured gain');
  // The split is degenerate here (the stamped character is all short), but it must be
  // taken against the AU gain: `long = auGain − auShort = 0`. Measured against the US
  // gain it came out as `497.05 − 588.89 = −91.84`, a NEGATIVE discountable slice that
  // reduced the household's Div 115 base on every gold disposal.
  assert.strictEqual(s1.auDiscountableGainsYTD, 0,
    'the discountable slice is the AU gain less the AU short slice, never negative');
});

test('F5: the collectible pair leaves real ≤ nominal, so the relief is never negative', () => {
  const usFn = US_FNS.get('COLLECTIBLE_SALE_TAX');
  const auFn = getFn(new AuTaxModule2027(), 'COLLECTIBLE_SALE_TAX');
  const action = { residency: 'AU', isGold: true, gain: 497.05, auGain: 588.89,
    auIndexedGain: 588.89, auShortTermGain: 588.89, auLongTermGain: 0 };

  const s0 = { usCollectibleGainsYTD: 0, auCapitalGainsYTD: 0, auDiscountableGainsYTD: 0,
    auRealCapitalGainsYTD: 0 };
  const s1 = auFn(usFn(s0, action), action);

  assert.ok(s1.auRealCapitalGainsYTD <= s1.auCapitalGainsYTD + 0.01,
    `real ${s1.auRealCapitalGainsYTD} exceeds nominal ${s1.auCapitalGainsYTD}`);
  const { reliefAmount } = new AuTaxRates2027()._cgtRelief(s1, s1.auCapitalGainsYTD);
  assert.ok(reliefAmount >= 0, `indexation relief printed negative: ${reliefAmount}`);
});

test('F5: a real bucket larger than the nominal one is a hard error in dev/test', () => {
  const rates = new AuTaxRates2027();
  assert.throws(
    () => rates._cgtRelief({ auCapitalGainsYTD: 421_934, auRealCapitalGainsYTD: 422_330 }, 421_934),
    /indexation partition violated/,
    'the F5 state must not pass silently',
  );
  // Float noise is not a violation.
  assert.doesNotThrow(() => rates._cgtRelief({ auRealCapitalGainsYTD: 100_000.005 }, 100_000));
});

test('F5: a production build clamps to the nominal gain rather than failing the run', () => {
  const prev = process.env.AU_INDEXATION_STRICT;
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(m);
  process.env.AU_INDEXATION_STRICT = 'off';
  try {
    const r = new AuTaxRates2027()._cgtRelief({ auRealCapitalGainsYTD: 422_330 }, 421_934);
    assert.strictEqual(r.netTaxableGain, 421_934, 'assess the nominal gain, not the impossible real one');
    assert.strictEqual(r.reliefAmount, 0, 'relief clamps to zero instead of going negative');
    assert.equal(warnings.length, 1, 'the violation is still reported');
  } finally {
    console.warn = realWarn;
    if (prev === undefined) delete process.env.AU_INDEXATION_STRICT;
    else process.env.AU_INDEXATION_STRICT = prev;
  }
});

test('F5: the FITO counterfactual is exempt — its degenerate limit is a detector', () => {
  // design 57 Part 2 D / FITO-D: when a classifier fails to stamp the US-source REAL
  // slice, the "without US-source" pass empties the nominal bucket and leaves the real
  // one whole. Clamping there would repair the symptom and hide the missing signal.
  const rates = new AuTaxRates2027();
  assert.doesNotThrow(() => {
    const r = rates._cgtRelief(
      { _fitoCounterfactual: true, auCapitalGainsYTD: 0, auRealCapitalGainsYTD: 100_000 }, 0);
    assert.strictEqual(r.netTaxableGain, 100_000, 'left untouched, so FITO-D still observes the collapse');
  });
});

// ─── Part 6: a capital LOSS must move both buckets by the same amount ────────
//
// The nominal `auCapitalGainsYTD` and the reform's `auRealCapitalGainsYTD` are booked
// per disposal by two different modules (§6.5) and are only meaningful as a pair:
// `_cgtRelief` assesses the real one and prints `nominal − real` as the indexation
// relief. Indexation cannot create or increase a capital loss (ITAA97 s960-275), so a
// LOSS carries no relief at all and must reach both buckets identically.
//
// Most emitters stamp `auIndexedGain = Math.max(0, …)`, which does not mean "no
// indexation on a loss" — it means the loss never reached the real bucket. That was
// invisible because `_applyCapitalLosses` rediscovers a current-year loss from a
// *bucket* that came out negative and subtracts it; a loss sitting beside a larger gain
// in the SAME bucket leaves every bucket positive, so nothing was subtracted and the
// FY2027 return assessed the gross indexed gain. The AU house — the one emitter that
// signs `auIndexedGain` correctly — had the opposite defect: its loss was in the real
// bucket AND subtracted again.

const US_FNS_2026 = new UsTaxModule2026().getReducerFns();
const AU_FNS_2027 = new AuTaxModule2027().getReducerFns();

/** Both buckets, summed across the household scalar and any per-person map. */
const buckets = (s) => {
  const tot = (scalar, map) =>
    (s[scalar] ?? 0) + Object.values(s[map] ?? {}).reduce((a, b) => a + b, 0);
  return {
    nominal: +tot('auCapitalGainsYTD',     'auPersonCapitalGainsYTD').toFixed(2),
    real:    +tot('auRealCapitalGainsYTD', 'auPersonRealCapitalGainsYTD').toFixed(2),
  };
};

/**
 * Every disposal type that feeds the FY2027 real bucket, with a LOSS payload. `gain`
 * and `auGain` are signed; `auIndexedGain` is floored the way the emitters floor it,
 * which is exactly the input the classifier has to be robust to.
 */
const LOSS_CASES = [
  { type: 'AU_STOCK_WITHDRAWAL_TAX', us: false,
    action: { residency: 'AU', gain: -400, auGain: -400, auIndexedGain: 0,
      auDiscountableGain: -400, auShortTermGain: 0, auLongTermGain: -400,
      stateKey: 'auStockAccount' } },
  { type: 'AU_HOUSE_SALE_TAX', us: false,
    action: { residency: 'AU', gain: -50_000, auGain: -50_000, auIndexedGain: -50_000,
      auTaxableFraction: 1, auShortTermGain: 0, auLongTermGain: -50_000,
      stateKey: 'auHouseProperty' } },
  { type: 'STOCK_WITHDRAWAL_TAX', us: true,
    action: { residency: 'AU', gain: -400, auGain: -400, auIndexedGain: 0,
      auDiscountableGain: -400, auShortTermGain: 0, auLongTermGain: -400,
      stateKey: 'usStockAccount' } },
  { type: 'COMPANY_SALE_TAX', us: true,
    action: { residency: 'AU', gain: -9_000, auGain: 0, auIndexedGain: 0,
      auShortTermGain: 0, auLongTermGain: -9_000 } },
  { type: 'COLLECTIBLE_SALE_TAX', us: true,
    action: { residency: 'AU', isGold: true, gain: -700, auGain: 0, auIndexedGain: 0,
      auShortTermGain: 0, auLongTermGain: -700 } },
  { type: 'COLLECTIBLE_SALE_TAX (true collectible, never indexed)', reducer: 'COLLECTIBLE_SALE_TAX', us: true,
    action: { residency: 'AU', gain: -700, auGain: 0, auIndexedGain: 0,
      auShortTermGain: 0, auLongTermGain: -700 } },
  { type: 'US_HOUSE_SALE_TAX', us: true,
    action: { residency: 'AU', gain: -50_000, auGain: 0, auIndexedGain: 0,
      auShortTermGain: 0, auLongTermGain: -50_000 } },
];

test('Part 6: a capital loss reaches the nominal and real buckets identically', () => {
  const failures = [];
  for (const { type, reducer, us, action } of LOSS_CASES) {
    const name = reducer ?? type;
    const s0 = { people: null, auCapitalGainsYTD: 0, auDiscountableGainsYTD: 0,
      auRealCapitalGainsYTD: 0, usCapitalGainsYTD: 0, usCollectibleGainsYTD: 0 };
    let s = s0;
    if (us) s = US_FNS_2026.get(name)(s, action);   // nominal side
    s = AU_FNS_2027.get(name)(s, action);           // real side (+ nominal, for AU-native)

    const b = buckets(s);
    if (b.real !== b.nominal) {
      failures.push(`${type}: nominal ${b.nominal} but real ${b.real}`);
    }
    if (!(b.nominal < 0)) failures.push(`${type}: the loss never reached the buckets at all`);
  }
  assert.deepEqual(failures, [],
    'A capital loss carries no indexation (s960-275), so it must reduce both buckets by\n' +
    'the same amount. Where it does not, `_cgtRelief` prints a relief line on a loss and\n' +
    '`_applyCapitalLosses` can only rediscover the loss when a whole bucket goes\n' +
    'negative — so a loss beside a larger gain in the same bucket is silently dropped\n' +
    'from the FY2027 assessment:\n  ' + failures.join('\n  '));
});

test('Part 6: a loss beside a larger gain in the SAME bucket still nets the real gain', () => {
  const stock = AU_FNS_2027.get('AU_STOCK_WITHDRAWAL_TAX');
  const disp = (nominal, indexed) => ({ residency: 'AU', gain: nominal, auGain: nominal,
    auIndexedGain: Math.max(0, indexed), auDiscountableGain: nominal,
    auShortTermGain: 0, auLongTermGain: nominal, stateKey: 'auStockAccount' });

  let s = { people: null, auCapitalGainsYTD: 0, auDiscountableGainsYTD: 0,
    auRealCapitalGainsYTD: 0, auCapitalLossPool: 0, auStockAccount: {} };
  s = stock(s, disp(1_000, 600));   // nominal 1,000, indexed 600
  s = stock(s, disp(-400, 0));      // a loss in the same discountable bucket

  // Every bucket stays positive, so `_applyCapitalLosses` finds no current-year loss to
  // apply — which is correct precisely because the accumulators already netted it.
  const c = new AuTaxRates2027()._applyCapitalLosses(s);
  assert.strictEqual(c.applied, 0, 'nothing to re-apply: the accumulators already netted');
  assert.strictEqual(c.total, 600, 'nominal net capital gain');
  assert.strictEqual(c.real, 200, 'real net capital gain = 600 indexed − 400 loss');
});

test('Part 6: the prior-year pool still comes off the real bucket, and only once', () => {
  const stock = AU_FNS_2027.get('AU_STOCK_WITHDRAWAL_TAX');
  const base = () => ({ people: null, auCapitalGainsYTD: 0, auDiscountableGainsYTD: 0,
    auRealCapitalGainsYTD: 0, auStockAccount: {} });
  const gain = { residency: 'AU', gain: 1_000, auGain: 1_000, auIndexedGain: 600,
    auDiscountableGain: 1_000, auShortTermGain: 0, auLongTermGain: 1_000,
    stateKey: 'auStockAccount' };
  const loss = { residency: 'AU', gain: -400, auGain: -400, auIndexedGain: 0,
    auDiscountableGain: 0, auShortTermGain: -400, auLongTermGain: 0,
    stateKey: 'auStockAccount' };
  const rates = new AuTaxRates2027();

  // A carried-forward loss lives OUTSIDE the year's accumulators, so it must be applied.
  const poolOnly = rates._applyCapitalLosses({ ...stock(base(), gain), auCapitalLossPool: 150 });
  assert.strictEqual(poolOnly.real, 450, '600 indexed − 150 carried-forward');

  // With a current-year loss in the OTHER bucket as well, the pool is applied and the
  // current-year loss is not — it is already inside the real accumulator.
  const both = rates._applyCapitalLosses({
    ...stock(stock(base(), gain), loss), auCapitalLossPool: 150 });
  assert.strictEqual(both.applied, 550, 'the nominal worksheet still reports both steps');
  assert.strictEqual(both.real, 50, '600 indexed − 400 current-year − 150 carried-forward');
});
