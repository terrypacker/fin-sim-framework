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

};
