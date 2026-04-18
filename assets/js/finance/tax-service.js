/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { TaxEngine }             from './tax/tax-engine.js';
import { AccountRulesEngine }    from './account-rules/account-rules-engine.js';
import { AccountService }        from './account.js';
import { MetricReducer, NoOpReducer } from '../simulation-framework/reducers.js';

import { UsTaxModule2025 }       from './tax/us/us-tax-module-2025.js';
import { UsTaxModule2026 }       from './tax/us/us-tax-module-2026.js';
import { AuTaxModule2025 }       from './tax/au/au-tax-module-2025.js';
import { AuTaxModule2026 }       from './tax/au/au-tax-module-2026.js';

import { UsAccountModule2025 }   from './account-rules/us/us-account-module-2025.js';
import { UsAccountModule2026 }   from './account-rules/us/us-account-module-2026.js';
import { AuAccountModule2025 }   from './account-rules/au/au-account-module-2025.js';
import { AuAccountModule2026 }   from './account-rules/au/au-account-module-2026.js';

/**
 * TaxService — coordinates TaxEngine and AccountRulesEngine.
 *
 * Pre-registers all known country+year modules and exposes a single
 * registerWith() entry point that wires the correct account and tax
 * rules into a Simulation instance for the requested countries and year.
 *
 * Usage:
 *   const taxService = new TaxService();
 *   const svc = taxService.registerWith(sim, ['US', 'AU'], 2026);
 *   // svc is the shared AccountService instance
 *
 * Registration order per country:
 *   1. AccountModule.registerWith(sim, svc)   — handlers + CASH_FLOW reducers
 *   2. TaxModule.registerReducers(sim.reducers) — TAX_CALC reducers
 *
 * The MetricReducer and NoOpReducer for RECORD_METRIC / RECORD_BALANCE are
 * also registered here so callers do not need to wire them separately.
 */
export class TaxService {
  constructor() {
    this._taxEngine          = new TaxEngine();
    this._accountRulesEngine = new AccountRulesEngine();
    this._accountService     = new AccountService();

    // Register all known tax modules
    this._taxEngine.register(new UsTaxModule2025());
    this._taxEngine.register(new UsTaxModule2026());
    this._taxEngine.register(new AuTaxModule2025());
    this._taxEngine.register(new AuTaxModule2026());

    // Register all known account modules
    this._accountRulesEngine.register(new UsAccountModule2025());
    this._accountRulesEngine.register(new UsAccountModule2026());
    this._accountRulesEngine.register(new AuAccountModule2025());
    this._accountRulesEngine.register(new AuAccountModule2026());
  }

  /**
   * Wire up all reducers and handlers for the given country codes and year.
   *
   * For each country code:
   *   - AccountModule.registerWith(sim, svc) registers event handlers and
   *     CASH_FLOW-priority account mechanics reducers (with next:[] tax chains)
   *   - TaxModule.registerReducers(sim.reducers) registers TAX_CALC-priority
   *     tax classification reducers
   *
   * Also registers MetricReducer (RECORD_METRIC) and NoOpReducer (RECORD_BALANCE).
   *
   * @param {import('../simulation-framework/simulation.js').Simulation} sim
   * @param {string[]} countryCodes  e.g. ['US'] or ['AU'] or ['US', 'AU']
   * @param {number}   year          e.g. 2026
   * @returns {AccountService}  shared AccountService instance for use in tests / scenarios
   */
  registerWith(sim, countryCodes, year) {
    for (const cc of countryCodes) {
      const accountModule = this._accountRulesEngine.get(cc, year);
      accountModule.registerWith(sim, this._accountService);

      const taxModule = this._taxEngine.get(cc, year);
      taxModule.registerReducers(sim.reducers);
    }

    new MetricReducer().registerWith(sim.reducers, 'RECORD_METRIC');
    new NoOpReducer('Balance Snapshot').registerWith(sim.reducers, 'RECORD_BALANCE');

    return this._accountService;
  }

  /** @returns {TaxEngine} */
  get taxEngine() { return this._taxEngine; }

  /** @returns {AccountRulesEngine} */
  get accountRulesEngine() { return this._accountRulesEngine; }
}
