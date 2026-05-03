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
 * DynamicTaxReducer — runtime-dispatched tax reducer for a single (countryCode, actionType) pair.
 *
 * Instead of fixing a tax module at setup time, this reducer reads
 * state.currentPeriods[cc] on every call to determine which year's
 * BaseTaxModule to delegate to.  This supports multi-year simulations
 * where tax rules change year over year.
 *
 * TaxService creates one instance per (cc, actionType) combination found
 * across all registered tax modules for each country, then registers them
 * through the service layer so they appear in the config graph.
 *
 * @param {import('./tax-engine.js').TaxEngine} taxEngine
 * @param {string} cc           Country code, e.g. 'US' or 'AU'.
 * @param {string} actionType   Action type this instance handles (e.g. 'IRA_CONTRIBUTION_TAX').
 */
export class DynamicTaxReducer extends Reducer {
  static description = "Dispatches a tax-calculation action to the correct year's BaseTaxModule, resolved from state.currentPeriods at runtime.";

  constructor(taxEngine, cc, actionType) {
    super(`dynamic:${cc}:${actionType}`, PRIORITY.TAX_CALC);
    this._taxEngine = taxEngine;
    this.cc = cc;
    this.reducedActionTypes = [actionType];
  }

  reduce(state, action, date) {
    const period = state.currentPeriods?.[this.cc];
    if (!period) {
      throw new Error(
        `DynamicTaxReducer: state.currentPeriods.${this.cc} is not set for action '${action.type}'. ` +
        `Ensure TaxService.registerWithServices() is called before running the simulation.`
      );
    }
    const taxYear = new Date(period.startMs).getUTCFullYear();
    const module  = this._taxEngine.get(this.cc, taxYear);
    const fn      = module.getReducerFns().get(action.type);
    // A future year's module may not handle every action type from an older module.
    if (!fn) return state;
    return fn(state, action, date);
  }
}
