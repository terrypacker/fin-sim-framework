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
import { debitIra }                                  from './ira-rollover-classes.js';

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

  reduce(state, action) {
    const { amount, iraKey, rothKey, residency } = action;
    const roth = state[rothKey];

    // Maintain §4.4 invariant: scale Roth holdings up to absorb the incoming amount.
    const newRoth = {
      ...roth,
      balance:              roth.balance                      + amount,
      rolloverContribBasis: (roth.rolloverContribBasis ?? 0) + amount,
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
      { [iraKey]: debitIra(state[iraKey], amount), [rothKey]: newRoth },
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
