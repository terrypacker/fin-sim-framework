/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * evt-investment-interest.test.mjs — design 86 G3 **error 1**: a standalone loan
 * whose proceeds were put to an income-producing use now produces a deduction.
 *
 * Before this, a `LoanAccount` with no `linkedPropertyKey` accrued interest and
 * emitted no tax action at all, so *borrow to invest in securities* deducted zero and
 * §10.2 had to state that such an arm was not modellable. The other half of G3 — a
 * rental-linked loan scaled by `deductibleFraction` — has been built since P4 and is
 * deliberately untouched here; the first test in this file is the one that keeps the
 * two halves from both claiming the same interest.
 *
 * Four things this suite exists to hold:
 *
 *  1. **No double count, and no opt-in surprise.** A rental-linked loan still deducts
 *     only through `computeRentalMonth`; an unstated `deductibleFraction` (null — the
 *     pre-86 default and every legacy loan) still deducts nothing.
 *  2. **The two jurisdictions genuinely differ on the same loan.** Australia allows it
 *     against any assessable income (s8-1, negative gearing). The US quarantines it to
 *     net investment income (§163(d)(1)) with an indefinite carryforward. A single
 *     "deduct the interest" path would be wrong in one country or the other.
 *  3. **It is not the §469 pool.** §10.2's explicit warning: routing this through
 *     `AU_RENTAL_INCOME_TAX` would feed `usPassiveActivityIncomeYTD` and the deduction
 *     would be suspended by a limitation that has nothing to do with it.
 *  4. **It does not break the §904 partition.** The G5b lesson — a negative that
 *     lowers gross income while leaving every foreign basket untouched stops the
 *     baskets partitioning income. The deduction is accumulated POSITIVE and enters
 *     via `agi` + `unrelatedDeductions`, exactly as the §988 loss does.
 *
 * Run with: node --test tests/unit/evt-investment-interest.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenarioSim } from '../helpers/scenario-harness.js';
import { investmentInterestAction } from '../../src/finance/account-rules/loan-classes.js';
import { _computeInvestmentInterestLimitation } from '../../src/finance/tax/us/us-tax-rates-base.js';
import { UsTaxModule2026 } from '../../src/finance/tax/us/us-tax-module-2026.js';
import { AuTaxModule2026 } from '../../src/finance/tax/au/au-tax-module-2026.js';
import { UsTaxRates2026 }  from '../../src/finance/tax/us/us-tax-rates-2026.js';

const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

/** A standalone (non-rental) loan state entry. */
const standalone = (o = {}) => ({
  type: 'loan', stateKey: 'usLoanAccount', country: 'US', currency: { code: 'USD' },
  balance: 500_000, linkedPropertyKey: null, deductibleFraction: 1,
  ownershipType: 'sole', ownerId: 'primary', ...o,
});

// ── The emission rule ────────────────────────────────────────────────────────

describe('G3 error 1 — which loan-months produce a deduction', () => {
  test('G3E1-1: a rental-linked loan emits NOTHING — the P4 path already deducts it', () => {
    // The one test standing between this channel and a double deduction: a mortgage on
    // a rental reaches the return through computeRentalMonth's `deductibleInterest`,
    // scaled by the very same `deductibleFraction`.
    const linked = standalone({ linkedPropertyKey: 'auHouseProperty' });
    assert.equal(investmentInterestAction(linked, 'l', 2_000, 2_500, 'US'), null);
  });

  test('G3E1-2: an unstated deductibleFraction emits nothing — every pre-86 loan is inert', () => {
    assert.equal(investmentInterestAction(standalone({ deductibleFraction: null }), 'l', 2_000, 2_500, 'US'), null);
    assert.equal(investmentInterestAction(standalone({ deductibleFraction: undefined }), 'l', 2_000, 2_500, 'US'), null);
  });

  test('G3E1-3: 0 / 0.5 / 1 scale the deduction exactly proportionally', () => {
    // §3 G3's stated test. 0 is a REAL authored answer ("purely private borrowing"),
    // not an absent one: it agrees with null on the number and differs on the claim.
    const at = f => investmentInterestAction(standalone({ deductibleFraction: f }), 'l', 2_000, 2_500, 'US');
    assert.equal(at(0), null, 'a stated 0% purpose deducts nothing');
    assert.equal(at(0.5).amount, 1_000);
    assert.equal(at(1).amount,   2_000);
    // Out-of-range input is clamped rather than trusted — the field is user-typed.
    assert.equal(at(4).amount,   2_000);
  });

  test('G3E1-4: cash basis — a negatively amortising loan deducts only the interest PAID', () => {
    // An individual deducts interest when paid (§163(a); s8-1). Where the payment is
    // below the accrual the shortfall is capitalised into the balance and is not yet
    // deductible — deducting the full accrual would relieve tax on money that never
    // left the borrower, in exactly the interest-only arms design 86 exists to study.
    const negAm = investmentInterestAction(standalone(), 'l', 2_000, 1_200, 'US');
    assert.equal(negAm.amount, 1_200, 'deduct what was paid, not what accrued');

    // A fully offset IO loan accrues nothing and pays nothing.
    assert.equal(investmentInterestAction(standalone(), 'l', 0, 0, 'US'), null);
  });

  test('G3E1-5: the loan\'s country picks the action type and the currency', () => {
    const us = investmentInterestAction(standalone(), 'l', 1_000, 1_000, 'AU');
    assert.equal(us.type, 'US_INVESTMENT_INTEREST_DEDUCTION');
    assert.equal(us.currency, 'USD');
    assert.equal(us.residency, 'AU', 'residency rides along — it decides the AU booking');

    const au = investmentInterestAction(
      standalone({ country: 'AU', currency: { code: 'AUD' } }), 'l', 1_000, 1_000, 'AU');
    assert.equal(au.type, 'AU_INVESTMENT_INTEREST_DEDUCTION');
    assert.equal(au.currency, 'AUD');
    assert.equal(au.ownerId, 'primary', 'ownership rides along for AU per-person attribution');
  });
});

// ── The §163(d) limitation ───────────────────────────────────────────────────

describe('G3 error 1 — IRC §163(d) limitation', () => {
  const limit = s => _computeInvestmentInterestLimitation(s);

  test('G3E1-6: the deduction is capped at net investment income; the excess carries forward', () => {
    const r = limit({ usInvestmentInterestYTD: 30_000, usNetInvestmentIncomeYTD: 18_000 });
    assert.equal(r.allowed, 18_000, '§163(d)(1): limited to net investment income');
    assert.equal(r.closing, 12_000, '§163(d)(2): the disallowed excess carries forward');

    // Nothing to deduct against ⇒ nothing allowed, everything carried.
    const none = limit({ usInvestmentInterestYTD: 30_000, usNetInvestmentIncomeYTD: 0 });
    assert.equal(none.allowed, 0);
    assert.equal(none.closing, 30_000);
  });

  test('G3E1-7: passive rental income is carved OUT of the base (§163(d)(4)(D))', () => {
    // This is the join that keeps §163(d) and §469 from double-counting the same
    // rental dollar: rents are §1411 net investment income (so they are in the pool)
    // but are NOT §163(d) investment income, because rental activity is passive per se
    // — the same classification G5's suspension already rests on.
    const withRent = limit({
      usInvestmentInterestYTD: 30_000,
      usNetInvestmentIncomeYTD: 50_000,     // 20k dividends/interest + 30k net rents
      usPassiveActivityIncomeYTD: 30_000,
    });
    assert.equal(withRent.nii, 20_000, 'rents leave the §163(d) base');
    assert.equal(withRent.allowed, 20_000);
    assert.equal(withRent.closing, 10_000);

    // A passive LOSS must not ENLARGE investment income — the carve-out is floored.
    const withLoss = limit({
      usInvestmentInterestYTD: 30_000,
      usNetInvestmentIncomeYTD: 20_000,
      usPassiveActivityIncomeYTD: -40_000,
    });
    assert.equal(withLoss.nii, 20_000, 'a suspended rental loss does not create §163(d) room');
  });

  test('G3E1-8: the pool releases against a later year\'s investment income', () => {
    // Year 2: no new borrowing, 15k of investment income, 12k of pool.
    const r = limit({ usInvestmentInterestCarryforward: 12_000, usInvestmentInterestYTD: 0,
                      usNetInvestmentIncomeYTD: 15_000 });
    assert.equal(r.allowed, 12_000, 'the whole pool is absorbed');
    assert.equal(r.closing, 0);

    // …and only up to that income; the remainder stays pooled indefinitely.
    const partial = limit({ usInvestmentInterestCarryforward: 12_000, usInvestmentInterestYTD: 0,
                            usNetInvestmentIncomeYTD: 5_000 });
    assert.equal(partial.allowed, 5_000);
    assert.equal(partial.closing, 7_000);
  });

  test('G3E1-9: capital gains do NOT enlarge the base — the §163(d)(4)(B)(iii) election is not made', () => {
    // Electing to treat net capital gain as investment income costs the preferential
    // rate on the elected amount. Defaulting the election ON would overstate the
    // deduction in every gain year; not electing is the statutory default.
    const r = limit({ usInvestmentInterestYTD: 30_000, usNetInvestmentIncomeYTD: 5_000,
                      usCapitalGainsYTD: 400_000, usCollectibleGainsYTD: 50_000 });
    assert.equal(r.nii, 5_000);
    assert.equal(r.allowed, 5_000, 'a large gain year does not unlock the deduction');
  });

  test('G3E1-10: pure — it reports a closing pool and never draws down the one it was handed', () => {
    // computeTax is re-run on counterfactual states (the FITO handoff and the
    // §865(g)(2) CGT rate), so a function that spent the pool in place would leave the
    // later passes assessing against a pool that no longer existed — the same trap
    // recorded on the AU Div 36 pool.
    const state = { usInvestmentInterestCarryforward: 12_000, usInvestmentInterestYTD: 5_000,
                    usNetInvestmentIncomeYTD: 4_000 };
    const first  = limit(state);
    const second = limit(state);
    assert.deepEqual(first, second, 're-running on the same state must give the same answer');
    assert.equal(state.usInvestmentInterestCarryforward, 12_000, 'the input pool is untouched');
  });

  test('G3E1-11: an empty channel is identically inert', () => {
    assert.deepEqual(_computeInvestmentInterestLimitation({}),
                     { opening: 0, expense: 0, nii: 0, allowed: 0, closing: 0 });
  });
});

// ── The classifiers ──────────────────────────────────────────────────────────

const PEOPLE = {
  primary: { id: 'primary', name: 'Terry',  residency: 'AU' },
  spouse:  { id: 'spouse',  name: 'Jeanne', residency: 'AU' },
};

const classifierState = () => ({
  people: PEOPLE,
  usOrdinaryIncomeYTD: 100_000, usNetInvestmentIncomeYTD: 40_000,
  usPassiveActivityIncomeYTD: 0, usInvestmentInterestYTD: 0,
  auOrdinaryIncomeYTD: 0, auPersonOrdinaryIncomeYTD: { primary: 80_000, spouse: 20_000 },
  usSourceOrdinaryUsdYTD: 0, usSourceOrdinaryAudYTD: 0,
  auPersonUsSourceOrdinaryAudYTD: {},
  baseExchangeRates: { USD_AUD: 1, AUD_USD: 1 },
  effectiveExchangeRates: { USD_AUD: 1, AUD_USD: 1 },
});

const US_FNS = new UsTaxModule2026().getReducerFns();
const AU_FNS = new AuTaxModule2026().getReducerFns();

describe('G3 error 1 — the classifiers', () => {
  test('G3E1-12: the US classifier accumulates POSITIVE and never touches usOrdinaryIncomeYTD', () => {
    // The G5b guard. A deduction that reduced usOrdinaryIncomeYTD would lower
    // grossIncomeAllSources while leaving every foreign basket untouched — basket
    // gross then exceeds total gross, the baskets stop partitioning income, and the
    // §904 denominator collapses. That failure cost a study run once already.
    const before = classifierState();
    const after  = US_FNS.get('US_INVESTMENT_INTEREST_DEDUCTION')(before, {
      type: 'US_INVESTMENT_INTEREST_DEDUCTION', amount: 9_000, residency: 'US',
    });
    assert.equal(after.usInvestmentInterestYTD, 9_000, 'accumulated positive, limited later');
    assert.equal(after.usOrdinaryIncomeYTD, 100_000, 'gross income is NOT reduced here');
    assert.equal(after.usPassiveActivityIncomeYTD, 0,
      '§469 is a different limitation — the deduction must not enter its pool');
    assert.equal(after.usNetInvestmentIncomeYTD, 40_000,
      'and it must not shrink the very base it is limited BY');
  });

  test('G3E1-13: an AU-resident also gets the s8-1 deduction on the AU return', () => {
    const after = US_FNS.get('US_INVESTMENT_INTEREST_DEDUCTION')(classifierState(), {
      type: 'US_INVESTMENT_INTEREST_DEDUCTION', amount: 9_000, residency: 'AU',
      ownershipType: 'sole', ownerId: 'primary',
    });
    assert.equal(after.usInvestmentInterestYTD, 9_000, 'the US side is unconditional — worldwide income');
    assert.ok(near(after.auPersonOrdinaryIncomeYTD.primary, 71_000),
      `the owner's AU assessable income falls by the deduction, got ${after.auPersonOrdinaryIncomeYTD.primary}`);
    assert.equal(after.auPersonOrdinaryIncomeYTD.spouse, 20_000, 'and only the owner\'s');
  });

  test('G3E1-14: the AU classifier deducts against ANY AU income — no quarantine', () => {
    // The substantive difference between the jurisdictions on the identical loan:
    // s8-1 has no §163(d) analogue, which is what negative gearing IS.
    const after = AU_FNS.get('AU_INVESTMENT_INTEREST_DEDUCTION')(classifierState(), {
      type: 'AU_INVESTMENT_INTEREST_DEDUCTION', amount: 30_000, residency: 'AU',
      ownershipType: 'sole', ownerId: 'primary',
    });
    assert.ok(near(after.auPersonOrdinaryIncomeYTD.primary, 50_000),
      'the full 30k reduces AU assessable income even though it exceeds AU investment income');
    assert.equal(after.usInvestmentInterestYTD, 30_000,
      'and the same interest is reported to the US side in USD, where §163(d) WILL limit it');
  });

  test('G3E1-15: shared ownership splits the AU deduction like a jointly-held asset', () => {
    // Lopsided on purpose (design 76's lesson): a 50/50 split cannot distinguish
    // correct apportionment from the even-split fallback.
    const after = AU_FNS.get('AU_INVESTMENT_INTEREST_DEDUCTION')(classifierState(), {
      type: 'AU_INVESTMENT_INTEREST_DEDUCTION', amount: 20_000, residency: 'AU',
      owners: [{ personId: 'primary', ownershipPct: 75 }, { personId: 'spouse', ownershipPct: 25 }],
    });
    assert.ok(near(after.auPersonOrdinaryIncomeYTD.primary, 65_000),
      `75% of 20k off the owner's income, got ${after.auPersonOrdinaryIncomeYTD.primary}`);
    assert.ok(near(after.auPersonOrdinaryIncomeYTD.spouse,  15_000));
  });

  test('G3E1-16: a foreign resident gets no AU deduction, but still the US one', () => {
    // A foreign resident is assessed only on AU-source income; the borrowing funded a
    // portfolio that is not it, so there is nothing for the deduction to reduce.
    const after = AU_FNS.get('AU_INVESTMENT_INTEREST_DEDUCTION')(classifierState(), {
      type: 'AU_INVESTMENT_INTEREST_DEDUCTION', amount: 20_000, residency: 'US',
      ownershipType: 'sole', ownerId: 'primary',
    });
    assert.equal(after.auPersonOrdinaryIncomeYTD.primary, 80_000, 'AU return untouched');
    assert.equal(after.usInvestmentInterestYTD, 20_000, 'US citizen, worldwide income');
  });
});

// ── computeTax integration ───────────────────────────────────────────────────

describe('G3 error 1 — the deduction on the return', () => {
  const rates = new UsTaxRates2026();
  const baseState = (extra = {}) => ({
    usOrdinaryIncomeYTD: 200_000, usNetInvestmentIncomeYTD: 40_000,
    usCapitalGainsYTD: 0, usCollectibleGainsYTD: 0, usPenaltyYTD: 0,
    usNegativeIncomeYTD: 0, usSeEarningsYTD: 0, usSsWagesYTD: 0, usFilingSingle: false,
    ...extra,
  });

  test('G3E1-17: the allowed deduction lowers AGI and tax; the disallowed part does not', () => {
    const none    = rates.computeTax(baseState());
    const allowed = rates.computeTax(baseState({ usInvestmentInterestYTD: 40_000 }));
    const capped  = rates.computeTax(baseState({ usInvestmentInterestYTD: 90_000 }));

    assert.ok(near(none.adjustedGrossIncome - allowed.adjustedGrossIncome, 40_000),
      `AGI should fall by the whole 40k, got ${none.adjustedGrossIncome - allowed.adjustedGrossIncome}`);
    assert.ok(allowed.netLiability < none.netLiability, 'and the tax with it');

    // 90k of interest against 40k of investment income: only 40k is deductible, so
    // this return is IDENTICAL to the 40k one and 50k waits in the pool.
    assert.ok(near(capped.adjustedGrossIncome, allowed.adjustedGrossIncome), 'the excess buys nothing this year');
    assert.equal(capped.investmentInterest.closing, 50_000);
    assert.equal(allowed.investmentInterest.closing, 0);
  });

  test('G3E1-18: the return SHOWS the disallowance rather than silently dropping it', () => {
    const detail = rates.computeTax(baseState({ usInvestmentInterestYTD: 90_000 }));
    const labels = detail.lineItems.map(l => l.label);
    assert.ok(labels.some(l => l.includes('§163(d)')), 'the deduction is a named line');
    assert.ok(labels.some(l => l.includes('carried forward')),
      'so is the pool — a reader must not have to infer that interest was disallowed');

    // An untouched channel adds no lines at all: an ordinary return is unchanged.
    const clean = rates.computeTax(baseState());
    assert.ok(!clean.lineItems.some(l => l.label.includes('§163(d)')));
  });

  test('G3E1-19: the §904 partition survives it', () => {
    // The invariant G5b broke: Σ basket gross ≤ gross income all sources. The
    // deduction enters `unrelatedDeductions`, which is apportioned across the
    // baskets — so it can never pull a basket's gross above the total.
    const detail = rates.computeTax(baseState({
      usInvestmentInterestYTD: 40_000,
      foreignGeneralIncomeYTD: 60_000, foreignPassiveIncomeYTD: 30_000,
      ftcCurrentGeneral: 12_000, ftcCurrentPassive: 4_000,
    }));
    const ftc = detail.ftc;
    const fracSum = [ftc.general, ftc.passive].filter(Boolean).reduce((s, b) => s + b.frac, 0);
    assert.ok(fracSum <= 1 + 1e-6, `§904 fractions sum to ${fracSum}`);
    for (const [name, b] of [['general', ftc.general], ['passive', ftc.passive]]) {
      if (!b) continue;
      assert.ok(b.numerator <= ftc.totalTaxable + 1e-6,
        `${name} numerator ${b.numerator} exceeds the §904 denominator ${ftc.totalTaxable}`);
    }
  });
});

// ── End to end ───────────────────────────────────────────────────────────────

/**
 * A borrow-to-invest arm: an authored standalone interest-only loan, no property in
 * sight. This is the test §10.2's gap was really about — every link in the chain
 * (handler emit → classifier → limitation → settle) leaves the loan looking normal if
 * it breaks, which is exactly how the gap survived P4.
 */
function borrowToInvest(deductibleFraction) {
  const { sim } = loadScenarioSim({
    simStart: '2026-01-01', simEnd: '2030-01-01', telemetry: 'off',
    mutateCfg: (cfg) => {
      cfg.accounts.push({
        __type: 'LoanAccount', id: 'acLoan', name: 'Margin Loan',
        stateKey: 'usLoanAccount', role: 'us-loan',
        country: 'US', currency: { code: 'USD', symbol: '$' },
        balance: 400_000, interestRate: 0.06, monthlyPayment: 2_000,
        interestOnly: true, deductibleFraction,
        ownerId: 'primary', ownershipType: 'sole',
      });
    },
  });
  return sim;
}

describe('G3 error 1 — end to end', () => {
  test('G3E1-20: an authored standalone loan accrues a real deduction over a run', () => {
    const sim = borrowToInvest(1);
    sim.stepTo(new Date('2026-07-01'));

    // 6 months of an interest-only 400k at 6% = 6 × 2,000.
    assert.ok(near(sim.state.usInvestmentInterestYTD, 12_000),
      `expected 12k of accrued deduction by mid-2026, got ${sim.state.usInvestmentInterestYTD}`);

    // Across the year-end settle: the YTD resets and re-accumulates, and the interest
    // the year's investment income could not absorb is POOLED rather than lost. The
    // pool is the half of this channel a single-year view cannot see.
    sim.stepTo(new Date('2027-06-01'));
    assert.ok(sim.state.usInvestmentInterestYTD < 12_000,
      'the YTD expense must reset at the US settle');
    assert.ok(sim.state.usInvestmentInterestCarryforward > 0,
      'interest disallowed in 2026 must survive the settle as a §163(d) pool');
  });

  test('G3E1-21: the same loan with an unstated fraction is completely inert', () => {
    const sim = borrowToInvest(null);
    sim.stepTo(new Date('2027-06-01'));
    assert.ok(!(sim.state.usInvestmentInterestYTD > 0),
      'a pre-86 loan must deduct nothing — deductibility follows a stated USE');
    assert.ok(!(sim.state.usInvestmentInterestCarryforward > 0));
    assert.equal(sim.state.usLoanAccount.balance, 400_000,
      'and the loan itself is unchanged either way (interest-only)');
  });
});

test('G3E1-22: end to end, an AU loan gives the owner s8-1 relief and the US a §163(d) pool', () => {
  // The asymmetry that makes this gap worth its own channel, on one loan in one run:
  // Australia lets the whole A$3,000/month reduce the owner's assessable income, while
  // the US takes the same interest into a pool it can only release against investment
  // income. A single "deduct the interest" path could not produce both.
  const arm = (deductibleFraction) => {
    const { sim } = loadScenarioSim({
      params: { moveYear: 2026 },              // AU-resident, so the s8-1 side is live
      simStart: '2026-01-01', simEnd: '2030-01-01', telemetry: 'off',
      mutateCfg: (cfg) => {
        cfg.accounts.push({
          __type: 'LoanAccount', id: 'acLoan', name: 'AU Margin Loan',
          stateKey: 'auLoanAccount', role: 'au-loan',
          country: 'AU', currency: { code: 'AUD', symbol: 'A$' },
          balance: 600_000, interestRate: 0.06, monthlyPayment: 3_000,
          interestOnly: true, deductibleFraction,
          ownerId: 'primary', ownershipType: 'sole',
        });
      },
    });
    sim.stepTo(new Date('2027-04-01'));
    return sim.state;
  };

  const on  = arm(1);
  const off = arm(null);

  assert.equal(on.people.primary.residency, 'AU', 'the AU branch must actually be live');
  assert.ok(on.auPersonOrdinaryIncomeYTD.primary < off.auPersonOrdinaryIncomeYTD.primary,
    'the owner\'s AU assessable income falls by the interest — no quarantine');
  assert.ok(near(on.auPersonOrdinaryIncomeYTD.spouse, off.auPersonOrdinaryIncomeYTD.spouse),
    'and only the owner\'s: a sole-owned loan is not split across the household');
  assert.ok(on.usInvestmentInterestCarryforward > 0,
    'while the US side pools what net investment income could not absorb');
  assert.ok(!(off.usInvestmentInterestCarryforward > 0), 'both inert without a stated fraction');
});
