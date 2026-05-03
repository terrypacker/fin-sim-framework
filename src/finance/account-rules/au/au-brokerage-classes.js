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

/** Resolve the AU cash pool. */
const auCash = (state) => state.auSavingsAccount ?? state.checkingAccount;

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-26: AU franked dividend (resident) — stays in account, increases all bases.
 * Chains AU_DIVIDEND_FRANKED_RESIDENT_TAX.
 */
export class AuDividendFrankedResidentApplyReducer extends Reducer {
  static description = 'Adds franked dividend to auStockAccount; chains AU_DIVIDEND_FRANKED_RESIDENT_TAX.';
  static actionType  = 'AU_DIVIDEND_FRANKED_RESIDENT_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('AU Franked Dividend Resident Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['AU_DIVIDEND_FRANKED_RESIDENT_APPLY'];
    this.generatedActionTypes = ['AU_DIVIDEND_FRANKED_RESIDENT_TAX'];
  }

  reduce(state, action) {
    const sa = state.auStockAccount;
    return this.newState(
      state,
      {
        auStockAccount: {
          ...sa,
          balance:           sa.balance           + action.amount,
          contributionBasis: sa.contributionBasis + action.amount,
          earningsBasis:     sa.earningsBasis     + action.amount,
        },
      },
      [{ type: 'AU_DIVIDEND_FRANKED_RESIDENT_TAX', amount: action.amount }]
    );
  }
}

/**
 * EVT-27: AU franked dividend (non-resident) — stays in account, no AU tax.
 */
export class AuDividendFrankedNonResidentApplyReducer extends Reducer {
  static description = 'Adds franked dividend to auStockAccount for non-residents; no AU tax chained.';
  static actionType  = 'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('AU Franked Dividend Non-Resident Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY'];
  }

  reduce(state, action) {
    const sa = state.auStockAccount;
    return this.newState(state, {
      auStockAccount: {
        ...sa,
        balance:           sa.balance           + action.amount,
        contributionBasis: sa.contributionBasis + action.amount,
        earningsBasis:     sa.earningsBasis     + action.amount,
      },
    });
  }
}

/**
 * EVT-28: AU unfranked dividend (resident) — stays in account.
 * Chains AU_DIVIDEND_UNFRANKED_RESIDENT_TAX.
 */
export class AuDividendUnfrankedResidentApplyReducer extends Reducer {
  static description = 'Adds unfranked dividend to auStockAccount; chains AU_DIVIDEND_UNFRANKED_RESIDENT_TAX.';
  static actionType  = 'AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('AU Unfranked Dividend Resident Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY'];
    this.generatedActionTypes = ['AU_DIVIDEND_UNFRANKED_RESIDENT_TAX'];
  }

  reduce(state, action) {
    const sa = state.auStockAccount;
    return this.newState(
      state,
      {
        auStockAccount: {
          ...sa,
          balance:           sa.balance           + action.amount,
          contributionBasis: sa.contributionBasis + action.amount,
          earningsBasis:     sa.earningsBasis     + action.amount,
        },
      },
      [{ type: 'AU_DIVIDEND_UNFRANKED_RESIDENT_TAX', amount: action.amount }]
    );
  }
}

/**
 * EVT-29: AU unfranked dividend (non-resident) — stays in account.
 * Chains AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX.
 */
export class AuDividendUnfrankedNonResidentApplyReducer extends Reducer {
  static description = 'Adds unfranked dividend to auStockAccount for non-residents; chains AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX.';
  static actionType  = 'AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('AU Unfranked Dividend Non-Resident Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY'];
    this.generatedActionTypes = ['AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX'];
  }

  reduce(state, action) {
    const sa = state.auStockAccount;
    return this.newState(
      state,
      {
        auStockAccount: {
          ...sa,
          balance:           sa.balance           + action.amount,
          contributionBasis: sa.contributionBasis + action.amount,
          earningsBasis:     sa.earningsBasis     + action.amount,
        },
      },
      [{ type: 'AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX', amount: action.amount }]
    );
  }
}

/** EVT-30: AU stock unrealized earnings — stay in account, no tax. */
export class AuStockEarningsApplyReducer extends Reducer {
  static description = 'Adds unrealized earnings to auStockAccount balance and earningsBasis; no tax effect.';
  static actionType  = 'AU_STOCK_EARNINGS_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('AU Stock Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['AU_STOCK_EARNINGS_APPLY'];
  }

  reduce(state, action) {
    const sa = state.auStockAccount;
    return this.newState(state, {
      auStockAccount: {
        ...sa,
        balance:       sa.balance       + action.amount,
        earningsBasis: sa.earningsBasis + action.amount,
      },
    });
  }
}

/**
 * EVT-31 (resident) / EVT-32 (non-resident): AU stock withdrawal (sale).
 * Credits AU cash pool, debits account.
 * Chains AU_STOCK_WITHDRAWAL_TAX (US cap gain always, AU cap gain + FTC if resident).
 */
export class AuStockWithdrawalApplyReducer extends Reducer {
  static description = 'Credits the AU cash pool with sale proceeds, debits auStockAccount, and chains AU_STOCK_WITHDRAWAL_TAX.';
  static actionType  = 'AU_STOCK_WITHDRAWAL_APPLY';

  constructor({ accountService }) {
    super('AU Stock Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['AU_STOCK_WITHDRAWAL_APPLY'];
    this.generatedActionTypes = ['AU_STOCK_WITHDRAWAL_TAX'];
  }

  reduce(state, action) {
    const { salePrice, costBasis, isAuResident } = action;
    const gain = Math.max(0, salePrice - costBasis);
    this.accountService.transaction(auCash(state), salePrice, null);
    const sa = state.auStockAccount;
    const newBalance  = sa.balance - salePrice;
    const newEarnings = Math.max(0, sa.earningsBasis - gain);
    const newContrib  = newBalance - newEarnings;
    return this.newState(
      state,
      {
        auStockAccount: {
          ...sa,
          balance:           newBalance,
          earningsBasis:     newEarnings,
          contributionBasis: newContrib,
        },
      },
      [{ type: 'AU_STOCK_WITHDRAWAL_TAX', gain, isAuResident }]
    );
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class AuDividendFrankedResidentHandler extends HandlerEntry {
  static description = 'Dispatches AU_DIVIDEND_FRANKED_RESIDENT_APPLY.';
  static eventType   = 'AU_DIVIDEND_FRANKED_RESIDENT';

  constructor() {
    super(null, 'AU Franked Dividend Resident');
    this.generatedActionTypes = ['AU_DIVIDEND_FRANKED_RESIDENT_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'AU_DIVIDEND_FRANKED_RESIDENT_APPLY', amount: data.amount },
      new RecordBalanceAction('auStockAccount.balance', 'auStockAccount'),
    ];
  }
}

export class AuDividendFrankedNonResidentHandler extends HandlerEntry {
  static description = 'Dispatches AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY.';
  static eventType   = 'AU_DIVIDEND_FRANKED_NONRESIDENT';

  constructor() {
    super(null, 'AU Franked Dividend Non-Resident');
    this.generatedActionTypes = ['AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY', amount: data.amount },
      new RecordBalanceAction('auStockAccount.balance', 'auStockAccount'),
    ];
  }
}

export class AuDividendUnfrankedResidentHandler extends HandlerEntry {
  static description = 'Dispatches AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY.';
  static eventType   = 'AU_DIVIDEND_UNFRANKED_RESIDENT';

  constructor() {
    super(null, 'AU Unfranked Dividend Resident');
    this.generatedActionTypes = ['AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY', amount: data.amount },
      new RecordBalanceAction('auStockAccount.balance', 'auStockAccount'),
    ];
  }
}

export class AuDividendUnfrankedNonResidentHandler extends HandlerEntry {
  static description = 'Dispatches AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY.';
  static eventType   = 'AU_DIVIDEND_UNFRANKED_NONRESIDENT';

  constructor() {
    super(null, 'AU Unfranked Dividend Non-Resident');
    this.generatedActionTypes = ['AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY', amount: data.amount },
      new RecordBalanceAction('auStockAccount.balance', 'auStockAccount'),
    ];
  }
}

export class AuStockEarningsHandler extends HandlerEntry {
  static description = 'Dispatches AU_STOCK_EARNINGS_APPLY.';
  static eventType   = 'AU_STOCK_EARNINGS';

  constructor() {
    super(null, 'AU Stock Earnings');
    this.generatedActionTypes = ['AU_STOCK_EARNINGS_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'AU_STOCK_EARNINGS_APPLY', amount: data.amount },
      new RecordBalanceAction('auStockAccount.balance', 'auStockAccount'),
    ];
  }
}

export class AuStockWithdrawalHandler extends HandlerEntry {
  static description = 'Dispatches AU_STOCK_WITHDRAWAL_APPLY with sale price, cost basis, and AU residency flag.';
  static eventType   = 'AU_STOCK_WITHDRAWAL';

  constructor() {
    super(null, 'AU Stock Withdrawal');
    this.generatedActionTypes = ['AU_STOCK_WITHDRAWAL_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    return [
      {
        type:         'AU_STOCK_WITHDRAWAL_APPLY',
        salePrice:    data.salePrice,
        costBasis:    data.costBasis,
        isAuResident: state.isAuResident,
      },
      new RecordBalanceAction('auStockAccount.balance', 'auStockAccount'),
    ];
  }
}
