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
 * cross-border-relief-scenario.test.mjs — design 52 behavioral lock-in.
 *
 * NOTE (2026-08-07): the real tripwire for this scenario is now
 * `tests/unit/golden-scenarios.test.mjs`, which pins the ENTIRE end state of the
 * same run against `tests/fixtures/golden-cross-border-reference.json`. The two
 * ±1% assertions below are kept because they carry intent the fixture cannot —
 * "a large DOWNWARD tax swing means the ftcYTD over-relief has returned" — and
 * because the comment block that follows is the provenance log for every regold.
 *
 * They are not, however, sufficient. Of the 17 regolds documented below, NINE
 * moved both metrics by under 1% and would have left this test green; they were
 * measured by hand, outside it. Measured directly: moving `moveYear` 2031→2032
 * shifts 71 state fields but net worth by only +0.0155%, and adding \$1/month of
 * spending shifts 22 fields at −0.0046%. Both pass here and both fail the fixture.
 *
 * The relief flip (real §904 FTC + FITO replacing the ftcYTD over-relief hack)
 * moved lifetime tax and ending wealth for every cross-border scenario, but NO
 * pre-existing golden asserted a post-credit cross-border liability — so the
 * change would otherwise be unguarded. This scenario-level golden pins the
 * default US→AU retiree's headline outcomes so a future regression (or an
 * accidental return of the over-relief) surfaces as a concrete diff.
 *
 * If this test fails after an intentional change, re-run the scenario, confirm
 * the new figures are correct, and update the expected values (a deliberate
 * regold — see design/52 §7).
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { ServiceRegistry }         from '../../src/services/service-registry.js';
import { ScenarioLoader }          from '../../src/scenarios/scenario-loader.js';
import { IntlRetirementScenario }  from '../../src/scenarios/intl-retirement-scenario.js';

function runDefaultIntlRetirement() {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  registry.scenarioRegistry.loadPrebuilt([{
    cls: IntlRetirementScenario, order: 1, active: true,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2050, 0, 1)),
  }]);
  const scenario = registry.scenarioService.createActiveScenario();
  scenario.buildSim();
  const cfg = registry.scenarioService.getActive();
  new ScenarioLoader().load(cfg, registry);

  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { scenario.sim.stepTo(new Date(Date.UTC(2050, 0, 1))); }
  finally { console.log = log; console.warn = warn; }
  return scenario.sim.state;
}

// Post-flip figures (design 52, moveYear 2031 → AU-resident 2031-2050). The
// pre-flip ftcYTD hack produced ~774,882 lifetime tax / ~12,046,007 net worth;
// real design-52 relief raised lifetime tax to ~895,088.
//
// Design 57 (AU CGT reform, FY2027+) then correctly applies to this AU resident's
// 2033 company-equity sale: the 50% CGT discount is removed (the full real gain is
// assessable) and the 30% minimum tax can bite. That lifts lifetime tax to
// ~1,068,129 (+19.3% vs the discounted figure) and lowers ending wealth to
// ~11,563,957 (-2.4%). These are the reform-correct figures — the two coupled
// design-57 bugs (inflation-wrapper dropping the reform + the real-bucket
// present-zero trap) are fixed. A large downward swing in tax would mean the 50%
// discount (or a spurious 100% CGT relief) has silently returned. A ±1% band
// absorbs incidental FX/rounding drift.
//
// NIIT (IRC §1411): the 3.8% Net Investment Income Tax now applies in the
// high-income US years (US-resident stretch, when MAGI clears the $250k MFJ
// threshold and there is investment income/gains). It is a Chapter-2A surtax
// outside the FTC system, so it lifts lifetime tax by ~$28k (+2.6%) to
// ~1,121,674 — an UPWARD move (an added surtax), leaving ending net worth
// within the ±1% band. A downward swing would still signal over-relief.
// Year-one accrual fix: the year-end investment-income family (bond coupons,
// dividends, stock/401k/super earnings, RMD) was scheduled with startOffset(1),
// which silently skipped the first sim year — holdings held from simStart earned
// nothing in year one. Corrected to startOffset(0), so year one now accrues its
// investment income and growth. This adds ~one extra year of compounding to the
// front of the run, lifting ending net worth ~+3.4% to ~11,911,160. Lifetime tax
// stays within the ±1% band (the extra year's tax is small next to the 44-year
// total). A large swing beyond these would signal the offset regressed.
//
// Design 66 §G3 (bond default re-baseline, the ONE deliberate regold): the default
// brokerage + 401(k) were all-equity, so the entire bond path (coupon streams,
// duration mark-to-market, Treasury/muni tax splits) was dead in the golden. Both
// are now 60% equity / 40% bond — the brokerage bond leg is a Treasury/corporate/muni
// mix (exercising all three BOND_COUPON_TAX treatments), the 401(k) a deferred sleeve.
// A balanced book compounds slower than 100% equity, so ending net worth falls -2.7%
// (11,911,160 → 11,584,539). Lifetime tax barely moves (+0.6%, 1,121,674 → 1,128,113):
// the bonds' ordinary-income coupons are roughly offset by lower equity growth (hence
// lower eventual CGT). A large downward tax swing would still signal over-relief; a
// large net-worth swing would signal the bond seeding or coupon path regressed.
//
// Design 66 §G4 (individual-bond maturity & pull-to-par): the default brokerage's
// Treasury sleeve is now an INDIVIDUAL bond (maturityDate 2035-01-01, par faceValue)
// rather than a perpetual fund. Over its life its price pulls to par (duration decays,
// rate-driven markdowns recover), and on the 2035 period-advance BondMaturityReducer
// redeems it at par to a CASH sleeve — which then earns money-market yield and is
// redeployed by drawdown/rebalance. The corporate + muni sleeves stay funds. Net
// effect is small: lifetime tax -0.08% (1,128,113 → 1,127,223) and ending net worth
// -0.03% (11,584,539 → 11,581,436) — both well inside the ±1% band, but re-pinned so
// the golden guards the maturity path exactly. A large swing would signal the pull-to-
// par or redemption path regressed.
//
// Design 66 §G10a (semi-annual coupons): the annual bond-coupon streams now fire on
// both half-year ends (Jun 30 / Dec 31), so half of each coupon is paid mid-year and
// (when reinvested) compounds for the second half. A small UPWARD move: net worth
// +0.024% (11,581,436 → 11,584,191) and lifetime tax +0.061% (1,127,223 → 1,127,909).
// Re-pinned so the golden guards the semi-annual split exactly.
//
// Design 66 §G10b (reinvestment risk): reinvested bond coupons now buy a new-vintage
// BOND lot at the *prevailing* FIXED_INCOME yield rather than growing the source bond
// at its own coupon (14 such lots are created across the run). This is essentially
// INERT on the default golden — the prevailing yield ≈ the seeded 0.04 coupon and the
// only reinvesting sleeve (k401) is tax-deferred — so net worth moves $1 (rounding)
// and lifetime tax is unchanged. The lever bites only when the prevailing rate diverges
// from the source coupon (a rate-regime shift), which the default scenario doesn't run.
// Design 71 §14 (§904 US-source leak): AU tax paid on US-SOURCE income was being
// staged as creditable US foreign tax. The §904 limitation blocked it in-year, but it
// banked as a 10-year carryforward vintage and was drawn down in later years against
// genuinely foreign income — over-relief deferred rather than prevented. Excluding the
// unrelieved US-source slice (`fitoLimit − fito`) collapses the 2033 company-sale
// staging from ~394,000 to ~1,300 and the pool peak from ~536,000 to ~3,400.
//
// This is an UPWARD tax move — exactly the direction that confirms over-relief was
// removed: lifetime tax +0.55% (1,127,909 → 1,134,089) and ending net worth −0.06%
// (11,584,190 → 11,577,657). Small because the limitation already blocked most of it;
// what leaked was the decade of carryforward drawdown after AU income ceased. Re-pinned
// so the ±1% band stays centred on the corrected figures.
// Design 72 §1 + §3 (cross-border equity fixes) — a large, intended DOWNWARD tax move,
// from two independent reliefs the engine was previously missing. Both bite on the same
// 2033 company sale, which is why the swing is big:
//
//   §3 s855-45 step-up: CompanyEquity never received the residency cost-base reset that
//   accounts/collectibles/property already got, so AU assessed the *entire* gain from
//   the original basis instead of only post-arrival appreciation.
//
//   §1 treaty re-sourcing: AU tax on US-SOURCE income had no §904 basket to sit in, so
//   it was dropped entirely and the two countries' taxes on the same gain became
//   additive (~70% combined). Form 1116 category F re-sources it, making the combined
//   burden max(US, AU) (~47%) as the treaty intends.
//
// Design 71 §14 removed *over*-relief; this removes *under*-relief. The pair are
// complementary, not contradictory: the leak 71 closed was AU tax on US-source income
// being credited against unrelated foreign income, whereas 72 credits it against the
// US tax on that same income, which is what the treaty actually allows.
//
// Lifetime tax −37.7% (1,134,089 → 706,637) and ending net worth +6.0%
// (11,577,657 → 12,273,473). A move back UP toward ~1.13m would mean the double
// taxation has returned; a move sharply DOWN from here would suggest the re-sourced
// basket has escaped its §904 limitation.
//
// De-minimis guard (design 72 §1): the FITO A$1,000 shortcut leaves `fitoLimit` null,
// which used to make _auTaxOnUsSourceIncome return 0 and declare the whole AU liability
// AU-source — leaking six figures into the general/passive baskets in a big realisation
// year. Now apportioned by US-source income share. FTC-US-9 guards the bound.
// Moved 706_637 → 698_420 (−1.2%) when the statutory 2026 US rates module
// (Rev. Proc. 2025-32) replaced the "inflate the 2025 brackets" fallback: the
// OBBBA schedule's wider bands + $32,200 MFJ standard deduction cut the US
// liability slightly. Downward, but ~1%, not the six-figure ftcYTD swing.
// Design 76 §0 + P2 (AU per-person attribution) — an UPWARD tax move in two parts,
// measured separately against 698,429 at the pre-76 baseline (34dc682):
//
//   §0 EVT-27, +0.28% (698,429 → 700,352). A franked dividend received while a
//   NON-resident of Australia chained no tax action at all, so it was taxed by
//   neither country. Australia is right to exempt it (ITAA 1936 s128B(3)(ga)), but a
//   US citizen is taxed on worldwide income, so it now reaches the US return.
//
//   P2 Gap A, +2.15% (700,352 → 715,426). `ownershipType` was dropped by
//   `_accountToStatePlain` on the way into runtime state, so `ownershipFractions`
//   could never take its `sole` branch and EVERY per-person attribution fell through
//   to an even split. The default scenario's `auStockAccount` is solely owned by
//   `primary`, so its franked dividends and franking credits were being halved onto
//   the spouse: `auPersonFrankingCreditYTD` read 4,517/4,517 and now reads 9,035/0.
//
// The rise is the correct removal of a phantom income split. Australia has no joint
// assessment and no income splitting — one spouse's investment income cannot be
// parked on the other to use their tax-free threshold and lower brackets.
//
// Checked, because the direction could also be explained by a modelling artifact:
// `frankingOffset = Math.min(credit, baseTax)` treats franking credits as
// NON-refundable, so concentrating them on one person could in principle waste them.
// Measured, it goes the other way — the cap costs 7,148 before P2 and only 4,137
// after, because the credits now land on the high-income owner who can absorb them
// instead of half-wasting against the low-income spouse. With a refundable offset the
// P2 delta would be LARGER (+18,085 rather than +15,074), so the cap understates this
// move rather than manufacturing it.
//
// P1 (design 76 Gap C, stateKey threading) was measured at exactly 698,429 — bit-for-
// bit inert, as its phase contract required.
//
// FOLLOW-UP (not design 76): resident franking credits have been refundable since the
// 2000 Ralph reforms (ITAA 1997 Div 67), so the Math.min cap is a real fidelity gap
// worth ~4,137 lifetime here. Out of scope for an attribution change.
//
// Design 76 P3 (Gap B + D), +0.97% (715,426 → 722,339). The remaining ~18 US-source
// income types stopped writing household scalars and now attribute to the account
// owner / earner / asset holder. On this scenario the household scalars drain to zero
// entirely, so nothing reaches computeAuTaxPerPerson's even-split divisor any more.
//
// The direction is the same income-splitting removal as P2, but P3 only lands here
// because Gap D moved with it. The FITO "without US-source" pass subtracts each
// person's US-source slice from their own income, so that slice must be attributed
// identically to the income. Migrating the income while leaving the removal set on an
// even split was measured at 949,884 (+32.8%) — each person's limit sized off a
// mismatched base. The two halves of P3 are not separable.
//
// P3 also tripped FTC-US-9, which is an invariant test rather than a golden: the
// de-minimis fallback in `_auTaxOnUsSourceIncome` read the household scalars to
// apportion AU tax by US-source share, and once those drained it computed a 0 share,
// declared the whole AU liability AU-source, and leaked ~88k of AU tax on US-source
// income back into the creditable base. Fixed by summing the per-person maps too
// (the same `_sumMap` treatment superTax already had). Worth noting that the golden
// alone would NOT have caught this — the invariant test did.
//
// Design 76 P4 (Gap D remainder), −0.33% (722,339 → 719,938). `usTaxPaidOnUsSourceAud`
// is the one FITO input that cannot be attributed — US tax is assessed MFJ and stamped
// once per US settle — so it is now APPORTIONED by each person's share of the US-source
// income AU is taxing, instead of split by headcount. DOWN is the expected direction:
// FITO has no carryforward (§4.5), so relief handed to a spouse whose own limit cannot
// absorb it is simply lost. Matching the offset to the income share wastes less of it.
//
// P4 also exposed a latent defect in `_auTaxOnUsSourceIncome`, again caught by
// FTC-US-9 rather than by any golden: the A$1,000 de-minimis test is PER PERSON, but
// the fallback handling it was all-or-nothing across the household. A mixed household
// — one spouse over the threshold with a computed fitoLimit, one under with a null one
// — contributed 0 for the under-threshold spouse, declaring their entire AU liability
// AU-source and therefore creditable against US tax (~24k of leak). Latent for as long
// as the even split kept both spouses on the same side of the threshold; P4's
// income-share apportionment pushed them apart. Now apportioned per person, which
// drops the peak current-year passive foreign tax from 13,515 to 154 — two orders of
// magnitude under FTC-US-9's bound, and consistent with that test's own statement that
// this household's genuine AU-source tax is very small.
//
// Design 76 P5 close-out, −0.01% (719,938 → 719,844). Two last attribution holes:
// BONUS_TAX now resolves an earner (explicit data.personId, else the sole person
// still working, else the highest wage) instead of sitting on the household scalar;
// and the FY2027 CGT-reform *real* buckets (auRealCapitalGainsYTD /
// usSourceRealCapGainsAudYTD) now attribute on the US-source paths in
// au-tax-module-2027, which had kept writing household scalars by design note.
// Barely visible here because this scenario realises little in FY2027+; on the real
// user scenario it moved lifetime tax +$1,022.
//
// The real-bucket hole was found by the P5 runtime warning on a live scenario, NOT
// by the suite — the residue test's field list had omitted the two real buckets, so
// it could not see them. Both are now listed there.
//
// A move back DOWN toward ~698k would mean ownership attribution has gone inert again.
//
// Design 77 (AU super fund tax) moved both, in opposite directions:
//   lifetime tax 719,844 → 723,849  (+0.56%)
//   net worth 12,260,459 → 12,183,627 (−0.63%)
//
// Net worth FELL because the Div 295 fund tax is now withheld from the super balance
// when it accrues, instead of being debited from the member's AU cash at the annual
// settle. Pre-77 the super account compounded on money that had already gone to the
// ATO — ~A$87k of lifetime fund tax earning 7% for up to two decades. The household is
// not newly poorer; the old figure was overstated.
//
// Lifetime tax ROSE even though the fund tax itself fell (A$87,435 → A$81,021, the
// smaller balance earning less to tax). The rise is `fundTax` on AU_TAX_SETTLE_APPLY
// (§5.4) keeping fund tax inside cumulativeTaxesPaid now that it has left the member's
// netLiability, plus the second-order drawdown differences a smaller super book causes.
// A sharp DROP of ~A$81k-equivalent here would mean that hand-off was lost and the
// metric has stopped counting tax the household is still paying.
//
// Design 83 G5 (Art. 22(4) non-erosion), −5.8% (723,849 → 682,015). Net worth moved
// under the tolerance and is unchanged. The Art. 22(2) figure handed to Australia is
// now the marginal US **regularTax** on US-source income — measured before any credit
// for Australian tax, which is what Art. 22(4)'s second sentence requires — instead of
// a marginal `netLiability` that had already been reduced by that very credit.
//
// DOWN is the expected direction and is not the ftcYTD over-relief this test guards
// against. The relief being handed to Australia is bounded twice and independently:
// by the §770-75 FITO limit on the AU side (the marginal AU tax on the US-source
// income — Australia cannot forgive more than it charged) and by the Art. 10(2)(b) /
// 11(2) rate ceilings on the US side. Design 83 §18 measures both. What changed is
// which country collects, not whether relief exists — and note the sign is
// plan-specific: on the full reference plan the same change moved lifetime tax the
// other way (+US$103k), because there the displaced AU tax had been fully usable as
// US foreign tax credit and here it is not.
const EXPECTED_LIFETIME_TAX = 682_015;
const EXPECTED_NET_WORTH     = 12_183_627;
const TOL = 0.01;

test('design 52 lock-in: default US→AU retiree lifetime tax reflects real §904 FTC + FITO', () => {
  const state = runDefaultIntlRetirement();
  const tax = state.cumulativeTaxesPaid ?? 0;
  assert.ok(
    Math.abs(tax - EXPECTED_LIFETIME_TAX) / EXPECTED_LIFETIME_TAX < TOL,
    `lifetime tax ${Math.round(tax)} outside ±${TOL * 100}% of ${EXPECTED_LIFETIME_TAX} `
    + `(a large downward swing would mean the ftcYTD over-relief has returned)`,
  );
});

test('design 52 lock-in: default US→AU retiree ending net worth', () => {
  const state = runDefaultIntlRetirement();
  const nw = state.metrics?.netWorth ?? 0;
  assert.ok(
    Math.abs(nw - EXPECTED_NET_WORTH) / EXPECTED_NET_WORTH < TOL,
    `net worth ${Math.round(nw)} outside ±${TOL * 100}% of ${EXPECTED_NET_WORTH}`,
  );
});
