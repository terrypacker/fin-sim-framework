/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY }              from '../../../simulation-framework/reducers.js';
import { computeGuardrailPortfolioValue } from '../guardrail-portfolio-value.js';
import { monthIndex, claimMonthOf, ownFactor } from '../../account-rules/us/us-social-security-rules.js';

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

/**
 * Present value of 1 a year for `n` years, paid at the START of each year, at rate `r`
 * (an annuity due). Fractional `n` is allowed: the payment count is continuous, which
 * keeps the spend smooth as the horizon shrinks between yearly checks.
 */
export function annuityDueFactor(r, n) {
  if (!(n > 0)) return 0;
  if (Math.abs(r) < 1e-12) return n;
  return (1 - Math.pow(1 + r, -n)) / r * (1 + r);
}

/**
 * Present value (USD, today's money) of each living person's own Social Security benefit
 * from their claim month to the horizon, at real rate `r`.
 *
 * `person.socialSecurityMonthly` is the PIA in today's dollars (InflationAdjustReducer
 * indexes it with US prices), so the stream is a constant real amount and a REAL rate
 * discounts it. The own-claim factor (early reduction / delayed credits) is applied; the
 * spousal top-up and the survivor benefit are NOT counted, so this slightly understates
 * a household's guaranteed income. That errs toward spending less early, not more.
 */
export function socialSecurityPv(state, dateMs, horizonYears, r) {
  const nowMi = monthIndex(dateMs);
  let pv = 0;
  for (const person of Object.values(state.people ?? {})) {
    const pia = person?.socialSecurityMonthly ?? 0;
    if (!(pia > 0) || !person.birthDate) continue;
    const entitledMi = claimMonthOf(person);
    const monthly    = pia * ownFactor(person.birthDate, entitledMi);
    const startYrs   = Math.max(0, (entitledMi - nowMi) / 12);
    const paidYrs    = horizonYears - startYrs;
    if (!(paidYrs > 0)) continue;
    pv += 12 * monthly * annuityDueFactor(r, paidYrs) / Math.pow(1 + r, startYrs);
  }
  return pv;
}

/**
 * Convert a USD amount (at spot) into the units `state.expenses` is denominated in.
 *
 * Mirrors MonthlyExpensesHandler: under RESIDENCE the authored figure is base-currency
 * USD that the handler re-bases into the residence currency at the ANCHOR rate
 * (`expenseRebaseRates` / `baseExchangeRates`), never spot. So a dollar of portfolio buys
 *   USD resident:  1 expense unit;
 *   AU resident:   spot / anchor expense units (convert to AUD at spot, re-base at anchor).
 * An explicit USD or AUD expense currency is plain spot conversion.
 */
export function usdToExpenseUnits(usd, state, expensesCurrency = 'RESIDENCE', primaryPersonKey = null) {
  const spot   = state.effectiveExchangeRates?.USD_AUD;
  const anchor = state.expenseRebaseRates?.USD_AUD ?? state.baseExchangeRates?.USD_AUD;
  if (expensesCurrency === 'AUD') return Number.isFinite(spot) ? usd * spot : usd;
  if (expensesCurrency === 'USD') return usd;
  const key = primaryPersonKey ?? Object.keys(state.people ?? {})[0];
  const isAu = state.people?.[key]?.residency === 'AU';
  if (!isAu || !Number.isFinite(spot) || !Number.isFinite(anchor) || anchor <= 0) return usd;
  return usd * spot / anchor;
}

/**
 * AmortizedSpendingReducer — the AMORTIZED ("spend it down") spending strategy.
 *
 * On each period advance it sets this year's spending to the level that would run the
 * household's resources to zero at the horizon if markets earned the assumed real rate
 * from here on, and re-solves every time from the money actually there:
 *
 *   resources = drawdown portfolio + PV(remaining own Social Security)
 *   target    = resources / annuityDue(realRate, years to horizon)        (per year)
 *   spend     = max(essential, smoothing × last spend + (1 − smoothing) × target)
 *
 * Good markets raise next year's spend, bad ones lower it, and the horizon shrinking
 * raises the spend share each year, which is what spends the gains rather than banking
 * them. The ESSENTIAL slice is the floor: only discretionary moves, and it never goes
 * below zero, so spending stays at or above the essential slice while money lasts.
 *
 * The portfolio is the guardrail's (drawdown accounts, FX-converted), expressed in the
 * expense figure's own units (see usdToExpenseUnits). Runs after inflation (+2),
 * regime-aware (+3) and explicit bands (+4), so it decides the level they would set.
 *
 * @param {object} opts
 * @param {Date|number} opts.horizonEnd          The date resources should reach zero (sim end).
 * @param {number} [opts.realRate=0.03]          Assumed real return on the resources.
 * @param {number} [opts.smoothing=0]            Weight on last period's spend, 0 ≤ k < 1.
 * @param {string} [opts.expensesCurrency='RESIDENCE']
 * @param {string} [opts.baseCurrency='USD']     Valuation currency of the portfolio.
 */
export class AmortizedSpendingReducer extends Reducer {
  static description = 'AMORTIZED spending: each period sets spending to the annuity that runs the portfolio plus remaining Social Security to zero at the horizon, never below the essential slice.';
  static type        = 'AmortizedSpendingReducer';
  static actionType  = null;

  constructor({ horizonEnd, realRate = 0.03, smoothing = 0, expensesCurrency = 'RESIDENCE', baseCurrency = 'USD' } = {}) {
    super('Amortized Spending', PRIORITY.PRE_PROCESS + 5);
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
    this.horizonEndMs       = horizonEnd == null ? null : new Date(horizonEnd).getTime();
    this.realRate           = realRate;
    this.smoothing          = Math.min(0.99, Math.max(0, smoothing ?? 0));
    this.expensesCurrency   = expensesCurrency;
    this.baseCurrency       = baseCurrency;
  }

  reduce(state, action, date) {
    if (!state.expenses || this.horizonEndMs == null) return this.newState(state);
    // The tick date is the reducer's third argument; a period-advance action carries none.
    const when   = date ?? action?.date ?? null;
    const dateMs = when != null ? new Date(when).getTime() : null;
    if (dateMs == null) return this.newState(state);

    const years = (this.horizonEndMs - dateMs) / MS_PER_YEAR;
    if (!(years > 0)) return this.newState(state);

    const r          = this.realRate;
    const portfolio  = computeGuardrailPortfolioValue(state, this.baseCurrency);
    const ssPv       = socialSecurityPv(state, dateMs, years, r);
    const resources  = usdToExpenseUnits(portfolio + ssPv, state, this.expensesCurrency);
    const target     = resources / annuityDueFactor(r, years) / 12;

    const essential  = state.expenses.essential ?? 0;
    const current    = essential + (state.expenses.discretionary ?? 0);
    const blended    = this.smoothing > 0 ? this.smoothing * current + (1 - this.smoothing) * target : target;
    const discretionary = Math.max(0, blended - essential);

    return this.newState(state, {
      expenses:        { ...state.expenses, essential, discretionary },
      monthlyExpenses: essential + discretionary,
      amortizedSpending: {
        date: dateMs, horizonYears: years, portfolio, socialSecurityPv: ssPv,
        resources, targetMonthly: target, monthly: essential + discretionary,
      },
    });
  }
}
