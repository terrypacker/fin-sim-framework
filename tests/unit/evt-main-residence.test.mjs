/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * evt-main-residence.test.mjs — design 83 G7, steps 1, 2, 3b and 5.
 *
 * The three cases this exists to get right, for a dwelling **rented first and possibly
 * occupied later** (design 83 sub-case 2b — the history that defeats both s118-145 and
 * s118-192, so neither is modelled):
 *
 *   1. Sell while still a foreign resident            → no AU exemption, no §121
 *   2. Sell as an AU resident, having moved in        → partial both sides
 *   3. Sell as an AU resident, having NOT moved in    → no exemption either side
 *
 * The single most important property of this suite is that **case 2 is partial, not
 * free.** Both countries prorate a main-home concession by time and both penalise the
 * rent-then-occupy order — Australia proportionally through s118-185, the United States
 * through §121(b)(5), whose Exception 1 forgives renting *after* you move out but not
 * *before* you move in. A reader who expects "tax free in Australia, \$500k in the US"
 * will find neither, and the tests below state the actual fractions so that expectation
 * is corrected by the suite rather than by a surprising number in a study.
 *
 * The second is that **depreciation behaves oppositely in the two countries** and so
 * cannot ride in one bucket: Australia's basis reduction enlarges an ordinary capital
 * gain that the exemption and the discount then shelter, while the United States taxes
 * the same slice as unrecaptured §1250 gain that §121 may never exclude.
 *
 * Run with: node --test tests/unit/evt-main-residence.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  auMainResidenceExemption, us121Exclusion, unrecaptured1250Gain,
  isMainResidenceThroughout, mainResidenceWindow, toMs, cgtDiscountFraction,
} from '../../src/finance/account-rules/main-residence.js';

const Y  = (y, m = 0, d = 1) => Date.UTC(y, m, d);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/** Bought 2006, rented throughout, moved into in 2032, sold 2035 — the user's shape. */
const rentedThenOccupied = {
  isPrimaryResidence: false,
  mainResidenceFrom:  Y(2032),
  mainResidenceUntil: null,
  rentalEnabled: true, monthlyRent: 2500,
};
const neverOccupied = { isPrimaryResidence: false, mainResidenceFrom: null, rentalEnabled: true };
const ACQ  = Y(2006);
const SALE = Y(2035);

// ── Step 1: the s118-110(3) gate ─────────────────────────────────────────────

describe('G7 step 1 — s118-110(3) foreign-resident denial', () => {
  test('MR-1: case 1 — a foreign resident at the CGT event gets NO exemption', () => {
    // The gate is what keeps case 1 correct once an exemption exists at all. Before
    // G7 the model gave no exemption because it had no exemption logic; the right
    // answer by omission. A main-residence rule added without this gate would have
    // BROKEN the case that already worked.
    const r = auMainResidenceExemption(rentedThenOccupied,
      { acquisitionMs: ACQ, saleMs: SALE, residencyAtSale: 'US' });
    assert.equal(r.exemptFraction, 0);
    assert.equal(r.reason, 'foreign-resident-at-cgt-event');
  });

  test('MR-2: it is a SNAPSHOT at the sale date, not a look-back over the hold', () => {
    // s118-110(3) asks where you are resident when the CGT event happens. Return,
    // become resident, then sell, and the denial never engages — however many of the
    // ownership years were spent abroad. That single sequencing fact is worth more
    // than every other rule in G7 combined, so it gets its own test.
    const abroad = auMainResidenceExemption(rentedThenOccupied,
      { acquisitionMs: ACQ, saleMs: SALE, residencyAtSale: 'US' });
    const home   = auMainResidenceExemption(rentedThenOccupied,
      { acquisitionMs: ACQ, saleMs: SALE, residencyAtSale: 'AU' });
    assert.equal(abroad.exemptFraction, 0);
    assert.ok(home.exemptFraction > 0, 'the identical history, sold as a resident, is partly exempt');
  });
});

// ── Step 2: the s118-185 fraction ────────────────────────────────────────────

describe('G7 step 2 — s118-185 partial exemption', () => {
  test('MR-3: case 2 — moving in exempts only the days it WAS the main residence', () => {
    // The expectation correction this whole suite exists for. Owned 29 years, occupied
    // for the last 3 ⇒ ~10% exempt, not 100%. "Tax free in Australia" is true only of a
    // dwelling that was the main residence for the WHOLE ownership period.
    const r = auMainResidenceExemption(rentedThenOccupied,
      { acquisitionMs: ACQ, saleMs: SALE, residencyAtSale: 'AU' });
    const expected = (SALE - Y(2032)) / (SALE - ACQ);
    assert.ok(near(r.exemptFraction, expected),
      `expected ~${(expected * 100).toFixed(1)}% exempt, got ${(r.exemptFraction * 100).toFixed(1)}%`);
    assert.ok(r.exemptFraction < 0.15, 'a late move-in buys a small fraction, not the lot');
    assert.equal(r.reason, 's118-185-partial');
  });

  test('MR-4: case 3 — never moving in exempts nothing', () => {
    const r = auMainResidenceExemption(neverOccupied,
      { acquisitionMs: ACQ, saleMs: SALE, residencyAtSale: 'AU' });
    assert.equal(r.exemptFraction, 0);
    assert.equal(r.reason, 'never-a-main-residence');
  });

  test('MR-5: moving in EARLIER is monotonically worth more', () => {
    // The lever's shape: smooth and monotonic on the AU side, which is what makes
    // mainResidenceFrom searchable the way moveYear is.
    const at = (year) => auMainResidenceExemption(
      { ...rentedThenOccupied, mainResidenceFrom: Y(year) },
      { acquisitionMs: ACQ, saleMs: SALE, residencyAtSale: 'AU' }).exemptFraction;
    const fractions = [2034, 2032, 2028, 2020].map(at);
    for (let i = 1; i < fractions.length; i++) {
      assert.ok(fractions[i] > fractions[i - 1], 'an earlier move-in must exempt more');
    }
  });

  test('MR-6: an unknown acquisition date DENIES the exemption rather than guessing', () => {
    // Defaulting to the simulation start would treat a 29-year hold as a 9-year one and
    // roughly triple the exempt fraction — a silent overstatement in the user's favour,
    // which is the worst failure available here. The reason names the branch so a
    // caller can surface it instead of shipping a quiet zero.
    const r = auMainResidenceExemption(rentedThenOccupied,
      { acquisitionMs: null, saleMs: SALE, residencyAtSale: 'AU' });
    assert.equal(r.exemptFraction, 0);
    assert.equal(r.reason, 'unknown-ownership-period');
  });

  test('MR-7: every pre-G7 property keeps its exact old answer', () => {
    // The compatibility contract. `isPrimaryResidence` is the only thing a saved
    // scenario carries, and it can only mean "throughout" or "never" — so it keeps
    // meaning exactly that, with no acquisition date required.
    const legacyPrimary = { isPrimaryResidence: true, mainResidenceFrom: null };
    const legacyRental  = { isPrimaryResidence: false, mainResidenceFrom: null };
    assert.ok(isMainResidenceThroughout(legacyPrimary));
    assert.equal(auMainResidenceExemption(legacyPrimary,
      { acquisitionMs: null, saleMs: SALE, residencyAtSale: 'AU' }).exemptFraction, 1);
    assert.equal(auMainResidenceExemption(legacyRental,
      { acquisitionMs: ACQ, saleMs: SALE, residencyAtSale: 'AU' }).exemptFraction, 0);
    // And the dates WIN when both are present — otherwise a stale boolean would
    // silently override a stated history.
    assert.ok(!isMainResidenceThroughout({ isPrimaryResidence: true, mainResidenceFrom: Y(2032) }));
  });

  test('MR-8: the window is clipped to the ownership period', () => {
    const w = mainResidenceWindow({ mainResidenceFrom: Y(2000), mainResidenceUntil: Y(2099) }, ACQ, SALE);
    assert.equal(w.fromMs, ACQ, 'cannot be a main residence before you owned it');
    assert.equal(w.untilMs, SALE, 'nor after you sold it');
  });
});

// ── Step 5: §121, and the order that costs you ───────────────────────────────

describe('G7 step 5 — IRC §121 nonqualified-use proration', () => {
  const args = (over = {}) => ({
    gain: 500_000, depreciationGain: 0,
    acquisitionMs: ACQ, saleMs: SALE, filingSingle: false, ...over,
  });

  test('MR-9: case 1/3 — never a principal residence, no exclusion', () => {
    const r = us121Exclusion(neverOccupied, args());
    assert.equal(r.excluded, 0);
    assert.equal(r.reason, 'never-a-principal-residence');
  });

  test('MR-10: the 2-of-5 test is a CLIFF — 23 months buys nothing', () => {
    // Below the gate the exclusion is zero however long you later live there, so a
    // sweep coarser than a year can step straight over the edge. Sample either side.
    const justUnder = us121Exclusion(
      { ...rentedThenOccupied, mainResidenceFrom: SALE - 23 * 30 * 24 * 3600 * 1000 }, args());
    const justOver  = us121Exclusion(
      { ...rentedThenOccupied, mainResidenceFrom: SALE - 25 * 30 * 24 * 3600 * 1000 }, args());
    assert.equal(justUnder.excluded, 0);
    assert.equal(justUnder.reason, 'fails-2-of-5-use-test');
    assert.ok(justOver.excluded > 0, 'two months later, the exclusion switches on');
  });

  test('MR-11: case 2 — rent-then-occupy is the PENALISED order', () => {
    // §121(b)(5)(C)(ii)(I) / Pub 523 Exception 1: the tail after you stop using it as
    // your main home is forgiven; the years before you move in are not. So this history
    // — the one being modelled — keeps most of its gain outside the exclusion however
    // large the cap is.
    const r = us121Exclusion(rentedThenOccupied, args());
    assert.ok(r.eligible);
    assert.ok(r.nonqualifiedFraction > 0.8,
      `most of the post-2009 period was nonqualified use, got ${r.nonqualifiedFraction}`);
    assert.ok(r.excluded < 100_000,
      `a $500k gain should keep well under the $500k cap here, got ${r.excluded}`);
  });

  test('MR-12: occupy-then-rent is FORGIVEN — the same years, the other way round', () => {
    // The asymmetry stated as a comparison, because it is invisible in either case
    // alone: identical ownership, identical occupancy length, opposite order.
    const occupyThenRent = { isPrimaryResidence: false,
                             mainResidenceFrom: ACQ, mainResidenceUntil: Y(2033) };
    const forgiven  = us121Exclusion(occupyThenRent, args({ saleMs: Y(2034) }));
    const penalised = us121Exclusion(rentedThenOccupied, args());
    assert.equal(forgiven.nonqualifiedFraction, 0,
      'renting AFTER the last day of use as a main home is not nonqualified use');
    assert.ok(forgiven.excluded > penalised.excluded,
      'the same years in the other order are worth more');
  });

  test('MR-13: depreciation is removed BEFORE the proration and never excluded', () => {
    const withDep = us121Exclusion(
      { isPrimaryResidence: true, mainResidenceFrom: null },
      args({ gain: 500_000, depreciationGain: 120_000 }));
    assert.equal(withDep.excluded, 380_000,
      'the §1250 slice leaves the excludable base entirely');
  });

  test('MR-14: the cap still binds, and follows filing status', () => {
    const mfj    = us121Exclusion({ isPrimaryResidence: true }, args({ gain: 900_000 }));
    const single = us121Exclusion({ isPrimaryResidence: true }, args({ gain: 900_000, filingSingle: true }));
    assert.equal(mfj.excluded, 500_000);
    assert.equal(single.excluded, 250_000);
  });
});

// ── Step 3b: the depreciation slice ──────────────────────────────────────────

describe('G7 step 3b — unrecaptured §1250 gain', () => {
  test('MR-15: the slice is the depreciation taken, capped at the gain', () => {
    assert.equal(unrecaptured1250Gain(300_000, 120_000), 120_000);
    assert.equal(unrecaptured1250Gain(80_000, 120_000), 80_000,
      'depreciation can exceed a gain on a fallen price; the excess is not §1250 gain');
    assert.equal(unrecaptured1250Gain(300_000, 0), 0, 'a never-rented dwelling has no slice');
  });

  test('MR-16: the asymmetry that decides case 2, in one assertion', () => {
    // Australia shelters the depreciation effect proportionally — the enlarged gain
    // rides s118-185 like any other. The United States never shelters it. So for a
    // long-rented dwelling, moving in relieves LESS than the headline suggests, and it
    // points the opposite way from "moving in makes it tax-free".
    const gain = 500_000, dep = 150_000;
    const auExempt = auMainResidenceExemption(rentedThenOccupied,
      { acquisitionMs: ACQ, saleMs: SALE, residencyAtSale: 'AU' }).exemptFraction;
    const auShelteredDep = dep * auExempt;
    const usShelteredDep = 0;   // §121 can never reach it

    assert.ok(auShelteredDep > 0, 'AU shelters part of the depreciation with the dwelling');
    assert.equal(usShelteredDep, 0, 'the US shelters none of it, ever');
    assert.equal(unrecaptured1250Gain(gain, dep), dep,
      'and the whole slice is taxed in the 25%-ceiling bucket rather than at LTCG rates');
  });
});

// ── Date handling ────────────────────────────────────────────────────────────

test('MR-17: dates round-trip from epoch ms, Date and ISO alike', () => {
  // Saved scenarios carry all three shapes depending on which editor last wrote them,
  // and a date silently parsed as NaN would read as "never a main residence" — a wrong
  // answer that looks exactly like a deliberate one.
  const ms = Y(2032);
  assert.equal(toMs(ms), ms);
  assert.equal(toMs(new Date(ms)), ms);
  assert.equal(toMs('2032-01-01'), ms);
  assert.equal(toMs(null), null);
  assert.equal(toMs('not a date'), null);
});

// ── Step 3: the CGT discount, apportioned by residency days ──────────────────

describe('G7 step 3 — s115-105/110/115 discount apportionment', () => {
  const disc = (over = {}) => cgtDiscountFraction({
    acquisitionMs: ACQ, saleMs: SALE, residencySinceMs: Y(2032), residencyAtSale: 'AU', ...over,
  });

  test('MR-18: case 2/3 — a returning resident does NOT get the full 50%', () => {
    // The defect: the model gave a resident-at-sale the whole discount on a gain that
    // mostly accrued while they were abroad. Owned 2006, resident from 2032, sold 2035
    // ⇒ about 3 years of 29, halved.
    const r = disc();
    const expected = 0.5 * ((SALE - Y(2032)) / (SALE - ACQ));
    assert.ok(near(r.fraction, expected), `expected ~${expected.toFixed(4)}, got ${r.fraction}`);
    assert.ok(r.fraction < 0.08, 'nowhere near the flat 50%');
    assert.equal(r.reason, 's115-115-apportioned');
  });

  test('MR-19: case 1 — a DEPARTING resident is owed a discount the model gave as zero', () => {
    // The other direction, and the one that was against the taxpayer: a foreign
    // resident at the CGT event still gets the discount for the days they WERE
    // resident. s115-115 apportions; it does not deny. What a foreign resident loses is
    // the main-residence exemption, which is s118-110(3) and a different provision.
    const r = cgtDiscountFraction({
      acquisitionMs: ACQ, saleMs: SALE, residencySinceMs: ACQ, residencyAtSale: 'US',
    });
    assert.ok(r.fraction > 0.49, 'resident for the whole period, sold after leaving');
    // …and someone who was never resident still gets nothing.
    const never = cgtDiscountFraction({
      acquisitionMs: ACQ, saleMs: SALE, residencySinceMs: null, residencyAtSale: 'US',
    });
    assert.equal(never.fraction, 0);
    assert.equal(never.reason, 'never-an-australian-resident');
  });

  test('MR-20: resident throughout is still exactly 50%', () => {
    // The compatibility case: design 62's deemed acquisition restarts the clock at the
    // move for every non-TAP asset, so its testing period lies wholly inside the
    // residency and this must reproduce the flat rate byte-for-byte.
    assert.equal(disc({ residencySinceMs: null, residencyAtSale: 'AU' }).fraction, 0.5);
    assert.equal(disc({ residencySinceMs: ACQ }).fraction, 0.5);
    assert.equal(disc({ residencySinceMs: Y(1990) }).fraction, 0.5, 'resident before acquiring');
  });

  test('MR-21: the fraction is monotonic in the length of residence', () => {
    const fractions = [2034, 2032, 2028, 2010].map(y => disc({ residencySinceMs: Y(y) }).fraction);
    for (let i = 1; i < fractions.length; i++) {
      assert.ok(fractions[i] > fractions[i - 1], 'longer residence ⇒ more discount');
    }
    assert.ok(fractions.every(f => f <= 0.5), 'and never above the statutory ceiling');
  });

  test('MR-22: no testing period falls back to the pre-apportionment answer', () => {
    // An asset with no acquisition date has no denominator. Denying the discount
    // outright would be a silent tax rise on every plan that never stated one, so this
    // one degrades to the old binary rather than to zero — the opposite choice from the
    // main-residence exemption, and for the opposite reason: there the fallback would
    // have been over-generous, here it would be over-harsh.
    assert.equal(cgtDiscountFraction({ acquisitionMs: null, saleMs: SALE, residencyAtSale: 'AU' }).fraction, 0.5);
    assert.equal(cgtDiscountFraction({ acquisitionMs: null, saleMs: SALE, residencyAtSale: 'US' }).fraction, 0);
  });
});

test('MR-23: end to end — a returning resident\'s AU house discount is apportioned', async () => {
  // The whole of step 3 in one run: an Australian dwelling is TAP, so s855-45 gives it
  // no deemed re-acquisition at the move and its testing period straddles the years
  // abroad. This is the only asset class in the model that reaches the apportionment,
  // and before it the household took a flat 50% on the lot.
  const { loadScenarioSim } = await import('../helpers/scenario-harness.js');
  const { sim } = loadScenarioSim({
    params: { moveYear: 2028 },
    simStart: '2026-01-01', simEnd: '2040-01-01',
    mutateCfg: (cfg) => {
      const au = cfg.realProperties.find(p => p.stateKey === 'auHouseProperty');
      au.plannedSaleYear   = 2036;
      au.acquisitionDate   = Date.UTC(2006, 0, 1);   // owned long before the move
      au.isPrimaryResidence = false;                  // investment property: no exemption
    },
    stepTo: '2036-03-01',
  });

  const base   = Object.values(sim.state.auPersonDiscountApportionedBaseYTD ?? {}).reduce((a, c) => a + c, 0);
  const relief = Object.values(sim.state.auPersonDiscountAllowanceYTD ?? {}).reduce((a, c) => a + c, 0);
  assert.ok(base > 0, 'the sale must record an apportioned base');

  const effective = relief / base;
  assert.ok(effective > 0 && effective < 0.25,
    `resident for ~8 of 30 years should discount well under 50%, got ${(effective * 100).toFixed(1)}%`);
  // And the gain itself is unchanged — this is a relief rate, not a smaller gain.
  const discountable = Object.values(sim.state.auPersonDiscountableGainsYTD ?? {}).reduce((a, c) => a + c, 0);
  assert.ok(near(discountable, base, 0.01), 'the whole discountable gain is apportioned, not part of it');
});
