/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { CurrencyConverter } from './currency-converter.js';

// Module-singleton converter (stateless; reads the rate from the passed state
// snapshot's effectiveExchangeRates each call).
const _converter = new CurrencyConverter();

/**
 * Convert a configured expense amount from its native currency into the
 * currency of the savings account it will actually be debited from, using the
 * run's recorded `state.effectiveExchangeRates`.
 *
 * This is what makes a post-residency-change withdrawal correct: a USD-denominated
 * expense pulled from an AUD account must leave the converted AUD magnitude
 * (e.g. $10k @ 1.5 → A$15k), not the raw native number.
 *
 * Falls back to the native amount when the source and target currencies match,
 * or when no pair/rate is available — so the simulation always debits *something*
 * rather than failing. In practice `effectiveExchangeRates` is seeded at scenario
 * start (FxService) and refreshed each period, so a rate is present at runtime.
 *
 * @param {number} amount    expense amount in `fromCode`
 * @param {string} fromCode  native currency of the expense, e.g. 'USD'
 * @param {object} account   the state-resident Account being debited (carries `.currency.code`)
 * @param {object} state     state snapshot carrying `effectiveExchangeRates`
 * @returns {number}         amount expressed in the account's currency
 */
export function convertExpenseToAccount(amount, fromCode, account, state) {
  // Account currency is normally a descriptor ({ code, symbol }); tolerate a
  // bare string code too.
  const toCode = account?.currency?.code ?? account?.currency ?? fromCode;
  if (amount == null || !fromCode || fromCode === toCode) return amount;
  const converted = _converter.convert(amount, fromCode, toCode, state);
  return converted == null ? amount : converted;
}
