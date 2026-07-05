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
 * Pure write of the walked FX deviation (design 47 §6.3).
 *
 * FxTickHandler already drew the RNG and computed the next deviation; this
 * reducer only stores it on state.fxDeviation[pair]. No math, no RNG — so the
 * reducer stays pure and replay-safe.
 *
 * Runs at PRIORITY.CASH_FLOW (20).
 */
export class FxStepApplyReducer extends Reducer {
  static description = 'Stores the walked FX log-deviation on state.fxDeviation[pair] (pure; handler already drew the RNG).';
  static type        = 'FxStepApplyReducer';
  static actionType  = 'FX_STEP_APPLY';

  constructor() {
    super('FX Step Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['FX_STEP_APPLY'];
    this.generatedActionTypes = [];
  }

  static fromJSON(d) {
    const r = new this();
    r.id = d.id;
    return r;
  }

  toJSON() {
    return { ...super.toJSON() };
  }

  reduce(state, action) {
    const { pair, deviation = 0 } = action;
    if (!pair) return this.newState(state);
    return this.newState(state, {
      fxDeviation: { ...(state.fxDeviation ?? {}), [pair]: deviation },
    });
  }
}
