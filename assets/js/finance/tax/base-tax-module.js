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
 * BaseTaxModule — abstract base for country+year tax classification modules.
 *
 * Subclasses register Stage-2 (TAX_CALC priority) reducers via registerReducers().
 * These reducers consume _TAX child actions emitted by Stage-1 account reducers
 * and update YTD tax tracking fields (usOrdinaryIncomeYTD, auCapitalGainsYTD, etc.)
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
   * Register all Stage-2 (TAX_CALC priority) reducers with the simulation's
   * ReducerPipeline.  Called by TaxService during sim wiring.
   * @param {import('../../simulation-framework/reducers.js').ReducerPipeline} pipeline
   */
  registerReducers(pipeline) {
    throw new Error(`${this.constructor.name}: registerReducers not implemented`);
  }
}
