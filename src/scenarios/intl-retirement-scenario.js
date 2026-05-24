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
import { Account, USD, AUD } from '../finance/account.js';
import { InvestmentAccount } from '../finance/investment-account.js';
import { TaxService } from '../finance/tax-service.js';
import { PeriodService } from '../finance/period/period-service.js';
import { buildUsCalendarYear, buildAuFiscalYear, applyTo } from '../finance/period/period-builder.js';
import { UsSavingsInterestMonthlyHandler } from '../finance/handlers/us-savings-interest-handler.js';
import { MonthlyExpensesHandler } from '../finance/handlers/monthly-expenses-handler.js';
import { IntlTransferToUsHandler, IntlTransferToAuHandler } from '../finance/handlers/intl-transfer-handlers.js';
import { AuSavingsInterestHandler, FixedIncomeInterestHandler, SuperEarningsHandler } from '../finance/handlers/earnings-handlers.js';
import { DividendScheduledHandler } from '../finance/handlers/dividend-scheduled-handler.js';
import { ChangeResidencyHandler } from '../finance/handlers/change-residency-handler.js';
import { OutOfFundsHandler } from '../finance/handlers/out-of-funds-handler.js';
import { UsSavingsInterestCreditReducer } from '../finance/reducers/us-savings-interest-credit-reducer.js';
import { ExpenseDebitReducer } from '../finance/reducers/expense-debit-reducer.js';
import { ReplenishSavingsReducer } from '../finance/reducers/replenish-savings-reducer.js';
import { IntlTransferApplyReducer } from '../finance/reducers/intl-transfer-apply-reducer.js';
import { StockDividendCashApplyReducer } from '../finance/reducers/stock-dividend-cash-apply-reducer.js';
import { ChangeResidencyApplyReducer } from '../finance/reducers/change-residency-apply-reducer.js';
import { SetOutOfFundsDateReducer } from '../finance/reducers/set-out-of-funds-date-reducer.js';

/**
 * Default parameters for the International Retirement scenario.
 * Any field can be overridden via the params argument to buildSim().
 */
export const INTL_RETIREMENT_DEFAULTS = {
  // People
  primaryBirthDate: new Date(Date.UTC(1978, 3, 15)),
  spouseBirthDate:  new Date(Date.UTC(1983, 8, 22)),
  moveYear:         2031,  // calendar year of US→AU move (Jul 1)

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

  // AU accounts
  auSavingsBalance:     50_000,  auSavingsInterestRate: 0.045,
  superBalance:        250_000,  superBasis:           180_000,
  auStockBalance:       60_000,  auStockBasis:          40_000,

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
  constructor({ eventSchedulerUI } = {}) {
    super({
      eventSchedulerUI,
      simStart: new Date(Date.UTC(2026, 0, 1)),
      simEnd:   new Date(Date.UTC(2041, 0, 1)),
    });
    // Populated in buildSim(); consumed in loadDefaults().
    this._people   = null;
    this._accounts = null;
    this._params   = null;
  }

  /**
   * Construct the initialState and register the Simulation.
   * Overrides BaseScenario.buildSim() to supply scenario-specific state.
   */
  buildSim(params) {
    const p = { ...INTL_RETIREMENT_DEFAULTS, ...(params ?? {}) };
    this._params = p;

    // ── People ────────────────────────────────────────────────────────────────
    const primary = new Person('primary', p.primaryBirthDate, { name: 'Primary', citizen: ['US'] });
    const spouse  = new Person('spouse',  p.spouseBirthDate,  { name: 'Spouse',  citizen: ['US'] });

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

    // ── Initial state ─────────────────────────────────────────────────────────
    const initialState = {
      metrics: {},
      people:  { primary, spouse },
      personBirthDate: p.primaryBirthDate,
      isAuResident:    false,

      // Accounts
      usSavingsAccount, fixedIncomeAccount, stockAccount,
      iraAccount, k401Account, rothAccount,
      auSavingsAccount, auStockAccount, superAccount,

      // Exchange rate / transfer fee
      exchangeRateUsdToAud: p.exchangeRateUsdToAud,
      intlTransferFeeUsd:   p.intlTransferFeeUsd,

      // YTD tax accumulators
      usOrdinaryIncomeYTD:         0,
      usNegativeIncomeYTD:         0,
      usCapitalGainsYTD:           0,
      usPenaltyYTD:                0,
      auOrdinaryIncomeYTD:         0,
      auCapitalGainsYTD:           0,
      auNonResidentWithholdingYTD: 0,
      auSuperTaxYTD:               0,
      auFrankingCreditYTD:         0,
      ftcYTD:                      0,

      superWithdrawalBlocked: false,
      outOfFundsDate:         null,
    };

    // ── Register simulation ───────────────────────────────────────────────────
    super.buildSim(params, initialState);

    // ── Wire TaxService (registers PERIOD_ADVANCE, TAX_SETTLE, account modules)
    const periodService = new PeriodService();
    for (let y = 2026; y <= 2041; y++) applyTo(periodService, buildUsCalendarYear(y));
    for (let y = 2025; y <= 2041; y++) applyTo(periodService, buildAuFiscalYear(y));
    new TaxService().registerWith(this.sim, ['US', 'AU'], periodService);

    // ── Schedule one-off CHANGE_RESIDENCY (Jul 1 of moveYear) ────────────────
    // This is wired via the sim directly; its handler is created in loadDefaults().
    this.sim.schedule({
      date: new Date(Date.UTC(p.moveYear, 6, 1)),
      type: 'CHANGE_RESIDENCY',
      data: {},
    });
  }

  /**
   * Populate all services with people, accounts, events, handlers, and reducers.
   * Called by ScenarioTabPresenter.afterBuildSim() when no saved config exists.
   */
  loadDefaults() {
    const { eventService, handlerService, reducerService, accountService, personService } = ServiceRegistry.getInstance();
    const p = this._params;

    // ── People ────────────────────────────────────────────────────────────────
    personService.register(this._people.primary);
    personService.register(this._people.spouse);

    // ── Accounts ──────────────────────────────────────────────────────────────
    for (const account of Object.values(this._accounts)) {
      accountService.createAccount(account);
    }

    // ── Recurring event series ────────────────────────────────────────────────
    const expensesEvent = EventBuilder.eventSeries()
      .name('Monthly Expenses').type('MONTHLY_EXPENSES')
      .interval('month-end').enabled(true).color('#F44336').build();
    eventService.register(expensesEvent);

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

    const taxEvent = EventBuilder.eventSeries()
      .name('Annual Tax Filing').type('ANNUAL_TAX')
      .interval('year-end').startOffset(1).enabled(true).color('#FF5722').build();
    eventService.register(taxEvent);

    // ── Handlers ──────────────────────────────────────────────────────────────

    const expensesHandler = new MonthlyExpensesHandler({
      monthlyExpenses: p.monthlyExpenses,
    });
    expensesHandler.handledEvents.push(expensesEvent);
    handlerService.register(expensesHandler);

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

    // User-triggered transfer handlers (no event series — fired on-demand)
    const intlToUsHandler = new IntlTransferToUsHandler();
    handlerService.register(intlToUsHandler);

    const intlToAuHandler = new IntlTransferToAuHandler();
    handlerService.register(intlToAuHandler);

    // CHANGE_RESIDENCY is scheduled directly in buildSim() (one-off)
    const changeResidencyHandler = new ChangeResidencyHandler();
    handlerService.register(changeResidencyHandler);

    // OUT_OF_FUNDS is fired by reducers when all sources are exhausted
    const outOfFundsHandler = new OutOfFundsHandler();
    handlerService.register(outOfFundsHandler);

    // ── Reducers ──────────────────────────────────────────────────────────────
    const { accountService: svc } = ServiceRegistry.getInstance();

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
