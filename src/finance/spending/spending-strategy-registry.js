/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { RegimeAwareSpendingReducer } from './strategies/regime-aware-spending-reducer.js';

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
 * Increment 2 will add GUARDRAIL and HEALTHCARE entries.
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

};
