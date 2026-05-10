/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../../simulation-framework/reducers.js';
import { HandlerEntry }       from '../../../simulation-framework/handlers.js';
import { FieldValueAction, RecordBalanceAction } from '../../../simulation-framework/actions.js';

/** Resolve the US cash pool. */
const usCash = (state) => state.usSavingsAccount ?? state.checkingAccount;

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-37: Social Security Income — credit US cash pool, chain SS_INCOME_TAX.
 * 85% of the amount is US-taxable ordinary income.
 */
export class SsIncomeApplyReducer extends Reducer {
  static description = 'Credits the US cash pool with SS income; chains SS_INCOME_TAX (85% taxable).';
  static actionType  = 'SS_INCOME_APPLY';

  constructor({ accountService }) {
    super('SS Income Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['SS_INCOME_APPLY'];
    this.generatedActionTypes = ['SS_INCOME_TAX'];
  }

  reduce(state, action) {
    const { amount, isAuResident } = action;
    this.accountService.transaction(usCash(state), amount, null);
    return this.newState(state, {}, [{ type: 'SS_INCOME_TAX', amount, isAuResident }]);
  }
}

/**
 * EVT-38: Wages (Gross) — credit US cash pool, chain WAGES_INCOME_TAX.
 */
export class WagesIncomeApplyReducer extends Reducer {
  static description = 'Credits the US cash pool with gross wages; chains WAGES_INCOME_TAX.';
  static actionType  = 'WAGES_INCOME_APPLY';

  constructor({ accountService }) {
    super('Wages Income Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['WAGES_INCOME_APPLY'];
    this.generatedActionTypes = ['WAGES_INCOME_TAX'];
  }

  reduce(state, action) {
    const { amount, isAuResident, personKey } = action;
    this.accountService.transaction(usCash(state), amount, null);
    return this.newState(state, {}, [{ type: 'WAGES_INCOME_TAX', amount, isAuResident, personKey }]);
  }
}

/**
 * EVT-39: Wages Taxes Withheld — debit US cash pool, track usWithheldYTD.
 * No separate TAX action; withholding is bookkeeping, not a taxable event.
 */
export class WagesWithheldApplyReducer extends Reducer {
  static description = 'Debits the US cash pool by the withheld amount and increments usWithheldYTD.';
  static actionType  = 'WAGES_WITHHELD_APPLY';

  constructor({ accountService }) {
    super('Wages Withheld Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes = ['WAGES_WITHHELD_APPLY'];
  }

  reduce(state, action) {
    this.accountService.transaction(usCash(state), -action.amount, null);
    return this.newState(state, {
      usWithheldYTD: (state.usWithheldYTD ?? 0) + action.amount,
    });
  }
}

/**
 * EVT-48: Self-Employment Income (US) — credit US cash pool, chain SE_INCOME_US_TAX.
 */
export class SeIncomeUsApplyReducer extends Reducer {
  static description = 'Credits the US cash pool with US self-employment income; chains SE_INCOME_US_TAX.';
  static actionType  = 'SE_INCOME_US_APPLY';

  constructor({ accountService }) {
    super('SE Income US Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['SE_INCOME_US_APPLY'];
    this.generatedActionTypes = ['SE_INCOME_US_TAX'];
  }

  reduce(state, action) {
    const { amount, isAuResident } = action;
    this.accountService.transaction(usCash(state), amount, null);
    return this.newState(state, {}, [{ type: 'SE_INCOME_US_TAX', amount, isAuResident }]);
  }
}

/**
 * EVT-50: Bonus — credit US cash pool, chain BONUS_TAX.
 */
export class BonusApplyReducer extends Reducer {
  static description = 'Credits the US cash pool with the bonus amount; chains BONUS_TAX.';
  static actionType  = 'BONUS_APPLY';

  constructor({ accountService }) {
    super('Bonus Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['BONUS_APPLY'];
    this.generatedActionTypes = ['BONUS_TAX'];
  }

  reduce(state, action) {
    const { amount, isAuResident } = action;
    this.accountService.transaction(usCash(state), amount, null);
    return this.newState(state, {}, [{ type: 'BONUS_TAX', amount, isAuResident }]);
  }
}

/**
 * EVT-51: Company Sale — credit US cash pool, chain COMPANY_SALE_TAX.
 * Gain = salePrice - costBasis.
 */
export class CompanySaleApplyReducer extends Reducer {
  static description = 'Credits the US cash pool with the company sale proceeds; chains COMPANY_SALE_TAX with the capital gain.';
  static actionType  = 'COMPANY_SALE_APPLY';

  constructor({ accountService }) {
    super('Company Sale Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['COMPANY_SALE_APPLY'];
    this.generatedActionTypes = ['COMPANY_SALE_TAX'];
  }

  reduce(state, action) {
    const { salePrice, costBasis, isAuResident } = action;
    const gain = Math.max(0, salePrice - costBasis);
    this.accountService.transaction(usCash(state), salePrice, null);
    return this.newState(state, {}, [{ type: 'COMPANY_SALE_TAX', gain, isAuResident }]);
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class SsIncomeHandler extends HandlerEntry {
  static description = 'Dispatches SS_INCOME_APPLY with the monthly SS amount and AU residency flag.';
  static eventType   = 'SS_INCOME';

  constructor() {
    super(null, 'Social Security Income');
    this.generatedActionTypes = ['SS_INCOME_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      { type: 'SS_INCOME_APPLY', amount: data.amount, isAuResident: state.isAuResident },
      new FieldValueAction('ss_income', 'Social Security Income', data.amount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

export class WagesIncomeHandler extends HandlerEntry {
  static description = 'Dispatches WAGES_INCOME_APPLY with gross wages amount and AU residency flag.';
  static eventType   = 'WAGES_INCOME';

  constructor() {
    super(null, 'Wages Income');
    this.generatedActionTypes = ['WAGES_INCOME_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      { type: 'WAGES_INCOME_APPLY', amount: data.amount, isAuResident: state.isAuResident },
      new FieldValueAction('wages_income', 'Wages Income', data.amount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

export class WagesWithheldHandler extends HandlerEntry {
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
  static description = 'Dispatches SE_INCOME_US_APPLY with the self-employment income amount and AU residency flag.';
  static eventType   = 'SE_INCOME_US';

  constructor() {
    super(null, 'Self-Employment Income (US)');
    this.generatedActionTypes = ['SE_INCOME_US_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      { type: 'SE_INCOME_US_APPLY', amount: data.amount, isAuResident: state.isAuResident },
      new FieldValueAction('se_income_us', 'Self-Employment Income (US)', data.amount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

export class BonusHandler extends HandlerEntry {
  static description = 'Dispatches BONUS_APPLY with the bonus amount and AU residency flag.';
  static eventType   = 'BONUS';

  constructor() {
    super(null, 'Bonus');
    this.generatedActionTypes = ['BONUS_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      { type: 'BONUS_APPLY', amount: data.amount, isAuResident: state.isAuResident },
      new FieldValueAction('bonus', 'Bonus', data.amount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

export class CompanySaleHandler extends HandlerEntry {
  static description = 'Dispatches COMPANY_SALE_APPLY with sale price, cost basis, and AU residency flag.';
  static eventType   = 'COMPANY_SALE';

  constructor() {
    super(null, 'Company Sale');
    this.generatedActionTypes = ['COMPANY_SALE_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      {
        type:         'COMPANY_SALE_APPLY',
        salePrice:    data.salePrice,
        costBasis:    data.costBasis,
        isAuResident: state.isAuResident,
      },
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}
