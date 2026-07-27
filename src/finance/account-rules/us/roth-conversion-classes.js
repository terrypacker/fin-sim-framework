/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY, AccountServiceReducer }  from '../../../simulation-framework/reducers.js';
import { HandlerEntry }                              from '../../../simulation-framework/handlers.js';
import { FieldValueAction, RecordBalanceAction }     from '../../../simulation-framework/actions.js';
import { debitIra, proRataIraSplit }                 from './ira-rollover-classes.js';

/**
 * Roth Conversion — EVT-52
 *
 * Converts a given amount from a Traditional IRA directly into the Roth IRA
 * (rolloverContribBasis bucket).  No cash pool is touched — the full gross
 * amount moves IRA→Roth.  The resulting ordinary income is recorded via
 * ROTH_CONVERSION_TAX and handled by the US tax module.  Any tax owed must
 * be paid from a separate source outside this event.
 *
 * Supports primary and spouse account pairs via the `owner` field.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveKeys(owner) {
  return owner === 'spouse'
    ? { iraKey: 'spouseIraAccount', rothKey: 'spouseRothAccount' }
    : { iraKey: 'iraAccount',       rothKey: 'rothAccount' };
}

function conversionActions(amount, iraKey, rothKey, residency) {
  return [
    { type: 'ROTH_CONVERSION_APPLY', amount, iraKey, rothKey, residency },
    new FieldValueAction('roth_conversion', 'Roth Conversion', amount),
    new RecordBalanceAction(`${iraKey}.balance`,  iraKey),
    new RecordBalanceAction(`${rothKey}.balance`, rothKey),
  ];
}

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-52: Roth Conversion Apply — debit IRA, credit Roth rolloverContribBasis.
 * Direct IRA→Roth transfer; no cash pool movement.
 * Chains ROTH_CONVERSION_TAX (ordinary income for US; also AU if resident).
 */
export class RothConversionApplyReducer extends AccountServiceReducer {
  static type        = 'RothConversionApplyReducer';
  static description = 'Debits the IRA and credits Roth rolloverContribBasis; no cash pool; chains ROTH_CONVERSION_TAX.';
  static actionType  = 'ROTH_CONVERSION_APPLY';

  constructor({ accountService }) { // accountService unused — no cash pool movement
    super('Roth Conversion Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['ROTH_CONVERSION_APPLY'];
    this.generatedActionTypes = ['ROTH_CONVERSION_TAX'];
  }

  reduce(state, action, date) {
    const { amount, iraKey, rothKey, residency } = action;
    const roth = state[rothKey];
    const ira  = state[iraKey];

    // Stamp a dated conversion lot so EVT-43 can apply the IRC §408A(d)(3)(F)
    // 5-year recapture per conversion (each conversion runs its own clock from
    // Jan 1 of its conversion year). Lots are kept in chronological (FIFO) order.
    const conversionMs = date instanceof Date ? date.getTime() : (date ?? null);

    // ─── s99B provenance: the conversion CARRIES it (design 84, Option 2b) ─────
    //
    // A conversion does not launder the source IRA's earnings into corpus. ATO
    // private advice 1051558091470 (checked into `docs/au-tax/`) answers exactly
    // this question — "Is the whole amount rolled over from Fund A to the account
    // considered corpus?" — with **No**: "the whole amount that was rolled into the
    // account from the Fund A fund would not be corpus in the account. You would
    // need to pay tax on the interest amount from the Fund A fund when it was
    // withdrawn." Corpus is "the total amount received less any amounts deposited
    // to the fund by the taxpayer, or on their behalf".
    //
    // So the two components travel to their own homes: the IRA's contributions are
    // deposited money and land as Roth CORPUS; the IRA's earnings are trust income
    // and land as Roth EARNINGS, where the ledger already assesses them on
    // withdrawal (EVT-44). That is why this reducer no longer stamps an
    // `taxableAmount` on the lot: the AU character now lives in the buckets, which
    // every withdrawal path reads, rather than in a per-lot annotation only the
    // conversion-aware paths knew to look at.
    //
    // PRO-RATA, not contributions-first. Two reasons. IRC §408(d)(2) aggregates all
    // traditional IRAs and makes any distribution proportional — the taxpayer does
    // not get to send the basis out first. And contributions-first quietly collapses
    // this whole treatment back into "the rollover is all corpus" for any conversion
    // smaller than the IRA's contribution basis, which is the position the ruling
    // rejects.
    const { fromContrib, fromEarnings } = proRataIraSplit(ira, amount);

    // Maintain §4.4 invariant: scale Roth holdings up to absorb the incoming amount.
    const newRoth = {
      ...roth,
      balance:               roth.balance                       + amount,
      rolloverContribBasis:  (roth.rolloverContribBasis  ?? 0) + fromContrib,
      rolloverEarningsBasis: (roth.rolloverEarningsBasis ?? 0) + fromEarnings,
      // The lot tracks the CORPUS leg only, because that is the bucket
      // `computeConversionRecapture` FIFO-consumes; its `amount` must tie to
      // `rolloverContribBasis` or the two desync. `taxableAmount: 0` is now always
      // right — the assessable leg went to `rolloverEarningsBasis` instead.
      rolloverConversions:  [ ...(roth.rolloverConversions ?? []), { amount: fromContrib, conversionMs, taxableAmount: 0 } ],
    };
    if (Array.isArray(roth.holdings) && roth.holdings.length > 0) {
      if (roth.balance > 0) {
        const rothFactor = (roth.balance + amount) / roth.balance;
        newRoth.holdings = roth.holdings.map(h => ({
          ...h,
          marketValue: +((h.marketValue ?? 0) * rothFactor).toFixed(2),
          costBasis:   +((h.costBasis   ?? 0) * rothFactor).toFixed(2),
        }));
      } else {
        // Roth was at zero; set the first (bootstrap) holding to the conversion amount.
        newRoth.holdings = roth.holdings.map((h, i) => i === 0
          ? { ...h, marketValue: +amount.toFixed(2), costBasis: +amount.toFixed(2) }
          : h
        );
      }
    }

    return this.newState(
      state,
      // Debit the IRA on the SAME basis the Roth was credited on, or the two
      // ledgers describe different transactions and the IRA's remaining
      // composition no longer matches what was taken out of it.
      { [iraKey]: debitIra(state[iraKey], amount, { proRata: true }), [rothKey]: newRoth },
      [{ type: 'ROTH_CONVERSION_TAX', amount, residency }]
    );
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * EVT-52: Roth Conversion — validates IRA balance then dispatches ROTH_CONVERSION_APPLY.
 * Supports owner: 'primary' (default) or 'spouse'.
 */
export class RothConversionHandler extends HandlerEntry {
  static type        = 'RothConversionHandler';
  static description = 'Validates IRA balance and dispatches ROTH_CONVERSION_APPLY; no cash-pool movement.';
  static eventType   = 'ROTH_CONVERSION';

  constructor() {
    super(null, 'Roth Conversion');
    this.generatedActionTypes = ['ROTH_CONVERSION_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ state, data }) {
    const { amount, owner = 'primary' } = data;
    const { iraKey, rothKey } = resolveKeys(owner);
    const iraBalance = state[iraKey]?.balance ?? 0;
    if (amount > iraBalance) {
      throw new Error(`RothConversion: requested ${amount} exceeds ${iraKey} balance ${iraBalance}`);
    }
    return conversionActions(amount, iraKey, rothKey, state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null);
  }
}

/**
 * Bracket-fill policy handler — fires on ROTH_CONVERSION_POLICY_EVALUATE.
 * Reads live usOrdinaryIncomeYTD to compute remaining bracket room, then
 * converts up to that amount (further capped by the IRA balance).
 * Emits nothing if room or IRA balance is zero.
 */
export class RothConversionPolicyHandler extends HandlerEntry {
  static type        = 'RothConversionPolicyHandler';
  static description = 'Bracket-fill policy: converts up to (targetIncome − usOrdinaryIncomeYTD), capped at IRA balance.';
  static eventType   = 'ROTH_CONVERSION_POLICY_EVALUATE';

  constructor() {
    super(null, 'Roth Conversion Policy');
    this.generatedActionTypes = ['ROTH_CONVERSION_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ state, data }) {
    const { targetIncome, iraKey, rothKey } = data;
    const room       = Math.max(0, targetIncome - state.usOrdinaryIncomeYTD);
    const iraBalance = state[iraKey]?.balance ?? 0;
    const amount     = Math.min(room, iraBalance);
    if (amount <= 0) return [];
    return conversionActions(amount, iraKey, rothKey, state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null);
  }
}
