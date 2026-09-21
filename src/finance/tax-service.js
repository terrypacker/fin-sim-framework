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
import {
  UsTaxInstalmentHandler, AuTaxInstalmentHandler,
  UsTaxInstalmentDebitReducer, AuTaxInstalmentDebitReducer,
  UsTaxRefundCreditReducer, AuTaxRefundCreditReducer,
} from './tax/tax-instalment-classes.js';
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
import { UsTaxFileHandler, UsTaxFileApplyReducer } from './tax/us/tax-file-classes.js';

// Per-country handler/reducer factories — keyed by country code.
const PERIOD_ADVANCE_HANDLER = { US: UsPeriodAdvanceHandler, AU: AuPeriodAdvanceHandler };

/**
 * The period advance OPENS its instant: it runs before every other event dated the same moment
 * (design 39 §14.10). Before the queue had a total order this held only by luck of the heap's
 * layout, and the one place it mattered was measured: on the move date the AU year-open and
 * `CHANGE_RESIDENCY` share 1 July, the year-open's rebalance and pool flows can SELL, and which
 * residency that sale is made under moved a real plan by 6%. The year opening first means the
 * sale is the departing resident's, and the move follows; the paycheck (order 1) still sees
 * the new residency.
 */
export const PERIOD_ADVANCE_ORDER = -1;
const PERIOD_ADVANCE_REDUCER = { US: UsPeriodAdvanceReducer, AU: AuPeriodAdvanceReducer };
const TAX_SETTLE_HANDLER     = { US: UsTaxSettleHandler,     AU: AuTaxSettleHandler     };
const TAX_SETTLE_APPLY_REDUCER = { US: UsTaxSettleApplyReducer, AU: AuTaxSettleApplyReducer };
const TAX_PAYMENT_DEBIT_REDUCER = { US: UsTaxPaymentDebitReducer, AU: AuTaxPaymentDebitReducer };
const TAX_INSTALMENT_HANDLER       = { US: UsTaxInstalmentHandler,       AU: AuTaxInstalmentHandler };
const TAX_INSTALMENT_DEBIT_REDUCER = { US: UsTaxInstalmentDebitReducer,  AU: AuTaxInstalmentDebitReducer };
const TAX_REFUND_CREDIT_REDUCER    = { US: UsTaxRefundCreditReducer,     AU: AuTaxRefundCreditReducer };

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
  getContributions(countryCodes, periodService, startDate, accountService, stateRegistry, parameters = {}) {
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
        order:    PERIOD_ADVANCE_ORDER,
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
      // ── design 107 §6–§8 — paying tax in instalments ─────────────────────────────
      //
      // The refund reducer is wired unconditionally and the instalment machinery is not.
      // Asymmetric on purpose: the refund is the settle's own counterpart (an over-payment has
      // to land somewhere the moment instalments exist, and a settle that emitted a refund
      // nothing consumed would silently forfeit it), while four extra event series per country
      // would re-resolve same-date ties in every scenario that never asked for them — the
      // \$391k lesson recorded on the filing handler above.
      reducers.push(new TAX_REFUND_CREDIT_REDUCER[cc]({ accountService, stateRegistry }));
      if (parameters?.taxInstalmentsEnabled) {
        reducers.push(new TAX_INSTALMENT_DEBIT_REDUCER[cc]());
        // §6654(c)(2) for the US: 15 April, 15 June, 15 September, and 15 January of the
        // FOLLOWING year — note the fourth is two weeks after the settle that closes the year
        // it belongs to, which is why the settle credits three and not four.
        //
        // s 45-61 for Australia, on a 30 June income year: the 21st of the month after each
        // instalment quarter, or the 28th for a `deferred BAS payer` — which is most
        // individuals lodging through an agent, hence the default. s 45-61(2)(d) puts the
        // December quarter's instalment at the next 28 February rather than 28 January.
        const deferred = parameters?.auDeferredBasPayer !== false;
        // ── THREE instalments, not four, and the reason is the settle date ──────────────
        //
        // Each regime's FOURTH instalment falls AFTER the settle that closes the year it
        // belongs to: 15 January for a 31 December US year (§6654(c)(2)), 28 July for a 30 June
        // AU one (s 45-61). The settle resets the year's running total and re-stamps the basis,
        // so an instalment fired after it reads the NEW year's basis against a zeroed total and
        // pays a full year in one go. Measured before this was fixed: every US instalment
        // landed on 15 January, 34 of them.
        //
        // Crediting it to the right year would mean keying the running total by tax year. The
        // cheaper answer is the one the statute already provides: **§6654(h)** — file and pay
        // in full by 31 January and no addition to tax arises on the 4th required instalment.
        // A settle that runs on 31 December and pays the balance IS paying in full by
        // 31 January, so the fourth instalment is discharged by the settle rather than skipped.
        // Australia has no §6654(h), but its assessment genuinely happens months after 30 June
        // (a return is lodged by October), so a model that settles ON 30 June has already
        // collapsed the fourth instalment into the assessment.
        //
        // The three that DO fall inside the year keep their exact statutory amounts, because
        // `CUMULATIVE_SHARE` states each as a share of the required annual payment: 25/50/75.
        // The balance is the settle's true-up, which is where it would have gone anyway.
        const DUE = cc === 'US'
          ? [[4, 15], [6, 15], [9, 15]]
          : (deferred ? [[10, 28], [2, 28], [4, 28]]
                      : [[10, 21], [1, 21], [4, 21]]);
        DUE.forEach(([month, day], i) => {
          const series = new EventSeries({
            name:     `${cc} Tax Instalment Q${i + 1}`,
            // One TYPE per quarter. `ScenarioCompiler` de-duplicates EventSeries by type, so
            // four series sharing `TAX_INSTALMENT_${cc}` collapse to one and only the last
            // survives — measured, and it put every US instalment on 15 January. A single
            // series with a quarterly interval cannot express these dates either: neither
            // calendar is evenly spaced (US Apr→Jun is two months, AU Oct→Feb is four).
            type:     `TAX_INSTALMENT_${cc}_Q${i + 1}`,
            interval: 'annually',
            month, day,
            data:     { cc, quarter: i + 1 },
            enabled:  true,
            color:    '#FFA726',
            // Ahead of the settle band (100) — an instalment is never the true-up.
            order:    90,
          });
          events.push(series);
          const h = new TAX_INSTALMENT_HANDLER[cc]({ quarter: i + 1 });
          h.handledEvents.push(series);
          handlers.push(h);
        });
      }
      // FILING the prior year's return, as an event distinct from the tax year ENDING
      // (design 94 §8.1l). It exists because a 31-December settle cannot see whether a
      // 31-December sale was a wash — that window closes on 30 January. US only: Australia
      // has no §1091, and its Part IVA answer is a different mechanism entirely (§8.1d).
      //
      // ⚠️ **NO EventSeries, and that is the whole trick** (§8.1m). A standing annual series
      // would sit in the queue of every US scenario — and the queue's comparator is
      // `date || order` with NO final tie-break, so merely ADDING a node re-resolves ties
      // among unrelated same-date events elsewhere in the run. Measured: a standing series
      // moved all eleven goldens, 560 fields, worst \$391k. The filing is therefore scheduled
      // LAZILY by the settle, one occurrence at a time, only when there is something to
      // amend — which is also what it means: you lodge an amendment when you have one.
      //
      // Registered by `static eventType` with no `handledEvents`, the same way the engine
      // wires its other event-driven-but-unscheduled handlers.
      if (cc === 'US') {
        handlers.push(new UsTaxFileHandler());
        reducers.push(new UsTaxFileApplyReducer());
      }

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


