/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY, AccountServiceReducer } from '../../../simulation-framework/reducers.js';
import { HandlerEntry }       from '../../../simulation-framework/handlers.js';
import { RecordBalanceAction } from '../../../simulation-framework/actions.js';
import { consumeHoldingsFifo } from '../../holdings/holdings-fifo.js';

/** Resolve the AU cash pool. */
const auCash = (state) => state.auSavingsAccount ?? state.checkingAccount;

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-26: AU franked dividend (resident) — stays in account, increases all bases.
 * Chains AU_DIVIDEND_FRANKED_RESIDENT_TAX.
 */
export class AuDividendFrankedResidentApplyReducer extends AccountServiceReducer {
  static type        = 'AuDividendFrankedResidentApplyReducer';
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
export class AuDividendFrankedNonResidentApplyReducer extends AccountServiceReducer {
  static type        = 'AuDividendFrankedNonResidentApplyReducer';
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
export class AuDividendUnfrankedResidentApplyReducer extends AccountServiceReducer {
  static type        = 'AuDividendUnfrankedResidentApplyReducer';
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
export class AuDividendUnfrankedNonResidentApplyReducer extends AccountServiceReducer {
  static type        = 'AuDividendUnfrankedNonResidentApplyReducer';
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
export class AuStockEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'AuStockEarningsApplyReducer';
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
export class AuStockWithdrawalApplyReducer extends AccountServiceReducer {
  static type        = 'AuStockWithdrawalApplyReducer';
  static description = 'Credits AU cash pool with sale proceeds, FIFO-consumes auStockAccount.holdings (design 25 §6.4), and chains AU_STOCK_WITHDRAWAL_TAX with the realized basis.';
  static actionType  = 'AU_STOCK_WITHDRAWAL_APPLY';

  constructor({ accountService, costBasisStrategy = 'FIFO' }) {
    super('AU Stock Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService    = accountService;
    this.costBasisStrategy = costBasisStrategy;
    this.reducedActionTypes   = ['AU_STOCK_WITHDRAWAL_APPLY'];
    this.generatedActionTypes = ['AU_STOCK_WITHDRAWAL_TAX'];
  }

  reduce(state, action) {
    const { salePrice, residency } = action;
    const sa = state.auStockAccount;

    let realizedBasis;
    let newHoldings = sa.holdings ?? [];
    if (action.costBasis != null) {
      realizedBasis = action.costBasis;
      const { newHoldings: consumed } = consumeHoldingsFifo(sa.holdings ?? [], salePrice);
      newHoldings = consumed;
    } else {
      const r = consumeHoldingsFifo(sa.holdings ?? [], salePrice);
      realizedBasis = r.realizedBasis;
      newHoldings   = r.newHoldings;
    }
    const gain = Math.max(0, salePrice - realizedBasis);

    this.accountService.transaction(auCash(state), salePrice, null);

    const newBalance  = +newHoldings.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);
    const newEarnings = Math.max(0, (sa.earningsBasis ?? 0) - gain);
    const newContrib  = newBalance - newEarnings;
    return this.newState(
      state,
      {
        auStockAccount: {
          ...sa,
          balance:           newBalance,
          holdings:          newHoldings,
          earningsBasis:     newEarnings,
          contributionBasis: newContrib,
        },
      },
      [{ type: 'AU_STOCK_WITHDRAWAL_TAX', gain, residency, proceeds: salePrice, costBasis: realizedBasis, description: sa.name || 'auStockAccount' }]
    );
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class AuDividendFrankedResidentHandler extends HandlerEntry {
  static type        = 'AuDividendFrankedResidentHandler';
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
  static type        = 'AuDividendFrankedNonResidentHandler';
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
  static type        = 'AuDividendUnfrankedResidentHandler';
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
  static type        = 'AuDividendUnfrankedNonResidentHandler';
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
  static type        = 'AuStockEarningsHandler';
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
  static type        = 'AuStockWithdrawalHandler';
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
        residency: state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null,
      },
      new RecordBalanceAction('auStockAccount.balance', 'auStockAccount'),
    ];
  }
}
