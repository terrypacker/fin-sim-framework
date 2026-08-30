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
 * scenario.mjs — design 97 §20.6, the MINIMAL scenario.
 *
 * §19 measured this requirement on a household plan and every measurement landed on a
 * confound: a bond reserve sat between the spend walk and equity so the draw never reached
 * it (§19.2(2)), the design-61 LOCATED planner produced most of the crash-year volume
 * (§19.2b), and the offset facility expired on the mortgage's amortisation schedule before
 * anything could be tested (§20.4). Three rounds were spent attributing results to the wrong
 * cause.
 *
 * This scenario removes each of them BY CONSTRUCTION rather than by controlling for them,
 * and it is fully synthetic — built from `IntlRetirementScenario.buildDefaultConfig()`, so it
 * carries no household figures and lives in source control with the code it exercises.
 *
 *   · ONE taxable brokerage holding ONE equity sleeve. Nothing sits in front of equity, so a
 *     spending draw that is not intercepted reaches it — which is the whole subject.
 *   · NO rebalancer. `TARGET_ALLOCATION` is not selected: with one sleeve there is nothing to
 *     rebalance, and the refill edge is cross-account (executor 2, §12.4), so the graph never
 *     needs executor 1. The seller in §19's crash was the rebalancer; here there isn't one.
 *   · US-only. No residency move, no AUD, no cross-border relief, no §988 leg. Every account
 *     but the three below is zeroed.
 *   · An INTEREST-ONLY loan, fully offset at t0, with `paymentSourceKey` pinned to cash.
 *     Both of §20.4's decay mechanisms are switched off: the direct debit cannot reach the
 *     offset, and the principal never amortises, so the facility is still there when a crash
 *     arrives late in the run.
 *
 * ─── why a fully-offset interest-only loan is the right instrument ───────────────────
 *
 * `scheduledLoanPayment` branch 2: inside an IO window the payment IS the accrued interest,
 * and `effectivePrincipal` nets the offset off the balance. So while the offset is full the
 * facility costs exactly nothing, and the moment spending draws it down the household starts
 * paying interest on precisely the amount drawn. That is the study's price term, isolated:
 * no principal repayment, no amortisation schedule, no rate reset, nothing else moving.
 *
 * A LOAN LEFT UNDRAWN IS NOT FREE IN GENERAL — §19.2(3)'s corollary, and design 86 §8.9
 * measured a real carrying cost — but here it genuinely is, because the offset is what makes
 * it so. That is a property of this instrument, not a general one, and it is deliberate: the
 * arms must differ in the POLICY, not in what they own.
 */

import { IntlRetirementScenario } from '../../../src/scenarios/intl-retirement-scenario.js';

export const CASH   = 'usSavingsAccount';
export const GROWTH = 'usStockAccount';
export const OFFSET = 'usOffsetAccount';
export const HOUSE  = 'usHouseProperty';
export const LOAN   = 'usHousePropertyLoan';   // synthesized from the mortgage (design 54 P2)

/** Everything the scenario is, in one place, so an arm can move one number and say so. */
export const DEFAULTS = Object.freeze({
  equity:          2_000_000,   // the growth book
  equityBasisFrac: 0.5,         // unrealized gain at t0 — a sale must cost tax, or the
                                // "sell later instead of now" question has no price at all
  cash:               50_000,
  facility:          400_000,   // loan balance AND offset balance: fully offset at t0
  loanRate:             0.055,
  // 3.6% of the book at t0. Deliberately a plan that SURVIVES centrally: at 6.6% every arm
  // ran out of portfolio before the horizon, and terminal wealth measured after an
  // out-of-funds event is not a comparison of policies — it is a comparison of two
  // insolvencies (`run.mjs`'s own contract says so). Sequence risk still bites: a bad draw
  // fails, which is what the failure count is for.
  monthlySpend:         6_000,
  equityGrowth:         0.07,   // PRICE return; the 2% dividend is separate and paid out
  simEndYear:            2061,
});

/**
 * Build the minimal cfg.
 *
 * @param {object} [o]
 * @param {object} [o.params]  extra scenario params (merged last, so an arm can override)
 * @param {object} [o.plan]    overrides on DEFAULTS
 */
export function buildScenario({ params = {}, plan = {} } = {}) {
  const P = { ...DEFAULTS, ...plan };

  const cfg = IntlRetirementScenario.buildDefaultConfig({
    // The three that make it a US-only, deterministic-FX world.
    fxProcessModel: 'NONE',
    moveYear:       P.simEndYear + 10,   // never moves; residency is one country for the run
    startingResidency: 'US',

    // One sleeve, one rate. The dividend is paid out rather than reinvested (the default),
    // so the equity book's market value compounds at the price rate exactly.
    brokerageGrowthRate: P.equityGrowth,

    monthlyExpenses: P.monthlySpend,
    inflationAdjust: true,

    // No rebalancer: see the header. LIQUIDITY_POOLS contributes the flow evaluation and
    // nothing else, and the spend order compiles whether or not it is selected (§12).
    behavioralStrategies: ['LIQUIDITY_POOLS'],
    // PER_ACCOUNT anyway, so that if a future arm DOES turn the rebalancer on, no
    // cross-account relocation can appear as a result (§19.2b).
    allocationLocation: 'PER_ACCOUNT',

    ...params,
  }, undefined, new Date(Date.UTC(P.simEndYear, 0, 1)));

  // ── people: retired, unwaged, unpensioned ────────────────────────────────────────
  // Sequence-of-returns risk is a property of a portfolio that is being DRAWN. With the
  // default wages and social security the household funds its spending out of income, the
  // book never sells anything, and every arm is byte-identical — measured, and the first
  // version of this scenario did exactly that. A wage or a pension also smooths the very
  // risk under test, so both are zero: the portfolio is the only source of money.
  for (const person of cfg.persons ?? []) {
    person.monthlyWage           = 0;
    person.socialSecurityMonthly = 0;
    person.retirementDate        = cfg.simStart;
  }

  // ── accounts: three live, the rest zeroed ────────────────────────────────────────
  // Zeroed rather than deleted. A toolset that projects a missing key produces a different
  // scenario shape and a different set of reducers; a zero-balance account is inert and the
  // run stays the ordinary one (`property-purchase-and-downsizer`'s dormant-at-value-0).
  for (const a of cfg.accounts) {
    if (a.stateKey === CASH) { a.balance = P.cash; a.contributionBasis = P.cash; a.holdings = []; continue; }
    if (a.stateKey === GROWTH) {
      a.balance = P.equity;
      a.contributionBasis = P.equity;
      a.drawdownPriority = 2;
      a.holdings = [{
        __type: 'Holding', id: 'h-equity', allocation: 'EQUITY', rateKey: 'EQUITY_US',
        marketValue: P.equity, costBasis: Math.round(P.equity * P.equityBasisFrac),
        purchaseDate: null, label: 'US Equity', taxExemption: 'none', couponFrequency: 2,
      }];
      continue;
    }
    a.balance = 0;
    a.contributionBasis = 0;
    a.holdings = [];
  }

  cfg.accounts.push({
    __type: 'OffsetAccount', stateKey: OFFSET, type: 'offset',
    name: 'Offset', role: 'us-offset',
    balance: P.facility, ownershipType: 'sole', ownerId: 'primary',
    minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
    offsetsPropertyKey: HOUSE,
    // Null, not a number: the offset is a spend source ONLY where an arm's graph claims it.
    // A priority here would make it reachable in the control arm too, by the §3.1 rule that
    // unclaimed accounts follow the pools — and the control would quietly not be the control.
    drawdownPriority: null,
  });

  // ── the property and its interest-only, fully-offset loan ────────────────────────
  for (const r of cfg.realProperties ?? []) {
    if (r.stateKey !== HOUSE) { r.value = 0; r.mortgageBalance = 0; continue; }
    r.mortgageBalance         = P.facility;
    r.mortgageInterestRate    = P.loanRate;
    r.mortgageInterestOnly    = true;
    // No `mortgageInterestOnlyUntilYear` and no `mortgageMaturityYear`: branch 2 of
    // `scheduledLoanPayment` then holds for the whole run and the balance is flat by
    // construction. That is what keeps the facility alive to the end (§20.4).
    r.mortgagePaymentSourceKey = CASH;
    r.monthlyMortgage          = 0;   // unused inside the IO window; 0 so a regression is loud
  }

  return cfg;
}
