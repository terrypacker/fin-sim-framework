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
 * BaseTaxRatesModule — abstract base for country+year tax rate/bracket modules.
 *
 * Each concrete subclass sets the bracket tables and rates for a specific
 * country and tax year, and implements computeTax() to compute the net
 * tax liability from a simulation state snapshot.
 *
 * These modules are used by TaxSettleService at period-end to resolve the
 * correct year's rates, mirroring how TaxEngine resolves classification
 * modules at runtime.
 */
export class BaseTaxRatesModule {
  /** @returns {string}  e.g. 'US' or 'AU' */
  get countryCode() {
    throw new Error(`${this.constructor.name}: countryCode not implemented`);
  }

  /** @returns {number}  e.g. 2024 or 2025 */
  get year() {
    throw new Error(`${this.constructor.name}: year not implemented`);
  }

  /**
   * Compute net tax liability from a simulation state snapshot.
   *
   * @param {object} state  Simulation state at period end
   * @returns {number}      Net tax owed (>= 0)
   */
  computeTax(state) {
    throw new Error(`${this.constructor.name}: computeTax() not implemented`);
  }
}
