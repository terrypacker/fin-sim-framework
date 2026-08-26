/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  SsIncomeApplyReducer, WagesIncomeApplyReducer, WagesWithheldApplyReducer,
  SeIncomeUsApplyReducer, BonusApplyReducer, CompanySaleApplyReducer,
  SsIncomeHandler, WagesIncomeHandler, WagesWithheldHandler,
  SeIncomeUsHandler, BonusHandler, CompanySaleHandler,
} from '../../finance/account-rules/us/us-income-classes.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

/**
 * US_INCOME toolset — US income event mechanics (SS, wages, SE, bonus, company sale).
 *
 * Capabilities: us-income
 * Depends on: US_TAX
 *
 * No guard: income reducers/handlers are always registered; they process events
 * that only fire when income is actually dispatched.
 */
export const US_INCOME = {
  id: 'US_INCOME',
  capabilities: ['us-income'],
  dependencies: ['US_TAX'],

  types: {
    handlers: [SsIncomeHandler, WagesIncomeHandler, WagesWithheldHandler, SeIncomeUsHandler, BonusHandler, CompanySaleHandler],
    reducers: [SsIncomeApplyReducer, WagesIncomeApplyReducer, WagesWithheldApplyReducer, SeIncomeUsApplyReducer, BonusApplyReducer, CompanySaleApplyReducer],
    actions: [
      { type: 'SS_INCOME_APPLY',     fields: { amount: ValueType.currency('USD'), residency: ValueType.text() , personKey: ValueType.text()} },
      { type: 'SS_INCOME_TAX',       fields: { amount: ValueType.currency('USD'), residency: ValueType.text() , personKey: ValueType.text()} },
      // workCountry — where the employment is EXERCISED (design 73 Gap 1), stamped by
      // PayrollHandler on every wage/SE apply. It decides source, and source
      // decides FEIE/§904 basketing, so a "wages by source country" drill that cannot
      // see it silently reports every wage as domestic. Neither drift pass caught this
      // one: the handler picks the action type through a variable (invisible to the
      // static scan) and the field is null whenever workCountry falls back to an unset
      // residency (invisible to the dynamic pass, which skips null values).
      { type: 'WAGES_INCOME_APPLY',  fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), personKey: ValueType.text(), targetKey: ValueType.text(), workCountry: ValueType.text() , netAmount: ValueType.currency('USD'), splits: ValueType.any()} },
      { type: 'WAGES_INCOME_TAX',    fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), personKey: ValueType.text() } },
      // `alreadyNetted` (design 95 phase 5) records that the wage was credited NET,
      // so this action accumulates usWithheldYTD WITHOUT debiting cash. Undeclared it
      // is stripped from the journal payload, which leaves the audit trail unable to
      // explain why a withholding moved no money.
      // `family: 'TAX_WITHHELD'` (design 95 phase 6) is what puts withheld tax into
      // "Tax Paid by Year". The report used to read the TAX_PAYMENT_DEBIT family alone,
      // and withholding never becomes a debit — the settle debits only the balance due —
      // so the report understated US federal tax by the whole year's withholding. A
      // family of its own rather than TAX_PAYMENT_DEBIT: this action deliberately does
      // NOT debit cash when `alreadyNetted`, and it is the one place P7 can hang AU PAYG.
      { type: 'WAGES_WITHHELD_APPLY', family: 'TAX_WITHHELD', cc: 'US',
        fields: { amount: ValueType.currency('USD'),
        personKey: ValueType.text(), alreadyNetted: ValueType.boolean() } },
      { type: 'SE_INCOME_US_APPLY',  fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), personKey: ValueType.text(), targetKey: ValueType.text(), workCountry: ValueType.text() , netAmount: ValueType.currency('USD'), splits: ValueType.any()} },
      { type: 'SE_INCOME_US_TAX',    fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), personKey: ValueType.text() } },
      { type: 'BONUS_APPLY',         fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), personKey: ValueType.text() } },
      { type: 'BONUS_TAX',           fields: { amount: ValueType.currency('USD'), residency: ValueType.text() , personKey: ValueType.text()} },
      { type: 'COMPANY_SALE_APPLY',  fields: { salePrice: ValueType.currency('USD'), costBasis: ValueType.currency('USD'), residency: ValueType.text(), stateKey: ValueType.text(), destinationKey: ValueType.text() } },
      // proceeds/costBasis/description are what put the disposal on Schedule D and
      // Form 8949 — every other CAPITAL_GAINS type already declares them. Without
      // them the sale reached Form 1040 line 6 (which reads the YTD accumulator) but
      // was invisible on the schedules, since pickPayload keeps ONLY declared fields.
      { type: 'COMPANY_SALE_TAX', family: 'CAPITAL_GAINS', cc: 'US',
        fields: { gain: ValueType.currency('USD'), auGain: ValueType.currency('USD'), auIndexedGain: ValueType.currency('USD'), usShortTermGain: ValueType.currency('USD'), usLongTermGain: ValueType.currency('USD'), auShortTermGain: ValueType.currency('USD'), auLongTermGain: ValueType.currency('USD'), residency: ValueType.text() , ownershipType: ValueType.text(), ownerId: ValueType.text(), owners: ValueType.any(),
                  proceeds: ValueType.currency('USD'), costBasis: ValueType.currency('USD'), description: ValueType.text() } },
    ],
  },

  paramSchema(context) { return []; },
  state(context) { return {}; },
  schedules(context) { return []; },

  handlers(context) {
    return [
      new SsIncomeHandler(),
      new WagesIncomeHandler(),
      new WagesWithheldHandler(),
      new SeIncomeUsHandler(),
      new BonusHandler(),
      new CompanySaleHandler(),
    ];
  },

  reducers(context) {
    const accountService = context.accountService;
    const stateRegistry  = context.stateRegistry;
    return [
      new SsIncomeApplyReducer({ accountService, stateRegistry }),
      new WagesIncomeApplyReducer({ accountService, stateRegistry }),
      new WagesWithheldApplyReducer({ accountService, stateRegistry }),
      new SeIncomeUsApplyReducer({ accountService, stateRegistry }),
      new BonusApplyReducer({ accountService, stateRegistry }),
      new CompanySaleApplyReducer({ accountService, stateRegistry }),
    ];
  },
};
