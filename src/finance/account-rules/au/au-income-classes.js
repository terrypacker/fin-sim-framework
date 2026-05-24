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
import { RecordBalanceAction } from '../../../simulation-framework/actions.js';

/** Resolve the AU cash pool. */
const auCash = (state) => state.auSavingsAccount ?? state.checkingAccount;

// ─── Reducer ─────────────────────────────────────────────────────────────────

/**
 * EVT-49: AU Self-Employment Income — credit AU cash pool, chain AU_SE_INCOME_TAX.
 * US: always ordinary income (US citizen taxed on worldwide income).
 * AU: ordinary income if AU resident.
 */
export class AuSeIncomeApplyReducer extends Reducer {
  static description = 'Credits the AU cash pool with self-employment income; chains AU_SE_INCOME_TAX.';
  static actionType  = 'SE_INCOME_AU_APPLY';

  constructor({ accountService }) {
    super('AU SE Income Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['SE_INCOME_AU_APPLY'];
    this.generatedActionTypes = ['AU_SE_INCOME_TAX'];
  }

  reduce(state, action) {
    const { amount, isAuResident } = action;
    this.accountService.transaction(auCash(state), amount, null);
    return this.newState(state, {}, [{ type: 'AU_SE_INCOME_TAX', amount, isAuResident }]);
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export class AuSeIncomeHandler extends HandlerEntry {
  static description = 'Dispatches SE_INCOME_AU_APPLY with the income amount and AU residency flag.';
  static eventType   = 'SE_INCOME_AU';

  constructor() {
    super(null, 'Self-Employment Income (AU)');
    this.generatedActionTypes = ['SE_INCOME_AU_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.auSavingsAccount != null ? 'auSavingsAccount' : 'checkingAccount';
    return [
      { type: 'SE_INCOME_AU_APPLY', amount: data.amount, isAuResident: state.isAuResident },
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}
