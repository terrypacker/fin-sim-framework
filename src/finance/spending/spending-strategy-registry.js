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
import { HealthcareExpenseApplyReducer }   from './strategies/healthcare-expense-apply-reducer.js';
import { AgeBandedSpendingReducer, DEFAULT_AGE_BANDS } from './strategies/age-banded-spending-reducer.js';

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
 * Handlers (RetirementDateHandler, HealthcareEventHandler) are wired in the
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
      },
      {
        key: 'guardrailRaiseThreshold', label: 'Guardrail Raise Threshold',
        type: 'Number', group: 'Spending', mc: false, opt: true,
        defaultValue: 0.20,
        description: 'Withdrawal rate fraction below initial that triggers a spending raise (0.20 = 20%)',
      },
      {
        key: 'guardrailCutPct', label: 'Guardrail Cut %',
        type: 'Number', group: 'Spending', mc: false, opt: true,
        defaultValue: 0.10,
        description: 'Fraction of discretionary spending to cut when the cut threshold is breached (0.10 = 10%)',
      },
      {
        key: 'guardrailRaisePct', label: 'Guardrail Raise %',
        type: 'Number', group: 'Spending', mc: false, opt: true,
        defaultValue: 0.10,
        description: 'Fraction to raise discretionary spending when the raise threshold is breached (0.10 = 10%)',
      },
      {
        key: 'guardrailBaseCurrency', label: 'Guardrail Base Currency',
        type: 'Text', group: 'Spending', mc: false, opt: true,
        defaultValue: 'USD',
        description: 'Currency to use when summing multi-currency portfolio values for the Guardrail check',
      },
    ],
  },

  HEALTHCARE: {
    reducers: () => [
      new HealthcareExpenseApplyReducer(),
    ],
    paramSchema: () => [
      {
        key: 'healthcareEvents', label: 'Healthcare Events',
        type: 'Array', group: 'Spending', mc: false, opt: true,
        defaultValue: [],
        description: 'List of one-off healthcare events: [{ date, amount, category, personId }]',
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
      },
      {
        key: 'ageBandSpendingSlice', label: 'Age-Band Spending Slice',
        type: 'Enum', group: 'Spending', mc: false, opt: true,
        options: ['discretionary', 'both'],
        defaultValue: 'discretionary',
        description: "Which expense slice the age factor bends: 'discretionary' (default) or 'both'",
      },
      {
        key: 'ageBandDeclineRate', label: 'Age-Band Decline Rate',
        type: 'Number', group: 'Spending', mc: true, opt: true,
        defaultValue: null,
        description: 'Convenience: a single real %/yr decline anchored at the primary person\'s retirement age. When set, overrides Spending Age Bands with a synthesized one-band glide (e.g. -0.01 = Blanchett\'s ~1%/yr smile)',
      },
    ],
  },

};
