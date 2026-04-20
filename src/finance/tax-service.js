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
import { AccountService, InsufficientFundsError } from './account.js';
import { MetricReducer, NoOpReducer, PRIORITY } from '../simulation-framework/reducers.js';
import { TaxSettleService }      from './tax-settle-service.js';

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

    // ── Step 2: register PERIOD_ADVANCE reducer + handler ─────────────────────
    // The reducer updates currentPeriods; the handler dispatches the scheduled
    // event as an action so the reducer actually fires (events → handlers →
    // actions → reducers; without a handler the reducer would never run).
    sim.reducers.register('PERIOD_ADVANCE', (state, action) => ({
      ...state,
      currentPeriods: { ...state.currentPeriods, [action.cc]: action.period },
    }), PRIORITY.PRE_PROCESS, 'Period Advance');

    sim.register('PERIOD_ADVANCE', ({ data }) => [
      { type: 'PERIOD_ADVANCE', cc: data.cc, period: data.period },
    ]);

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

    // ── Step 6: schedule TAX_SETTLE events at each period end ──────────────────
    const settleService = new TaxSettleService();
    const _computeTax = (state, cc) =>
      cc === 'AU' ? settleService.computeAuTax(state) : settleService.computeUsTax(state);

    // YTD fields to reset after settlement, keyed by country code
    const _ytdFields = {
      US: ['usOrdinaryIncomeYTD', 'usNegativeIncomeYTD', 'usCapitalGainsYTD', 'usPenaltyYTD', 'ftcYTD'],
      AU: ['auOrdinaryIncomeYTD', 'auCapitalGainsYTD', 'auNonResidentWithholdingYTD', 'auSuperTaxYTD', 'auFrankingCreditYTD'],
    };

    for (const cc of countryCodes) {
      const periodType = _periodTypeFor(cc);
      for (const period of periodService.getAllPeriods()) {
        if (period.type === periodType && period.endMs > startTs) {
          // Schedule on the last day of the period (endMs is exclusive midnight UTC)
          const d       = new Date(period.endMs);
          const lastDay = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1);
          sim.schedule({ date: lastDay, type: 'TAX_SETTLE', data: { cc } });
        }
      }
    }

    // TAX_SETTLE handler: compute → emit TAX_SETTLE_APPLY + RECORD_BALANCE
    sim.register('TAX_SETTLE', ({ data, state }) => {
      const { cc } = data;
      const tax = _computeTax(state, cc);
      return [
        { type: 'TAX_SETTLE_APPLY', cc, tax },
        { type: 'RECORD_BALANCE' },
      ];
    });

    // TAX_SETTLE_APPLY reducer: reset YTD fields, emit TAX_PAYMENT_DEBIT if tax > 0
    sim.reducers.register('TAX_SETTLE_APPLY', (state, action) => {
      const { cc, tax } = action;
      const resets = {};
      for (const field of (_ytdFields[cc] || [])) {
        if (field in state) resets[field] = 0;
      }
      const nextState = { ...state, ...resets };
      if (tax > 0) {
        return { state: nextState, next: [{ type: 'TAX_PAYMENT_DEBIT', amount: tax, cc }] };
      }
      return nextState;
    }, PRIORITY.TAX_APPLY, 'Tax Settle Apply');

    // TAX_PAYMENT_DEBIT reducer: debit the appropriate country's cash account.
    // If the account is short, replenish from domestic investment accounts first.
    // Partial payment is accepted if all domestic sources are exhausted.
    sim.reducers.register('TAX_PAYMENT_DEBIT', (state, action, date) => {
      const { amount, cc } = action;
      const accountKey  = cc === 'AU' ? 'auSavingsAccount' : 'usSavingsAccount';
      const cashAccount = state[accountKey];
      const shortfall   = amount - Math.max(0, cashAccount.balance);
      if (shortfall > 0) {
        try {
          this._accountService.replenishSavings(state, accountKey, shortfall, date);
        } catch (e) {
          if (!(e instanceof InsufficientFundsError)) throw e;
          // Proceed with partial payment — pay what's available
        }
      }
      const debit = Math.min(amount, Math.max(0, cashAccount.balance));
      if (debit > 0) {
        this._accountService.transaction(cashAccount, -debit, date);
      }
      const metricKey = cc === 'AU' ? 'tax_paid_au' : 'tax_paid_us';
      const list      = state.metrics[metricKey] || [];
      return {
        ...state,
        [accountKey]: { ...cashAccount },   // explicit new reference so the balance change is visible in state diffs
        metrics: { ...state.metrics, [metricKey]: [...list, debit] },
      };
    }, PRIORITY.TAX_APPLY + 1, 'Tax Payment Debit');

    // ── Step 7: register metric/balance reducers ───────────────────────────────
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
