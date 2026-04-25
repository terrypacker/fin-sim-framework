/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { PRIORITY } from '../../simulation-framework/reducers.js';

/**
 * BaseTaxModule — abstract base for country+year tax classification modules.
 *
 * Subclasses implement getReducerFns() returning a Map of actionType → reducer
 * function.  registerReducers() is a default implementation that iterates that
 * map and registers each entry — used for static (single-year) wiring.
 *
 * TaxEngine.registerDynamic() uses getReducerFns() directly to build per-year
 * runtime dispatchers, which is the preferred path for multi-year simulations.
 */
export class BaseTaxModule {
  /** @returns {string}  e.g. 'US' or 'AU' */
  get countryCode() {
    throw new Error(`${this.constructor.name}: countryCode not implemented`);
  }

  /** @returns {number}  e.g. 2025 or 2026 */
  get year() {
    throw new Error(`${this.constructor.name}: year not implemented`);
  }

  /**
   * Returns a Map of actionType → reducer function for this country+year module.
   * Each function has signature: (state, action, date) => newState
   *
   * This is the primary extension point for subclasses.
   *
   * @returns {Map<string, function(object, object, Date): object>}
   */
  getReducerFns() {
    throw new Error(`${this.constructor.name}: getReducerFns() not implemented`);
  }

  /**
   * Register all Stage-2 (TAX_CALC priority) reducers with the simulation's
   * ReducerPipeline.  Default implementation delegates to getReducerFns().
   * Used for static single-year wiring; prefer TaxEngine.registerDynamic()
   * for multi-year simulations.
   *
   * @param {import('../../simulation-framework/reducers.js').ReducerPipeline} pipeline
   */
  registerReducers(pipeline) {
    for (const [type, fn] of this.getReducerFns()) {
      pipeline.register(type, fn, PRIORITY.TAX_CALC, `${type}@${this.countryCode}${this.year}`);
    }
  }
}
