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
import { creditPay } from '../../payroll/wage-splits.js';
import { resolveCashKey } from '../cash-routing.js';

/** Resolve the AU cash pool (legacy tail; prefer resolveCashKey for routing). */
const auCash = (state) => state.auSavingsAccount ?? state.checkingAccount;

// ─── Reducer ─────────────────────────────────────────────────────────────────

/**
 * EVT-49: AU Self-Employment Income — credit AU cash pool, chain AU_SE_INCOME_TAX.
 * US: always ordinary income (US citizen taxed on worldwide income).
 * AU: ordinary income if the earner is AU-resident OR the services were performed
 * in Australia — see `bookAuPersonalServicesIncome` in au-tax-module-2026.
 *
 * Design 73 §6b: like AUD wages, this reducer is about the fee's *denomination*,
 * not its source, so it forwards `workCountry` — where the services are actually
 * performed — to the tax action. Before §6b it destructured four fields and rebuilt
 * the tax action from those alone, dropping the source attribute one hop after
 * PayrollHandler computed it.
 */
export class AuSeIncomeApplyReducer extends AccountServiceReducer {
  static type        = 'AuSeIncomeApplyReducer';
  static description = 'Credits the AU cash pool with self-employment income; chains AU_SE_INCOME_TAX.';
  static actionType  = 'SE_INCOME_AU_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('AU SE Income Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['SE_INCOME_AU_APPLY'];
    this.generatedActionTypes = ['AU_SE_INCOME_TAX'];
  }

  reduce(state, action) {
    const { amount, residency, personKey, workCountry } = action;
    // Credit the transaction account the handler resolved (design 69, parity with
    // AU wages); fall back to the single AU cash pool for legacy actions.
    // Design 95 §6 phase 2 — honours `splits` when the handler stamped them,
    // otherwise credits the single targetKey exactly as before.
    creditPay(this.accountService, state, action, resolveCashKey(this.stateRegistry, 'AU', state));
    // `workCountry` is absent on actions saved before design 73 §6b and on the bare
    // SE_INCOME_AU event path; the tax reducer falls back to residency, which is the
    // pre-73 assumption for a resident earner.
    return this.newState(state, {}, [{ type: 'AU_SE_INCOME_TAX', amount, residency, personKey, workCountry }]);
  }
}

/**
 * Design 50: Wages **paid in AUD** — credit AU cash pool (native AUD), chain
 * AU_WAGES_INCOME_TAX.
 *
 * Fired by PayrollHandler for any person whose `wageCurrency` is AUD, so an
 * AU-denominated wage lands in the AUD savings account as AUD (not coerced into
 * USD in the US pool).
 *
 * Design 73 Gap 1: this reducer is about the wage's *denomination*, NOT its source.
 * It was documented as "AU-source wages", and that misleading docstring is what let
 * the defect survive review: an Australian employer can pay AUD to someone who
 * never sets foot in Australia, and that wage is not AU-source. The chained
 * AU_WAGES_INCOME_TAX therefore carries `workCountry` — where the employment is
 * actually exercised — alongside `personKey` and `residency`, and branches on
 * source first. Crediting AUD to an AU account is a cash-flow fact; it says nothing
 * about which country may tax the wage.
 */
export class AuWagesIncomeApplyReducer extends AccountServiceReducer {
  static type        = 'AuWagesIncomeApplyReducer';
  static description = 'Credits the AU cash pool with wages paid in AUD (native AUD); chains AU_WAGES_INCOME_TAX.';
  static actionType  = 'AU_WAGES_INCOME_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('AU Wages Income Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['AU_WAGES_INCOME_APPLY'];
    this.generatedActionTypes = ['AU_WAGES_INCOME_TAX'];
  }

  reduce(state, action) {
    const { amount, residency, personKey, workCountry } = action;
    // Credit the transaction account the handler resolved; fall back to the single
    // AU cash pool for legacy actions saved without a targetKey.
    // Design 95 §6 phase 2 — honours `splits` when the handler stamped them,
    // otherwise credits the single targetKey exactly as before.
    creditPay(this.accountService, state, action, resolveCashKey(this.stateRegistry, 'AU', state));
    // `workCountry` is absent on actions saved before design 73; the tax reducer
    // falls back to residency, which is the pre-73 assumption for a resident earner.
    return this.newState(state, {}, [{ type: 'AU_WAGES_INCOME_TAX', amount, residency, personKey, workCountry }]);
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export class AuSeIncomeHandler extends HandlerEntry {
  static type        = 'AuSeIncomeHandler';
  static description = 'Dispatches SE_INCOME_AU_APPLY with the income amount and AU residency flag.';
  static eventType   = 'SE_INCOME_AU';

  constructor() {
    super(null, 'Self-Employment Income (AU)');
    this.generatedActionTypes = ['SE_INCOME_AU_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.auSavingsAccount != null ? 'auSavingsAccount' : 'checkingAccount';
    return [
      { type: 'SE_INCOME_AU_APPLY', amount: data.amount, residency: state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null, personKey: data.personKey },
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}
