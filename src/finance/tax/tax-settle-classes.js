/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY }  from '../../simulation-framework/reducers.js';
import { HandlerEntry }        from '../../simulation-framework/handlers.js';
import { TaxSettleService }    from '../tax-settle-service.js';
import { InsufficientFundsError } from '../assets/account.js';
import { ACCOUNT_ROLES } from '../state/account-roles.js';

// YTD fields reset to zero after each annual settlement, keyed by country code.
const YTD_FIELDS = {
  US: ['usOrdinaryIncomeYTD', 'usNegativeIncomeYTD', 'usCapitalGainsYTD', 'usCollectibleGainsYTD', 'usPenaltyYTD', 'ftcYTD'],
  AU: ['auOrdinaryIncomeYTD', 'auCapitalGainsYTD', 'auNonResidentWithholdingYTD', 'auSuperTaxYTD', 'auFrankingCreditYTD'],
};

// Per-person AU accumulator maps reset to zero after each AU settlement.
const PER_PERSON_AU_FIELDS = [
  'auPersonOrdinaryIncomeYTD',
  'auPersonCapitalGainsYTD',
  'auPersonFrankingCreditYTD',
  'auPersonNonResidentWithholdingYTD',
  'auPersonSuperTaxYTD',
];

// ─── TaxSettleHandler base + per-country subclasses ───────────────────────────

class TaxSettleHandlerBase extends HandlerEntry {
  static cc;
  static settleActionType;

  constructor() {
    super(null, `${new.target.cc} Tax Settle`);
    this._settleService = new TaxSettleService();
    this.generatedActionTypes = [new.target.settleActionType, 'RECORD_BALANCE'];
  }
}

/**
 * Fires at the end of each US tax year (scheduled by TaxService).
 *
 * Computes the US tax liability via TaxSettleService, then emits:
 *   US_TAX_SETTLE_APPLY — resets US YTD fields and chains US_TAX_PAYMENT_DEBIT if tax > 0
 *   RECORD_BALANCE      — captures a post-settlement balance snapshot
 */
export class UsTaxSettleHandler extends TaxSettleHandlerBase {
  static type             = 'UsTaxSettleHandler';
  static category         = 'handler';
  static cc               = 'US';
  static settleActionType = 'US_TAX_SETTLE_APPLY';
  static eventType        = 'TAX_SETTLE_US';
  static description      = 'Computes end-of-year US tax liability and emits US_TAX_SETTLE_APPLY + RECORD_BALANCE.';

  call({ state }) {
    const taxDetail = this._settleService.computeUsTax(state);
    return [
      { type: 'US_TAX_SETTLE_APPLY', tax: taxDetail.netLiability, taxDetail },
      { type: 'RECORD_BALANCE' },
    ];
  }
}

/**
 * Fires at the end of each AU fiscal year (scheduled by TaxService).
 *
 * Computes the AU tax liability via TaxSettleService.  When per-person data is
 * available, uses per-person breakdown; otherwise falls back to household total.
 * Emits:
 *   AU_TAX_SETTLE_APPLY — resets AU YTD fields and chains AU_TAX_PAYMENT_DEBIT if tax > 0
 *   RECORD_BALANCE      — captures a post-settlement balance snapshot
 */
export class AuTaxSettleHandler extends TaxSettleHandlerBase {
  static type             = 'AuTaxSettleHandler';
  static category         = 'handler';
  static cc               = 'AU';
  static settleActionType = 'AU_TAX_SETTLE_APPLY';
  static eventType        = 'TAX_SETTLE_AU';
  static description      = 'Computes end-of-year AU tax liability and emits AU_TAX_SETTLE_APPLY + RECORD_BALANCE.';

  call({ state }) {
    if (state.auPersonOrdinaryIncomeYTD && Object.keys(state.auPersonOrdinaryIncomeYTD).length > 0) {
      const personTaxDetails = this._settleService.computeAuTaxPerPerson(state);
      if (personTaxDetails.length > 0) {
        const totalTax = personTaxDetails.reduce((sum, p) => sum + p.taxDetail.netLiability, 0);
        return [
          { type: 'AU_TAX_SETTLE_APPLY', tax: totalTax, taxDetail: null, personTaxDetails },
          { type: 'RECORD_BALANCE' },
        ];
      }
    }
    const taxDetail = this._settleService.computeAuTax(state);
    return [
      { type: 'AU_TAX_SETTLE_APPLY', tax: taxDetail.netLiability, taxDetail },
      { type: 'RECORD_BALANCE' },
    ];
  }
}

// ─── TaxSettleApplyReducer base + per-country subclasses ─────────────────────

class TaxSettleApplyReducerBase extends Reducer {
  static cc;
  static applyActionType;
  static debitActionType;

  constructor() {
    const cc = new.target.cc;
    super(`${cc} Tax Settle Apply`, PRIORITY.TAX_APPLY);
    this.reducedActionTypes   = [new.target.applyActionType];
    this.generatedActionTypes = [new.target.debitActionType];
  }

  reduce(state, action) {
    const cc = this.constructor.cc;
    const { tax } = action;
    const resets = {};
    for (const field of (YTD_FIELDS[cc] || [])) {
      if (field in state) resets[field] = 0;
    }
    if (cc === 'AU') {
      for (const field of PER_PERSON_AU_FIELDS) {
        if (state[field]) {
          resets[field] = Object.fromEntries(Object.keys(state[field]).map(k => [k, 0]));
        }
      }
    }
    if (tax > 0) {
      return this.newState({ ...state, ...resets }, {}, [{ type: this.constructor.debitActionType, amount: tax }]);
    }
    return this.newState({ ...state, ...resets });
  }
}

/**
 * Resets US YTD tax accumulators and, when the computed tax is positive,
 * chains a US_TAX_PAYMENT_DEBIT action to debit the US savings account.
 */
export class UsTaxSettleApplyReducer extends TaxSettleApplyReducerBase {
  static type            = 'UsTaxSettleApplyReducer';
  static category        = 'reducer';
  static cc              = 'US';
  static applyActionType = 'US_TAX_SETTLE_APPLY';
  static debitActionType = 'US_TAX_PAYMENT_DEBIT';
  static description     = 'Resets US YTD tax fields after settlement; chains US_TAX_PAYMENT_DEBIT when tax > 0.';
}

/**
 * Resets AU YTD tax accumulators (including per-person maps) and, when the
 * computed tax is positive, chains an AU_TAX_PAYMENT_DEBIT action to debit
 * the AU savings account.
 */
export class AuTaxSettleApplyReducer extends TaxSettleApplyReducerBase {
  static type            = 'AuTaxSettleApplyReducer';
  static category        = 'reducer';
  static cc              = 'AU';
  static applyActionType = 'AU_TAX_SETTLE_APPLY';
  static debitActionType = 'AU_TAX_PAYMENT_DEBIT';
  static description     = 'Resets AU YTD tax fields after settlement; chains AU_TAX_PAYMENT_DEBIT when tax > 0.';
}

// ─── TaxPaymentDebitReducer base + per-country subclasses ────────────────────

class TaxPaymentDebitReducerBase extends Reducer {
  static cc;
  static actionType;
  static savingsRole;

  static fromJSON(d, services) {
    const r = new this(services);
    r.id = d.id;
    return r;
  }

  constructor({ accountService, stateRegistry }) {
    const cc = new.target.cc;
    super(`${cc} Tax Payment Debit`, PRIORITY.TAX_APPLY + 1);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = [new.target.actionType];
    this.generatedActionTypes = ['INTL_TRANSFER_RECORD'];
  }

  reduce(state, action, date) {
    const role       = this.constructor.savingsRole;
    const accountKey = this.stateRegistry.getStateKey(role);
    const cashAccount = state[accountKey];
    const shortfall   = action.amount - Math.max(0, cashAccount.balance);

    let crossBorderTransfers = [];
    if (shortfall > 0) {
      try {
        // A cross-currency cash sweep here (e.g. AU cash topping up US savings to
        // pay US tax) is journaled via INTL_TRANSFER_RECORD (design 44 Gap A).
        ({ crossBorderTransfers = [] } = this.accountService.replenishSavings(state, accountKey, shortfall, date));
      } catch (e) {
        if (!(e instanceof InsufficientFundsError)) throw e;
        // Proceed with partial payment — pay what's available.
      }
    }

    const debit = Math.min(action.amount, Math.max(0, cashAccount.balance));
    if (debit > 0) {
      this.accountService.transaction(cashAccount, -debit, date);
    }

    return this.newState(state, {
      [accountKey]: { ...cashAccount },   // explicit new reference so balance change is visible in state diffs
    }, crossBorderTransfers);
  }
}

/**
 * Debits the US savings account for the computed tax amount.
 *
 * @param {object} opts
 * @param {import('../services/account-service.js').AccountService} opts.accountService
 * @param {object} opts.stateRegistry
 */
export class UsTaxPaymentDebitReducer extends TaxPaymentDebitReducerBase {
  static type        = 'UsTaxPaymentDebitReducer';
  static category    = 'reducer';
  static cc          = 'US';
  static actionType  = 'US_TAX_PAYMENT_DEBIT';
  static savingsRole = ACCOUNT_ROLES.US_SAVINGS;
  static description = 'Debits the US savings account for the tax amount; replenishes from investment accounts first when the balance is short.';
}

/**
 * Debits the AU savings account for the computed tax amount.
 *
 * @param {object} opts
 * @param {import('../services/account-service.js').AccountService} opts.accountService
 * @param {object} opts.stateRegistry
 */
export class AuTaxPaymentDebitReducer extends TaxPaymentDebitReducerBase {
  static type        = 'AuTaxPaymentDebitReducer';
  static category    = 'reducer';
  static cc          = 'AU';
  static actionType  = 'AU_TAX_PAYMENT_DEBIT';
  static savingsRole = ACCOUNT_ROLES.AU_SAVINGS;
  static description = 'Debits the AU savings account for the tax amount; replenishes from investment accounts first when the balance is short.';
}
