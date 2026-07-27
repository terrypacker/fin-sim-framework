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
import { resolveDestinationCashKey } from '../cash-routing.js';

const US_PRIMARY_HOME_EXEMPTION = 500_000;

const YEAR_MS       = 365 * 24 * 60 * 60 * 1000;
const SIX_YEARS_MS  = 6 * YEAR_MS;

/**
 * AU main-residence exemption fraction for a FOREIGN dwelling of an AU resident
 * (design 62 §5.3). The person became absent at the deemed-acquisition date (the
 * move), so ITAA97 s118-145 (the absence rule) applies:
 *   - not a main residence (investment property) ⇒ 0 (fully assessable);
 *   - main residence, NOT income-producing ⇒ 1 (indefinite absence exemption);
 *   - main residence, income-producing (rented) ⇒ the 6-year absence limit, applied
 *     proportionally: exempt = min(6y, ownership) / ownership from the move to sale.
 * Simplification: assumes the foreign dwelling retains the exemption (a competing
 * AU main-residence claim would reduce it; not modeled).
 *
 * @returns {number} exempt fraction in [0, 1]
 */
export function auMainResidenceExemptFraction(propState, deemedAcqMs, saleMs) {
  if (!propState?.isPrimaryResidence) return 0;
  if (deemedAcqMs == null || saleMs == null || saleMs <= deemedAcqMs) return 1;
  const incomeProducing = propState.rentalEnabled === true && (propState.monthlyRent ?? 0) > 0;
  if (!incomeProducing) return 1;
  const ownershipMs = saleMs - deemedAcqMs;
  return Math.min(SIX_YEARS_MS, ownershipMs) / ownershipMs;
}

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
    const { salePrice, costBasis, mortgageBalance, stateKey, destinationKey, residency } = action;
    const mortgage    = mortgageBalance ?? 0;
    const netProceeds = Math.max(0, salePrice - mortgage);
    // Depreciation taken during the hold reduces the tax basis, so the gain is
    // larger (design 48 §4.5). accumulatedDepreciation is 0 for non-rental
    // properties, so this is a no-op there.
    const accumulatedDep = (stateKey && state[stateKey]?.accumulatedDepreciation) ?? 0;
    const adjustedBasis  = Math.max(0, costBasis - accumulatedDep);
    const rawGain     = Math.max(0, salePrice - adjustedBasis);
    const taxableGain = Math.max(0, rawGain - US_PRIMARY_HOME_EXEMPTION);

    // AU assessment of the foreign (US) house for an AU resident (design 62 §5):
    // an AU resident is taxable on worldwide capital gains. The AU gain is measured
    // from the s855-45 stepped-up basis (market value at the move, stamped on the
    // property state as costBaseByCountry.AU), reduced by the AU main-residence
    // exemption. US $500k exclusion stays US-side only. When the property was not
    // stepped up (domestic/TAP, or not owned at the move) auBasis is absent ⇒ no AU
    // gain here. Both figures are in the property currency (USD); the AU classifier
    // converts. Indexation is deferred for property (design 57 §6.4), matching AU_HOUSE.
    const propState = stateKey ? state[stateKey] : null;
    const auBasis   = propState?.costBaseByCountry?.AU;
    let auGain = 0, auDiscountableGain = 0;
    if (auBasis != null && residency === 'AU') {
      const saleMs      = state.currentPeriods?.AU?.startMs ?? state.currentPeriods?.US?.startMs ?? null;
      const deemedAcqMs = propState.acquisitionDateByCountry?.AU ?? null;
      const auRawGain   = Math.max(0, salePrice - auBasis);
      const exemptFrac  = auMainResidenceExemptFraction(propState, deemedAcqMs, saleMs);
      auGain = +(auRawGain * (1 - exemptFrac)).toFixed(2);
      // CGT 50%-discount eligibility (design 62 §4): held ≥12 months from the deemed
      // acquisition. The non-exempt slice is discountable only when held long enough.
      const held12mo = deemedAcqMs != null && saleMs != null && (saleMs - deemedAcqMs) >= YEAR_MS;
      auDiscountableGain = held12mo ? auGain : 0;
    }

    const destKey     = resolveDestinationCashKey(this.stateRegistry, 'US', state, destinationKey);
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
        auGain,
        auDiscountableGain,
        residency,
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
    const actions = [
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
    // Design 54 P2: the sale pays off the linked loan (balance → 0). The loan's
    // metric series is otherwise only recorded by LOAN_PAYMENT, which skips a
    // zero-balance loan, so its chart would freeze at the pre-sale balance.
    // Snapshot the loan here (after US_HOUSE_SALE_APPLY zeroes it) so the payoff
    // shows on the chart.
    if (loan) actions.push(new RecordBalanceAction(`${loan.stateKey}.balance`, loan.stateKey));
    return actions;
  }
}
