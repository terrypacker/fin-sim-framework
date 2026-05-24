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
import { InsufficientFundsError } from './account.js';
import { AccountService } from './services/account-service.js';
import { ReducerBuilder } from '../simulation-framework/builders/reducer-builder.js'
import { PRIORITY, ArrayReducer, NoOpReducer } from '../simulation-framework/reducers.js';
import { TaxSettleService }      from './tax-settle-service.js';

import { PeriodAdvanceReducer, PeriodAdvanceHandler } from './tax/period-advance-classes.js';
import { TaxSettleHandler, TaxSettleApplyReducer, TaxPaymentDebitReducer } from './tax/tax-settle-classes.js';
import { DynamicTaxReducer } from './tax/dynamic-tax-reducer.js';

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
   * Also registers MetricReducer (RECORD_ARRAY_METRIC) and NoOpReducer (RECORD_BALANCE).
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
    ReducerBuilder.array().name('Tax Debit').build().registerWith(sim.reducers, 'RECORD_ARRAY_METRIC');
    ReducerBuilder.noOp().name('Balance Snapshot').build().registerWith(sim.reducers, 'RECORD_BALANCE');

    return this._accountService;
  }

  /**
   * Wire up all reducers and handlers through the ServiceRegistry so they
   * appear in the config graph and are reachable via the UI.
   *
   * Performs the same state-setup and event-scheduling work as registerWith(),
   * then registers every reducer and handler as a named class instance via
   * the service layer (reducerService / handlerService).  SimulationSync
   * picks up the CREATE events and wires each instance into the Simulation.
   *
   * Call this instead of registerWith() when building a scenario that uses
   * the full service-registry stack (e.g. IntlRetirementScenario).
   * Tests that call registerWith() directly are unaffected.
   *
   * @param {import('../simulation-framework/simulation.js').Simulation} sim
   * @param {string[]} countryCodes
   * @param {import('./period/period-service.js').PeriodService} periodService
   * @param {import('../services/service-registry.js').ServiceRegistry} serviceRegistry
   * @returns {import('./services/account-service.js').AccountService}
   */
  registerWithServices(sim, countryCodes, periodService, serviceRegistry) {
    const { reducerService, handlerService, accountService } = serviceRegistry;
    const startTs = sim.currentDate.getTime();

    // ── Step 1: resolve the starting period for each country ──────────────────
    const currentPeriods = {};
    for (const cc of countryCodes) {
      const periodType = _periodTypeFor(cc);
      const current = periodService.getAllPeriods()
        .find(p => p.type === periodType && p.startMs <= startTs && startTs < p.endMs);
      if (!current) {
        throw new Error(
          `TaxService.registerWithServices: no '${periodType}' period found for start date ` +
          `${sim.currentDate.toISOString()} in PeriodService.`
        );
      }
      currentPeriods[cc] = current;
    }

    // Inject currentPeriods into simulation state before any events run.
    sim.state = { ...sim.state, currentPeriods };

    // ── Step 2: register PERIOD_ADVANCE reducer + handler ─────────────────────
    reducerService.register(new PeriodAdvanceReducer());
    handlerService.register(new PeriodAdvanceHandler());

    // ── Step 3: schedule PERIOD_ADVANCE events for future year boundaries ──────
    for (const cc of countryCodes) {
      const periodType = _periodTypeFor(cc);
      for (const period of periodService.getAllPeriods()) {
        if (period.type === periodType && period.startMs > startTs) {
          const d = new Date(period.startMs);
          const schedDate = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
          const year = d.getUTCFullYear();
          serviceRegistry.eventService.createOneOffEvent({
            name:    `Period Advance ${cc} ${year}`,
            type:    'PERIOD_ADVANCE',
            date:    schedDate,
            data:    { cc, period },
            enabled: true,
          });
        }
      }
    }

    // ── Step 4: register account module reducers + handlers ───────────────────
    for (const cc of countryCodes) {
      const startYear     = new Date(currentPeriods[cc].startMs).getUTCFullYear();
      const accountModule = this._accountRulesEngine.get(cc, startYear);
      accountModule.createReducers(accountService).forEach(r => reducerService.register(r));
      accountModule.createHandlers().forEach(h => handlerService.register(h));
    }

    // ── Step 5: register dynamic tax reducers ──────────────────────────────────
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
        reducerService.register(new DynamicTaxReducer(this._taxEngine, cc, actionType));
      }
    }

    // ── Step 6: schedule TAX_SETTLE events at each period end ──────────────────
    for (const cc of countryCodes) {
      const periodType = _periodTypeFor(cc);
      for (const period of periodService.getAllPeriods()) {
        if (period.type === periodType && period.endMs > startTs) {
          const d       = new Date(period.endMs);
          const lastDay = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1);
          const year    = new Date(period.startMs).getUTCFullYear();
          serviceRegistry.eventService.createOneOffEvent({
            name:    `Tax Settle ${cc} ${year}`,
            type:    'TAX_SETTLE',
            date:    lastDay,
            data:    { cc },
            enabled: true,
          });
        }
      }
    }

    // ── Step 7: register TAX_SETTLE handler + TAX_SETTLE_APPLY + TAX_PAYMENT_DEBIT
    handlerService.register(new TaxSettleHandler());
    reducerService.register(new TaxSettleApplyReducer());
    reducerService.register(new TaxPaymentDebitReducer({ accountService }));

    // ── Step 8: register metric/balance reducers ───────────────────────────────
    const taxDebitReducer = new ArrayReducer('Tax Debit');
    taxDebitReducer.reducedActionTypes = ['RECORD_ARRAY_METRIC'];
    reducerService.register(taxDebitReducer);

    const balanceSnapshotReducer = new NoOpReducer('Balance Snapshot');
    balanceSnapshotReducer.reducedActionTypes = ['RECORD_BALANCE'];
    reducerService.register(balanceSnapshotReducer);

    return accountService;
  }

  /**
   * Phase 1 of the two-phase setup: state init + direct event scheduling.
   *
   * Resolves the starting period for each country, injects currentPeriods into
   * sim.state, and schedules PERIOD_ADVANCE and TAX_SETTLE events directly on
   * the simulation (no service layer).  Stores the resolved periods on this
   * instance for use by registerHandlersAndReducers().
   *
   * Call from buildSim() so that state and events are ready before any items
   * are wired through the service layer.
   *
   * @param {import('../simulation-framework/simulation.js').Simulation} sim
   * @param {string[]} countryCodes
   * @param {import('./period/period-service.js').PeriodService} periodService
   */
  setup(sim, countryCodes, periodService) {
    const startTs = sim.currentDate.getTime();

    // Resolve the starting period for each country and inject into sim.state.
    const currentPeriods = {};
    for (const cc of countryCodes) {
      const periodType = _periodTypeFor(cc);
      const current = periodService.getAllPeriods()
        .find(p => p.type === periodType && p.startMs <= startTs && startTs < p.endMs);
      if (!current) {
        throw new Error(
          `TaxService.setup: no '${periodType}' period found for start date ` +
          `${sim.currentDate.toISOString()} in PeriodService. ` +
          `Add the appropriate year via buildUsCalendarYear() or buildAuFiscalYear().`
        );
      }
      currentPeriods[cc] = current;
    }
    sim.state = { ...sim.state, currentPeriods };
    this._currentPeriods = currentPeriods;  // retained for registerHandlersAndReducers()

    // Schedule PERIOD_ADVANCE events directly on sim (no service layer).
    for (const cc of countryCodes) {
      const periodType = _periodTypeFor(cc);
      for (const period of periodService.getAllPeriods()) {
        if (period.type === periodType && period.startMs > startTs) {
          const d = new Date(period.startMs);
          const schedDate = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
          sim.schedule({ date: schedDate, type: 'PERIOD_ADVANCE', data: { cc, period } });
        }
      }
    }

    // Schedule TAX_SETTLE events directly on sim (no service layer).
    for (const cc of countryCodes) {
      const periodType = _periodTypeFor(cc);
      for (const period of periodService.getAllPeriods()) {
        if (period.type === periodType && period.endMs > startTs) {
          const d = new Date(period.endMs);
          const lastDay = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1);
          sim.schedule({ date: lastDay, type: 'TAX_SETTLE', data: { cc } });
        }
      }
    }
  }

  /**
   * Phase 2 of the two-phase setup: register handlers and reducers through the
   * service layer so they appear in the config graph and are serializable.
   *
   * Must be called after setup() (which populates this._currentPeriods).
   * Call from loadDefaults() — when a saved scenario is loaded,
   * ScenarioSerializer.load() restores the saved items instead of this method
   * creating fresh duplicates.
   *
   * @param {import('../services/service-registry.js').ServiceRegistry} serviceRegistry
   * @param {string[]} countryCodes
   */
  registerHandlersAndReducers(serviceRegistry, countryCodes) {
    const { reducerService, handlerService, accountService } = serviceRegistry;

    // PERIOD_ADVANCE reducer + handler
    reducerService.register(new PeriodAdvanceReducer());
    handlerService.register(new PeriodAdvanceHandler());

    // Account module reducers + handlers (static, start-year mechanics)
    for (const cc of countryCodes) {
      const startYear     = new Date(this._currentPeriods[cc].startMs).getUTCFullYear();
      const accountModule = this._accountRulesEngine.get(cc, startYear);
      accountModule.createReducers(accountService).forEach(r => reducerService.register(r));
      accountModule.createHandlers().forEach(h => handlerService.register(h));
    }

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
        reducerService.register(new DynamicTaxReducer(this._taxEngine, cc, actionType));
      }
    }

    // TAX_SETTLE handler + reducers
    handlerService.register(new TaxSettleHandler());
    reducerService.register(new TaxSettleApplyReducer());
    reducerService.register(new TaxPaymentDebitReducer({ accountService }));

    // Metric/balance reducers
    const taxDebitReducer = new ArrayReducer('Tax Debit');
    taxDebitReducer.reducedActionTypes = ['RECORD_ARRAY_METRIC'];
    reducerService.register(taxDebitReducer);

    const balanceSnapshotReducer = new NoOpReducer('Balance Snapshot');
    balanceSnapshotReducer.reducedActionTypes = ['RECORD_BALANCE'];
    reducerService.register(balanceSnapshotReducer);
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
