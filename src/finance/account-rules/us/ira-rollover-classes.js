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
import { FieldValueAction, RecordBalanceAction } from '../../../simulation-framework/actions.js';
import { getUniformDistributionPeriod } from './us-rmd-uniform-table.js';
import { resolveCashKey } from '../cash-routing.js';
import { scaleHoldings } from '../../holdings/holding-utils.js';

/** Resolve the US cash pool (legacy tail; prefer resolveCashKey for routing). */
const usCash = (state) => state.usSavingsAccount ?? state.checkingAccount;

/**
 * Split `amount` across an IRA's contribution/earnings basis **pro rata** — the
 * IRC §408(d)(2) aggregation rule, under which any distribution from a
 * traditional IRA carries basis and earnings in proportion rather than letting
 * the taxpayer choose. (It is the rule that defeats the backdoor Roth.)
 *
 * Exported because the Roth conversion path (design 84, Option 2b) has to credit
 * the Roth on exactly the basis it debits the IRA, or the two ledgers describe
 * different transactions.
 */
export function proRataIraSplit(ia, amount) {
  const contrib  = ia?.contributionBasis ?? 0;
  const earnings = ia?.earningsBasis     ?? 0;
  const total    = contrib + earnings;
  if (!(total > 0) || !(amount > 0)) return { fromContrib: 0, fromEarnings: 0 };
  const draw         = Math.min(amount, total);
  const fromEarnings = +(draw * (earnings / total)).toFixed(2);
  return { fromContrib: +(draw - fromEarnings).toFixed(2), fromEarnings };
}

/**
 * Reduce IRA by `amount`, drawing from contributionBasis first then earningsBasis.
 * Scales holdings proportionally to maintain the §4.4 invariant.
 * Returns the updated iraAccount object.
 *
 * `proRata` switches the split to `proRataIraSplit` above. The contribution-first
 * default is left alone deliberately: it is what every other rollover path has
 * always done, and for a traditional IRA — whose basis is pre-tax in this engine —
 * the US charge is the whole gross either way, so nothing downstream of those
 * callers turns on it. It DOES turn on it for a Roth conversion, where the split
 * decides how much of the money is s99B corpus (design 84 G11).
 */
export function debitIra(ia, amount, { proRata = false } = {}) {
  const { fromContrib, fromEarnings } = proRata
    ? proRataIraSplit(ia, amount)
    : {
        fromContrib:  Math.min(amount, ia.contributionBasis),
        fromEarnings: Math.min(amount - Math.min(amount, ia.contributionBasis), ia.earningsBasis),
      };
  const newBalance = ia.balance - amount;

  const result = {
    ...ia,
    balance:           newBalance,
    contributionBasis: ia.contributionBasis - fromContrib,
    earningsBasis:     ia.earningsBasis     - fromEarnings,
  };

  if (ia.balance > 0) {
    // Same helper as every other value move, so par scales with the position. No vintage:
    // this helper only ever DEBITS (`newBalance = ia.balance - amount`), which is a
    // proportional sell — there is no new money here to open a lot for (design 93 §5.0a).
    result.holdings = scaleHoldings(ia.holdings, ia.balance, newBalance);
  }

  return result;
}

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-35: IRA Rollover Withdrawal — credit US cash pool, debit IRA (contrib first
 * then earnings).  No penalty regardless of age (rollovers are penalty-exempt).
 * Chains IRA_ROLLOVER_WITHDRAWAL_TAX (ordinary income).
 */
export class IraRolloverWithdrawalApplyReducer extends AccountServiceReducer {
  static type        = 'IraRolloverWithdrawalApplyReducer';
  static description = 'Credits the US cash pool and debits the IRA (no penalty); chains IRA_ROLLOVER_WITHDRAWAL_TAX.';
  static actionType  = 'IRA_ROLLOVER_WITHDRAWAL_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('IRA Rollover Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['IRA_ROLLOVER_WITHDRAWAL_APPLY'];
    this.generatedActionTypes = ['IRA_ROLLOVER_WITHDRAWAL_TAX'];
  }

  reduce(state, action) {
    const { amount, residency } = action;
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], amount, null);
    // Per-account (design 55 §7 / 76 Gap B): honor a handler-stamped stateKey so a
    // household with more than one IRA debits — and taxes — the right person's.
    const key = action.stateKey ?? 'iraAccount';
    return this.newState(
      state,
      { [key]: debitIra(state[key], amount) },
      // Design 76 Gap B: stamp the account so the AU return attributes to its owner.
      [{ type: 'IRA_ROLLOVER_WITHDRAWAL_TAX', amount, residency, stateKey: key }]
    );
  }
}

/**
 * EVT-40: IRA RMD — credit US cash pool, debit IRA (required at age 73+, SECURE 2.0).
 * No penalty.  Chains IRA_RMD_TAX (ordinary income).
 * Accepts optional action.stateKey to support multiple IRA accounts per person.
 */
export class IraRmdApplyReducer extends AccountServiceReducer {
  static type        = 'IraRmdApplyReducer';
  static description = 'Credits the US cash pool and debits the IRA for the required minimum distribution; chains IRA_RMD_TAX.';
  static actionType  = 'IRA_RMD_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('IRA RMD Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['IRA_RMD_APPLY'];
    this.generatedActionTypes = ['IRA_RMD_TAX'];
  }

  reduce(state, action) {
    const { amount, residency } = action;
    const stateKey = action.stateKey ?? 'iraAccount';
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], amount, null);
    return this.newState(
      state,
      { [stateKey]: debitIra(state[stateKey], amount) },
      // Design 76 Gap B: stamp the account so the AU return attributes to its owner.
      [{ type: 'IRA_RMD_TAX', amount, residency, stateKey }]
    );
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class IraRolloverWithdrawalHandler extends HandlerEntry {
  static type        = 'IraRolloverWithdrawalHandler';
  static description = 'Dispatches IRA_ROLLOVER_WITHDRAWAL_APPLY — no penalty applied (rollover exemption).';
  static eventType   = 'IRA_ROLLOVER_WITHDRAWAL';

  constructor() {
    super(null, 'IRA Rollover Withdrawal');
    this.generatedActionTypes = ['IRA_ROLLOVER_WITHDRAWAL_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ state, data }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      {
        type:         'IRA_ROLLOVER_WITHDRAWAL_APPLY',
        amount:       data.amount,
        residency: state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null,
      },
      new FieldValueAction('ira_rollover_withdrawal', 'IRA Rollover Withdrawal', data.amount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

export class IraRmdHandler extends HandlerEntry {
  static type        = 'IraRmdHandler';
  static description = 'Dispatches IRA_RMD_APPLY for the required minimum distribution.';
  static eventType   = 'IRA_RMD';

  constructor() {
    super(null, 'IRA RMD');
    this.generatedActionTypes = ['IRA_RMD_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ state, data }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      {
        type:         'IRA_RMD_APPLY',
        amount:       data.amount,
        residency: state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null,
      },
      new FieldValueAction('ira_rmd', 'IRA RMD', data.amount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

/**
 * Auto-scheduled annual IRA Required Minimum Distribution handler.
 *
 * Fires on the IRA_ANNUAL_RMD event (year-end) for a specific IRA account / owner.
 * Checks whether the associated person has reached RMD age (per the AccountRulesEngine),
 * calculates the distribution using the IRS Uniform Lifetime Table, and dispatches
 * IRA_RMD_APPLY.
 *
 * Rules per SECURE 2.0 Act:
 *   - First RMD: due by December 31 of the year the owner turns 73 (default simulation
 *     behaviour — no delay).  IRS allows delay to April 1 of the following year, but
 *     that results in two RMDs in a single tax year.
 *   TODO: Support delayFirstRmd=true (April 1 grace period) and the resulting two-RMD year.
 *
 * RMD amount = current IRA balance / Uniform Lifetime distribution period for owner's age.
 *   TODO: IRS basis is the prior December 31 balance; simplified here to use the balance
 *         at the time the event fires.
 *
 * Early withdrawal penalties do not apply to RMDs.
 *   TODO: Enforce failure-to-withdraw penalty (50% of shortfall) if the full RMD is
 *         not taken — not yet implemented.
 *
 * @param {object} opts
 * @param {import('../../../finance/services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string}  opts.role              - ACCOUNT_ROLES.IRA
 * @param {string}  opts.ownerId           - Person id owning this IRA
 * @param {string}  [opts.stateKey]        - Explicit state key (falls back to registry lookup)
 * @param {import('../account-rules-engine.js').AccountRulesEngine} opts.accountRulesEngine
 */
export class IraAnnualRmdHandler extends HandlerEntry {
  static type        = 'IraAnnualRmdHandler';
  static description = 'Auto-calculates and dispatches the annual IRA RMD for the account owner once they reach age 73.';
  static eventType   = 'IRA_ANNUAL_RMD';

  constructor({ stateRegistry, role, ownerId, stateKey, accountRulesEngine } = {}) {
    super(null, 'IRA Annual RMD');
    this.stateRegistry      = stateRegistry;
    this.role               = role;
    this.ownerId            = ownerId;
    this._stateKeyFixed     = stateKey ?? null;
    this.accountRulesEngine = accountRulesEngine ?? null;
    this.generatedActionTypes = ['IRA_RMD_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  static fromJSON(d, services) {
    const h = new this(services ?? {});
    h.id = d.id;
    return h;
  }

  call({ date, state }) {
    const resolvedKey = this._stateKeyFixed ?? this.stateRegistry?.getStateKey(this.role, this.ownerId);
    const ira = state[resolvedKey];
    if (!ira || ira.balance <= 0) return [];

    const year   = date.getUTCFullYear();
    const rules  = this.accountRulesEngine?.get('US', year)?.getIraRmdRules?.();
    if (!rules) return [];

    const person = state.people?.[this.ownerId];
    if (!person?.birthDate) return [];

    const birthDate = person.birthDate instanceof Date ? person.birthDate : new Date(person.birthDate);
    const age = _getAge(birthDate, date);
    if (age < rules.rmdAge) return [];

    const distributionPeriod = getUniformDistributionPeriod(age);
    if (!distributionPeriod) return [];

    const rmdAmount = Math.round(ira.balance / distributionPeriod * 100) / 100;
    if (rmdAmount <= 0) return [];

    const cashKey  = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    const label    = `${person.name ?? this.ownerId} IRA RMD`;
    return [
      { type: 'IRA_RMD_APPLY', amount: rmdAmount, stateKey: resolvedKey, residency: person.residency ?? null },
      new FieldValueAction(`ira_annual_rmd_${this.ownerId}`, label, rmdAmount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
      new RecordBalanceAction(`${resolvedKey}.balance`, resolvedKey),
    ];
  }
}

/** Returns whole years of age as of asOfDate. */
function _getAge(birthDate, asOfDate) {
  const years = asOfDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const hadBirthday =
    asOfDate.getUTCMonth() > birthDate.getUTCMonth() ||
    (asOfDate.getUTCMonth() === birthDate.getUTCMonth() &&
      asOfDate.getUTCDate() >= birthDate.getUTCDate());
  return hadBirthday ? years : years - 1;
}
