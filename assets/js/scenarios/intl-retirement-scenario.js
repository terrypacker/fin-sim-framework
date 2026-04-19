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
 * intl-retirement-scenario.js
 *
 * International two-person retirement simulation:
 *   - Two people (primary + spouse), US and AU citizens
 *   - Begin residing in the US; move to AU on Jul 1 of moveYear
 *   - Full account access regardless of residency status
 *   - Tax events computed at END of period (Dec 31 US / Jun 30 AU) via TAX_SETTLE
 *   - Monthly checking interest
 *   - Stock dividends: cash payout or reinvestment toggle
 *   - CHANGE_RESIDENCY event closes the partial US year before the move
 */

// ─── Default parameters ────────────────────────────────────────────────────────

export const DEFAULT_PARAMS = {
  // People
  primaryBirthDate: new Date(Date.UTC(1970, 3, 15)),
  spouseBirthDate:  new Date(Date.UTC(1972, 8, 22)),
  moveYear:         2031,            // calendar year of US→AU move (Jul 1)

  // Checking
  initialChecking:      30_000,
  checkingMinBalance:    3_000,
  checkingInterestRate:  0.03,

  // US accounts
  rothBalance:    80_000,  rothBasis:    60_000,
  iraBalance:    200_000,  iraBasis:    150_000,
  k401Balance:   300_000,  k401Basis:   200_000,
  stockBalance:  150_000,  stockBasis:   90_000,
  stockDividendRate: 0.02, stockDividendReinvest: false,
  fixedIncomeBalance:  80_000,
  fixedIncomeInterestRate: 0.04,

  // AU accounts
  auSavingsBalance:  50_000,  auSavingsInterestRate: 0.045,
  superBalance:     250_000,  superBasis:            180_000,
  auStockBalance:    60_000,  auStockBasis:           40_000,

  // Assets (not yet tracked as Asset objects — stored as plain balance fields)
  // Real property events can be scheduled manually for EVT-33/34.

  // Expenses
  monthlyExpenses: 6_000,
};

// ─── Recurring event series ────────────────────────────────────────────────────

// NOTE: earnings event types use INTL_ prefix to avoid colliding with the
// account module handlers (which also register for AU_SAVINGS_EARNINGS etc.
// and expect data.amount to be provided).
export const DEFAULT_EVENT_SERIES = [
  new FinSimLib.Scenarios.EventSeries({ id: 'expenses',         label: 'Monthly Expenses',          type: 'MONTHLY_EXPENSES',                 interval: 'monthly',  enabled: true,                color: '#F44336' }),
  new FinSimLib.Scenarios.EventSeries({ id: 'checkingInterest', label: 'Monthly Checking Interest', type: 'CHECKING_INTEREST_MONTHLY',        interval: 'monthly',  enabled: true,                color: '#00BCD4' }),
  new FinSimLib.Scenarios.EventSeries({ id: 'usDividends',      label: 'US Stock Dividends',        type: 'DIVIDEND_SCHEDULED',               interval: 'annually', enabled: true, startOffset: 1, color: '#4CAF50' }),
  new FinSimLib.Scenarios.EventSeries({ id: 'fixedIncome',      label: 'Fixed Income Interest',     type: 'INTL_FIXED_INCOME_INTEREST',       interval: 'annually', enabled: true, startOffset: 1, color: '#2196F3' }),
  new FinSimLib.Scenarios.EventSeries({ id: 'auSavings',        label: 'AU Savings Interest',       type: 'INTL_AU_SAVINGS_INTEREST',         interval: 'annually', enabled: true, startOffset: 1, color: '#FF9800' }),
  new FinSimLib.Scenarios.EventSeries({ id: 'superEarnings',    label: 'Super Earnings',            type: 'INTL_SUPER_EARNINGS',              interval: 'annually', enabled: true, startOffset: 1, color: '#9C27B0' }),
];

// ─── Scenario class ────────────────────────────────────────────────────────────

export class IntlRetirementScenario extends FinSimLib.Scenarios.BaseScenario {
  /**
   * @param {object} [opts]
   * @param {object}        [opts.params]       - Override DEFAULT_PARAMS
   * @param {EventSeries[]} [opts.eventSeries]  - Recurring event series
   * @param {Array}         [opts.customEvents] - One-off events [{type, date, data?}]
   */
  constructor({ params = {}, eventSeries = DEFAULT_EVENT_SERIES, customEvents = [] } = {}) {
    super({ eventSeries, customEvents });
    this.params   = { ...DEFAULT_PARAMS, ...params };
    this.simStart = new Date(Date.UTC(2026, 0, 1));
    this.simEnd   = new Date(Date.UTC(2041, 0, 1));
    this._buildSim();
  }

  _buildSim() {
    const p = this.params;

    // ── PeriodService: US calendar years 2026-2040, AU fiscal years 2025-2040
    const periodService = new FinSimLib.Finance.PeriodService();
    for (let y = 2026; y <= 2040; y++) FinSimLib.Finance.applyTo(periodService, FinSimLib.Finance.buildUsCalendarYear(y));
    for (let y = 2025; y <= 2040; y++) FinSimLib.Finance.applyTo(periodService, FinSimLib.Finance.buildAuFiscalYear(y));

    // ── Initial state
    const initialState = {
      metrics: {},

      // Canonical person records
      people: {
        primary: new FinSimLib.Finance.Person('primary', p.primaryBirthDate, { name: 'Primary', isAuResident: false }),
        spouse:  new FinSimLib.Finance.Person('spouse',  p.spouseBirthDate,  { name: 'Spouse',  isAuResident: false }),
      },
      // Flat compat fields read by account module handlers (kept in sync by CHANGE_RESIDENCY_APPLY)
      personBirthDate: p.primaryBirthDate,
      isAuResident:    false,

      // Checking (joint)
      checkingAccount: new FinSimLib.Finance.Account(p.initialChecking, { ownershipType: 'joint', minimumBalance: p.checkingMinBalance }),

      // US accounts
      rothAccount:        new FinSimLib.Finance.InvestmentAccount(p.rothBalance,         { contributionBasis: p.rothBasis  }),
      iraAccount:         new FinSimLib.Finance.InvestmentAccount(p.iraBalance,          { contributionBasis: p.iraBasis   }),
      k401Account:        new FinSimLib.Finance.InvestmentAccount(p.k401Balance,         { contributionBasis: p.k401Basis  }),
      stockAccount:       new FinSimLib.Finance.InvestmentAccount(p.stockBalance,        { contributionBasis: p.stockBasis }),
      fixedIncomeAccount: new FinSimLib.Finance.Account(p.fixedIncomeBalance),

      // AU accounts
      auSavingsAccount: new FinSimLib.Finance.Account(p.auSavingsBalance),
      superAccount:     new FinSimLib.Finance.InvestmentAccount(p.superBalance, { contributionBasis: p.superBasis }),
      auStockAccount:   new FinSimLib.Finance.InvestmentAccount(p.auStockBalance, { contributionBasis: p.auStockBasis }),

      // Drawdown order — ordered list of account keys for REPLENISH_CHECKING cascade
      drawdownOrder: [
        'fixedIncomeAccount',
        'stockAccount',
        'iraAccount',
        'k401Account',
        'rothAccount',
        'auSavingsAccount',
        'auStockAccount',
        'superAccount'
      ],

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

      // Blocked flags (may be set by handlers)
      superWithdrawalBlocked: false,
    };

    this.sim = new FinSimLib.Core.Simulation(this.simStart, { initialState });

    // ── Register TaxService (injects currentPeriods, schedules PERIOD_ADVANCE + TAX_SETTLE)
    this._accountService = new FinSimLib.Finance.TaxService().registerWith(this.sim, ['US', 'AU'], periodService);

    // ── Register scenario-level reducers
    this._registerReducers(p);

    // ── Register scenario-level handlers
    this._registerHandlers(p);

    // ── Schedule CHANGE_RESIDENCY (Jul 1 of moveYear)
    this.sim.schedule({
      date: new Date(Date.UTC(p.moveYear, 6, 1)),
      type: 'CHANGE_RESIDENCY',
      data: {},
    });

    // ── Schedule all recurring event series
    this._scheduleEvents();
  }

  _registerReducers(p) {
    const svc = this._accountService;

    // ── EXPENSE_DEBIT — capped at available balance ────────────────────────────
    this.sim.reducers.register('EXPENSE_DEBIT', (state, action, date) => {
      const debit = Math.min(action.amount, Math.max(0, state.checkingAccount.balance));
      if (debit > 0) svc.transaction(state.checkingAccount, -debit, date);
      return { ...state };
    }, FinSimLib.Core.PRIORITY.CASH_FLOW, 'Expense Debit');

    // ── REPLENISH_CHECKING — DFS cascade through drawdownOrder ────────────────
    // Withdraws from the first account in drawdownOrder that has a balance,
    // then chains to the next if still in deficit.
    // Note: some accounts (e.g. fixedIncomeAccount after FIXED_INCOME_EARNINGS_APPLY)
    // are plain { balance } objects, not full Account instances, so we mutate
    // balance directly instead of using svc.transaction.
    this.sim.reducers.register('REPLENISH_CHECKING', (state, action, date) => {
      const { deficit, orderIndex = 0 } = action;

      for (let i = orderIndex; i < state.drawdownOrder.length; i++) {
        const key     = state.drawdownOrder[i];
        const account = state[key];
        if (!account || account.balance <= 0) continue;

        const withdraw  = Math.min(deficit, account.balance);
        const remaining = deficit - withdraw;

        svc.transaction(state.checkingAccount, withdraw, date);
        account.balance -= withdraw;   // direct mutation; works for full Account and bare { balance }

        const newState = { ...state };
        if (remaining > 0) {
          return {
            state: newState,
            next: [{ type: 'REPLENISH_CHECKING', deficit: remaining, orderIndex: i + 1 }],
          };
        }
        return newState;
      }
      // No funds available — checking remains where it is
      return { ...state };
    }, FinSimLib.Core.PRIORITY.PRE_PROCESS, 'Replenish Checking');

    // ── CHECKING_INTEREST_CREDIT — monthly interest, US (and AU after move) ───
    this.sim.reducers.register('CHECKING_INTEREST_CREDIT', (state, action, date) => {
      svc.transaction(state.checkingAccount, action.amount, date);
      const usNext = state.usOrdinaryIncomeYTD + action.amount;
      const base   = { ...state, usOrdinaryIncomeYTD: usNext };
      if (state.isAuResident) {
        return {
          ...base,
          auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + action.amount,
          ftcYTD:              state.ftcYTD + action.amount,
        };
      }
      return base;
    }, FinSimLib.Core.PRIORITY.CASH_FLOW, 'Checking Interest Credit');

    // ── STOCK_DIVIDEND_CASH_APPLY — cash payout path ──────────────────────────
    // Credits checking + chains STOCK_DIVIDEND_TAX (same tax as reinvest path)
    this.sim.reducers.register('STOCK_DIVIDEND_CASH_APPLY', (state, action, date) => {
      const { amount, isAuResident } = action;
      svc.transaction(state.checkingAccount, amount, date);
      return {
        state: { ...state },
        next: [{ type: 'STOCK_DIVIDEND_TAX', amount, isAuResident }],
      };
    }, FinSimLib.Core.PRIORITY.CASH_FLOW, 'Stock Dividend Cash Apply');

    // ── CHANGE_RESIDENCY_APPLY — flip residency flags ─────────────────────────
    this.sim.reducers.register('CHANGE_RESIDENCY_APPLY', (state) => {
      // Snapshot balanceAtResidencyChange on all InvestmentAccounts
      const investmentKeys = ['rothAccount', 'iraAccount', 'k401Account',
                              'stockAccount', 'superAccount', 'auStockAccount'];
      for (const key of investmentKeys) {
        if (state[key]) svc.recordResidencyChange(state[key]);
      }

      // Update canonical person records + flat compat fields
      const primary = state.people?.primary
        ? { ...state.people.primary, isAuResident: true }
        : state.people?.primary;
      const spouse  = state.people?.spouse
        ? { ...state.people.spouse,  isAuResident: true }
        : state.people?.spouse;

      return {
        ...state,
        people: { primary, spouse },
        isAuResident: true,
      };
    }, FinSimLib.Core.PRIORITY.PRE_PROCESS, 'Change Residency Apply');
  }

  _registerHandlers(p) {
    // ── MONTHLY_EXPENSES ───────────────────────────────────────────────────────
    this.sim.register('MONTHLY_EXPENSES', new FinSimLib.Core.HandlerEntry(({ data, date, state }) => {
      const amount       = data?.amount ?? p.monthlyExpenses;
      const postDebitBal = state.checkingAccount.balance - amount;
      const deficit      = (state.checkingAccount.minimumBalance ?? 0) - postDebitBal;
      const actions      = [];
      if (deficit > 0) {
        actions.push({ type: 'REPLENISH_CHECKING', deficit, orderIndex: 0 });
      }
      actions.push(
        { type: 'EXPENSE_DEBIT', amount },
        new FinSimLib.Core.RecordMetricAction('monthly_expenses', amount),
        new FinSimLib.Core.RecordBalanceAction(),
      );
      return actions;
    }, 'Monthly Expenses'));

    // ── CHECKING_INTEREST_MONTHLY ──────────────────────────────────────────────
    this.sim.register('CHECKING_INTEREST_MONTHLY', new FinSimLib.Core.HandlerEntry(({ state }) => {
      const amount = +(state.checkingAccount.balance * p.checkingInterestRate / 12).toFixed(2);
      if (amount <= 0) return [new FinSimLib.Core.RecordBalanceAction()];
      return [
        { type: 'CHECKING_INTEREST_CREDIT', amount },
        new FinSimLib.Core.RecordMetricAction('checking_interest', amount),
        new FinSimLib.Core.RecordBalanceAction(),
      ];
    }, 'Monthly Checking Interest'));

    // ── DIVIDEND_SCHEDULED — bypass STOCK_DIVIDEND handler for payout toggle ──
    this.sim.register('DIVIDEND_SCHEDULED', new FinSimLib.Core.HandlerEntry(({ state, data }) => {
      const stockVal = state.stockAccount?.balance ?? 0;
      const amount   = +(stockVal * p.stockDividendRate).toFixed(2);
      if (amount <= 0) return [new FinSimLib.Core.RecordBalanceAction()];

      const reinvest    = data?.reinvest ?? p.stockDividendReinvest;
      const isAuResident = state.isAuResident;

      if (reinvest) {
        return [
          { type: 'STOCK_DIVIDEND_APPLY', amount, isAuResident },
          new FinSimLib.Core.RecordMetricAction('dividends', amount),
          new FinSimLib.Core.RecordBalanceAction(),
        ];
      } else {
        return [
          { type: 'STOCK_DIVIDEND_CASH_APPLY', amount, isAuResident },
          new FinSimLib.Core.RecordMetricAction('dividends', amount),
          new FinSimLib.Core.RecordBalanceAction(),
        ];
      }
    }, 'Dividend Scheduled'));

    // ── INTL_AU_SAVINGS_INTEREST — compute from balance × rate, emit APPLY ────
    this.sim.register('INTL_AU_SAVINGS_INTEREST', new FinSimLib.Core.HandlerEntry(({ state }) => {
      const amount = +(state.auSavingsAccount.balance * p.auSavingsInterestRate).toFixed(2);
      if (amount <= 0) return [new FinSimLib.Core.RecordBalanceAction()];
      return [
        { type: 'AU_SAVINGS_EARNINGS_APPLY', amount, isAuResident: state.isAuResident },
        new FinSimLib.Core.RecordMetricAction('au_savings_interest', amount),
        new FinSimLib.Core.RecordBalanceAction(),
      ];
    }, 'AU Savings Interest'));

    // ── INTL_FIXED_INCOME_INTEREST — compute from balance × rate, emit APPLY ─
    this.sim.register('INTL_FIXED_INCOME_INTEREST', new FinSimLib.Core.HandlerEntry(({ state }) => {
      const amount = +(state.fixedIncomeAccount.balance * p.fixedIncomeInterestRate).toFixed(2);
      if (amount <= 0) return [new FinSimLib.Core.RecordBalanceAction()];
      return [
        { type: 'FIXED_INCOME_EARNINGS_APPLY', amount, isAuResident: state.isAuResident },
        new FinSimLib.Core.RecordMetricAction('fixed_income_interest', amount),
        new FinSimLib.Core.RecordBalanceAction(),
      ];
    }, 'Fixed Income Interest'));

    // ── INTL_SUPER_EARNINGS — compute from balance × rate, emit APPLY ─────────
    this.sim.register('INTL_SUPER_EARNINGS', new FinSimLib.Core.HandlerEntry(({ state, data }) => {
      const rate   = data?.rate ?? 0.07;
      const amount = +(state.superAccount.balance * rate).toFixed(2);
      if (amount <= 0) return [new FinSimLib.Core.RecordBalanceAction()];
      return [
        { type: 'SUPER_EARNINGS_APPLY', amount },
        new FinSimLib.Core.RecordMetricAction('super_earnings', amount),
        new FinSimLib.Core.RecordBalanceAction(),
      ];
    }, 'Super Earnings'));

    // ── CHANGE_RESIDENCY — flip flags, close partial US year, log balance ─────
    // TAX_SETTLE_APPLY is a reducer (not a handler), so we emit it directly here
    // after computing the US tax from the pre-residency state.
    const _settleService = new FinSimLib.Finance.TaxSettleService();
    this.sim.register('CHANGE_RESIDENCY', new FinSimLib.Core.HandlerEntry(({ state }) => {
      const usTax = _settleService.computeUsTax(state);
      return [
        { type: 'CHANGE_RESIDENCY_APPLY' },
        { type: 'TAX_SETTLE_APPLY', cc: 'US', tax: usTax },
        new FinSimLib.Core.RecordBalanceAction(),
      ];
    }, 'Change Residency'));
  }
}
