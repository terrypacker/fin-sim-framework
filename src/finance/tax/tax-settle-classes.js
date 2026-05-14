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
  US: ['usOrdinaryIncomeYTD', 'usNegativeIncomeYTD', 'usCapitalGainsYTD', 'usPenaltyYTD', 'ftcYTD'],
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

// ─── TAX_SETTLE handler ────────────────────────────────────────────────────────

/**
 * Fires at the end of each tax year (scheduled by TaxService).
 *
 * Computes the total tax liability for the given country via TaxSettleService,
 * then emits:
 *   TAX_SETTLE_APPLY — resets YTD fields and chains TAX_PAYMENT_DEBIT if tax > 0
 *   RECORD_BALANCE   — captures a post-settlement balance snapshot
 *
 * SimulationSync wires this via the static eventType property.
 */
export class TaxSettleHandler extends HandlerEntry {
  static description = 'Computes end-of-year tax liability and emits TAX_SETTLE_APPLY + RECORD_BALANCE; works for both US and AU settlements.';
  static eventType   = 'TAX_SETTLE';

  constructor() {
    super(null, 'Tax Settle');
    this._settleService = new TaxSettleService();
    this.generatedActionTypes = ['TAX_SETTLE_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const { cc } = data;

    if (cc === 'AU' && state.auPersonOrdinaryIncomeYTD && Object.keys(state.auPersonOrdinaryIncomeYTD).length > 0) {
      const personTaxDetails = this._settleService.computeAuTaxPerPerson(state);
      if (personTaxDetails.length > 0) {
        const totalTax = personTaxDetails.reduce((sum, p) => sum + p.taxDetail.netLiability, 0);
        return [
          { type: 'TAX_SETTLE_APPLY', cc, tax: totalTax, taxDetail: null, personTaxDetails },
          { type: 'RECORD_BALANCE' },
        ];
      }
    }

    const taxDetail = cc === 'AU'
      ? this._settleService.computeAuTax(state)
      : this._settleService.computeUsTax(state);
    return [
      { type: 'TAX_SETTLE_APPLY', cc, tax: taxDetail.netLiability, taxDetail },
      { type: 'RECORD_BALANCE' },
    ];
  }
}

// ─── TAX_SETTLE_APPLY reducer ─────────────────────────────────────────────────

/**
 * Resets YTD tax accumulators for the settled country code and, when the
 * computed tax is positive, chains a TAX_PAYMENT_DEBIT action to debit the
 * appropriate savings account.
 */
export class TaxSettleApplyReducer extends Reducer {
  static description = 'Resets YTD tax fields after settlement; chains TAX_PAYMENT_DEBIT when tax > 0.';
  static actionType  = 'TAX_SETTLE_APPLY';

  constructor() {
    super('Tax Settle Apply', PRIORITY.TAX_APPLY);
    this.reducedActionTypes   = ['TAX_SETTLE_APPLY'];
    this.generatedActionTypes = ['TAX_PAYMENT_DEBIT'];
  }

  reduce(state, action) {
    const { cc, tax } = action;
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
      return this.newState({ ...state, ...resets }, {}, [{ type: 'TAX_PAYMENT_DEBIT', amount: tax, cc }]);
    }
    return this.newState({ ...state, ...resets });
  }
}

// ─── TAX_PAYMENT_DEBIT reducer ────────────────────────────────────────────────

/**
 * Debits the country-appropriate savings account for the computed tax amount.
 *
 * If the savings balance is insufficient, AccountService.replenishSavings()
 * is called first to draw from domestic investment accounts.  A partial
 * payment is accepted when all domestic sources are exhausted.
 *
 * @param {object} opts
 * @param {import('../services/account-service.js').AccountService} opts.accountService
 */
export class TaxPaymentDebitReducer extends Reducer {
  static description = 'Debits the country savings account for the tax amount; replenishes from investment accounts first when the balance is short.';
  static actionType  = 'TAX_PAYMENT_DEBIT';

  constructor({ accountService, stateRegistry }) {
    super('Tax Payment Debit', PRIORITY.TAX_APPLY + 1);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = ['TAX_PAYMENT_DEBIT'];
  }

  reduce(state, action, date) {
    const { amount, cc } = action;
    const role       = cc === 'AU' ? ACCOUNT_ROLES.AU_SAVINGS : ACCOUNT_ROLES.US_SAVINGS;
    const accountKey = this.stateRegistry.getStateKey(role);
    const cashAccount = state[accountKey];
    const shortfall   = amount - Math.max(0, cashAccount.balance);

    if (shortfall > 0) {
      try {
        this.accountService.replenishSavings(state, accountKey, shortfall, date);
      } catch (e) {
        if (!(e instanceof InsufficientFundsError)) throw e;
        // Proceed with partial payment — pay what's available.
      }
    }

    const debit = Math.min(amount, Math.max(0, cashAccount.balance));
    if (debit > 0) {
      this.accountService.transaction(cashAccount, -debit, date);
    }

    const metricKey = cc === 'AU' ? 'tax_paid_au' : 'tax_paid_us';
    const list      = state.metrics[metricKey] || [];

    return this.newState(state, {
      [accountKey]: { ...cashAccount },   // explicit new reference so balance change is visible in state diffs
      metrics: { ...state.metrics, [metricKey]: [...list, debit] },
    });
  }
}
