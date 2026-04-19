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
import { MetricReducer, NoOpReducer, PRIORITY } from '../simulation-framework/reducers.js';

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
 * registerWith() entry point that wires account and tax rules into a
 * Simulation instance for the requested countries.
 *
 * Tax module selection is now dynamic: rather than fixing a single year at
 * setup time, TaxEngine.registerDynamic() registers per-action dispatchers
 * that read state.currentPeriods[cc] at runtime to resolve the correct year
 * module.  TaxService injects state.currentPeriods on startup and schedules
 * PERIOD_ADVANCE events at each year boundary so the state stays current as
 * the simulation advances through multiple tax years.
 *
 * Account module selection remains static (using the year that contains the
 * simulation start date) because CASH_FLOW mechanics are currently identical
 * across years.  Full dynamic dispatch for account modules is a follow-on
 * when contribution limits or age gates diverge between years.
 *
 * Usage:
 *   const ps = new PeriodService();
 *   applyTo(ps, buildUsCalendarYear(2025));
 *   applyTo(ps, buildUsCalendarYear(2026));
 *
 *   const taxService = new TaxService();
 *   const svc = taxService.registerWith(sim, ['US'], ps);
 *   // svc is the shared AccountService instance
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
   * Wire up all reducers and handlers for the given country codes.
   *
   * What this does per country:
   *   1. Finds the annual Period in periodService that contains the simulation
   *      start date and records it in state.currentPeriods[cc].
   *   2. Schedules PERIOD_ADVANCE events at every future year boundary found
   *      in periodService so state.currentPeriods[cc] stays current.
   *   3. Registers the AccountModule for the start year (CASH_FLOW handlers +
   *      reducers — static for now, same mechanics across years).
   *   4. Calls TaxEngine.registerDynamic() which registers one runtime
   *      dispatcher per action type; each dispatcher reads
   *      state.currentPeriods[cc] to pick the correct year's module.
   *
   * Also registers MetricReducer (RECORD_METRIC) and NoOpReducer (RECORD_BALANCE).
   *
   * The periodService must contain at least one annual period (YEAR_US for US,
   * YEAR_AU for AU) that spans the simulation start date.  Populate it with
   * buildUsCalendarYear() / buildAuFiscalYear() from period-builder.js.
   *
   * @param {import('../simulation-framework/simulation.js').Simulation} sim
   * @param {string[]} countryCodes  e.g. ['US'] or ['AU'] or ['US', 'AU']
   * @param {import('./period/period-service.js').PeriodService} periodService
   * @returns {AccountService}  shared AccountService instance for use in tests / scenarios
   */
  registerWith(sim, countryCodes, periodService) {
    const startTs = sim.currentDate.getTime();

    // ── Step 1: resolve the starting period for each country ──────────────────
    const currentPeriods = {};

    for (const cc of countryCodes) {
      const periodType = _periodTypeFor(cc);
      const current = periodService.getAllPeriods()
        .find(p => p.type === periodType && p.startMs <= startTs && startTs < p.endMs);

      if (!current) {
        throw new Error(
          `TaxService.registerWith: no '${periodType}' period found for start date ` +
          `${sim.currentDate.toISOString()} in PeriodService. ` +
          `Add the appropriate year via buildUsCalendarYear() or buildAuFiscalYear().`
        );
      }
      currentPeriods[cc] = current;
    }

    // Inject currentPeriods into simulation state before any events run.
    sim.state = { ...sim.state, currentPeriods };

    // ── Step 2: register PERIOD_ADVANCE reducer ────────────────────────────────
    sim.reducers.register('PERIOD_ADVANCE', (state, action) => ({
      ...state,
      currentPeriods: { ...state.currentPeriods, [action.cc]: action.period },
    }), PRIORITY.PRE_PROCESS, 'Period Advance');

    // ── Step 3: schedule PERIOD_ADVANCE events for future year boundaries ──────
    for (const cc of countryCodes) {
      const periodType = _periodTypeFor(cc);

      for (const period of periodService.getAllPeriods()) {
        if (period.type === periodType && period.startMs > startTs) {
          // Extract UTC date parts and build a local-midnight Date to avoid
          // timezone skew when normalizeDate() strips the time component.
          const d = new Date(period.startMs);
          const schedDate = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
          sim.schedule({
            date: schedDate,
            type: 'PERIOD_ADVANCE',
            data: { cc, period },
          });
        }
      }
    }

    // ── Step 4: register account modules (static, start-year mechanics) ────────
    for (const cc of countryCodes) {
      const startYear     = new Date(currentPeriods[cc].startMs).getUTCFullYear();
      const accountModule = this._accountRulesEngine.get(cc, startYear);
      accountModule.registerWith(sim, this._accountService);
    }

    // ── Step 5: register dynamic tax reducers ──────────────────────────────────
    this._taxEngine.registerDynamic(sim.reducers, countryCodes);

    // ── Step 6: register metric/balance reducers ───────────────────────────────
    new MetricReducer().registerWith(sim.reducers, 'RECORD_METRIC');
    new NoOpReducer('Balance Snapshot').registerWith(sim.reducers, 'RECORD_BALANCE');

    return this._accountService;
  }

  /** @returns {TaxEngine} */
  get taxEngine() { return this._taxEngine; }

  /** @returns {AccountRulesEngine} */
  get accountRulesEngine() { return this._accountRulesEngine; }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Maps a country code to the PeriodType used for its annual tax year.
 * @param {string} cc
 * @returns {string}
 */
function _periodTypeFor(cc) {
  return cc === 'AU' ? 'YEAR_AU' : 'YEAR_US';
}
