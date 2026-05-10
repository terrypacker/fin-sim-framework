/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseScenario } from './base-scenario.js';
import { ServiceRegistry } from '../services/service-registry.js';
import { EventBuilder } from '../simulation-framework/builders/event-builder.js';
import { Person } from '../finance/person.js';
import { Account, USD, AUD } from '../finance/assets/account.js';
import { InvestmentAccount } from '../finance/assets/investment-account.js';
import { TaxService } from '../finance/tax-service.js';
import { PeriodService } from '../finance/period/period-service.js';
import { buildUsCalendarYear, buildAuFiscalYear, applyTo } from '../finance/period/period-builder.js';
import { UsSavingsInterestMonthlyHandler } from '../finance/handlers/us-savings-interest-handler.js';
import { MonthlyExpensesHandler } from '../finance/handlers/monthly-expenses-handler.js';
import { IntlTransferToUsHandler, IntlTransferToAuHandler } from '../finance/handlers/intl-transfer-handlers.js';
import {
  AuSavingsInterestHandler, FixedIncomeInterestHandler, SuperEarningsHandler,
  IntlRothEarningsHandler, IntlIraEarningsHandler, IntlK401EarningsHandler,
  IntlUsStockEarningsHandler, IntlAuStockEarningsHandler, IntlAuStockDividendHandler,
} from '../finance/handlers/earnings-handlers.js';
import { DividendScheduledHandler } from '../finance/handlers/dividend-scheduled-handler.js';
import { ChangeResidencyHandler } from '../finance/handlers/change-residency-handler.js';
import { OutOfFundsHandler } from '../finance/handlers/out-of-funds-handler.js';
import { MonthlyWagesHandler } from '../finance/handlers/monthly-wages-handler.js';
import { UsSavingsInterestCreditReducer } from '../finance/reducers/us-savings-interest-credit-reducer.js';
import { ExpenseDebitReducer } from '../finance/reducers/expense-debit-reducer.js';
import { ReplenishSavingsReducer } from '../finance/reducers/replenish-savings-reducer.js';
import { IntlTransferApplyReducer } from '../finance/reducers/intl-transfer-apply-reducer.js';
import { StockDividendCashApplyReducer } from '../finance/reducers/stock-dividend-cash-apply-reducer.js';
import { ChangeResidencyApplyReducer } from '../finance/reducers/change-residency-apply-reducer.js';
import { SetOutOfFundsDateReducer } from '../finance/reducers/set-out-of-funds-date-reducer.js';
import {
  ReducerBuilder
} from "../simulation-framework/builders/reducer-builder.js";
import {
  InternationalRetirementFinancialState
} from "../finance/state/intl-retirement-state.js";

/**
 * Default parameters for the International Retirement scenario.
 * Any field can be overridden via the params argument to buildSim().
 */
export const INTL_RETIREMENT_DEFAULTS = {
  // People
  primaryBirthDate:     new Date(Date.UTC(1978, 3, 15)),
  spouseBirthDate:      new Date(Date.UTC(1983, 8, 22)),
  primaryMonthlyWage:   8_000,
  spouseMonthlyWage:    4_000,
  primaryRetirementDate: new Date(Date.UTC(2040, 0, 1)),
  spouseRetirementDate:  new Date(Date.UTC(2040, 0, 1)),
  moveYear:             2031,  // calendar year of US→AU move (Jul 1)

  // US Savings (primary USD cash pool)
  initialUsSavings:     30_000,
  usSavingsMinBalance:   3_000,
  usSavingsInterestRate: 0.03,

  // US investment accounts
  rothBalance:   80_000,  rothBasis:   60_000,
  iraBalance:   200_000,  iraBasis:   150_000,
  k401Balance:  300_000,  k401Basis:  200_000,
  stockBalance: 150_000,  stockBasis:  90_000,
  stockDividendRate:    0.02,
  stockDividendReinvest: false,
  fixedIncomeBalance:   80_000,
  fixedIncomeInterestRate: 0.04,

  // US investment growth rates (annual, separate from dividends)
  rothGrowthRate:   0.07,
  iraGrowthRate:    0.07,
  k401GrowthRate:   0.07,
  usStockGrowthRate: 0.05,

  // AU accounts
  auSavingsBalance:     50_000,
  auSavingsMinBalance:   3_000,  auSavingsInterestRate: 0.045,
  superBalance:        250_000,  superBasis:           180_000,
  auStockBalance:       60_000,  auStockBasis:          40_000,
  auStockGrowthRate:   0.06,
  auStockDividendRate: 0.04,

  // International transfer
  exchangeRateUsdToAud: 1.55,  // 1 USD = 1.55 AUD
  intlTransferFeeUsd:   15,    // fixed fee per transfer in USD

  // Expenses (local currency: USD pre-move, AUD post-move)
  monthlyExpenses: 6_000,
};

/**
 * IntlRetirementScenario — International two-person retirement simulation.
 *
 * Two people (primary + spouse), US→AU migration on Jul 1 of moveYear.
 * Uses all framework finance handler/reducer classes registered via the
 * ServiceRegistry so the UI can inspect and serialize every component.
 *
 * ### Build phases
 *
 *   buildSim()      — builds initialState with accounts and people,
 *                     registers the Simulation, wires TaxService,
 *                     and schedules the one-off CHANGE_RESIDENCY event.
 *
 *   loadDefaults()  — populates all services with people, accounts,
 *                     events, handlers, and reducers via service factories
 *                     so every item appears in the config graph and UI.
 */
export class IntlRetirementScenario extends BaseScenario {
  constructor({ context, params, simStart, simEnd } = {}) {
    super({
      context,
      params,
      simStart: simStart ?? new Date(Date.UTC(2026, 0, 1)),
      simEnd:   simEnd ?? new Date(Date.UTC(2041, 0, 1)),
    });
    // Populated in buildSim(); consumed in loadDefaults().
    this._people      = null;
    this._accounts    = null;
    this._params      = null;
    this._taxService  = null;
  }

  /**
   * Build the scenario-specific default initial state.
   * Called by BaseScenario.buildSim() when no saved initialState is provided.
   * Constructs all domain objects (people, accounts) from params and stores
   * them on `this._people` / `this._accounts` so loadDefaults() can use them.
   */
  buildDefaultInitialState(params) {
    const p = { ...INTL_RETIREMENT_DEFAULTS, ...(params ?? {}) };
    this._params = p;

    // ── People ────────────────────────────────────────────────────────────────
    const primary = new Person('primary', p.primaryBirthDate, {
      name: 'Primary', citizen: ['US'],
      monthlyWage:    p.primaryMonthlyWage,
      retirementDate: p.primaryRetirementDate,
    });
    const spouse  = new Person('spouse',  p.spouseBirthDate,  {
      name: 'Spouse',  citizen: ['US'],
      monthlyWage:    p.spouseMonthlyWage,
      retirementDate: p.spouseRetirementDate,
    });

    // ── US accounts ───────────────────────────────────────────────────────────
    const usSavingsAccount = new Account(p.initialUsSavings, {
      name:          'US Savings',
      ownershipType: 'joint',
      minimumBalance: p.usSavingsMinBalance,
      country:       'US',
      currency:      USD,
    });
    const fixedIncomeAccount = new Account(p.fixedIncomeBalance, {
      name:             'Fixed Income',
      country:          'US',
      currency:         USD,
      ownerId:          primary.id,
      drawdownPriority: 1,
    });
    const stockAccount = new InvestmentAccount(p.stockBalance, {
      name:             'US Stock',
      contributionBasis: p.stockBasis,
      country:          'US',
      currency:         USD,
      ownerId:          primary.id,
      drawdownPriority: 2,
    });
    const iraAccount = new InvestmentAccount(p.iraBalance, {
      name:             'Traditional IRA',
      contributionBasis: p.iraBasis,
      country:          'US',
      currency:         USD,
      ownerId:          primary.id,
      drawdownPriority: 3,
      minimumAge:       59.5,
    });
    const k401Account = new InvestmentAccount(p.k401Balance, {
      name:             '401(k)',
      contributionBasis: p.k401Basis,
      country:          'US',
      currency:         USD,
      ownerId:          primary.id,
      drawdownPriority: 4,
      minimumAge:       59.5,
    });
    const rothAccount = new InvestmentAccount(p.rothBalance, {
      name:             'Roth IRA',
      contributionBasis: p.rothBasis,
      country:          'US',
      currency:         USD,
      ownerId:          primary.id,
      drawdownPriority: 5,
      minimumAge:       59.5,
    });

    // ── AU accounts ───────────────────────────────────────────────────────────
    const auSavingsAccount = new Account(p.auSavingsBalance, {
      name:     'AU Savings',
      country:  'AU',
      minimumBalance: p.auSavingsMinBalance,
      currency: AUD,
    });
    const auStockAccount = new InvestmentAccount(p.auStockBalance, {
      name:             'AU Stock',
      contributionBasis: p.auStockBasis,
      country:          'AU',
      currency:         AUD,
      ownerId:          primary.id,
      drawdownPriority: 1,
    });
    const superAccount = new InvestmentAccount(p.superBalance, {
      name:             'Superannuation',
      contributionBasis: p.superBasis,
      country:          'AU',
      currency:         AUD,
      ownerId:          primary.id,
      drawdownPriority: 2,
      minimumAge:       60,
    });

    // ── Store for loadDefaults() ──────────────────────────────────────────────
    this._people = { primary, spouse };
    this._accounts = {
      usSavingsAccount, fixedIncomeAccount, stockAccount,
      iraAccount, k401Account, rothAccount,
      auSavingsAccount, auStockAccount, superAccount,
    };

    return new InternationalRetirementFinancialState({
      primary, spouse,
      usSavingsAccount, fixedIncomeAccount, stockAccount,
      iraAccount, k401Account, rothAccount,
      auSavingsAccount, auStockAccount, superAccount,
      exchangeRateUsdToAud: p.exchangeRateUsdToAud,
      intlTransferFeeUsd:   p.intlTransferFeeUsd,
    });
  }

  /**
   * Register the simulation and wire TaxService.
   * Overrides BaseScenario.buildSim() only to add TaxService setup after the
   * simulation is created (TaxService needs this.sim).
   * The initialState is provided via buildDefaultInitialState() when absent.
   *
   * The problem with moving this logic to loadDefaults() is that loadDefaults() is only called
   *   for fresh scenarios. When a saved config is loaded, afterBuildSim() calls ScenarioSerializer.deserialize()
   *   instead — loadDefaults() is never reached. The currentPeriods injection would be skipped and the dynamic
   *   tax reducers would have nothing to read.
   *
   *   Fresh scenario:  buildSim() → afterBuildSim() → loadDefaults()      ✓ setup() runs
   *   Saved scenario:  buildSim() → afterBuildSim() → deserialize()        ✗ setup() never runs
   */
  buildSim() {
    super.buildSim();

    // ── Wire TaxService — phase 1: state init + direct event scheduling.
    //    Handlers/reducers are registered in loadDefaults() (phase 2) so that
    //    loading a saved config restores the serialized items instead of
    //    creating a duplicate set here.
    const startYear = this.simStart.getFullYear();
    const endYear = this.simEnd.getFullYear();
    const periodService = new PeriodService();
    for (let y = startYear; y <= endYear; y++) applyTo(periodService, buildUsCalendarYear(y));
    //Start AU the year before so 1st period ends in first year
    for (let y = startYear - 1; y <= endYear; y++) applyTo(periodService, buildAuFiscalYear(y));
    this._taxService = new TaxService();
    this._taxService.setup(this.sim, ['US', 'AU'], periodService);
  }

  /**
   * Populate all services with people, accounts, events, handlers, and reducers.
   * Called by ScenarioTabPresenter.afterBuildSim() when no saved config exists.
   */
  loadDefaults() {
    const { eventService, handlerService, reducerService, accountService, personService } = ServiceRegistry.getInstance();
    const p = this._params;

    // ── TaxService phase 2: register handlers/reducers through the service layer
    this._taxService.registerHandlersAndReducers(ServiceRegistry.getInstance(), ['US', 'AU']);

    // ── People ────────────────────────────────────────────────────────────────
    personService.register(this._people.primary);
    personService.register(this._people.spouse);

    // ── Accounts ──────────────────────────────────────────────────────────────
    for (const account of Object.values(this._accounts)) {
      accountService.createAccount(account);
    }

    // ── Schedule one-off CHANGE_RESIDENCY (Jul 1 of moveYear) ────────────────
    // Registered through EventService so it gets an ID visible in the config graph.
    const moveYearEvent = eventService.createOneOffEvent({
      name:    'Change Residency',
      type:    'CHANGE_RESIDENCY',
      date:    new Date(Date.UTC(p.moveYear, 6, 1)),
      data:    {},
      enabled: true,
    });

    // ── Recurring event series ────────────────────────────────────────────────
    const expensesEvent = EventBuilder.eventSeries()
      .name('Monthly Expenses').type('MONTHLY_EXPENSES')
      .interval('month-end').enabled(true).color('#F44336').build();
    eventService.register(expensesEvent);

    const wagesEvent = EventBuilder.eventSeries()
      .name('Monthly Wages').type('MONTHLY_WAGES')
      .interval('month-end').enabled(true).color('#4CAF50').build();
    eventService.register(wagesEvent);

    const usSavingsIntEvent = EventBuilder.eventSeries()
      .name('Monthly US Savings Interest').type('US_SAVINGS_INTEREST_MONTHLY')
      .interval('month-end').enabled(true).color('#00BCD4').build();
    eventService.register(usSavingsIntEvent);

    const dividendsEvent = EventBuilder.eventSeries()
      .name('US Stock Dividends').type('DIVIDEND_SCHEDULED')
      .interval('year-end').startOffset(1).enabled(true).color('#4CAF50').build();
    eventService.register(dividendsEvent);

    const fixedIncomeEvent = EventBuilder.eventSeries()
      .name('Fixed Income Interest').type('INTL_FIXED_INCOME_INTEREST')
      .interval('year-end').startOffset(1).enabled(true).color('#2196F3').build();
    eventService.register(fixedIncomeEvent);

    const auSavingsEvent = EventBuilder.eventSeries()
      .name('AU Savings Interest').type('INTL_AU_SAVINGS_INTEREST')
      .interval('year-end').startOffset(1).enabled(true).color('#FF9800').build();
    eventService.register(auSavingsEvent);

    const superEvent = EventBuilder.eventSeries()
      .name('Super Earnings').type('INTL_SUPER_EARNINGS')
      .interval('year-end').startOffset(1).enabled(true).color('#9C27B0').build();
    eventService.register(superEvent);

    const rothEarningsEvent = EventBuilder.eventSeries()
      .name('Roth IRA Earnings').type('INTL_ROTH_EARNINGS')
      .interval('year-end').startOffset(1).enabled(true).color('#7E57C2').build();
    eventService.register(rothEarningsEvent);

    const iraEarningsEvent = EventBuilder.eventSeries()
      .name('IRA Earnings').type('INTL_IRA_EARNINGS')
      .interval('year-end').startOffset(1).enabled(true).color('#5C6BC0').build();
    eventService.register(iraEarningsEvent);

    const k401EarningsEvent = EventBuilder.eventSeries()
      .name('401k Earnings').type('INTL_K401_EARNINGS')
      .interval('year-end').startOffset(1).enabled(true).color('#42A5F5').build();
    eventService.register(k401EarningsEvent);

    const usStockEarningsEvent = EventBuilder.eventSeries()
      .name('US Stock Earnings').type('INTL_STOCK_EARNINGS')
      .interval('year-end').startOffset(1).enabled(true).color('#26A69A').build();
    eventService.register(usStockEarningsEvent);

    const auStockEarningsEvent = EventBuilder.eventSeries()
      .name('AU Stock Earnings').type('INTL_AU_STOCK_EARNINGS')
      .interval('year-end').startOffset(1).enabled(true).color('#66BB6A').build();
    eventService.register(auStockEarningsEvent);

    const auStockDividendEvent = EventBuilder.eventSeries()
      .name('AU Stock Dividend').type('INTL_AU_STOCK_DIVIDEND')
      .interval('year-end').startOffset(1).enabled(true).color('#FFA726').build();
    eventService.register(auStockDividendEvent);

    // ── Handlers ──────────────────────────────────────────────────────────────

    const expensesHandler = new MonthlyExpensesHandler({
      monthlyExpenses: p.monthlyExpenses,
    });
    expensesHandler.handledEvents.push(expensesEvent);
    handlerService.register(expensesHandler);

    const wagesHandler = new MonthlyWagesHandler();
    wagesHandler.handledEvents.push(wagesEvent);
    handlerService.register(wagesHandler);

    const usSavingsIntHandler = new UsSavingsInterestMonthlyHandler({
      interestRate: p.usSavingsInterestRate,
    });
    usSavingsIntHandler.handledEvents.push(usSavingsIntEvent);
    handlerService.register(usSavingsIntHandler);

    const dividendHandler = new DividendScheduledHandler({
      dividendRate: p.stockDividendRate,
      reinvest:     p.stockDividendReinvest,
    });
    dividendHandler.handledEvents.push(dividendsEvent);
    handlerService.register(dividendHandler);

    const fixedIncomeHandler = new FixedIncomeInterestHandler({
      interestRate: p.fixedIncomeInterestRate,
    });
    fixedIncomeHandler.handledEvents.push(fixedIncomeEvent);
    handlerService.register(fixedIncomeHandler);

    const auSavingsHandler = new AuSavingsInterestHandler({
      interestRate: p.auSavingsInterestRate,
    });
    auSavingsHandler.handledEvents.push(auSavingsEvent);
    handlerService.register(auSavingsHandler);

    const superHandler = new SuperEarningsHandler();
    superHandler.handledEvents.push(superEvent);
    handlerService.register(superHandler);

    const rothEarningsHandler = new IntlRothEarningsHandler({ growthRate: p.rothGrowthRate });
    rothEarningsHandler.handledEvents.push(rothEarningsEvent);
    handlerService.register(rothEarningsHandler);

    const iraEarningsHandler = new IntlIraEarningsHandler({ growthRate: p.iraGrowthRate });
    iraEarningsHandler.handledEvents.push(iraEarningsEvent);
    handlerService.register(iraEarningsHandler);

    const k401EarningsHandler = new IntlK401EarningsHandler({ growthRate: p.k401GrowthRate });
    k401EarningsHandler.handledEvents.push(k401EarningsEvent);
    handlerService.register(k401EarningsHandler);

    const usStockEarningsHandler = new IntlUsStockEarningsHandler({ growthRate: p.usStockGrowthRate });
    usStockEarningsHandler.handledEvents.push(usStockEarningsEvent);
    handlerService.register(usStockEarningsHandler);

    const auStockEarningsHandler = new IntlAuStockEarningsHandler({ growthRate: p.auStockGrowthRate });
    auStockEarningsHandler.handledEvents.push(auStockEarningsEvent);
    handlerService.register(auStockEarningsHandler);

    const auStockDividendHandler = new IntlAuStockDividendHandler({ dividendRate: p.auStockDividendRate });
    auStockDividendHandler.handledEvents.push(auStockDividendEvent);
    handlerService.register(auStockDividendHandler);

    // User-triggered transfer handlers (no event series — fired on-demand)
    const intlToUsHandler = new IntlTransferToUsHandler();
    handlerService.register(intlToUsHandler);

    const intlToAuHandler = new IntlTransferToAuHandler();
    handlerService.register(intlToAuHandler);

    // CHANGE_RESIDENCY is scheduled directly in buildSim() (one-off)
    const changeResidencyHandler = new ChangeResidencyHandler();
    changeResidencyHandler.handledEvents.push(moveYearEvent);
    handlerService.register(changeResidencyHandler);

    // OUT_OF_FUNDS is fired by reducers when all sources are exhausted
    const outOfFundsHandler = new OutOfFundsHandler();
    handlerService.register(outOfFundsHandler);

    // ── Reducers ──────────────────────────────────────────────────────────────
    const { accountService: svc } = ServiceRegistry.getInstance();

    const recordMetricReducer = ReducerBuilder.metric(null).reduceActionType('RECORD_METRIC').build();
    reducerService.register(recordMetricReducer);

    const expenseDebitReducer = new ExpenseDebitReducer({ accountService: svc });
    reducerService.register(expenseDebitReducer);

    const replenishReducer = new ReplenishSavingsReducer({ accountService: svc });
    reducerService.register(replenishReducer);

    const intlTransferReducer = new IntlTransferApplyReducer({ accountService: svc });
    reducerService.register(intlTransferReducer);

    const usSavingsIntCreditReducer = new UsSavingsInterestCreditReducer({ accountService: svc });
    reducerService.register(usSavingsIntCreditReducer);

    const stockDividendCashReducer = new StockDividendCashApplyReducer({ accountService: svc });
    reducerService.register(stockDividendCashReducer);

    const changeResidencyApplyReducer = new ChangeResidencyApplyReducer({ accountService: svc });
    reducerService.register(changeResidencyApplyReducer);

    const setOutOfFundsDateReducer = new SetOutOfFundsDateReducer();
    reducerService.register(setOutOfFundsDateReducer);
  }
}
