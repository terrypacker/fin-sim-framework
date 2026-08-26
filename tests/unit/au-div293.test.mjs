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
 * au-div293.test.mjs — design 95 §9.4, phase 8. ITAA97 Division 293.
 *
 * The extra 15% a high earner pays on their concessional contributions. Two things
 * about it are easy to get wrong and both are pinned here:
 *
 *   - **the "lesser of" in s293-20(1)** makes it NON-LINEAR. A naive
 *     `15% x concessional` for anyone over \$250,000 overstates it, and someone one
 *     dollar over the threshold owes 15 cents rather than thousands.
 *   - **it is the MEMBER'S liability**, so it belongs inside their net liability and
 *     is debited from their cash — but it is NOT part of the income tax the franking
 *     offset and the FITO reduce, and (review Q5) it is deliberately NOT staged as a
 *     creditable foreign tax on the US side.
 *
 * Run with: node --test tests/unit/au-div293.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { div293, DIV293_THRESHOLD_AUD, DIV293_RATE } from '../../src/finance/tax/au/div293.js';
import { AuTaxRates2026 } from '../../src/finance/tax/au/au-tax-rates-2026.js';
import { maxContributionsBase } from '../../src/finance/tax/au/au-super-limits.js';

const resident = extra => ({ people: { p: { residency: 'AU' } }, ...extra });

// ─── The provision itself ────────────────────────────────────────────────────

test('D293-1 below the threshold there is no liability at all', () => {
  // 200,000 + 20,000 = 220,000. The sum of BOTH limbs is what is tested, not income
  // alone — someone on 240,000 with 20,000 of contributions is over it.
  assert.equal(div293({ taxableIncome: 200_000, concessionalContributions: 20_000 }).tax, 0);
  assert.equal(div293({ taxableIncome: 240_000, concessionalContributions: 20_000 }).tax, 1_500);
});

test('D293-2 the "lesser of" phases in over exactly one contribution\'s width', () => {
  const cc = 20_000;
  const at = income => div293({ taxableIncome: income, concessionalContributions: cc });

  // A dollar over the threshold costs 15 cents, not 15% of the contributions. This is
  // the whole point of s293-20(1) and the thing a flat `15% x concessional` gets
  // wrong by \$2,999.85 on this fixture.
  const oneOver = at(DIV293_THRESHOLD_AUD - cc + 1);
  assert.equal(oneOver.taxableContributions, 1);
  assert.equal(oneOver.tax, 0.15);
  assert.equal(oneOver.binding, 'EXCESS');

  // Halfway through the band, half the contributions are taxed.
  assert.equal(at(240_000).taxableContributions, 10_000);
  // At the top of the band and beyond, all of them are — and it stops rising.
  assert.equal(at(230_000 + cc).taxableContributions, cc);
  assert.equal(at(500_000).taxableContributions, cc, 'the tax is capped by the contributions');
  assert.equal(at(500_000).binding, 'CONTRIBUTIONS');
});

test('D293-3 no contributions ⇒ no liability, however high the income (s293-20(2))', () => {
  const r = div293({ taxableIncome: 5_000_000, concessionalContributions: 0 });
  assert.equal(r.tax, 0);
  assert.equal(r.binding, null);
});

test('D293-4 low tax contributions are net of the excess concessional amount (s293-25)', () => {
  // Phase 7 clamps contributions at the Div 291 cap, so `excessConcessional` is
  // structurally zero today — but the parameter is real and taken, so a future phase
  // that models the excess regime instead of clamping does not have to find this line.
  const r = div293({ taxableIncome: 400_000, concessionalContributions: 30_000,
                     excessConcessional: 5_000 });
  assert.equal(r.lowTaxContributions, 25_000);
  assert.equal(r.tax, +(25_000 * DIV293_RATE).toFixed(2));
});

test('D293-5 the threshold is a literal, and is no longer the SG contributions base', () => {
  // s293-20(1) writes \$250,000 into the statute; it is not indexed. The SGAA s10A(5)
  // base moves with the concessional cap and passed it on 1 July 2026. Deriving one
  // from the other was right for two years and is now wrong by \$20,830.
  assert.equal(DIV293_THRESHOLD_AUD, 250_000);
  assert.equal(maxContributionsBase(2025), DIV293_THRESHOLD_AUD, 'equal through 2025-26…');
  assert.notEqual(maxContributionsBase(2026), DIV293_THRESHOLD_AUD, '…and apart from 2026-27');
});

test('D293-6 sacrificing cannot avoid it — the two limbs move in opposite directions', () => {
  // s293-20(1)(a) disregards reportable superannuation contributions, so a sacrificed
  // dollar leaves limb (a) and arrives in limb (b). The SUM barely moves, which is
  // exactly how the provision is designed and why it cannot be sacrificed away.
  const noSacrifice = div293({ taxableIncome: 300_000, concessionalContributions: 20_000 });
  const sacrificed  = div293({ taxableIncome: 280_000, concessionalContributions: 40_000 });

  assert.equal(noSacrifice.taxableContributions, 20_000);
  assert.equal(sacrificed.taxableContributions,  40_000);
  // Sacrificing MORE increases the Div 293 base rather than reducing it — the
  // concession being clawed back is the concession on the sacrifice itself.
  assert.ok(sacrificed.tax > noSacrifice.tax);
});

// ─── On the return ───────────────────────────────────────────────────────────

test('D293-7 it lands inside net liability but outside gross tax', () => {
  const rates = new AuTaxRates2026();
  const withCc = rates.computeTax(resident({
    auOrdinaryIncomeYTD: 300_000, auLowTaxContributionsYTD: 30_000 }));
  const noCc   = rates.computeTax(resident({ auOrdinaryIncomeYTD: 300_000 }));

  assert.equal(withCc.div293Tax, 4_500);
  assert.equal(noCc.div293Tax, 0, 'control: no contributions, no Div 293');

  // Gross Tax is the income tax, and Div 293 is not part of it — it is imposed by its
  // own Act on a base of its own.
  assert.equal(withCc.grossTax, noCc.grossTax);
  // …but the member really owes it, so it is inside what they pay.
  assert.equal(+(withCc.netLiability - noCc.netLiability).toFixed(2), 4_500);
});

test('D293-8 the return foots: the visible lines sum to Net Tax Liability', () => {
  // Design 71 §6. The Div 293 lines sit BELOW the offsets (nothing above reaches it)
  // and ABOVE the total (it is part of it) — printing it under the total it belongs
  // to would leave the lines not summing, which is the check this pins.
  const rates = new AuTaxRates2026();
  const d = rates.computeTax(resident({
    auOrdinaryIncomeYTD: 300_000, auLowTaxContributionsYTD: 30_000 }));

  const labels = d.lineItems.map(l => l.label);
  const iGross = labels.indexOf('Gross Tax');
  const iD293  = labels.findIndex(l => l.startsWith('Div 293 Tax'));
  const iNet   = labels.indexOf('Net Tax Liability');
  assert.ok(iGross < iD293 && iD293 < iNet, 'Gross Tax → Div 293 → Net Tax Liability');

  const grossLine = d.lineItems[iGross].amount;
  const credits   = d.lineItems.slice(iGross + 1, iNet)
    .filter(l => !l.label.startsWith('Div 293 Taxable'))
    .reduce((s, l) => s + l.amount, 0);
  assert.ok(Math.abs(grossLine + credits - d.netLiability) < 0.01,
    `${grossLine} + ${credits} must equal ${d.netLiability}`);
});

test('D293-9 no offset above it can reduce it', () => {
  // Franking credits are refundable and uncapped under s67-25, so on a return whose
  // income tax they wipe out entirely the Div 293 liability must still stand. It is a
  // separate imposition, not a component of the assessment the offsets reduce.
  const rates = new AuTaxRates2026();
  const d = rates.computeTax(resident({
    auOrdinaryIncomeYTD: 300_000, auFrankingCreditYTD: 500_000,
    auLowTaxContributionsYTD: 30_000 }));

  assert.ok(d.netLiability < 0, 'control: the offsets more than cover the income tax');
  assert.equal(d.div293Tax, 4_500, 'and Div 293 survives them untouched');
});

test('D293-10 a non-resident is liable too', () => {
  // Nothing in s293-15 or s293-20 conditions the liability on residency. A foreign
  // resident working in Australia has an employer paying the SG for them just the
  // same, and omitting this would let a cross-border household's non-resident earner
  // escape it silently.
  const rates = new AuTaxRates2026();
  const nr = rates.computeTax({
    people: { p: { residency: 'US' } },
    auOrdinaryIncomeYTD: 300_000, auLowTaxContributionsYTD: 30_000 });
  assert.equal(nr.isResident, false, 'control: this really is the non-resident branch');
  assert.equal(nr.div293Tax, 4_500);
  assert.ok(nr.lineItems.some(l => l.label.startsWith('Div 293 Tax')));
});

test('D293-11 capital gains are in the base, because taxable income is', () => {
  // "Income for surcharge purposes" is built on TAXABLE income, which includes the net
  // capital gain after the Div 115 discount. That is what makes a disposal year the
  // one a working member is most likely to be caught by — and it is exactly what
  // happens to the `au-single-homeowner` golden in 2040, when its classic car sells.
  const rates = new AuTaxRates2026();
  const base = { auOrdinaryIncomeYTD: 150_000, auLowTaxContributionsYTD: 25_000 };
  const quiet = rates.computeTax(resident(base));
  const gainYear = rates.computeTax(resident({
    ...base, auCapitalGainsYTD: 200_000, auDiscountableGainsYTD: 200_000 }));

  assert.equal(quiet.div293Tax, 0, 'control: salary alone stays under the threshold');
  assert.ok(gainYear.div293Tax > 0, 'the gain year is caught');
});

test('D293-12 the s290-150 deduction reduces the Div 293 base as well as the income tax', () => {
  // The deduction reduces TAXABLE income, which is limb (a). The contribution it was
  // claimed on is a concessional contribution, so it also arrives in limb (b) — the
  // same offsetting pair as sacrifice in D293-6, reaching the same place.
  const rates = new AuTaxRates2026();
  const withDeduction = rates.computeTax(resident({
    auOrdinaryIncomeYTD: 280_000, auDeductibleSuperYTD: 20_000,
    auLowTaxContributionsYTD: 30_000 }));
  const without = rates.computeTax(resident({
    auOrdinaryIncomeYTD: 280_000, auLowTaxContributionsYTD: 30_000 }));

  assert.equal(without.div293TaxableContributions, 30_000);
  // 260,000 taxable + 30,000 = 290,000 ⇒ excess 40,000, still above the contributions,
  // so the CONTRIBUTIONS limb still binds and the tax is unchanged. The deduction
  // moves the income tax, not this.
  assert.equal(withDeduction.assessableIncome, 260_000);
  assert.equal(withDeduction.div293Tax, without.div293Tax);
  assert.ok(withDeduction.netLiability < without.netLiability, 'but the income tax falls');
});

// ─── The cross-border decision (review Q5) ───────────────────────────────────

test('D293-13 Div 293 is paid but NOT staged as a creditable foreign tax', async () => {
  // Review Q5, TABLED: Div 293 is an Australian income tax on an individual, which
  // points toward creditable under Art 22 / §901, but it is imposed on CONTRIBUTIONS
  // rather than on income received. An uncredited Div 293 is the conservative
  // reading, and turning the credit on later moves lifetime tax in a known direction.
  //
  // The subtlety this pins is that it must be BOTH: inside `action.tax`, so the
  // member is actually debited and `cumulativeTaxesPaid` counts it; and out of
  // `ftcCurrentForeignTax`, so the US return cannot credit it. Testing one without
  // the other would pass on an implementation that never charged it at all.
  const { AuTaxSettleApplyReducer } = await import('../../src/finance/tax/tax-settle-classes.js');

  const reducer = new AuTaxSettleApplyReducer({});
  const taxDetail = { netLiability: 34_500, div293Tax: 4_500 };
  const patches = reducer._extraStatePatches(
    { effectiveExchangeRates: { USD_AUD: 1 }, baseExchangeRates: { USD_AUD: 1 } },
    { type: 'AU_TAX_SETTLE_APPLY', tax: 34_500, fxRate: 1,
      personTaxDetails: [{ personKey: 'primary', taxDetail }] });

  // 34,500 is charged; 30,000 of it is creditable income tax.
  assert.equal(patches.ftcCurrentForeignTax, 30_000);

  // Control: with no Div 293 the whole liability stages, so the subtraction above is
  // a real exclusion rather than an arithmetic coincidence.
  const clean = reducer._extraStatePatches(
    { effectiveExchangeRates: { USD_AUD: 1 }, baseExchangeRates: { USD_AUD: 1 } },
    { type: 'AU_TAX_SETTLE_APPLY', tax: 30_000, fxRate: 1,
      personTaxDetails: [{ personKey: 'primary', taxDetail: { netLiability: 30_000, div293Tax: 0 } }] });
  assert.equal(clean.ftcCurrentForeignTax, 30_000);
});

test('D293-14 the single-return settle path excludes it too', async () => {
  // Two settle shapes exist — per-person and the household fallback — and a fix
  // applied to only one of them is the recurring shape of defect in this area.
  const { AuTaxSettleApplyReducer } = await import('../../src/finance/tax/tax-settle-classes.js');
  const reducer = new AuTaxSettleApplyReducer({});
  const patches = reducer._extraStatePatches(
    { effectiveExchangeRates: { USD_AUD: 1 }, baseExchangeRates: { USD_AUD: 1 } },
    { type: 'AU_TAX_SETTLE_APPLY', tax: 34_500, fxRate: 1,
      taxDetail: { netLiability: 34_500, div293Tax: 4_500 } });
  assert.equal(patches.ftcCurrentForeignTax, 30_000);
});

// ─── Regressions from the design-95 close-out review ─────────────────────────

test('D293-15 the single-return settle path charges Div 293 too', async () => {
  // `auLowTaxContributionsYTD` is written per person by `computeAuTaxPerPerson`.
  // `AuTaxSettleHandler` falls back to `computeAuTax(state)` on raw state whenever
  // there is no per-person split, and that state had no such field and no aggregation
  // of `auSuperCapsByPerson` — so Div 293 was STRUCTURALLY zero on that path, however
  // high the income and contributions.
  const { TaxSettleService } = await import('../../src/finance/tax-settle-service.js');
  const svc = new TaxSettleService();

  const state = {
    people: { p: { residency: 'AU' } },
    currentPeriods: { AU: { startMs: Date.UTC(2026, 6, 1) } },
    auOrdinaryIncomeYTD: 300_000,
    auSuperCapsByPerson: { p: { concessionalYTD: 30_000 } },
  };
  assert.equal(svc.computeAuTax(state).div293Tax, 4_500);

  // Control: no contributions anywhere ⇒ still nothing, so the aggregation is reading
  // the record rather than inventing a figure.
  assert.equal(svc.computeAuTax({ ...state, auSuperCapsByPerson: {} }).div293Tax, 0);
});

test('D293-16 a non-resident keeps the s290-150 deduction alongside the new charges', async () => {
  // The non-resident branch gained Div 293 in P8 but never had the P6b deduction, so a
  // non-resident making a deductible contribution paid 15% in the fund, possibly 15%
  // again under Div 293, and got nothing back — strictly worse than not contributing.
  const rates = new AuTaxRates2026();
  const base = { people: { p: { residency: 'US' } }, auOrdinaryIncomeYTD: 300_000,
                 auLowTaxContributionsYTD: 30_000 };

  const withDed = rates.computeTax({ ...base, auDeductibleSuperYTD: 20_000 });
  const without = rates.computeTax(base);

  assert.equal(withDed.isResident, false, 'control: really the non-resident branch');
  assert.equal(withDed.assessableIncome, 280_000, 'the deduction reduces taxable income');
  assert.ok(withDed.netLiability < without.netLiability,
    'and is worth something — it was worth nothing at all before');
  // Both charges still apply; the fix adds the deduction, it does not remove them.
  assert.equal(withDed.div293Tax, 4_500);
});
