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
import { ArrayReducer, BalanceSnapshotReducer } from '../simulation-framework/reducers.js';

import { PeriodAdvanceReducer, PeriodAdvanceHandler } from './tax/period-advance-classes.js';
import { TaxSettleHandler, TaxSettleApplyReducer, TaxPaymentDebitReducer } from './tax/tax-settle-classes.js';
import { DynamicTaxReducer } from './tax/dynamic-tax-reducer.js';
import { EventSeries } from '../simulation-framework/events/event-series.js';

import { UsTaxModule2024 }       from './tax/us/us-tax-module-2024.js';
import { UsTaxModule2025 }       from './tax/us/us-tax-module-2025.js';
import { UsTaxModule2026 }       from './tax/us/us-tax-module-2026.js';
import { AuTaxModule2024 }       from './tax/au/au-tax-module-2024.js';
import { AuTaxModule2025 }       from './tax/au/au-tax-module-2025.js';
import { AuTaxModule2026 }       from './tax/au/au-tax-module-2026.js';

import { UsAccountModule2024 }   from './account-rules/us/us-account-module-2024.js';
import { UsAccountModule2025 }   from './account-rules/us/us-account-module-2025.js';
import { UsAccountModule2026 }   from './account-rules/us/us-account-module-2026.js';
import { AuAccountModule2024 }   from './account-rules/au/au-account-module-2024.js';
import { AuAccountModule2025 }   from './account-rules/au/au-account-module-2025.js';
import { AuAccountModule2026 }   from './account-rules/au/au-account-module-2026.js';

/**
 * TaxService — coordinates TaxEngine and AccountRulesEngine.
 *
 * Pre-registers all known country+year modules. The declarative API is
 * getContributions(), used by the US_TAX / AU_TAX toolsets to obtain all
 * events, handlers, and reducers as plain data without calling any services.
 *
 * Tax module selection is dynamic: TaxEngine.registerDynamic() registers
 * per-action dispatchers that read state.currentPeriods[cc] at runtime to
 * resolve the correct year module.
 */
export class TaxService {
  constructor() {
    this._taxEngine          = new TaxEngine();
    this._accountRulesEngine = new AccountRulesEngine();

    // Register all known tax modules
    this._taxEngine.register(new UsTaxModule2024());
    this._taxEngine.register(new UsTaxModule2025());
    this._taxEngine.register(new UsTaxModule2026());
    this._taxEngine.register(new AuTaxModule2024());
    this._taxEngine.register(new AuTaxModule2025());
    this._taxEngine.register(new AuTaxModule2026());

    // Register all known account modules
    this._accountRulesEngine.register(new UsAccountModule2024());
    this._accountRulesEngine.register(new UsAccountModule2025());
    this._accountRulesEngine.register(new UsAccountModule2026());
    this._accountRulesEngine.register(new AuAccountModule2024());
    this._accountRulesEngine.register(new AuAccountModule2025());
    this._accountRulesEngine.register(new AuAccountModule2026());
  }

  /**
   * Declarative alternative to the two-phase setup()/registerHandlersAndReducers() API.
   *
   * Returns all contributions as plain data — no services are called, no side effects.
   * The ScenarioCompiler (via the US_TAX / AU_TAX toolsets) is responsible for
   * registering the returned items with the real service layer.
   *
   * @param {string[]}  countryCodes
   * @param {import('./period/period-service.js').PeriodService} periodService
   * @param {Date}      startDate
   * @param {object}    accountService
   * @param {object}    stateRegistry
   * @returns {{ statePatches: object, events: object[], handlers: object[], reducers: object[] }}
   */
  getContributions(countryCodes, periodService, startDate, accountService, stateRegistry) {
    const startTs = startDate.getTime();

    // Resolve starting period for each country
    const currentPeriods = {};
    for (const cc of countryCodes) {
      const periodType = _periodTypeFor(cc);
      const current = periodService.getAllPeriods()
        .find(p => p.type === periodType && p.startMs <= startTs && startTs < p.endMs);
      if (!current) {
        throw new Error(
          `TaxService.getContributions: no '${periodType}' period found for start date ` +
          `${startDate.toISOString()} in PeriodService. ` +
          `Add the appropriate year via buildUsCalendarYear() or buildAuFiscalYear().`
        );
      }
      currentPeriods[cc] = current;
    }

    const events   = [];
    const handlers = [];
    const reducers = [];

    const periodAdvanceHandler = new PeriodAdvanceHandler();

    for (const cc of countryCodes) {
      const { month, day } = _periodAdvanceDateFor(cc);
      const periodType = _periodTypeFor(cc);
      const periods = periodService.getAllPeriods().filter(p => p.type === periodType);
      const series = new EventSeries({
        name:     `${cc} Period Advance`,
        type:     `PERIOD_ADVANCE_${cc}`,
        interval: 'annually',
        month,
        day,
        data:     { cc, periods },
        enabled:  true,
        color:    '#78909C',
      });
      events.push(series);
      periodAdvanceHandler.handledEvents.push(series);
    }

    const taxSettleHandler = new TaxSettleHandler();

    for (const cc of countryCodes) {
      const { month, day } = _taxSettleDateFor(cc);
      const series = new EventSeries({
        name:     `${cc} Tax Settle`,
        type:     `TAX_SETTLE_${cc}`,
        interval: 'annually',
        month,
        day,
        data:     { cc },
        enabled:  true,
        color:    '#FF7043',
      });
      events.push(series);
      taxSettleHandler.handledEvents.push(series);
    }

    handlers.push(periodAdvanceHandler);
    reducers.push(new PeriodAdvanceReducer());

    // Dynamic tax reducers (one per action type per country)
    for (const cc of countryCodes) {
      const actionTypes = new Set();
      Object.keys(this._taxEngine._modules)
        .filter(k => k.startsWith(cc + '_'))
        .forEach(k => {
          for (const [type] of this._taxEngine._modules[k].getReducerFns()) {
            actionTypes.add(type);
          }
        });
      for (const actionType of actionTypes) {
        reducers.push(new DynamicTaxReducer(this._taxEngine, cc, actionType));
      }
    }

    handlers.push(taxSettleHandler);
    reducers.push(new TaxSettleApplyReducer());
    reducers.push(new TaxPaymentDebitReducer({ accountService, stateRegistry }));

    const taxDebitReducer = new ArrayReducer('Tax Debit');
    taxDebitReducer.reducedActionTypes = ['RECORD_ARRAY_METRIC'];
    reducers.push(taxDebitReducer);

    const balanceSnapshotReducer = new BalanceSnapshotReducer('Balance Snapshot');
    balanceSnapshotReducer.reducedActionTypes = ['RECORD_BALANCE'];
    reducers.push(balanceSnapshotReducer);

    return { statePatches: { currentPeriods }, events, handlers, reducers };
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

/**
 * Month/day (1-based) of the first day of the new tax year for a country.
 * This is the date PERIOD_ADVANCE fires each year.
 */
function _periodAdvanceDateFor(cc) {
  return cc === 'AU' ? { month: 7, day: 1 } : { month: 1, day: 1 };
}

/**
 * Month/day (1-based) of the last day of the tax year for a country.
 * This is the date TAX_SETTLE fires each year.
 */
function _taxSettleDateFor(cc) {
  return cc === 'AU' ? { month: 6, day: 30 } : { month: 12, day: 31 };
}
