/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';

/**
 * YieldCurveStepReducer — stores the new stochastic level deviation from a
 * YIELD_CURVE_STEP_APPLY action (design 67 §6, Phase 3). The pure counterpart to
 * YieldCurveTickHandler: the handler owns the seeded-RNG draw, this reducer just
 * records the result into `state.yieldCurveLevelDev[country]`, which YieldCurveReducer
 * then folds onto the effective fixed-income level. Priority CASH_FLOW (20), matching
 * the FX step reducer — after the pre-process rate rebuild, so the deviation is picked
 * up on the next period's YieldCurveReducer pass.
 */
export class YieldCurveStepReducer extends Reducer {
  static type        = 'YieldCurveStepReducer';
  static description = 'Stores the stochastic fixed-income level deviation from a YIELD_CURVE_STEP_APPLY action into state.yieldCurveLevelDev (design 67 §6).';

  constructor() {
    super('Yield Curve Step', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['YIELD_CURVE_STEP_APPLY'];
  }

  reduce(state, action) {
    const cc = action?.country;
    if (cc == null || action.deviation == null) return this.newState(state);
    return this.newState(state, {
      yieldCurveLevelDev: { ...(state.yieldCurveLevelDev ?? {}), [cc]: action.deviation },
    });
  }
}
