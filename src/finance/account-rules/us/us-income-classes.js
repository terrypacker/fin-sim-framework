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
    const { amount, residency } = action;
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], amount, null);
    return this.newState(state, {}, [{ type: 'SS_INCOME_TAX', amount, residency }]);
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
    const { amount, residency } = action;
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], amount, null);
    return this.newState(state, {}, [{ type: 'BONUS_TAX', amount, residency }]);
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

    return this.newState(state, stateUpdate, [{ type: 'COMPANY_SALE_TAX', gain, auGain, auIndexedGain, residency }]);
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

export class BonusHandler extends HandlerEntry {
  static type        = 'BonusHandler';
  static description = 'Dispatches BONUS_APPLY with the bonus amount and AU residency flag.';
  static eventType   = 'BONUS';

  constructor() {
    super(null, 'Bonus');
    this.generatedActionTypes = ['BONUS_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      { type: 'BONUS_APPLY', amount: data.amount, residency: state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null },
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
