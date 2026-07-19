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
const EXPECTED_LIFETIME_TAX = 1_134_089;
const EXPECTED_NET_WORTH     = 11_577_657;
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
