/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ACCOUNT_ROLES } from '../state/account-roles.js';
import { convertNetOfFee, fxFeeIn } from '../fx/fx-conversion.js';

/**
 * Resolve the state key of the cash pool a country's debits/credits should hit
 * (design 55 Phase 6b). This is the single routing point that honors a flagged
 * "transaction account": every account-rule reducer/handler that moves cash in or
 * out of the household hub goes through here so a non-default transaction account
 * is respected everywhere — not just wages/expenses (Phase 6a).
 *
 * Fallback chain (first hit wins):
 *   1. `resolveTransactionAccountKey(country, ownerId)` — an account explicitly
 *      flagged `isTransactionAccount` (owner-preferred, then any owner).
 *   2. `getStateKey(savingsRole, ownerId)` — the owner's savings account.
 *   3. `getStateKey(savingsRole)` — any savings account for the country.
 *   4. Legacy literal: `usSavingsAccount`/`auSavingsAccount` if present in state,
 *      else `checkingAccount`.
 *
 * The registry hit is only used when the resolved account actually exists in the
 * live `state` (guards against a renamed/absent stateKey); otherwise the legacy
 * literal is returned. When there is no `stateRegistry` (partial test stubs) the
 * chain short-circuits straight to the legacy literal — byte-for-byte with the
 * old `state.usSavingsAccount ?? state.checkingAccount` helpers.
 *
 * Method-level optional chaining (`?.()`) is load-bearing: several hand-rolled
 * test stubs supply a partial `stateRegistry` exposing only `getStateKey`, so
 * `resolveTransactionAccountKey?.()` must short-circuit a missing method.
 *
 * @param {import('../services/state-registry.js').StateRegistry} [stateRegistry]
 * @param {string} country - ISO country code ('US' | 'AU')
 * @param {object} state   - Current simulation state (for the legacy tail + guard)
 * @param {string|null} [ownerId=null] - Preferred owner; null = any owner
 * @returns {string} A state key guaranteed present in `state` (or the legacy key).
 */
export function resolveCashKey(stateRegistry, country, state, ownerId = null) {
  const isAu = country === 'AU';
  const savingsRole = isAu ? ACCOUNT_ROLES.AU_SAVINGS : ACCOUNT_ROLES.US_SAVINGS;
  const legacyKey = isAu
    ? (state.auSavingsAccount != null ? 'auSavingsAccount' : 'checkingAccount')
    : (state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount');

  const resolved =
       stateRegistry?.resolveTransactionAccountKey?.(country, ownerId)
    ?? stateRegistry?.getStateKey?.(savingsRole, ownerId)
    ?? stateRegistry?.getStateKey?.(savingsRole);

  return (resolved != null && state[resolved] != null) ? resolved : legacyKey;
}

/**
 * Resolve the destination cash key for a proceeds credit (asset/property/company
 * sale) that carries an optional pre-stamped `destinationKey` (design 55 §7.4).
 *
 * An explicit, still-valid `destinationKey` (a user-chosen sale destination) wins;
 * but a stamped key that is **absent from `state`** — e.g. a stale canonical
 * `usSavingsAccount`/`checkingAccount` baked by a handler after the account was
 * deleted or the transaction account was reflagged — must NOT be trusted. The bare
 * `destinationKey ?? resolveCashKey(...)` idiom only caught `null`, so an absent-but-
 * non-null key slipped through and hit `transaction(undefined)`. This existence
 * guard routes such a key back through the flag-aware {@link resolveCashKey} chain.
 *
 * @param {object} stateRegistry
 * @param {string} country
 * @param {object} state
 * @param {string|null|undefined} destinationKey - the action's stamped destination
 * @param {string|null} [ownerId=null]
 * @returns {string}
 */
export function resolveDestinationCashKey(stateRegistry, country, state, destinationKey, ownerId = null) {
  if (destinationKey != null && state[destinationKey] != null) return destinationKey;
  return resolveCashKey(stateRegistry, country, state, ownerId);
}

/**
 * Resolve a user-chosen sale destination (`saleDestinationAccount` on a company
 * equity / real property / collectible) to a state key, falling back to the
 * caller's default cash pool when it names nothing that exists (design 72 §2).
 *
 * The stored value is expected to be a state key; `ScenarioLoader` normalizes the
 * account-**id** form (which the asset editors persist whenever the chosen account
 * had no stateKey yet) up front, because runtime account state carries `stateKey`
 * but not `id` and so cannot resolve one. Anything that still names nothing in
 * `state` lands on `defaultKey` — silently, which is why the normalization
 * matters: the sale still "works", the proceeds simply land in cash instead of
 * the chosen investment account and earn the savings rate for the rest of the
 * run. That was Gap 2 — a marginal tranche compounding at ~3% instead of ~8%.
 *
 * @param {object} state
 * @param {string|null|undefined} saleDestinationAccount
 * @param {string} defaultKey - the caller's country cash-pool key
 * @returns {string}
 */
export function resolveSaleDestinationKey(state, saleDestinationAccount, defaultKey) {
  if (saleDestinationAccount && state[saleDestinationAccount] != null) return saleDestinationAccount;
  return defaultKey;
}

/**
 * Resolve a cash account GUARANTEED PRESENT in `state`, preferring `country`'s
 * pool and falling back to the OTHER country's when this country has none.
 *
 * `resolveCashKey` can return an absent legacy literal (`checkingAccount`) when a
 * country has no wired cash account — normally harmless because the sim only routes
 * a country's cash for people who bank there. Inheritance breaks that assumption: an
 * inherited **US** IRA distribution (design 63 §6.2) or **AU** super lump-sum (§6.4)
 * forces cash movement in a country the heir may not bank in at all (e.g. an
 * AU-resident US-citizen heir with no US cash, §7). The bare key would then strand
 * the proceeds or crash `transaction(undefined)`.
 *
 * This picks the heir's cash *wherever it exists*, so the caller can currency-convert
 * and land/source the money cross-border instead of stranding it. Returns
 * `{ key, account, country, crossed }` (`crossed` = fell back to the other country),
 * or `null` when the household holds no cash account in EITHER country (degenerate —
 * callers no-op rather than fabricate one).
 *
 * @param {object} stateRegistry
 * @param {string} country - preferred ISO country ('US' | 'AU')
 * @param {object} state
 * @param {string|null} [ownerId=null]
 * @returns {{ key: string, account: object, country: string, crossed: boolean } | null}
 */
export function resolvePresentCash(stateRegistry, country, state, ownerId = null) {
  const localKey = resolveCashKey(stateRegistry, country, state, ownerId);
  if (state[localKey] != null) {
    return { key: localKey, account: state[localKey], country, crossed: false };
  }
  const other    = country === 'AU' ? 'US' : 'AU';
  const otherKey = resolveCashKey(stateRegistry, other, state, ownerId);
  if (state[otherKey] != null) {
    return { key: otherKey, account: state[otherKey], country: other, crossed: true };
  }
  return null;
}

/**
 * Credit an asset disposal's proceeds to its destination account, converting when the
 * two are denominated in different currencies.
 *
 * **The conversion is the whole point.** `AccountService.transaction` is a currency-blind
 * numeric credit — it adds the number it is given to `account.balance` and nothing on the
 * path inspects either currency. So a sale reducer that handed it the proceeds directly
 * booked A$1,342,583 of Australian house proceeds into a USD brokerage account as
 * $1,342,583, a 1.55x windfall that then compounded for the rest of the run. On the
 * measured plan that was +$473,151 at the sale and +$2,015,515 by 2070, and because the
 * error scales with proceeds and compounds from the sale date it silently inverted every
 * comparison of *when* to sell.
 *
 * Nothing guarded it because same-currency is the overwhelmingly common case and the
 * asset editors happily let an AU property name a US account as its sale destination.
 *
 * Uses the same `convertNetOfFee` the drawdown sweep does (design 44 §5a), so a disposal
 * and a cash sweep across the same border agree to the cent.
 *
 * **No §988 event.** The proceeds are converted at the disposal, so the foreign currency
 * is never held: there is no basis and no holding period for an exchange gain to accrue
 * against. `AccountService.replenishSavings` realizes §988 because it spends a foreign
 * balance that has been sitting there; this does not. Design 87 §8.
 *
 * @param {object} accountService
 * @param {object} state
 * @param {string} destKey   destination account state key (already resolved)
 * @param {number} amount    proceeds in `fromCcy`
 * @param {string} fromCcy   the disposed asset's own currency
 * @param {?string} srcKey   the asset's state key, for the journal record
 * @param {?Date} date
 * @returns {{credited: number, transfer: ?object}} `transfer` is an INTL_TRANSFER_RECORD
 *          action for a cross-currency credit, else null — the caller emits it so the leg
 *          is visible in the journal rather than appearing as a bare balance jump.
 */
export function creditSaleProceeds(accountService, state, destKey, amount, fromCcy, srcKey = null, date = null) {
  const dest  = state[destKey];
  const toCcy = dest?.currency?.code ?? dest?.country ?? fromCcy;

  if (toCcy === fromCcy || !(amount > 0)) {
    accountService.transaction(dest, amount, date);
    return { credited: amount, transfer: null };
  }

  const usdAud   = state.effectiveExchangeRates?.USD_AUD ?? 1.55;
  const fxFeeUsd = state.effectiveFxFees?.USD_AUD ?? 15;
  const fee      = fxFeeIn(toCcy, fromCcy, usdAud, fxFeeUsd);
  const credited = Math.max(0, convertNetOfFee(amount, fromCcy, toCcy, usdAud, fxFeeUsd));
  accountService.transaction(dest, credited, date);

  return {
    credited,
    transfer: {
      type:       'INTL_TRANSFER_RECORD',
      direction:  fromCcy === 'AUD' ? 'AU_TO_US' : 'US_TO_AU',
      srcKey,
      dstKey:     destKey,
      from:       fromCcy,
      to:         toCcy,
      fromAmount: +amount.toFixed(2),
      toAmount:   +credited.toFixed(2),
      fee:        +fee.toFixed(2),
    },
  };
}
