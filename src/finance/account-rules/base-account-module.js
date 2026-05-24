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
 * BaseAccountModule — abstract base for country+year account mechanics modules.
 *
 * Subclasses register:
 *   - Event handlers (age gates, residency checks, action dispatch)
 *   - Stage-1 (CASH_FLOW priority) reducers that mutate account balances and
 *     emit _TAX child actions via next:[] for cross-country tax classification
 */
export class BaseAccountModule {
  /** @returns {string}  e.g. 'US' or 'AU' */
  get countryCode() {
    throw new Error(`${this.constructor.name}: countryCode not implemented`);
  }

  /** @returns {number}  e.g. 2025 or 2026 */
  get year() {
    throw new Error(`${this.constructor.name}: year not implemented`);
  }

  /**
   * Register all event handlers and Stage-1 (CASH_FLOW priority) reducers.
   * Called by TaxService during sim wiring.
   * @param {import('../../simulation-framework/simulation.js').Simulation} sim
   * @param {import('../services/account-service.js').AccountService} svc
   */
  registerWith(sim, svc) {
    throw new Error(`${this.constructor.name}: registerWith not implemented`);
  }
}
