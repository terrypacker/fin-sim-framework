/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { AccountServiceReducer, PRIORITY }        from '../../../simulation-framework/reducers.js';
import { HandlerEntry }                            from '../../../simulation-framework/handlers.js';
import { FieldValueAction, RecordBalanceAction }   from '../../../simulation-framework/actions.js';
import { getUsEarlyWithdrawalRules }               from './us-early-withdrawal-rules.js';
import { getBirthDate, getResidency, primaryPersonKey } from '../../residency-utils.js';

/**
 * Scheduled early-withdrawal "decant" lever — design 45 Phase 1 (proactive,
 * pre-move US retirement drawdown). The planner schedules a deliberate early
 * withdrawal while US-resident and below the age gate, paying the 10% penalty on
 * purpose, to move tax-advantaged dollars into taxable BROKERAGE before a move to
 * Australia (where the US wrapper's status isn't honored). Cash lands at cost
 * basis = market (design 43), so the AU residency cost-base step-up (design 36
 * §12.2) later forgives the pre-move gain.
 *
 * Distinct from the INVOLUNTARY `replenishSavings` Phase 2 fallback: that one
 * only fires to cover a cash deficit and targets savings; this one is a
 * SCHEDULED amount routed to brokerage, journaled as a plan. Both share the
 * per-class penalty + tax-action core (`AccountService.earlyWithdrawalTaxActions`,
 * design 45 §6) so they can never diverge on what a given early draw emits.
 *
 * Two classes (settled decisions §4.2):
 *   - TAX_DEFERRED (IRA + 401k, combined) → drawn IRA-then-401k; ordinary income
 *     + 10% penalty on the whole gross.
 *   - ROTH → contributions first (penalty/tax free), then earnings (penalty) —
 *     the contrib-first ordering of `reduceLedgerForWithdrawal`.
 *
 * Intra-year ordering (Q2): the toolset stamps these events with an `order`
 * ABOVE Roth conversions, so in a year with both, conversions apply first and
 * these withdrawals draw against the post-conversion balances.
 */

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Penalty rate for an early draw from `account` at `asOfMs`: the type's rate
 *  while the owner is below the age gate, else 0 (penalty-free above it). */
function penaltyRateFor(account, state, ownerKey, asOfMs) {
  const rules = getUsEarlyWithdrawalRules(account.type);
  if (!rules) return 0;
  const birthDate = getBirthDate(state, account.ownerId ?? ownerKey);
  if (!birthDate) return rules.penaltyRate;       // unknown age → assume below the gate
  const ageDecimal = (asOfMs - birthDate) / MS_PER_YEAR;
  return ageDecimal < rules.ageThreshold ? rules.penaltyRate : 0;
}

// ─── Reducer ────────────────────────────────────────────────────────────────

/**
 * Applies a scheduled early withdrawal: per class, draw the gross (capped to the
 * account's drawable balance), reduce its basis ledger, penalize + emit the
 * withdrawal-tax actions, and route the NET cash (gross − penalty) to the
 * destination — landing at cost basis = market when that's a brokerage. Income
 * tax on the draw is owed separately via the chained tax actions (paid from
 * another source, exactly like a Roth conversion's tax).
 */
export class ScheduledEarlyWithdrawalApplyReducer extends AccountServiceReducer {
  static type        = 'ScheduledEarlyWithdrawalApplyReducer';
  static description  = 'Draws a scheduled early withdrawal per class (IRA→401k, Roth contrib→earnings), penalizes + emits withdrawal-tax actions, and routes net cash to brokerage at market basis.';
  static actionType  = 'SCHEDULED_EARLY_WITHDRAWAL_APPLY';

  constructor({ accountService }) {
    super('Scheduled Early Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService       = accountService;
    this.reducedActionTypes   = ['SCHEDULED_EARLY_WITHDRAWAL_APPLY'];
    this.generatedActionTypes = [
      'IRA_WITHDRAWAL_CONTRIB_TAX', 'IRA_WITHDRAWAL_EARNINGS_TAX',
      'K401_WITHDRAWAL_TAX', 'ROTH_WITHDRAWAL_EARNINGS_TAX',
    ];
  }

  reduce(state, action, date) {
    const svc    = this.accountService;
    const asOfMs = date instanceof Date ? date.getTime() : (date ?? null);
    const {
      taxDeferredAmount = 0, rothAmount = 0,
      iraKey, k401Key, rothKey, destinationKey, residency,
    } = action;

    const dest = destinationKey ? state[destinationKey] : null;
    if (!dest) return this.newState(state, {}, []);   // no landing account → no-op

    const patch      = {};
    const taxActions = [];
    let   netTotal   = 0;

    // Draw `wantGross` from one account (capped to drawable), mutate its ledger +
    // holdings, collect the tax actions, and return the gross actually drawn and
    // the net (gross − penalty) to forward to the destination.
    const drawFrom = (key, wantGross) => {
      if (!key || wantGross <= 1e-9) return 0;
      const account = state[key];
      if (!account) return 0;
      const drawable = svc._drawableBalance(account);
      const gross    = Math.min(wantGross, drawable);
      if (gross <= 1e-9) return 0;

      const penaltyRate = penaltyRateFor(account, state, key, asOfMs);
      const { fromContrib, fromEarnings } = svc.reduceLedgerForWithdrawal(account, gross);
      const { penalty, taxActions: ta }   = svc.earlyWithdrawalTaxActions(
        account, { fromContrib, fromEarnings, penaltyRate, residency }
      );
      svc.transaction(account, -gross, date);   // balance + holdings (ledger already reduced)
      taxActions.push(...ta);
      patch[key] = { ...account };              // capture in-place mutations
      netTotal  += gross - penalty;
      return gross;
    };

    // TAX_DEFERRED class: IRA first, then 401k (combined class, defined order).
    let tdRemaining = taxDeferredAmount;
    for (const key of [iraKey, k401Key]) {
      if (tdRemaining <= 1e-9) break;
      tdRemaining -= drawFrom(key, tdRemaining);
    }

    // ROTH class: contributions first (penalty-free), then earnings (penalty).
    drawFrom(rothKey, rothAmount);

    // Land the net cash in the destination. Brokerage carries a contribution/
    // earnings ledger separate from holdings: the deposited cash is all cost
    // basis (zero unrealized gain), so it bumps contributionBasis only — which
    // is exactly what the AU step-up (design 36 §12.2) keys off at the move.
    if (netTotal > 1e-9) {
      svc.transaction(dest, +netTotal, date);
      patch[destinationKey] = ('contributionBasis' in dest)
        ? { ...dest, contributionBasis: (dest.contributionBasis ?? 0) + netTotal }
        : { ...dest };
    }

    return this.newState(state, patch, taxActions);
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * Fires on the scheduled `SCHEDULED_EARLY_WITHDRAWAL` event and dispatches the
 * apply action plus journal-visible records (the planned amount + post-draw
 * balances). Emits nothing when neither class has a positive amount or there is
 * no destination to land the cash in.
 */
export class EarlyWithdrawalPolicyHandler extends HandlerEntry {
  static type        = 'EarlyWithdrawalPolicyHandler';
  static description  = 'Dispatches SCHEDULED_EARLY_WITHDRAWAL_APPLY for the scheduled per-class amounts and records the move.';
  static eventType   = 'SCHEDULED_EARLY_WITHDRAWAL';

  constructor() {
    super(null, 'Early Withdrawal Policy');
    this.generatedActionTypes = ['SCHEDULED_EARLY_WITHDRAWAL_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ state, data }) {
    const {
      taxDeferredAmount = 0, rothAmount = 0,
      iraKey, k401Key, rothKey, destinationKey, owner,
    } = data;

    if ((taxDeferredAmount <= 0 && rothAmount <= 0) || !destinationKey || !state[destinationKey]) return [];

    const ownerKey  = owner ?? primaryPersonKey(state);
    const residency = getResidency(state, ownerKey);

    const actions = [
      {
        type: 'SCHEDULED_EARLY_WITHDRAWAL_APPLY',
        taxDeferredAmount, rothAmount,
        iraKey, k401Key, rothKey, destinationKey, residency,
      },
      new FieldValueAction('early_withdrawal', 'Early Withdrawal', taxDeferredAmount + rothAmount),
    ];
    for (const key of [iraKey, k401Key, rothKey, destinationKey]) {
      if (key && state[key]) actions.push(new RecordBalanceAction(`${key}.balance`, key));
    }
    return actions;
  }
}
