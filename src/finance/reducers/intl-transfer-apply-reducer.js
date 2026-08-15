/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';
import { InsufficientFundsError } from '../assets/account.js';
import { getUsEarlyWithdrawalRules } from '../account-rules/us/us-early-withdrawal-rules.js';
import { convertNetOfFee, grossUpForTarget } from '../fx/fx-conversion.js';

/**
 * Handles the INTL_TRANSFER_APPLY action.
 *
 * Executes a cross-currency transfer in one of two directions, reading the
 * exchange rate and fee from state so they can be updated at runtime without
 * re-registering the reducer.
 *
 * Direction AU_TO_US (AUD → USD):
 *   AUD needed  = (targetDeficit + feeUsd) × rate
 *   USD received = audWithdrawn ÷ rate − feeUsd
 *
 * Direction US_TO_AU (USD → AUD):
 *   USD needed  = targetDeficit ÷ rate + feeUsd
 *   AUD received = (usdWithdrawn − feeUsd) × rate
 *
 * If the source savings account is short, AccountService.replenishSavings is
 * called synchronously to draw from domestic investment accounts before the
 * transfer executes.  On full exhaustion a partial transfer proceeds with
 * whatever is available, then OUT_OF_FUNDS is chained for the remaining gap.
 *
 * Runs at PRIORITY.PRE_PROCESS — before EXPENSE_DEBIT so the savings account
 * is topped up before the debit fires.
 *
 * State keys read:
 *   state.effectiveExchangeRates.USD_AUD  — 1 USD = N AUD (written by FxRefreshReducer)
 *   state.effectiveFxFees.USD_AUD         — fixed fee per transfer in USD
 *
 * @param {object}   opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 * @param {string}   [opts.usSavingsKey='usSavingsAccount']
 * @param {string}   [opts.auSavingsKey='auSavingsAccount']
 * @param {Function} [opts.earlyWithdrawalRulesFn] - (accountType) → rules | null
 */
export class IntlTransferApplyReducer extends Reducer {
  static description = 'Executes a cross-currency transfer (AU↔US) with exchange rate conversion and fee; chains OUT_OF_FUNDS if neither side can cover the deficit.';
  static type        = 'IntlTransferApplyReducer';
  static actionType  = 'INTL_TRANSFER_APPLY';

  constructor({ accountService, stateRegistry = null, usSavingsKey = 'usSavingsAccount', auSavingsKey = 'auSavingsAccount', earlyWithdrawalRulesFn = getUsEarlyWithdrawalRules } = {}) {
    super('International Transfer Apply', PRIORITY.PRE_PROCESS);
    this.accountService         = accountService;
    this.stateRegistry          = stateRegistry;
    this.usSavingsKey           = usSavingsKey;
    this.auSavingsKey           = auSavingsKey;
    this.earlyWithdrawalRulesFn = earlyWithdrawalRulesFn;
    this.reducedActionTypes     = ['INTL_TRANSFER_APPLY'];
    this.generatedActionTypes   = ['OUT_OF_FUNDS'];
  }

  static fromJSON(d, { accountService, stateRegistry } = {}) {
    const r = new this({ accountService, stateRegistry, usSavingsKey: d.usSavingsKey ?? 'usSavingsAccount', auSavingsKey: d.auSavingsKey ?? 'auSavingsAccount' });
    r.id = d.id;
    return r;
  }

  toJSON() {
    return { ...super.toJSON(), usSavingsKey: this.usSavingsKey, auSavingsKey: this.auSavingsKey };
  }

  reduce(state, action, date) {
    const { direction, targetDeficit } = action;
    const rate  = state.effectiveExchangeRates?.USD_AUD ?? 1.55;
    const fee   = state.effectiveFxFees?.USD_AUD ?? 15;
    // Design 55 §7: sweep the account flagged as each country's transaction account
    // when present; otherwise the configured savings key (back-compat, unchanged).
    let usKey = this.stateRegistry?.resolveTransactionAccountKey?.('US') ?? this.usSavingsKey;
    let auKey = this.stateRegistry?.resolveTransactionAccountKey?.('AU') ?? this.auSavingsKey;
    // Optional explicit destination override (design 44): a caller that needs the
    // proceeds credited to a *specific* account rather than the country's default
    // transaction account (e.g. the tax-payment path topping up the exact savings
    // account it debits) passes action.dstKey. It overrides only the receiving
    // side for this direction; the source stays the other country's transaction
    // account (whose investments replenishSavings liquidates below).
    if (action.dstKey) {
      if (direction === 'US_TO_AU') auKey = action.dstKey;
      else                         usKey = action.dstKey;
    }
    const usAcc = state[usKey];
    const auAcc = state[auKey];
    const pendingTaxActions = [];

    // Absent counterpart: the funding side's account may not exist (e.g. a US-only
    // scenario with no AU accounts). There is nothing to draw from, so the whole
    // targetDeficit is uncoverable — report it rather than dereferencing undefined.
    const srcAcc = direction === 'AU_TO_US' ? auAcc : usAcc;
    if (!srcAcc) {
      const ccy = direction === 'AU_TO_US' ? 'USD' : 'AUD';
      return targetDeficit > 0.01
        ? this.newState(state, {}, [{ type: 'OUT_OF_FUNDS', deficit: targetDeficit, currency: ccy }])
        : this.newState(state);
    }

    if (direction === 'AU_TO_US') {
      const audNeeded = grossUpForTarget(targetDeficit, 'AUD', 'USD', rate, fee);
      const shortfall = audNeeded - auAcc.balance;
      if (shortfall > 0) {
        try {
          const result = this.accountService.replenishSavings(state, auKey, shortfall, date, this.earlyWithdrawalRulesFn);
          pendingTaxActions.push(...result.pendingTaxActions, ...(result.crossBorderTransfers ?? []));
        } catch (e) {
          if (!(e instanceof InsufficientFundsError)) throw e;
          // The draw ran the funding country dry, but everything it sold on the way
          // down is still taxable — keep those accruals rather than losing them with
          // the error (see InsufficientFundsError.partial).
          pendingTaxActions.push(...e.partial.pendingTaxActions, ...e.partial.crossBorderTransfers);
        }
      }
      const audActual   = Math.min(audNeeded, auAcc.balance);
      const usdReceived = Math.max(0, convertNetOfFee(audActual, 'AUD', 'USD', rate, fee));
      // Design 87 G1 — converting AUD to USD is the paradigm §988 disposition of
      // nonfunctional currency (§988(c)(1)(C)(i)), and unlike the offset leg there is no
      // matched opposite position, so it is the one place §988 produces a genuinely new
      // number.
      //
      // MIGRATED to phase 3: the realization is no longer computed here. The handler
      // declares `section988: { kind: 'DISPOSE' }` on this action and the currency lot
      // observer does the work, which buys three things this code could not. It measures
      // against LOTS rather than a single blended rate, so FIFO is expressible; it routes
      // the personal share to the CAPITAL branch (G10) instead of booking it as ordinary;
      // and it sees the `replenishSavings` top-up above, which credits this same pool
      // inside this reducer and which the old ordering priced at the pre-top-up rate.
      // Name the disposing pool on the declaration the handler stamped. The handler cannot
      // supply it: `auKey` comes from this reducer's own stateRegistry/config resolution
      // above, not from anything on the action. It matters because `replenishSavings` may
      // have topped this pool up from ANOTHER AUD account, and an unnamed DISPOSE would
      // realize that internal leg too — turning a `(a)(1)(iii)(E)` non-recognition transfer
      // into a taxable disposition.
      if (action.section988) {
        action.section988.accountKey = auKey;
        // The GROSS units disposed of. `replenishSavings` above may have credited this
        // same pool, so its NET movement understates the conversion — see the observer's
        // note on declared units. This is the amount that actually moved, which is why
        // design 87 §6 puts the decision in the reducer rather than the handler.
        action.section988.units = audActual;
      }
      if (audActual > 0) {
        this.accountService.transaction(auAcc, -audActual,   date);
        this.accountService.transaction(usAcc, +usdReceived, date);
      }
      const usdShortfall = targetDeficit - usdReceived;
      if (usdShortfall > 0.01) {
        return this.newState(state, {},
          [...pendingTaxActions, { type: 'OUT_OF_FUNDS', deficit: usdShortfall, currency: 'USD' }]);
      }

    } else {
      const usdNeeded = grossUpForTarget(targetDeficit, 'USD', 'AUD', rate, fee);
      const shortfall = usdNeeded - usAcc.balance;
      if (shortfall > 0) {
        try {
          const result = this.accountService.replenishSavings(state, usKey, shortfall, date, this.earlyWithdrawalRulesFn);
          pendingTaxActions.push(...result.pendingTaxActions, ...(result.crossBorderTransfers ?? []));
        } catch (e) {
          if (!(e instanceof InsufficientFundsError)) throw e;
          // The draw ran the funding country dry, but everything it sold on the way
          // down is still taxable — keep those accruals rather than losing them with
          // the error (see InsufficientFundsError.partial).
          pendingTaxActions.push(...e.partial.pendingTaxActions, ...e.partial.crossBorderTransfers);
        }
      }
      const usdActual   = Math.min(usdNeeded, usAcc.balance);
      const audReceived = Math.max(0, convertNetOfFee(usdActual, 'USD', 'AUD', rate, fee));
      // Design 87 G1, mirror direction — acquiring AUD establishes basis and realizes
      // NOTHING. MIGRATED to phase 3: the observer sees the credit and blends the pool's
      // basis itself, so the balance-before capture this used to need is gone with it.
      // Every other credit path in the model now gets the same treatment (G8), which is
      // what this one call site could never provide.
      if (usdActual > 0) {
        this.accountService.transaction(usAcc, -usdActual,   date);
        this.accountService.transaction(auAcc, +audReceived, date);
      }
      const audShortfall = targetDeficit - audReceived;
      if (audShortfall > 0.01) {
        return this.newState(state, {},
          [...pendingTaxActions, { type: 'OUT_OF_FUNDS', deficit: audShortfall, currency: 'AUD' }]);
      }
    }

    return pendingTaxActions.length > 0
      ? this.newState(state, {}, pendingTaxActions)
      : this.newState(state);
  }

}

/**
 * Handles INTL_TRANSFER_RECORD — a journal/telemetry-only marker for a
 * cross-currency cash sweep that `AccountService.replenishSavings` already
 * executed inline (the "stranding fix" spends idle foreign cash before domestic
 * investments, so the conversion must happen synchronously inside the drawdown
 * loop rather than via a chained INTL_TRANSFER_APPLY). This reducer makes that
 * leg visible in the journal without moving money — the transfer is already
 * done. Design 44 Gap A / A2.
 *
 * Action fields (all informational): direction, srcKey, dstKey, from, to,
 *   fromAmount, toAmount, fee.
 */
export class IntlTransferRecordReducer extends Reducer {
  static description = 'Journal/telemetry-only record of a cross-border cash sweep already executed inline by replenishSavings; no state change.';
  static type        = 'IntlTransferRecordReducer';
  static actionType  = 'INTL_TRANSFER_RECORD';

  constructor() {
    super('International Transfer Record', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['INTL_TRANSFER_RECORD'];
    this.generatedActionTypes = [];
  }

  static fromJSON(d) {
    const r = new this();
    r.id = d.id;
    return r;
  }

  reduce(state) {
    return this.newState(state);
  }
}
