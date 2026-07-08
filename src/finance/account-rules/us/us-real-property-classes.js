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
import { findLoanForProperty } from '../loan-classes.js';
import { resolveCashKey } from '../cash-routing.js';

const US_PRIMARY_HOME_EXEMPTION = 500_000;

/** Default US cash pool key when no saleDestinationAccount is provided. */
const defaultUsCashKey = (state) =>
  state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';

/** Resolve the destination state key, falling back to the default US cash pool. */
const resolveDestinationKey = (state, saleDestinationAccount) => {
  if (saleDestinationAccount && state[saleDestinationAccount] != null) {
    return saleDestinationAccount;
  }
  return defaultUsCashKey(state);
};

// ─── Reducer ──────────────────────────────────────────────────────────────────

/**
 * EVT-34: US house sale — credit destination account with sale proceeds net of
 * mortgage payoff, compute taxable capital gain after the $500K primary-home
 * exemption (mortgage payoff does not reduce the taxable gain), and chain
 * US_HOUSE_SALE_TAX.
 */
export class UsHouseSaleApplyReducer extends AccountServiceReducer {
  static type        = 'UsHouseSaleApplyReducer';
  static description = 'Credits the destination account with net proceeds (salePrice − mortgage), zeroes mortgageBalance, and chains US_HOUSE_SALE_TAX with the post-exemption taxable gain.';
  static actionType  = 'US_HOUSE_SALE_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('US House Sale Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['US_HOUSE_SALE_APPLY'];
    this.generatedActionTypes = ['US_HOUSE_SALE_TAX'];
  }

  reduce(state, action) {
    const { salePrice, costBasis, mortgageBalance, stateKey, destinationKey } = action;
    const mortgage    = mortgageBalance ?? 0;
    const netProceeds = Math.max(0, salePrice - mortgage);
    // Depreciation taken during the hold reduces the tax basis, so the gain is
    // larger (design 48 §4.5). accumulatedDepreciation is 0 for non-rental
    // properties, so this is a no-op there.
    const accumulatedDep = (stateKey && state[stateKey]?.accumulatedDepreciation) ?? 0;
    const adjustedBasis  = Math.max(0, costBasis - accumulatedDep);
    const rawGain     = Math.max(0, salePrice - adjustedBasis);
    const taxableGain = Math.max(0, rawGain - US_PRIMARY_HOME_EXEMPTION);
    const destKey     = destinationKey ?? resolveCashKey(this.stateRegistry, 'US', state);
    this.accountService.transaction(state[destKey], netProceeds, null);
    const updates = {};
    if (stateKey && state[stateKey]) {
      updates[stateKey] = { ...state[stateKey], mortgageBalance: 0, value: 0 };
    }
    // Design 54 P2: the debt lives on the linked Loan — the sale pays it off, so
    // close the loan (balance 0) alongside zeroing the property value.
    const loan = stateKey ? findLoanForProperty(state, stateKey) : null;
    if (loan) {
      updates[loan.stateKey] = { ...loan, balance: 0 };
    }
    return this.newState(
      state,
      updates,
      // Emit the realized gain under the family-standard `gain` field (shared by
      // every CAPITAL_GAINS disposal type) so the Capital Gains by Disposal report
      // aggregates it uniformly. proceeds/costBasis/description give the report a
      // readable, drillable row.
      [{
        type:        'US_HOUSE_SALE_TAX',
        gain:        taxableGain,
        proceeds:    salePrice,
        costBasis:   adjustedBasis,
        description: stateKey || 'usHouse',
      }]
    );
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export class UsHouseSaleHandler extends HandlerEntry {
  static type        = 'UsHouseSaleHandler';
  static description = 'Dispatches US_HOUSE_SALE_APPLY with sale price, cost basis, current mortgage balance, and resolved destination account.';
  static eventType   = 'US_HOUSE_SALE';

  constructor() {
    super(null, 'US House Sale');
    this.generatedActionTypes = ['US_HOUSE_SALE_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const propState       = data.stateKey ? state[data.stateKey] : null;
    // Design 54 P2: the payoff amount is the linked Loan's balance, not the
    // retired property scalar (now always 0).
    const loan            = data.stateKey ? findLoanForProperty(state, data.stateKey) : null;
    const mortgageBalance = loan?.balance ?? propState?.mortgageBalance ?? 0;
    const destinationKey  = resolveDestinationKey(state, data.saleDestinationAccount);
    return [
      {
        type:            'US_HOUSE_SALE_APPLY',
        salePrice:       data.salePrice ?? propState?.value ?? 0,
        costBasis:       data.costBasis,
        mortgageBalance,
        residency:       state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null,
        stateKey:        data.stateKey ?? null,
        destinationKey,
      },
      new RecordBalanceAction(`${destinationKey}.balance`, destinationKey),
    ];
  }
}
