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
 *   - US expenses come from usSavingsAccount (USD); AU expenses from auSavingsAccount (AUD)
 *   - Domestic drawdown cascade exhausts local investment accounts before triggering
 *     an international transfer with exchange rate conversion and fixed fee
 *   - Tax events computed at END of period (Dec 31 US / Jun 30 AU) via TAX_SETTLE
 *   - Monthly US savings interest
 *   - Stock dividends: cash payout or reinvestment toggle
 *   - CHANGE_RESIDENCY event closes the partial US year before the move
 */

// ─── Default parameters ────────────────────────────────────────────────────────

export const DEFAULT_PARAMS = {
  // People
  primaryBirthDate: new Date(Date.UTC(1978, 3, 15)),
  spouseBirthDate:  new Date(Date.UTC(1983, 8, 22)),
  moveYear:         2031,            // calendar year of US→AU move (Jul 1)

  // US Savings (primary USD cash pool)
  initialUsSavings:      30_000,
  usSavingsMinBalance:    3_000,
  usSavingsInterestRate:  0.03,

  // US investment accounts
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

  // International transfer
  exchangeRateUsdToAud: 1.55,   // 1 USD = 1.55 AUD
  intlTransferFeeUsd:   15,     // fixed fee per transfer, in USD

  // Expenses (in local currency: USD pre-move, AUD post-move)
  monthlyExpenses: 6_000,
};

// ─── Recurring event series ────────────────────────────────────────────────────

// NOTE: earnings event types use INTL_ prefix to avoid colliding with the
// account module handlers (which also register for AU_SAVINGS_EARNINGS etc.
// and expect data.amount to be provided).
export const DEFAULT_EVENT_SERIES = [
  new FinSimLib.Scenarios.EventSeries({ id: 'expenses',         label: 'Monthly Expenses',          type: 'MONTHLY_EXPENSES',                 interval: 'month-end', enabled: true,                color: '#F44336' }),
  new FinSimLib.Scenarios.EventSeries({ id: 'usSavingsInt',     label: 'Monthly US Savings Interest',type: 'US_SAVINGS_INTEREST_MONTHLY',      interval: 'month-end', enabled: true,                color: '#00BCD4' }),
  new FinSimLib.Scenarios.EventSeries({ id: 'usDividends',      label: 'US Stock Dividends',        type: 'DIVIDEND_SCHEDULED',               interval: 'year-end',  enabled: true, startOffset: 1, color: '#4CAF50' }),
  new FinSimLib.Scenarios.EventSeries({ id: 'fixedIncome',      label: 'Fixed Income Interest',     type: 'INTL_FIXED_INCOME_INTEREST',       interval: 'year-end',  enabled: true, startOffset: 1, color: '#2196F3' }),
  new FinSimLib.Scenarios.EventSeries({ id: 'auSavings',        label: 'AU Savings Interest',       type: 'INTL_AU_SAVINGS_INTEREST',         interval: 'year-end',  enabled: true, startOffset: 1, color: '#FF9800' }),
  new FinSimLib.Scenarios.EventSeries({ id: 'superEarnings',    label: 'Super Earnings',            type: 'INTL_SUPER_EARNINGS',              interval: 'year-end',  enabled: true, startOffset: 1, color: '#9C27B0' }),
  new FinSimLib.Scenarios.EventSeries({ id: 'tax',              label: 'Annual Tax Filing',         type: 'ANNUAL_TAX',                       interval: 'year-end',  enabled: true, startOffset: 1, color: '#FF5722' }),
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
    const p   = this.params;
    const USD = FinSimLib.Finance.USD;
    const AUD = FinSimLib.Finance.AUD;

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

      // US Savings — primary USD cash pool (replaces checkingAccount)
      usSavingsAccount: new FinSimLib.Finance.Account(p.initialUsSavings, {
        ownershipType: 'joint',
        minimumBalance: p.usSavingsMinBalance,
        country:  'US',
        currency: USD,
      }),

      // US investment accounts
      rothAccount:        new FinSimLib.Finance.InvestmentAccount(p.rothBalance,         { contributionBasis: p.rothBasis,  country: 'US', currency: USD }),
      iraAccount:         new FinSimLib.Finance.InvestmentAccount(p.iraBalance,          { contributionBasis: p.iraBasis,   country: 'US', currency: USD }),
      k401Account:        new FinSimLib.Finance.InvestmentAccount(p.k401Balance,         { contributionBasis: p.k401Basis,  country: 'US', currency: USD }),
      stockAccount:       new FinSimLib.Finance.InvestmentAccount(p.stockBalance,        { contributionBasis: p.stockBasis, country: 'US', currency: USD }),
      fixedIncomeAccount: new FinSimLib.Finance.Account(p.fixedIncomeBalance,            { country: 'US', currency: USD }),

      // AU accounts — auSavingsAccount is the primary AUD cash pool
      auSavingsAccount: new FinSimLib.Finance.Account(p.auSavingsBalance, {
        country:  'AU',
        currency: AUD,
      }),
      superAccount:   new FinSimLib.Finance.InvestmentAccount(p.superBalance,   { contributionBasis: p.superBasis,   country: 'AU', currency: AUD }),
      auStockAccount: new FinSimLib.Finance.InvestmentAccount(p.auStockBalance, { contributionBasis: p.auStockBasis, country: 'AU', currency: AUD }),

      // Drawdown orders — domestic investment accounts only (not the savings accounts themselves).
      // Each entry is either a plain string key or { key, minAge } where minAge (in years)
      // gates early withdrawal; REPLENISH_SAVINGS skips the account until the age is met.
      usDrawdownOrder: [
        { key: 'fixedIncomeAccount' },
        { key: 'stockAccount' },
        { key: 'iraAccount',  minAge: 59.5 },
        { key: 'k401Account', minAge: 59.5 },
        { key: 'rothAccount', minAge: 59.5 },
      ],
      auDrawdownOrder: [
        { key: 'auStockAccount' },
        { key: 'superAccount', minAge: 60 },
      ],

      // Exchange rate and transfer fee
      exchangeRateUsdToAud: p.exchangeRateUsdToAud,   // 1 USD = N AUD
      intlTransferFeeUsd:   p.intlTransferFeeUsd,      // fixed fee in USD

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

    // ── EXPENSE_DEBIT — residence-aware: USD pre-move, AUD post-move ───────────
    this.sim.reducers.register('EXPENSE_DEBIT', (state, action, date) => {
      const account = state.isAuResident ? state.auSavingsAccount : state.usSavingsAccount;
      const debit   = Math.min(action.amount, Math.max(0, account.balance));
      if (debit > 0) svc.transaction(account, -debit, date);
      return { ...state };
    }, FinSimLib.Core.PRIORITY.CASH_FLOW, 'Expense Debit');

    // ── REPLENISH_SAVINGS — cascades through the domestic drawdown order,
    //    then crosses to the other country via INTL_TRANSFER_APPLY if exhausted.
    //    targetKey: 'usSavingsAccount' | 'auSavingsAccount'
    this.sim.reducers.register('REPLENISH_SAVINGS', (state, action, date) => {
      const { deficit, targetKey, orderIndex = 0 } = action;
      const isAu        = targetKey === 'auSavingsAccount';
      const drawdown    = isAu ? state.auDrawdownOrder : state.usDrawdownOrder;

      // Compute person's age in whole years as of this date for minAge checks.
      const bd  = state.personBirthDate;
      const yrs = date.getUTCFullYear() - bd.getUTCFullYear();
      const hadBirthday = date.getUTCMonth() > bd.getUTCMonth() ||
        (date.getUTCMonth() === bd.getUTCMonth() && date.getUTCDate() >= bd.getUTCDate());
      const personAge = hadBirthday ? yrs : yrs - 1;

      for (let i = orderIndex; i < drawdown.length; i++) {
        const entry   = drawdown[i];
        const key     = typeof entry === 'string' ? entry : entry.key;
        const minAge  = typeof entry === 'string' ? 0    : (entry.minAge ?? 0);
        const account = state[key];
        if (!account || account.balance <= 0) continue;
        if (minAge > 0 && personAge < minAge) continue;

        const withdraw  = Math.min(deficit, account.balance);
        const remaining = deficit - withdraw;

        svc.transaction(state[targetKey], withdraw, date);
        account.balance -= withdraw;

        const newState = { ...state };
        if (remaining > 0) {
          return {
            state: newState,
            next: [{ type: 'REPLENISH_SAVINGS', deficit: remaining, targetKey, orderIndex: i + 1 }],
          };
        }
        return newState;
      }

      // Domestic accounts exhausted — trigger international transfer
      if (deficit > 0) {
        return {
          state: { ...state },
          next: [{
            type:      'INTL_TRANSFER_APPLY',
            direction: isAu ? 'US_TO_AU' : 'AU_TO_US',
            // For AU_TO_US: we need `deficit` USD net of fee; compute AUD to withdraw
            // For US_TO_AU: we need `deficit` AUD net of fee; compute USD to withdraw
            targetDeficit: deficit,
          }],
        };
      }
      return { ...state };
    }, FinSimLib.Core.PRIORITY.PRE_PROCESS, 'Replenish Savings');

    // ── INTL_TRANSFER_APPLY — cross-currency transfer with exchange rate + fee ─
    //
    //  AU_TO_US: withdraw AUD from auSavingsAccount, convert to USD, subtract fee,
    //            credit usSavingsAccount.
    //    AUD needed = (targetDeficitUsd + feeUsd) * usdToAud
    //    USD received = audWithdrawn / usdToAud - feeUsd
    //
    //  US_TO_AU: withdraw USD from usSavingsAccount, subtract fee, convert to AUD,
    //            credit auSavingsAccount.
    //    USD needed = targetDeficitAud / usdToAud + feeUsd
    //    AUD received = (usdWithdrawn - feeUsd) * usdToAud
    //
    //  If the source savings account is short, a REPLENISH_SAVINGS is chained on
    //  the source account first, then this action retries (replenished: true).
    //  The replenished flag prevents a second replenishment attempt so the transfer
    //  proceeds with whatever is available after the domestic drawdown.
    this.sim.reducers.register('INTL_TRANSFER_APPLY', (state, action, date) => {
      const { direction, targetDeficit, replenished = false } = action;
      const rate = state.exchangeRateUsdToAud;
      const fee  = state.intlTransferFeeUsd;

      if (direction === 'AU_TO_US') {
        const audNeeded  = (targetDeficit + fee) * rate;
        const shortfall  = audNeeded - state.auSavingsAccount.balance;
        if (!replenished && shortfall > 0) {
          return {
            state: { ...state },
            next: [
              { type: 'REPLENISH_SAVINGS', deficit: shortfall, targetKey: 'auSavingsAccount', orderIndex: 0 },
              { type: 'INTL_TRANSFER_APPLY', direction, targetDeficit, replenished: true },
            ],
          };
        }
        const audActual   = Math.min(audNeeded, state.auSavingsAccount.balance);
        const usdReceived = Math.max(0, audActual / rate - fee);
        if (audActual > 0) {
          svc.transaction(state.auSavingsAccount, -audActual,   date);
          svc.transaction(state.usSavingsAccount, +usdReceived, date);
        }
      } else {
        // US_TO_AU
        const usdNeeded  = targetDeficit / rate + fee;
        const shortfall  = usdNeeded - state.usSavingsAccount.balance;
        if (!replenished && shortfall > 0) {
          return {
            state: { ...state },
            next: [
              { type: 'REPLENISH_SAVINGS', deficit: shortfall, targetKey: 'usSavingsAccount', orderIndex: 0 },
              { type: 'INTL_TRANSFER_APPLY', direction, targetDeficit, replenished: true },
            ],
          };
        }
        const usdActual   = Math.min(usdNeeded, state.usSavingsAccount.balance);
        const audReceived = Math.max(0, (usdActual - fee) * rate);
        if (usdActual > 0) {
          svc.transaction(state.usSavingsAccount, -usdActual,   date);
          svc.transaction(state.auSavingsAccount, +audReceived, date);
        }
      }
      return { ...state };
    }, FinSimLib.Core.PRIORITY.PRE_PROCESS, 'International Transfer Apply');

    // ── US_SAVINGS_INTEREST_CREDIT — monthly interest on US savings ────────────
    this.sim.reducers.register('US_SAVINGS_INTEREST_CREDIT', (state, action, date) => {
      svc.transaction(state.usSavingsAccount, action.amount, date);
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
    }, FinSimLib.Core.PRIORITY.CASH_FLOW, 'US Savings Interest Credit');

    // ── STOCK_DIVIDEND_CASH_APPLY — cash payout path, credits usSavingsAccount ─
    this.sim.reducers.register('STOCK_DIVIDEND_CASH_APPLY', (state, action, date) => {
      const { amount, isAuResident } = action;
      svc.transaction(state.usSavingsAccount, amount, date);
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
      const amount      = data?.amount ?? p.monthlyExpenses;
      const isAu        = state.isAuResident;
      const targetKey   = isAu ? 'auSavingsAccount' : 'usSavingsAccount';
      const account     = state[targetKey];
      const postDebitBal = account.balance - amount;
      const deficit     = (account.minimumBalance ?? 0) - postDebitBal;
      const actions     = [];
      if (deficit > 0) {
        actions.push({ type: 'REPLENISH_SAVINGS', deficit, targetKey, orderIndex: 0 });
      }
      actions.push(
        { type: 'EXPENSE_DEBIT', amount },
        new FinSimLib.Core.RecordMetricAction('monthly_expenses', amount),
        new FinSimLib.Core.RecordBalanceAction(),
      );
      return actions;
    }, 'Monthly Expenses'));

    // ── US_SAVINGS_INTEREST_MONTHLY ────────────────────────────────────────────
    this.sim.register('US_SAVINGS_INTEREST_MONTHLY', new FinSimLib.Core.HandlerEntry(({ state }) => {
      const amount = +(state.usSavingsAccount.balance * p.usSavingsInterestRate / 12).toFixed(2);
      if (amount <= 0) return [new FinSimLib.Core.RecordBalanceAction()];
      return [
        { type: 'US_SAVINGS_INTEREST_CREDIT', amount },
        new FinSimLib.Core.RecordMetricAction('us_savings_interest', amount),
        new FinSimLib.Core.RecordBalanceAction(),
      ];
    }, 'Monthly US Savings Interest'));

    // ── DIVIDEND_SCHEDULED — bypass STOCK_DIVIDEND handler for payout toggle ──
    this.sim.register('DIVIDEND_SCHEDULED', new FinSimLib.Core.HandlerEntry(({ state, data }) => {
      const stockVal = state.stockAccount?.balance ?? 0;
      const amount   = +(stockVal * p.stockDividendRate).toFixed(2);
      if (amount <= 0) return [new FinSimLib.Core.RecordBalanceAction()];

      const reinvest     = data?.reinvest ?? p.stockDividendReinvest;
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

    // ── INTL_TRANSFER_TO_US — user-triggered AUD→USD transfer ────────────────
    //    data.amount: AUD amount to send from auSavingsAccount
    this.sim.register('INTL_TRANSFER_TO_US', new FinSimLib.Core.HandlerEntry(({ state, data }) => {
      const amount  = data?.amount ?? 0;
      const rate    = state.exchangeRateUsdToAud;
      const fee     = state.intlTransferFeeUsd;
      const audActual     = Math.min(amount, state.auSavingsAccount.balance);
      const targetDeficit = Math.max(0, audActual / rate - fee);
      return [
        { type: 'INTL_TRANSFER_APPLY', direction: 'AU_TO_US', targetDeficit },
        new FinSimLib.Core.RecordMetricAction('intl_transfer_to_us', targetDeficit),
        new FinSimLib.Core.RecordBalanceAction(),
      ];
    }, 'International Transfer to US'));

    // ── INTL_TRANSFER_TO_AU — user-triggered USD→AUD transfer ────────────────
    //    data.amount: USD amount to send from usSavingsAccount
    this.sim.register('INTL_TRANSFER_TO_AU', new FinSimLib.Core.HandlerEntry(({ state, data }) => {
      const amount  = data?.amount ?? 0;
      const rate    = state.exchangeRateUsdToAud;
      const fee     = state.intlTransferFeeUsd;
      const usdActual     = Math.min(amount, state.usSavingsAccount.balance);
      const targetDeficit = Math.max(0, (usdActual - fee) * rate);
      return [
        { type: 'INTL_TRANSFER_APPLY', direction: 'US_TO_AU', targetDeficit },
        new FinSimLib.Core.RecordMetricAction('intl_transfer_to_au', targetDeficit),
        new FinSimLib.Core.RecordBalanceAction(),
      ];
    }, 'International Transfer to AU'));

    // ── CHANGE_RESIDENCY — flip flags, close partial US year, log balance ─────
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
