/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/** Below a cent a residual is float/FX dust, never an insolvency (matches IntlTransferApplyReducer). */
const DUST = 0.01;

/**
 * Route a shortfall the domestic accounts could not cover: across the border when there
 * is another country to draw from, otherwise straight to OUT_OF_FUNDS.
 *
 * The spending path (ReplenishSavingsReducer) and both tax-payment debits used to emit
 * INTL_TRANSFER_APPLY unconditionally and leave the "nothing over there either" verdict
 * to IntlTransferApplyReducer. That reducer is registered only by US_AU_CROSS_BORDER, so
 * on a single-country plan the escalation had no reducer, the engine dropped it, and
 * every unfunded month — and every unpaid tax bill — vanished: no OUT_OF_FUNDS, no
 * cumulativeDeficit, scenarioFailed never set.
 *
 * The counterpart test is the same one IntlTransferApplyReducer applies before drawing
 * (the other country's flagged transaction account, else its legacy savings key, must
 * exist in state), so a cross-border plan escalates exactly as it did and a plan with no
 * counterpart gets the OUT_OF_FUNDS that reducer would have emitted.
 *
 * @param {object} opts
 * @param {object} opts.state
 * @param {import('../services/state-registry.js').StateRegistry} [opts.stateRegistry]
 * @param {'US'|'AU'} opts.toCountry - the country whose account is short
 * @param {number}    opts.deficit   - the uncovered amount, in `toCountry`'s currency
 * @param {string}    [opts.dstKey]  - INTL_TRANSFER_APPLY receiving-account override
 * @param {string}    [opts.currency] - OUT_OF_FUNDS currency; defaults to `toCountry`'s
 * @returns {{ crossBorder: boolean, actions: object[] }} `crossBorder` false means the
 *          shortfall was reported, so the caller has nothing to retry
 */
export function escalateShortfall({
  state, stateRegistry, toCountry, deficit, dstKey,
  currency = toCountry === 'AU' ? 'AUD' : 'USD',
}) {
  const fromCountry = toCountry === 'AU' ? 'US' : 'AU';
  if (hasCounterpartAccount(state, stateRegistry, fromCountry)) {
    const direction = toCountry === 'AU' ? 'US_TO_AU' : 'AU_TO_US';
    // Two literals rather than a conditional assignment: the action-payload static scan
    // reads emitted fields from object literals, and would lose `dstKey` otherwise.
    const transfer = dstKey
      ? { type: 'INTL_TRANSFER_APPLY', direction, targetDeficit: deficit, dstKey }
      : { type: 'INTL_TRANSFER_APPLY', direction, targetDeficit: deficit };
    return { crossBorder: true, actions: [transfer] };
  }
  return {
    crossBorder: false,
    actions: deficit > DUST
      ? [{ type: 'OUT_OF_FUNDS', deficit, currency }]
      : [],
  };
}

/**
 * Whether `country` has the transaction account IntlTransferApplyReducer would draw from.
 * @param {object} state
 * @param {import('../services/state-registry.js').StateRegistry} [stateRegistry]
 * @param {'US'|'AU'} country
 */
export function hasCounterpartAccount(state, stateRegistry, country) {
  const key = stateRegistry?.resolveTransactionAccountKey?.(country)
    ?? (country === 'AU' ? 'auSavingsAccount' : 'usSavingsAccount');
  return state[key] != null;
}
