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
 * k401-limits.test.mjs — design 95 §7, phase 3.
 *
 * The tiered employer match and the statutory ceilings: §401(a)(17) on
 * compensation, §402(g) + §414(v) on the employee's deferral, §415(c) on all annual
 * additions.
 *
 * **These tests carry phase 3 on their own.** The reference goldens defer 10% with a
 * 4% match on \$120,000 — every limit in this file sits far above that, so a green
 * golden suite says nothing whatever about any of it. The one golden that does bind
 * the limits (`payroll-limits`) was added by this phase for exactly that reason.
 *
 * Dollar figures are asserted against the limits module rather than hard-coded,
 * except where the point IS the published number. A test that hard-codes \$24,500
 * fails the day the 2027 notice is transcribed, which would train whoever does it to
 * edit tests until they pass.
 *
 * Run with: node --test tests/unit/k401-limits.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { matchedFraction, resolveMatchTiers, monthlyK401, DEFAULT_MATCH_TIERS }
  from '../../src/finance/payroll/k401-limits.js';
import { usContributionLimits, catchUpAllowance, US_CONTRIBUTION_LIMITS_BY_YEAR }
  from '../../src/finance/tax/us/us-contribution-limits.js';

const YEAR = 2026;
const L    = usContributionLimits(YEAR);

/** Run a full year of monthly contributions, accumulating as the reducer does. */
function runYear({ annualPay, deferralPct, matchTiers, legacyMatchPct,
                   nonElectivePct = 0, age = 40, scenarioCap = null, months = 12 }) {
  let deferralYTD = 0, additionsYTD = 0;
  const clamps = new Set();
  const rows = [];
  for (let m = 0; m < months; m++) {
    const r = monthlyK401({ annualPay, deferralPct, matchTiers, legacyMatchPct,
                            nonElectivePct, age, taxYear: YEAR,
                            deferralYTD, additionsYTD, scenarioCap });
    deferralYTD  = +(deferralYTD  + r.deferral).toFixed(2);
    additionsYTD = +(additionsYTD + r.deferral + r.match + r.nonElective).toFixed(2);
    r.clamps.forEach(c => clamps.add(c));
    rows.push(r);
  }
  return { deferralYTD, additionsYTD, clamps: [...clamps], rows };
}

// ─── The match formula ────────────────────────────────────────────────────────

test('K401-1 the match is a function of the DEFERRAL, not a flat % of pay', () => {
  const tiers = [{ matchRate: 1.00, uptoPctOfComp: 0.03 }];

  // The whole point of phase 3. The old code paid 3% regardless of what was deferred.
  assert.equal(matchedFraction(0.10, tiers), 0.03, 'a 10% deferral fills the 3% band');
  assert.equal(matchedFraction(0.03, tiers), 0.03, 'exactly at the band');
  assert.equal(matchedFraction(0.01, tiers), 0.01,
    'someone deferring 1% is matched 1% — NOT the 3% the flat-percentage model paid');
  assert.equal(matchedFraction(0, tiers), 0, 'no deferral, no match');
});

test('K401-2 the safe-harbor basic match is expressible as data', () => {
  // §401(k)(12)(B)(i): 100% on the first 3%, 50% on the next 2% — a maximum of 4%.
  const safeHarbor = [{ matchRate: 1.00, uptoPctOfComp: 0.03 },
                      { matchRate: 0.50, uptoPctOfComp: 0.02 }];

  assert.equal(matchedFraction(0.06, safeHarbor), 0.04, '3% + (2% × 50%) = 4%, capped');
  assert.equal(matchedFraction(0.05, safeHarbor), 0.04, 'the band is fully consumed at 5%');
  assert.equal(matchedFraction(0.04, safeHarbor), 0.035, '3% + (1% × 50%)');
  assert.equal(matchedFraction(0.02, safeHarbor), 0.02, 'only the first tier is reached');

  // And the other common shape, from the same data structure.
  assert.equal(matchedFraction(0.06, [{ matchRate: 0.5, uptoPctOfComp: 0.06 }]), 0.03,
    '50% on the first 6%');
});

test('K401-3 the legacy flat percentage is reinterpreted as a 100% match', () => {
  assert.deepEqual(resolveMatchTiers(null, 0.04),
    [{ matchRate: 1.00, uptoPctOfComp: 0.04 }]);

  // Numerically identical wherever the deferral covers the band — which is every
  // existing scenario, and why the reference golden did not move.
  assert.equal(matchedFraction(0.10, resolveMatchTiers(null, 0.04)), 0.04);
  // …and different exactly where the old model was wrong.
  assert.equal(matchedFraction(0.02, resolveMatchTiers(null, 0.04)), 0.02);

  // Explicit tiers win over the legacy parameter.
  const tiers = [{ matchRate: 0.5, uptoPctOfComp: 0.06 }];
  assert.deepEqual(resolveMatchTiers(tiers, 0.04), tiers);
  assert.deepEqual(resolveMatchTiers(null, 0), [], 'no match configured at all');
});

test('K401-4 the default tiers are 100% of the first 3%', () => {
  assert.equal(matchedFraction(0.10, DEFAULT_MATCH_TIERS), 0.03);
});

// ─── §401(a)(17) compensation limit ───────────────────────────────────────────

test('K401-5 §401(a)(17) caps the pay BOTH percentages are taken on', () => {
  const pay = L.compensation * 2;          // comfortably over the limit
  const r = monthlyK401({ annualPay: pay, deferralPct: 0.10,
                          matchTiers: [{ matchRate: 1, uptoPctOfComp: 0.03 }],
                          age: 40, taxYear: YEAR });

  assert.equal(r.eligiblePay, L.compensation);
  // Ratios, not dollars, so this survives the 2027 notice being transcribed.
  assert.equal(r.match, +(L.compensation * 0.03 / 12).toFixed(2),
    'the match is 3% of CAPPED pay, not of actual pay');
  assert.ok(r.clamps.includes('401(a)(17)'));

  // Control: at half the limit nothing is capped and the match is 3% of actual pay.
  const under = monthlyK401({ annualPay: L.compensation / 2, deferralPct: 0.10,
                              matchTiers: [{ matchRate: 1, uptoPctOfComp: 0.03 }],
                              age: 40, taxYear: YEAR });
  assert.equal(under.eligiblePay, L.compensation / 2);
  assert.deepEqual(under.clamps, [], 'control: no clamp reported when none binds');
});

// ─── §402(g) / §414(v) deferral ceiling ───────────────────────────────────────

test('K401-6 §402(g) binds mid-year and stops the deferral', () => {
  // 40% of $200,000 is $80,000 — far past the limit, so it binds partway through.
  const { deferralYTD, clamps, rows } = runYear({ annualPay: 200_000, deferralPct: 0.40 });

  assert.equal(deferralYTD, L.electiveDeferral,
    'the year\'s deferrals total exactly the §402(g) limit');
  assert.ok(clamps.includes('402(g)'), 'and the clamp is reported, not silent');

  const stopped = rows.findIndex(r => r.deferral === 0);
  assert.ok(stopped > 0 && stopped < 12,
    `the deferral must stop partway through the year, not at month 0 or never (${stopped})`);

  // Control: a modest deferral runs all twelve months untouched. Compared within a
  // cent because each month is rounded to cents independently, so twelve twelfths of
  // \$10,000 foot to \$9,999.96 — dust, and pre-existing behaviour.
  const modest = runYear({ annualPay: 200_000, deferralPct: 0.05 });
  assert.ok(Math.abs(modest.deferralYTD - 10_000) < 0.05, `${modest.deferralYTD}`);
  assert.deepEqual(modest.clamps, [], 'control: nothing binds, so nothing is reported');
});

test('K401-7 §414(v) gives 50+ additional headroom, and 60-63 more still', () => {
  const at40 = runYear({ annualPay: 400_000, deferralPct: 0.40, age: 40 });
  const at55 = runYear({ annualPay: 400_000, deferralPct: 0.40, age: 55 });
  const at61 = runYear({ annualPay: 400_000, deferralPct: 0.40, age: 61 });
  const at64 = runYear({ annualPay: 400_000, deferralPct: 0.40, age: 64 });

  assert.equal(at40.deferralYTD, L.electiveDeferral);
  assert.equal(at55.deferralYTD, L.electiveDeferral + L.catchUp50);
  assert.equal(at61.deferralYTD, L.electiveDeferral + L.catchUp60to63);
  // SECURE 2.0 §109's higher amount is a BAND, not a floor — it reverts at 64.
  assert.equal(at64.deferralYTD, L.electiveDeferral + L.catchUp50);
  assert.ok(at61.deferralYTD > at55.deferralYTD, '60-63 exceeds the ordinary catch-up');

  assert.equal(catchUpAllowance(49, L), 0, 'no catch-up below 50');
});

test('K401-8 an authored plan cap applies ON TOP of the statute, never instead', () => {
  // Stricter than §402(g): the plan's own limit binds.
  const strict = runYear({ annualPay: 200_000, deferralPct: 0.40, scenarioCap: 10_000 });
  assert.equal(strict.deferralYTD, 10_000);
  assert.ok(strict.clamps.includes('plan cap'));

  // Laxer than §402(g): the STATUTE still binds. A scenario may model a plan
  // stricter than the Code; it may not legislate a laxer one.
  const lax = runYear({ annualPay: 400_000, deferralPct: 0.40, scenarioCap: 999_000 });
  assert.equal(lax.deferralYTD, L.electiveDeferral,
    'an authored cap above the statutory limit cannot raise it');
  assert.ok(lax.clamps.includes('402(g)'));
});

// ─── §415(c) annual additions ─────────────────────────────────────────────────

test('K401-9 §415(c) caps deferral + match + non-elective together', () => {
  // Big non-elective contribution: no single stream breaches, but their sum does.
  // Pay deliberately UNDER §401(a)(17) so the only clamp that can fire is §415(c) —
  // otherwise the control below cannot tell the two limits apart.
  const { additionsYTD, clamps } = runYear({
    annualPay: 300_000, deferralPct: 0.06,
    matchTiers: [{ matchRate: 1, uptoPctOfComp: 0.06 }],
    nonElectivePct: 0.20, age: 40,
  });

  assert.equal(additionsYTD, L.annualAdditions,
    'total annual additions stop exactly at the §415(c) dollar limit');
  assert.ok(clamps.includes('415(c)'));

  // Control: the same streams at a quarter of the rate stay well under.
  const small = runYear({ annualPay: 300_000, deferralPct: 0.06,
                          matchTiers: [{ matchRate: 1, uptoPctOfComp: 0.06 }],
                          nonElectivePct: 0.02, age: 40 });
  assert.ok(small.additionsYTD < L.annualAdditions);
  assert.deepEqual(small.clamps, []);
});

test('K401-10 §415(c) is also the lesser of 100% of compensation', () => {
  // A low-paid participant cannot receive additions exceeding their whole pay.
  const { additionsYTD } = runYear({ annualPay: 20_000, deferralPct: 0.50,
                                     matchTiers: [{ matchRate: 1, uptoPctOfComp: 0.50 }],
                                     nonElectivePct: 0.50, age: 40 });
  assert.ok(additionsYTD <= 20_000 + 0.01,
    `additions (${additionsYTD}) cannot exceed 100% of a \$20,000 compensation`);
});

test('K401-11 the employee\'s own deferral has first claim on §415(c) room', () => {
  const r = monthlyK401({
    annualPay: 400_000, deferralPct: 0.06,
    matchTiers: [{ matchRate: 1, uptoPctOfComp: 0.06 }],
    nonElectivePct: 0.20, age: 40, taxYear: YEAR,
    // Almost no room left for the month.
    deferralYTD: 0, additionsYTD: L.annualAdditions - 1_000,
  });

  assert.ok(r.deferral > 0, 'the deferral is funded first — it is the member\'s own money');
  assert.equal(r.match + r.nonElective, +(1_000 - r.deferral).toFixed(2),
    'employer money takes only what is left, and never crowds out the deferral');
  assert.ok(r.deferral + r.match + r.nonElective <= 1_000 + 0.01);
});

// ─── The limits table itself ──────────────────────────────────────────────────

test('K401-12 the published 2026 figures match the notice on disk', () => {
  // These ARE the published numbers, so hard-coding them is the point: this test is
  // a transcription check against IRS Notice 2025-67, not a behavioural assertion.
  const l = usContributionLimits(2026);
  assert.equal(l.electiveDeferral, 24_500);
  assert.equal(l.catchUp50,         8_000);
  assert.equal(l.catchUp60to63,    11_250);
  assert.equal(l.annualAdditions,  72_000);
  assert.equal(l.compensation,    360_000);

  const y25 = US_CONTRIBUTION_LIMITS_BY_YEAR[2025];
  assert.equal(y25.electiveDeferral, 23_500);
  assert.equal(y25.annualAdditions,  70_000);
  assert.equal(y25.compensation,    350_000);
});

test('K401-13 years outside the published range clamp rather than extrapolate', () => {
  // Phase 3 carries no indexation — see the module header. Beyond the table the last
  // published year is held flat, which understates later headroom VISIBLY rather
  // than inventing a number. Phase 9 replaces this with real projection.
  assert.deepEqual(usContributionLimits(2099), usContributionLimits(2026));
  assert.deepEqual(usContributionLimits(1999), usContributionLimits(2025));
});
