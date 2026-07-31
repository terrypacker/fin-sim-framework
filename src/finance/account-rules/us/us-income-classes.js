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
import { resolveCashKey, resolveDestinationCashKey, resolveSaleDestinationKey } from '../cash-routing.js';

/** Resolve the US cash pool (legacy tail; prefer resolveCashKey for routing). */
const usCash = (state) => state.usSavingsAccount ?? state.checkingAccount;

/** Default US cash pool key when no saleDestinationAccount is provided. */
const defaultUsCashKey = (state) =>
  state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';

/**
 * Resolve the destination state key, falling back to the default US cash pool.
 * Delegates to the shared resolver so a `saleDestinationAccount` persisted as an
 * account *id* rather than a state key still finds its account (design 72 §2).
 */
const resolveDestinationKey = (state, saleDestinationAccount) =>
  resolveSaleDestinationKey(state, saleDestinationAccount, defaultUsCashKey(state));

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-37: Social Security Income — credit US cash pool, chain SS_INCOME_TAX.
 * 85% of the amount is US-taxable ordinary income.
 */
export class SsIncomeApplyReducer extends AccountServiceReducer {
  static type        = 'SsIncomeApplyReducer';
  static description = 'Credits the US cash pool with SS income; chains SS_INCOME_TAX (85% taxable).';
  static actionType  = 'SS_INCOME_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('SS Income Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['SS_INCOME_APPLY'];
    this.generatedActionTypes = ['SS_INCOME_TAX'];
  }

  reduce(state, action) {
    const { amount, residency, personKey } = action;
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], amount, null);
    // personKey carries through to the AU return (design 76 Gap B). Absent on the
    // bare-event path, which has no person — that falls back to the household scalar.
    return this.newState(state, {}, [{ type: 'SS_INCOME_TAX', amount, residency, personKey }]);
  }
}

/**
 * EVT-38: Wages (Gross) — credit US cash pool, chain WAGES_INCOME_TAX.
 */
export class WagesIncomeApplyReducer extends AccountServiceReducer {
  static type        = 'WagesIncomeApplyReducer';
  static description = 'Credits the US cash pool with gross wages; chains WAGES_INCOME_TAX.';
  static actionType  = 'WAGES_INCOME_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Wages Income Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['WAGES_INCOME_APPLY'];
    this.generatedActionTypes = ['WAGES_INCOME_TAX'];
  }

  reduce(state, action) {
    const { amount, residency, personKey, targetKey } = action;
    // Credit the transaction account the handler resolved; fall back to the single
    // US cash pool for legacy actions saved without a targetKey.
    this.accountService.transaction(state[targetKey] ?? state[resolveCashKey(this.stateRegistry, 'US', state)], amount, null);
    return this.newState(state, {}, [{ type: 'WAGES_INCOME_TAX', amount, residency, personKey }]);
  }
}

/**
 * EVT-39: Wages Taxes Withheld — debit US cash pool, track usWithheldYTD.
 * No separate TAX action; withholding is bookkeeping, not a taxable event.
 */
export class WagesWithheldApplyReducer extends AccountServiceReducer {
  static type        = 'WagesWithheldApplyReducer';
  static description = 'Debits the US cash pool by the withheld amount and increments usWithheldYTD.';
  static actionType  = 'WAGES_WITHHELD_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Wages Withheld Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = ['WAGES_WITHHELD_APPLY'];
  }

  reduce(state, action) {
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], -action.amount, null);
    return this.newState(state, {
      usWithheldYTD: (state.usWithheldYTD ?? 0) + action.amount,
    });
  }
}

/**
 * EVT-48: Self-Employment Income (US) — credit US cash pool, chain SE_INCOME_US_TAX.
 */
export class SeIncomeUsApplyReducer extends AccountServiceReducer {
  static type        = 'SeIncomeUsApplyReducer';
  static description = 'Credits the US cash pool with US self-employment income; chains SE_INCOME_US_TAX.';
  static actionType  = 'SE_INCOME_US_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('SE Income US Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['SE_INCOME_US_APPLY'];
    this.generatedActionTypes = ['SE_INCOME_US_TAX'];
  }

  reduce(state, action) {
    const { amount, residency, personKey, targetKey } = action;
    // Credit the transaction account the handler resolved (design 69, parity with
    // wages); fall back to the single US cash pool for legacy actions.
    this.accountService.transaction(state[targetKey] ?? state[resolveCashKey(this.stateRegistry, 'US', state)], amount, null);
    return this.newState(state, {}, [{ type: 'SE_INCOME_US_TAX', amount, residency, personKey }]);
  }
}

/**
 * EVT-50: Bonus — credit US cash pool, chain BONUS_TAX.
 */
export class BonusApplyReducer extends AccountServiceReducer {
  static type        = 'BonusApplyReducer';
  static description = 'Credits the US cash pool with the bonus amount; chains BONUS_TAX.';
  static actionType  = 'BONUS_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Bonus Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['BONUS_APPLY'];
    this.generatedActionTypes = ['BONUS_TAX'];
  }

  reduce(state, action) {
    const { amount, residency, personKey } = action;
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], amount, null);
    // A bonus is W-2 wages and belongs wholly to the earner — Australia assesses it
    // to them alone. BonusHandler.resolveBonusEarner picks the person (explicit
    // data.personId, else the sole active earner, else the highest wage), so this
    // always carries a personKey in practice.
    return this.newState(state, {}, [{ type: 'BONUS_TAX', amount, residency, personKey }]);
  }
}

/**
 * EVT-51: Company Sale — credit the destination account with the sale proceeds,
 * zero out the CompanyEquity asset (when the sale is asset-backed), and chain
 * COMPANY_SALE_TAX with the capital gain. Gain = salePrice - costBasis; taxed as
 * a US long-term capital gain (and an AU capital gain when AU-resident).
 */
export class CompanySaleApplyReducer extends AccountServiceReducer {
  static type        = 'CompanySaleApplyReducer';
  static description = 'Credits the destination account with company sale proceeds, zeroes the CompanyEquity asset, and chains COMPANY_SALE_TAX with the capital gain.';
  static actionType  = 'COMPANY_SALE_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Company Sale Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['COMPANY_SALE_APPLY'];
    this.generatedActionTypes = ['COMPANY_SALE_TAX'];
  }

  reduce(state, action) {
    const { salePrice, costBasis, residency, stateKey, destinationKey } = action;
    const gain    = Math.max(0, salePrice - costBasis);
    const destKey = resolveDestinationCashKey(this.stateRegistry, 'US', state, destinationKey);
    this.accountService.transaction(state[destKey], salePrice, null);
    const stateUpdate = {};
    const eq = stateKey ? state[stateKey] : null;
    if (stateKey && eq != null) {
      stateUpdate[stateKey] = { ...eq, value: 0 };
    }

    // AU gain from the s855-45 stepped-up basis (design 72 §3): a vested foreign
    // stake is deemed re-acquired at market value on commencing AU residency, so a
    // post-move sale is AU-assessable only on post-arrival appreciation. The US gain
    // above is unchanged — after the move the two countries hold different bases.
    // Falls back to the raw gain when no AU basis was stamped, so pre-move sales and
    // non-moving scenarios are byte-identical to pre-72 behavior.
    const auBasis = eq?.costBaseByCountry?.AU ?? costBasis;
    const auGain  = Math.max(0, salePrice - auBasis);
    // AU CGT-reform indexation (design 57): index the stepped-up basis from the
    // deemed-acquisition price level to the sale-year level. Without a stamped level
    // there is nothing to index from, so the real gain is the nominal AU gain.
    let auIndexedGain = auGain;
    if (eq?.acquisitionPriceLevel != null) {
      const nowLevel     = state.cpiAccumulator?.AU ?? state.inflationAccumulator?.AU ?? 1;
      const indexedBasis = auBasis * (nowLevel / eq.acquisitionPriceLevel);
      auIndexedGain = Math.max(0, salePrice - indexedBasis);
    }

    // Design 76 Gap B: carry the equity's ownership so the AU gain is attributed to
    // its holder rather than halved across the household (mirrors AU_HOUSE_SALE_TAX).
    return this.newState(state, stateUpdate, [{ type: 'COMPANY_SALE_TAX', gain, auGain, auIndexedGain, residency,
      // Sale detail for Schedule D / Form 8949 (mirrors US_HOUSE_SALE_TAX). `gain`
      // alone identifies the tax, not the disposal — a return has to show what was
      // sold, for how much, and against what basis.
      proceeds: salePrice, costBasis, description: stateKey || 'Company Equity',
      ownershipType: eq?.ownershipType, ownerId: eq?.ownerId, owners: eq?.owners }]);
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class SsIncomeHandler extends HandlerEntry {
  static type        = 'SsIncomeHandler';
  static description = 'Dispatches SS_INCOME_APPLY with the monthly SS amount and AU residency flag.';
  static eventType   = 'SS_INCOME';

  constructor() {
    super(null, 'Social Security Income');
    this.generatedActionTypes = ['SS_INCOME_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      { type: 'SS_INCOME_APPLY', amount: data.amount, residency: state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null },
      new FieldValueAction('ss_income', 'Social Security Income', data.amount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

export class WagesIncomeHandler extends HandlerEntry {
  static type        = 'WagesIncomeHandler';
  static description = 'Dispatches WAGES_INCOME_APPLY with gross wages amount and AU residency flag.';
  static eventType   = 'WAGES_INCOME';

  constructor() {
    super(null, 'Wages Income');
    this.generatedActionTypes = ['WAGES_INCOME_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      { type: 'WAGES_INCOME_APPLY', amount: data.amount, residency: state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null },
      new FieldValueAction('wages_income', 'Wages Income', data.amount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

export class WagesWithheldHandler extends HandlerEntry {
  static type        = 'WagesWithheldHandler';
  static description = 'Dispatches WAGES_WITHHELD_APPLY with the withheld tax amount.';
  static eventType   = 'WAGES_WITHHELD';

  constructor() {
    super(null, 'Wages Withheld');
    this.generatedActionTypes = ['WAGES_WITHHELD_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      { type: 'WAGES_WITHHELD_APPLY', amount: data.amount },
      new FieldValueAction('wages_withheld', 'Wages Withheld', data.amount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

export class SeIncomeUsHandler extends HandlerEntry {
  static type        = 'SeIncomeUsHandler';
  static description = 'Dispatches SE_INCOME_US_APPLY with the self-employment income amount and AU residency flag.';
  static eventType   = 'SE_INCOME_US';

  constructor() {
    super(null, 'Self-Employment Income (US)');
    this.generatedActionTypes = ['SE_INCOME_US_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      { type: 'SE_INCOME_US_APPLY', amount: data.amount, residency: state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null },
      new FieldValueAction('se_income_us', 'Self-Employment Income (US)', data.amount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

/** Whether `person` is drawing employment income on `date` (matches MonthlyWagesHandler). */
function _isEarning(person, date) {
  if ((person?.monthlyWage ?? 0) <= 0) return false;
  const retDate = person.retirementDate;
  return retDate ? date < retDate : true;
}

/** One warning per session for an unattributed bonus, not one per event. */
let _warnedBonusFallback = false;

/**
 * Resolve which person a bonus belongs to (design 76 P5).
 *
 * A bonus is W-2 wages and belongs wholly to the person who earned it — Australia
 * assesses it to them alone, and personal services income is never apportionable.
 * The BONUS event historically carried no person, so this resolves one:
 *
 *   1. `data.personId`, when the event names an earner. Always preferred.
 *   2. The only person still drawing wages on this date. Unambiguous whenever one
 *      spouse has retired, which is the common case for a bonus late in a career.
 *   3. The highest earner among those still working, else the highest earner overall.
 *      A deterministic tie-break rather than a coin flip.
 *
 * This used to be allowed to fall through to a household scalar, which
 * `computeAuTaxPerPerson` then split by headcount. That option is gone: the scalars
 * were deleted once every other income type attributed, and an unresolved bonus would
 * now be *dropped* from the AU return rather than merely mis-split. A documented
 * inference beats silently losing the income, and case 3 warns so it is visible.
 *
 * @returns {string|null} personKey, or null when the household has no people at all
 */
export function resolveBonusEarner(state, data, date) {
  const people = state?.people ?? {};
  const keys   = Object.keys(people).filter(k => people[k] != null);
  if (keys.length === 0) return null;

  // (1) Explicit.
  if (data?.personId != null && people[data.personId] != null) return data.personId;

  // (2) Exactly one person is still working.
  const working = keys.filter(k => _isEarning(people[k], date));
  if (working.length === 1) return working[0];

  // (3) Highest wage among the plausible set; deterministic, and warned about.
  const pool = working.length > 0 ? working : keys;
  const best = pool.reduce((a, b) =>
    (people[b].monthlyWage ?? 0) > (people[a].monthlyWage ?? 0) ? b : a, pool[0]);
  if (keys.length > 1 && !_warnedBonusFallback) {
    _warnedBonusFallback = true;
    console.warn(
      `[design 76] A BONUS event carries no personId and more than one earner is plausible; `
      + `attributing it to "${people[best].name || best}" (highest wage). Australia assesses a bonus `
      + `to the person who earned it, so set the event's data.personId to make this explicit.`);
  }
  return best;
}

export class BonusHandler extends HandlerEntry {
  static type        = 'BonusHandler';
  static description = 'Dispatches BONUS_APPLY with the bonus amount, the earning person, and their AU residency flag.';
  static eventType   = 'BONUS';

  constructor() {
    super(null, 'Bonus');
    this.generatedActionTypes = ['BONUS_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data, state, date }) {
    const cashKey   = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    const personKey = resolveBonusEarner(state, data, date);
    // Residency of the EARNER, not of whoever happens to be first in state.people —
    // it decides whether Australia assesses this bonus at all.
    const residency = state.people?.[personKey]?.residency
      ?? state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null;
    return [
      { type: 'BONUS_APPLY', amount: data.amount, residency, personKey },
      new FieldValueAction('bonus', 'Bonus', data.amount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

export class CompanySaleHandler extends HandlerEntry {
  static type        = 'CompanySaleHandler';
  static description = 'Dispatches COMPANY_SALE_APPLY with sale price, cost basis, residency, backing asset stateKey, and resolved destination account.';
  static eventType   = 'COMPANY_SALE';

  constructor() {
    super(null, 'Company Sale');
    this.generatedActionTypes = ['COMPANY_SALE_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const equityState    = data.stateKey ? state[data.stateKey] : null;
    const destinationKey = resolveDestinationKey(state, data.saleDestinationAccount);
    return [
      {
        type:         'COMPANY_SALE_APPLY',
        salePrice:    data.salePrice ?? equityState?.value ?? 0,
        costBasis:    data.costBasis,
        residency:    state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null,
        stateKey:     data.stateKey ?? null,
        destinationKey,
      },
      new RecordBalanceAction(`${destinationKey}.balance`, destinationKey),
    ];
  }
}
