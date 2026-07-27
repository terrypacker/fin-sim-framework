/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { RegimeAwareSpendingReducer }       from './strategies/regime-aware-spending-reducer.js';
import { GuardrailBaselineApplyReducer }   from './strategies/guardrail-baseline-apply-reducer.js';
import { GuardrailAdjustApplyReducer }     from './strategies/guardrail-adjust-apply-reducer.js';
import { GuardrailAnnualCheckReducer }     from './strategies/guardrail-annual-check-reducer.js';
import { ExpenseEventApplyReducer }        from './strategies/expense-event-apply-reducer.js';
import { AgeBandedSpendingReducer, DEFAULT_AGE_BANDS } from './strategies/age-banded-spending-reducer.js';
import { ExplicitBandsSpendingReducer, DEFAULT_EXPENSE_BANDS } from './strategies/explicit-bands-spending-reducer.js';

/**
 * Whole years of age as of asOfDate (matches the RMD handlers' _getAge).
 * Used to anchor the convenience `ageBandDeclineRate` knob to the primary
 * person's retirement age (design/33 §10 Q4).
 */
function _ageAt(birthDate, asOfDate) {
  const b = new Date(birthDate);
  const d = new Date(asOfDate);
  const years = d.getUTCFullYear() - b.getUTCFullYear();
  const hadBirthday =
    d.getUTCMonth() > b.getUTCMonth() ||
    (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() >= b.getUTCDate());
  return hadBirthday ? years : years - 1;
}

/**
 * Build the band table for the AGE_BANDED strategy. When the convenience
 * `ageBandDeclineRate` scalar is set, synthesize a one-band table anchored at
 * the primary person's retirement age (Blanchett's smooth glide from one
 * number — MC/opt-able without design 25a). Otherwise use the full
 * `spendingAgeBands` array (default DEFAULT_AGE_BANDS).
 */
function _ageBands(context) {
  const p = context.parameters;
  if (p.ageBandDeclineRate != null) {
    const primary = context.people?.[0];
    let anchor = 65;
    if (primary?.birthDate && primary?.retirementDate) {
      anchor = _ageAt(primary.birthDate, primary.retirementDate);
    }
    return [
      { startAge: 0,      multiplier: 1.0, annualRealDrift: 0 },
      { startAge: anchor, multiplier: 1.0, annualRealDrift: p.ageBandDeclineRate },
    ];
  }
  return p.spendingAgeBands ?? DEFAULT_AGE_BANDS;
}

/**
 * Registry of pluggable spending strategies (design/26).
 *
 * Each entry exposes:
 *   reducers(context)   → Reducer[] to add to the simulation
 *   paramSchema()       → paramSchema entries contributed by this strategy
 *
 * The FIXED entry returns no reducers — InflationAdjustReducer is always
 * registered directly by the toolset and handles the fixed-inflation-adjusted
 * behavior (design/26 §12 decision 3).
 *
 * Handlers (RetirementDateHandler, ExpenseEventHandler) are wired in the
 * toolset's handlers() method since they need account + stateRegistry context.
 */
export const SPENDING_STRATEGY_REGISTRY = {

  FIXED: {
    reducers:    ()        => [],
    paramSchema: ()        => [],
  },

  REGIME_AWARE: {
    reducers: (context) => [
      new RegimeAwareSpendingReducer({
        regimeAwareCutPct: context.parameters.regimeAwareCutPct ?? 0.15,
      }),
    ],
    paramSchema: () => [
      {
        key: 'regimeAwareCutPct', label: 'Regime-Aware Spending Cut',
        type: 'Number', group: 'Spending', mc: false, opt: true,
        defaultValue: 0.15,
        description: 'Fraction of discretionary spending cut while any ECONOMIC_STRESS-tagged regime is active (0.15 = 15% cut)',
        visibleWhen: { param: 'spendingStrategy', includes: 'REGIME_AWARE' },
      },
    ],
  },

  GUARDRAIL: {
    reducers: (context) => [
      new GuardrailBaselineApplyReducer(),
      new GuardrailAdjustApplyReducer(),
      new GuardrailAnnualCheckReducer({
        cutThreshold:   context.parameters.guardrailCutThreshold   ?? 0.20,
        raiseThreshold: context.parameters.guardrailRaiseThreshold ?? 0.20,
        cutPct:         context.parameters.guardrailCutPct         ?? 0.10,
        raisePct:       context.parameters.guardrailRaisePct       ?? 0.10,
        baseCurrency:   context.parameters.guardrailBaseCurrency   ?? 'USD',
      }),
    ],
    paramSchema: () => [
      {
        key: 'guardrailCutThreshold', label: 'Guardrail Cut Threshold',
        type: 'Number', group: 'Spending', mc: false, opt: true,
        defaultValue: 0.20,
        description: 'Withdrawal rate fraction above initial that triggers a spending cut (0.20 = 20%)',
        visibleWhen: { param: 'spendingStrategy', includes: 'GUARDRAIL' },
      },
      {
        key: 'guardrailRaiseThreshold', label: 'Guardrail Raise Threshold',
        type: 'Number', group: 'Spending', mc: false, opt: true,
        defaultValue: 0.20,
        description: 'Withdrawal rate fraction below initial that triggers a spending raise (0.20 = 20%)',
        visibleWhen: { param: 'spendingStrategy', includes: 'GUARDRAIL' },
      },
      {
        key: 'guardrailCutPct', label: 'Guardrail Cut %',
        type: 'Number', group: 'Spending', mc: false, opt: true,
        defaultValue: 0.10,
        description: 'Fraction of discretionary spending to cut when the cut threshold is breached (0.10 = 10%)',
        visibleWhen: { param: 'spendingStrategy', includes: 'GUARDRAIL' },
      },
      {
        key: 'guardrailRaisePct', label: 'Guardrail Raise %',
        type: 'Number', group: 'Spending', mc: false, opt: true,
        defaultValue: 0.10,
        description: 'Fraction to raise discretionary spending when the raise threshold is breached (0.10 = 10%)',
        visibleWhen: { param: 'spendingStrategy', includes: 'GUARDRAIL' },
      },
      {
        key: 'guardrailBaseCurrency', label: 'Guardrail Base Currency',
        type: 'Text', group: 'Spending', mc: false, opt: true,
        defaultValue: 'USD',
        description: 'Currency to use when summing multi-currency portfolio values for the Guardrail check',
        visibleWhen: { param: 'spendingStrategy', includes: 'GUARDRAIL' },
      },
    ],
  },

  // Generalized from HEALTHCARE by design 86 G8. Healthcare is now a `category`
  // VALUE rather than a strategy, which is the correct relationship between the two:
  // a medical bill and a roof replacement are the same kind of thing to the engine —
  // a dated amount debited from savings — and differ only in what you call them and
  // where the money comes from.
  EXPENSE_EVENTS: {
    reducers: () => [
      new ExpenseEventApplyReducer(),
    ],
    paramSchema: () => [
      {
        key: 'expenseEvents', label: 'One-Off Expense Events',
        type: 'ExpenseEventList', group: 'Spending', mc: false, opt: true,
        defaultValue: [],
        description: 'List of dated one-off expenses: [{ date, amount, currency, category, fundFrom, personId, propertyKey, capitalize }]. '
          + '`currency` defaults to the linked property\'s, else the household expense currency — set it explicitly for a cost that is genuinely denominated in one currency (design 86 §8). '
          + '`fundFrom` is a state key debited DIRECTLY, taking only what is above that account\'s minimumBalance, with any remainder falling through to the residence-appropriate savings account; omit it for the residency default. '
          + 'It is the way to draw an out-of-queue account such as an offset WITHOUT giving that account a drawdownPriority, which would drain it against all spending. '
          + '`propertyKey` + `capitalize` (0-1) add that fraction of the cost to the property\'s capitalizedImprovements, reducing the eventual capital gain the way capitalizeRepairs does.',
        visibleWhen: { param: 'spendingStrategy', includes: 'EXPENSE_EVENTS' },
      },
    ],
  },

  EXPLICIT_BANDS: {
    reducers: (context) => [
      new ExplicitBandsSpendingReducer({
        bands:              context.parameters.spendingExpenseBands ?? DEFAULT_EXPENSE_BANDS,
        discretionaryShare: context.parameters.discretionarySharePct ?? 0.30,
      }),
    ],
    paramSchema: () => [
      {
        key: 'spendingExpenseBands', label: 'Spending Expense Bands',
        type: 'ExpenseBandList', group: 'Spending', mc: false, opt: true,
        defaultValue: DEFAULT_EXPENSE_BANDS,
        description: 'Absolute monthly spend per age band: each band is { startAge, monthlyAmount } in base-year currency; compounded to nominal by the residence price level at band transitions. The lever for "optimal monthly expense amount per age band" (design 38 §6.1).',
        visibleWhen: { param: 'spendingStrategy', includes: 'EXPLICIT_BANDS' },
      },
    ],
  },

  AGE_BANDED: {
    reducers: (context) => [
      new AgeBandedSpendingReducer({
        bands: _ageBands(context),
        slice: context.parameters.ageBandSpendingSlice ?? 'discretionary',
      }),
    ],
    paramSchema: () => [
      {
        key: 'spendingAgeBands', label: 'Spending Age Bands',
        type: 'AgeBandList', group: 'Spending', mc: false, opt: true,
        defaultValue: DEFAULT_AGE_BANDS,
        description: 'Age-band table for the retirement spending smile: each band is { startAge, multiplier, annualRealDrift }; multiplier is the relative step entering the band, annualRealDrift the within-band real glide',
        visibleWhen: { param: 'spendingStrategy', includes: 'AGE_BANDED' },
      },
      {
        key: 'ageBandSpendingSlice', label: 'Age-Band Spending Slice',
        type: 'Enum', group: 'Spending', mc: false, opt: true,
        options: ['discretionary', 'both'],
        defaultValue: 'discretionary',
        description: "Which expense slice the age factor bends: 'discretionary' (default) or 'both'",
        visibleWhen: { param: 'spendingStrategy', includes: 'AGE_BANDED' },
      },
      {
        key: 'ageBandDeclineRate', label: 'Age-Band Decline Rate',
        type: 'Number', group: 'Spending', mc: true, opt: true,
        defaultValue: null,
        description: 'Convenience: a single real %/yr decline anchored at the primary person\'s retirement age. When set, overrides Spending Age Bands with a synthesized one-band glide (e.g. -0.01 = Blanchett\'s ~1%/yr smile)',
        visibleWhen: { param: 'spendingStrategy', includes: 'AGE_BANDED' },
      },
    ],
  },

};
