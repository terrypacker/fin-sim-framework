/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../../simulation-framework/reducers.js';
import { HandlerEntry }       from '../../../simulation-framework/handlers.js';
import { RecordBalanceAction } from '../../../simulation-framework/actions.js';

/** Resolve the US cash pool. */
const usCash = (state) => state.usSavingsAccount ?? state.checkingAccount;

// ─── Fixed Income Reducers ────────────────────────────────────────────────────

/** EVT-9: Fixed income contribution — debit US cash pool, credit account, no tax. */
export class FixedIncomeContributionApplyReducer extends Reducer {
  static description = 'Debits the US cash pool and credits the fixed income account balance; no tax effect.';
  static actionType  = 'FIXED_INCOME_CONTRIBUTION_APPLY';

  constructor({ accountService }) {
    super('Fixed Income Contribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes = ['FIXED_INCOME_CONTRIBUTION_APPLY'];
  }

  reduce(state, action) {
    this.accountService.transaction(usCash(state), -action.amount, null);
    return this.newState(state, {
      fixedIncomeAccount: {
        ...state.fixedIncomeAccount,
        balance: state.fixedIncomeAccount.balance + action.amount,
      },
    });
  }
}

/** EVT-10: Fixed income withdrawal — debit account, credit US cash pool, no tax. */
export class FixedIncomeWithdrawalApplyReducer extends Reducer {
  static description = 'Credits the US cash pool and debits the fixed income account balance; no tax effect.';
  static actionType  = 'FIXED_INCOME_WITHDRAWAL_APPLY';

  constructor({ accountService }) {
    super('Fixed Income Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes = ['FIXED_INCOME_WITHDRAWAL_APPLY'];
  }

  reduce(state, action) {
    this.accountService.transaction(usCash(state), action.amount, null);
    return this.newState(state, {
      fixedIncomeAccount: {
        ...state.fixedIncomeAccount,
        balance: state.fixedIncomeAccount.balance - action.amount,
      },
    });
  }
}

/**
 * EVT-11: Fixed income earnings — stay in account.
 * Chains FIXED_INCOME_EARNINGS_TAX (US ordinary income, AU ordinary if resident).
 */
export class FixedIncomeEarningsApplyReducer extends Reducer {
  static description = 'Adds earnings to fixed income account; chains FIXED_INCOME_EARNINGS_TAX.';
  static actionType  = 'FIXED_INCOME_EARNINGS_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('Fixed Income Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['FIXED_INCOME_EARNINGS_APPLY'];
    this.generatedActionTypes = ['FIXED_INCOME_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const { amount, isAuResident } = action;
    return this.newState(
      state,
      {
        fixedIncomeAccount: {
          ...state.fixedIncomeAccount,
          balance: state.fixedIncomeAccount.balance + amount,
        },
      },
      [{ type: 'FIXED_INCOME_EARNINGS_TAX', amount, isAuResident }]
    );
  }
}

// ─── Stock Reducers ───────────────────────────────────────────────────────────

/** EVT-12: Stock contribution — debit US cash pool, credit contributionBasis, no tax. */
export class StockContributionApplyReducer extends Reducer {
  static description = 'Debits the US cash pool and credits stock contributionBasis; no tax effect.';
  static actionType  = 'STOCK_CONTRIBUTION_APPLY';

  constructor({ accountService }) {
    super('Stock Contribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes = ['STOCK_CONTRIBUTION_APPLY'];
  }

  reduce(state, action) {
    this.accountService.transaction(usCash(state), -action.amount, null);
    const key = action.stateKey ?? 'usStockAccount';
    const sa = state[key];
    return this.newState(state, {
      [key]: {
        ...sa,
        balance:           sa.balance           + action.amount,
        contributionBasis: sa.contributionBasis + action.amount,
      },
    });
  }
}

/**
 * EVT-13: Stock dividend — stays in account, increases both bases.
 * Chains STOCK_DIVIDEND_TAX (US ordinary income, AU ordinary if resident).
 */
export class StockDividendApplyReducer extends Reducer {
  static description = 'Adds dividend to stock balance and both bases; chains STOCK_DIVIDEND_TAX.';
  static actionType  = 'STOCK_DIVIDEND_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('Stock Dividend Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['STOCK_DIVIDEND_APPLY'];
    this.generatedActionTypes = ['STOCK_DIVIDEND_TAX'];
  }

  reduce(state, action) {
    const { amount, isAuResident } = action;
    const key = action.stateKey ?? 'usStockAccount';
    const sa = state[key];
    return this.newState(
      state,
      {
        [key]: {
          ...sa,
          balance:           sa.balance           + amount,
          contributionBasis: sa.contributionBasis + amount,
          earningsBasis:     sa.earningsBasis     + amount,
        },
      },
      [{ type: 'STOCK_DIVIDEND_TAX', amount, isAuResident }]
    );
  }
}

/** EVT-14: Stock earnings (unrealized) — stay in account, no tax. */
export class StockEarningsApplyReducer extends Reducer {
  static description = 'Adds unrealized earnings to stock balance and earningsBasis; no tax effect.';
  static actionType  = 'STOCK_EARNINGS_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('Stock Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['STOCK_EARNINGS_APPLY'];
  }

  reduce(state, action) {
    const key = action.stateKey ?? 'usStockAccount';
    const sa = state[key];
    return this.newState(state, {
      [key]: {
        ...sa,
        balance:       sa.balance       + action.amount,
        earningsBasis: sa.earningsBasis + action.amount,
      },
    });
  }
}

/**
 * EVT-15: Stock withdrawal (sale) — credit US cash pool, debit account.
 * Chains STOCK_WITHDRAWAL_TAX (US capital gain, AU capital gain if resident).
 */
export class StockWithdrawalApplyReducer extends Reducer {
  static description = 'Credits the US cash pool with sale proceeds, debits the stock account, and chains STOCK_WITHDRAWAL_TAX.';
  static actionType  = 'STOCK_WITHDRAWAL_APPLY';

  constructor({ accountService }) {
    super('Stock Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['STOCK_WITHDRAWAL_APPLY'];
    this.generatedActionTypes = ['STOCK_WITHDRAWAL_TAX'];
  }

  reduce(state, action) {
    const { salePrice, costBasis, isAuResident } = action;
    const gain = Math.max(0, salePrice - costBasis);
    this.accountService.transaction(usCash(state), salePrice, null);
    const key = action.stateKey ?? 'usStockAccount';
    const sa = state[key];
    const newBalance  = sa.balance - salePrice;
    const newEarnings = Math.max(0, sa.earningsBasis - gain);
    const newContrib  = newBalance - newEarnings;
    return this.newState(
      state,
      {
        [key]: {
          ...sa,
          balance:           newBalance,
          contributionBasis: newContrib,
          earningsBasis:     newEarnings,
        },
      },
      [{ type: 'STOCK_WITHDRAWAL_TAX', gain, isAuResident }]
    );
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class FixedIncomeContributionHandler extends HandlerEntry {
  static description = 'Dispatches FIXED_INCOME_CONTRIBUTION_APPLY.';
  static eventType   = 'FIXED_INCOME_CONTRIBUTION';

  constructor() {
    super(null, 'Fixed Income Contribution');
    this.generatedActionTypes = ['FIXED_INCOME_CONTRIBUTION_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'FIXED_INCOME_CONTRIBUTION_APPLY', amount: data.amount },
      new RecordBalanceAction('fixedIncomeAccount.balance', 'fixedIncomeAccount'),
    ];
  }
}

export class FixedIncomeWithdrawalHandler extends HandlerEntry {
  static description = 'Dispatches FIXED_INCOME_WITHDRAWAL_APPLY.';
  static eventType   = 'FIXED_INCOME_WITHDRAWAL';

  constructor() {
    super(null, 'Fixed Income Withdrawal');
    this.generatedActionTypes = ['FIXED_INCOME_WITHDRAWAL_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'FIXED_INCOME_WITHDRAWAL_APPLY', amount: data.amount },
      new RecordBalanceAction('fixedIncomeAccount.balance', 'fixedIncomeAccount'),
    ];
  }
}

export class FixedIncomeEarningsHandler extends HandlerEntry {
  static description = 'Dispatches FIXED_INCOME_EARNINGS_APPLY, passing through the AU residency flag.';
  static eventType   = 'FIXED_INCOME_EARNINGS';

  constructor() {
    super(null, 'Fixed Income Earnings');
    this.generatedActionTypes = ['FIXED_INCOME_EARNINGS_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    return [
      { type: 'FIXED_INCOME_EARNINGS_APPLY', amount: data.amount, isAuResident: state.isAuResident },
      new RecordBalanceAction('fixedIncomeAccount.balance', 'fixedIncomeAccount'),
    ];
  }
}

export class StockContributionHandler extends HandlerEntry {
  static description = 'Dispatches STOCK_CONTRIBUTION_APPLY.';
  static eventType   = 'STOCK_CONTRIBUTION';

  constructor() {
    super(null, 'Stock Contribution');
    this.generatedActionTypes = ['STOCK_CONTRIBUTION_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'STOCK_CONTRIBUTION_APPLY', amount: data.amount },
      new RecordBalanceAction('usStockAccount.balance', 'usStockAccount'),
    ];
  }
}

export class StockDividendHandler extends HandlerEntry {
  static description = 'Dispatches STOCK_DIVIDEND_APPLY, passing through the AU residency flag.';
  static eventType   = 'STOCK_DIVIDEND';

  constructor() {
    super(null, 'Stock Dividend');
    this.generatedActionTypes = ['STOCK_DIVIDEND_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    return [
      { type: 'STOCK_DIVIDEND_APPLY', amount: data.amount, isAuResident: state.isAuResident },
      new RecordBalanceAction('usStockAccount.balance', 'usStockAccount'),
    ];
  }
}

export class StockEarningsHandler extends HandlerEntry {
  static description = 'Dispatches STOCK_EARNINGS_APPLY.';
  static eventType   = 'STOCK_EARNINGS';

  constructor() {
    super(null, 'Stock Earnings');
    this.generatedActionTypes = ['STOCK_EARNINGS_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'STOCK_EARNINGS_APPLY', amount: data.amount },
      new RecordBalanceAction('usStockAccount.balance', 'usStockAccount'),
    ];
  }
}

export class StockWithdrawalHandler extends HandlerEntry {
  static description = 'Dispatches STOCK_WITHDRAWAL_APPLY with sale price, cost basis, and AU residency flag.';
  static eventType   = 'STOCK_WITHDRAWAL';

  constructor() {
    super(null, 'Stock Withdrawal');
    this.generatedActionTypes = ['STOCK_WITHDRAWAL_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    return [
      {
        type:         'STOCK_WITHDRAWAL_APPLY',
        salePrice:    data.salePrice,
        costBasis:    data.costBasis,
        isAuResident: state.isAuResident,
      },
      new RecordBalanceAction('usStockAccount.balance', 'usStockAccount'),
    ];
  }
}
