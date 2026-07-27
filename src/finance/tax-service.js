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

import {
  UsPeriodAdvanceReducer, UsPeriodAdvanceHandler,
  AuPeriodAdvanceReducer, AuPeriodAdvanceHandler,
} from './tax/period-advance-classes.js';
import {
  UsTaxSettleHandler, UsTaxSettleApplyReducer, UsTaxPaymentDebitReducer,
  AuTaxSettleHandler, AuTaxSettleApplyReducer, AuTaxPaymentDebitReducer,
} from './tax/tax-settle-classes.js';
import { DynamicTaxReducer } from './tax/dynamic-tax-reducer.js';
import { EventSeries } from '../simulation-framework/events/event-series.js';

import { UsTaxModule2024 }       from './tax/us/us-tax-module-2024.js';
import { UsTaxModule2025 }       from './tax/us/us-tax-module-2025.js';
import { UsTaxModule2026 }       from './tax/us/us-tax-module-2026.js';
import { AuTaxModule2024 }       from './tax/au/au-tax-module-2024.js';
import { AuTaxModule2025 }       from './tax/au/au-tax-module-2025.js';
import { AuTaxModule2026 }       from './tax/au/au-tax-module-2026.js';
import { AuTaxModule2027 }       from './tax/au/au-tax-module-2027.js';

import { UsAccountModule2024 }   from './account-rules/us/us-account-module-2024.js';
import { UsAccountModule2025 }   from './account-rules/us/us-account-module-2025.js';
import { UsAccountModule2026 }   from './account-rules/us/us-account-module-2026.js';
import { AuAccountModule2024 }   from './account-rules/au/au-account-module-2024.js';
import { AuAccountModule2025 }   from './account-rules/au/au-account-module-2025.js';
import { AuAccountModule2026 }   from './account-rules/au/au-account-module-2026.js';

// Per-country handler/reducer factories — keyed by country code.
const PERIOD_ADVANCE_HANDLER = { US: UsPeriodAdvanceHandler, AU: AuPeriodAdvanceHandler };
const PERIOD_ADVANCE_REDUCER = { US: UsPeriodAdvanceReducer, AU: AuPeriodAdvanceReducer };
const TAX_SETTLE_HANDLER     = { US: UsTaxSettleHandler,     AU: AuTaxSettleHandler     };
const TAX_SETTLE_APPLY_REDUCER = { US: UsTaxSettleApplyReducer, AU: AuTaxSettleApplyReducer };
const TAX_PAYMENT_DEBIT_REDUCER = { US: UsTaxPaymentDebitReducer, AU: AuTaxPaymentDebitReducer };

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
    this._taxEngine.register(new AuTaxModule2027());

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
   * Returns all contributions for the specified country codes as plain data —
   * no services are called, no side effects. Each country's period-advance,
   * tax-settle, and tax-payment-debit handlers and reducers are per-country
   * subclasses that own their own action types (no shared reducers needed).
   *
   * @param {string[]}  countryCodes  — e.g. ['US'] or ['AU']
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

    for (const cc of countryCodes) {
      // Period advance — one handler + one reducer per country
      const periodType = _periodTypeFor(cc);
      const periods    = periodService.getAllPeriods().filter(p => p.type === periodType);
      const { month: paMonth, day: paDay } = _periodAdvanceDateFor(cc);
      const paSeries = new EventSeries({
        name:     `${cc} Period Advance`,
        type:     `PERIOD_ADVANCE_${cc}`,
        interval: 'annually',
        month:    paMonth,
        day:      paDay,
        data:     { cc, periods },
        enabled:  true,
        color:    '#78909C',
      });
      events.push(paSeries);

      const paHandler = new PERIOD_ADVANCE_HANDLER[cc]();
      paHandler.handledEvents.push(paSeries);
      handlers.push(paHandler);

      reducers.push(new PERIOD_ADVANCE_REDUCER[cc]());

      // Tax settle — one handler + one apply reducer per country
      const { month: tsMonth, day: tsDay } = _taxSettleDateFor(cc);
      const tsSeries = new EventSeries({
        name:     `${cc} Tax Settle`,
        type:     `TAX_SETTLE_${cc}`,
        interval: 'annually',
        month:    tsMonth,
        day:      tsDay,
        data:     { cc },
        enabled:  true,
        color:    '#FF7043',
        order:    100,   // settle band: always after the year's income (design 34 §13)
      });
      events.push(tsSeries);

      const tsHandler = new TAX_SETTLE_HANDLER[cc]();
      tsHandler.handledEvents.push(tsSeries);
      handlers.push(tsHandler);

      reducers.push(new TAX_SETTLE_APPLY_REDUCER[cc]());
      reducers.push(new TAX_PAYMENT_DEBIT_REDUCER[cc]({ accountService, stateRegistry }));

      // Dynamic tax reducers (one per action type per country)
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
 * This is the date the PERIOD_ADVANCE_${cc} series fires each year.
 */
function _periodAdvanceDateFor(cc) {
  return cc === 'AU' ? { month: 7, day: 1 } : { month: 1, day: 1 };
}

/**
 * Month/day (1-based) of the last day of the tax year for a country.
 * This is the date the TAX_SETTLE_${cc} series fires each year.
 */
function _taxSettleDateFor(cc) {
  return cc === 'AU' ? { month: 6, day: 30 } : { month: 12, day: 31 };
}
