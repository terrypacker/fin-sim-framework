/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ALLOCATION }       from './allocation.js';
import { ACCOUNT_TYPE }     from '../assets/account.js';
import { ACCOUNT_ROLES }    from '../state/account-roles.js';
import { RATE_KEYS, ROLE_TO_RATE_KEY } from '../economic-regimes/rate-keys.js';

/**
 * Default ALLOCATION per account ROLE. Role is the more granular signal —
 * the same Account class (BrokerageAccount) backs both EQUITY (US_STOCK)
 * and BOND (FIXED_INCOME) positions in the current codebase, so role-based
 * lookup picks the right sleeve where type alone cannot.
 *
 * Falls through to DEFAULT_ALLOCATION_BY_TYPE when an account has no role.
 */
export const DEFAULT_ALLOCATION_BY_ROLE = Object.freeze({
  [ACCOUNT_ROLES.US_SAVINGS]:      ALLOCATION.CASH,
  [ACCOUNT_ROLES.AU_SAVINGS]:      ALLOCATION.CASH,
  [ACCOUNT_ROLES.US_OFFSET]:       ALLOCATION.CASH,
  [ACCOUNT_ROLES.AU_OFFSET]:       ALLOCATION.CASH,
  [ACCOUNT_ROLES.FIXED_INCOME]:    ALLOCATION.BOND,
  [ACCOUNT_ROLES.AU_FIXED_INCOME]: ALLOCATION.BOND,
  [ACCOUNT_ROLES.US_STOCK]:        ALLOCATION.EQUITY,
  [ACCOUNT_ROLES.AU_STOCK]:        ALLOCATION.EQUITY,
  [ACCOUNT_ROLES.ROTH]:            ALLOCATION.EQUITY,
  [ACCOUNT_ROLES.IRA]:             ALLOCATION.EQUITY,
  [ACCOUNT_ROLES.K401]:            ALLOCATION.EQUITY,
  [ACCOUNT_ROLES.SUPER]:           ALLOCATION.EQUITY,
});

/**
 * Default ALLOCATION per account TYPE (the ACCOUNT_TYPE discriminator).
 * Used as the fallback when an account has no role stamped.
 */
export const DEFAULT_ALLOCATION_BY_TYPE = Object.freeze({
  [ACCOUNT_TYPE.CHECKING]:        ALLOCATION.CASH,
  [ACCOUNT_TYPE.SAVINGS]:         ALLOCATION.CASH,
  [ACCOUNT_TYPE.OFFSET]:          ALLOCATION.CASH,
  [ACCOUNT_TYPE.BROKERAGE]:       ALLOCATION.EQUITY,
  [ACCOUNT_TYPE.FOUR_OH_ONE_K]:   ALLOCATION.EQUITY,
  [ACCOUNT_TYPE.ROTH]:            ALLOCATION.EQUITY,
  [ACCOUNT_TYPE.TRADITIONAL_IRA]: ALLOCATION.EQUITY,
  [ACCOUNT_TYPE.SUPER]:           ALLOCATION.EQUITY,
});

/**
 * Country × allocation → rateKey table (design 25 §4.3). GOLD is country-agnostic
 * and resolved ahead of this table; every other allocation must appear here.
 */
const RATE_KEY_BY_COUNTRY_ALLOCATION = Object.freeze({
  US: Object.freeze({
    [ALLOCATION.EQUITY]: RATE_KEYS.EQUITY_US,
    [ALLOCATION.BOND]:   RATE_KEYS.FIXED_INCOME_US,
    [ALLOCATION.CASH]:   RATE_KEYS.SAVINGS_US,
  }),
  AU: Object.freeze({
    [ALLOCATION.EQUITY]: RATE_KEYS.EQUITY_AU,
    [ALLOCATION.BOND]:   RATE_KEYS.FIXED_INCOME_AU,
    [ALLOCATION.CASH]:   RATE_KEYS.SAVINGS_AU,
  }),
});

/**
 * Resolve a Holding's default ALLOCATION from an Account.
 * Role wins when present; falls through to type.
 *
 * @throws when the account has neither a known role nor a known type — there is no
 *   catch-all allocation to fall back on, and guessing produces a holding that the
 *   rebalance and drawdown class lists silently ignore.
 */
export function resolveDefaultAllocation(account) {
  if (account?.role && DEFAULT_ALLOCATION_BY_ROLE[account.role]) {
    return DEFAULT_ALLOCATION_BY_ROLE[account.role];
  }
  if (account?.type && DEFAULT_ALLOCATION_BY_TYPE[account.type]) {
    return DEFAULT_ALLOCATION_BY_TYPE[account.type];
  }
  throw new Error(
    `Cannot resolve a default allocation for account "${account?.stateKey ?? account?.id ?? '(unnamed)'}": ` +
    `role=${account?.role ?? 'none'} type=${account?.type ?? 'none'}. ` +
    'Give the account a known role or type, or author the holding\'s allocation explicitly.',
  );
}

/**
 * The rate-key CLASS each allocation may resolve within. The account ROLE is only
 * allowed to refine the key *inside* its allocation's class — picking US vs AU
 * equity for an EQUITY sleeve, say. It can never move a holding to a different
 * asset class, which is what made a BOND sleeve in a `us-stock` brokerage resolve
 * to EQUITY_US and take equity shocks and equity duration handling.
 */
/**
 * The rate keys that belong to each ALLOCATION's class.
 *
 * Exported since design 94 step 2 so `Security`'s coherence check reuses this table rather
 * than growing a second one. It is the guard that stops role from refining ACROSS classes
 * here, and the same guard stops a BOND lot naming an equity security there — one table,
 * both directions, which is the whole of design 94 D5's "no second classifier".
 */
export const CLASS_KEYS_BY_ALLOCATION = Object.freeze({
  // Design 90 §7.2 — all four MARKET keys live inside the EQUITY class, so a holding
  // may track any market while `resolveRateKey`'s containment rule keeps doing its
  // real job: stopping a BOND sleeve in a `us-stock` brokerage from resolving to an
  // equity series and taking equity shocks.
  [ALLOCATION.EQUITY]: Object.freeze(new Set([RATE_KEYS.EQUITY_US, RATE_KEYS.EQUITY_AU,
                                              RATE_KEYS.EQUITY_INTL_EX_US, RATE_KEYS.EQUITY_INTL_EX_AU])),
  [ALLOCATION.BOND]:   Object.freeze(new Set([RATE_KEYS.FIXED_INCOME_US, RATE_KEYS.FIXED_INCOME_AU])),
  [ALLOCATION.CASH]:   Object.freeze(new Set([RATE_KEYS.SAVINGS_US,      RATE_KEYS.SAVINGS_AU])),
});

/**
 * Resolve a Holding's rateKey. **Allocation is authoritative**; role only refines.
 *
 * Lookup order:
 *   1. GOLD → the single country-agnostic commodity series (design 56 §7).
 *   2. The account role's key, but ONLY when it belongs to the allocation's own
 *      class — this is what lets a Roth's EQUITY sleeve pick EQUITY_US while a
 *      Roth's BOND sleeve still resolves FIXED_INCOME_US.
 *   3. The (country, allocation) table.
 *
 * An unknown ALLOCATION throws: it is a closed enum this module owns, and a holding
 * whose class cannot be named is invisible to rebalancing, drawdown and shocks.
 * An absent or unknown COUNTRY returns null instead — `Account.country` is an
 * optional field that legitimately defaults to null, and null here means
 * "unresolved", which the earnings paths already handle by falling back to the
 * account-level rate. Such a holding is also never matched by a jurisdiction shock,
 * which is the right answer for an account that belongs to no jurisdiction.
 *
 * @param {string|null} country    - ISO country code (e.g. 'US', 'AU')
 * @param {string}      allocation - ALLOCATION value
 * @param {string|null} [role]     - ACCOUNT_ROLES value; refines within the class only
 * @returns {string|null} a RATE_KEYS value, or null when the country is unknown
 * @throws when the allocation is not a known ALLOCATION
 */
/**
 * The MARKET keys an equity holding may track, per country of domicile (design 90 §7.3).
 * A US-domiciled account's "international" is ex-US; an AU-domiciled account's is ex-AU.
 * They are different baskets — ex-US contains Australia and ex-AU contains the US — which
 * is why one shared "international" key would be wrong for both.
 */
export const EQUITY_MARKETS_BY_COUNTRY = Object.freeze({
  US: Object.freeze({ domestic: RATE_KEYS.EQUITY_US, international: RATE_KEYS.EQUITY_INTL_EX_US }),
  AU: Object.freeze({ domestic: RATE_KEYS.EQUITY_AU, international: RATE_KEYS.EQUITY_INTL_EX_AU }),
});

/**
 * Resolve an account's equity market MIX — the sub-axis under `ALLOCATION.EQUITY`
 * (design 90 §7.3).
 *
 * This is the second, smaller lever the design promised: `ALLOCATION` stays the closed
 * four-value enum that the rebalancer, glidepath, drawdown selection and the reporting
 * cube are all built on, and the market split lives one level down inside EQUITY. Nothing
 * above has to learn a new class.
 *
 * It is also what lets a Super balance stop being a beta fudge. §7.1's complaint was that
 * a diversified fund with a large international allocation could only be expressed as "AU
 * equity at beta 0.7"; with a mix it is expressed as what it is — some AU, some ex-AU —
 * and the return follows from the markets rather than from a scaling constant.
 *
 * **Returns a single-market mix by default, which is what keeps this inert.** With no
 * authored mix and no international share, an equity account resolves to
 * `{ <its domestic market>: 1 }` — exactly the one sleeve `resolveRateKey` produced
 * before, so bootstrapping is byte-identical until somebody asks for a split.
 *
 * @param {object} account         - needs `country`, and optionally `equityMarketMix`
 * @param {string} [allocation]    - only EQUITY has markets; anything else ⇒ null
 * @returns {Object<string,number>|null} rateKey → weight (summing to 1), or null when
 *   the allocation has no market axis.
 */
export function resolveEquityMarketMix(account, allocation = ALLOCATION.EQUITY) {
  if (allocation !== ALLOCATION.EQUITY) return null;
  const markets = EQUITY_MARKETS_BY_COUNTRY[account?.country];
  if (!markets) return null;

  // An authored mix wins outright. Filtered to keys inside the EQUITY class and to
  // positive weights, then renormalised — an authored mix that does not sum to 1 is a
  // statement of proportions, not of totals, and silently rescaling it beats either
  // throwing or quietly leaving part of the balance unallocated.
  const authored = account?.equityMarketMix;
  if (authored && typeof authored === 'object') {
    const valid = Object.entries(authored)
      .filter(([k, w]) => CLASS_KEYS_BY_ALLOCATION[ALLOCATION.EQUITY].has(k) && w > 0);
    const total = valid.reduce((s, [, w]) => s + w, 0);
    if (total > 0) return Object.fromEntries(valid.map(([k, w]) => [k, w / total]));
  }

  return { [markets.domestic]: 1 };
}

export function resolveRateKey(country, allocation, role = null) {
  if (allocation === ALLOCATION.GOLD) return RATE_KEYS.GOLD;

  const classKeys = CLASS_KEYS_BY_ALLOCATION[allocation];
  if (!classKeys) {
    throw new Error(
      `Cannot resolve a rateKey for unknown allocation "${allocation}". ` +
      `Expected one of: ${Object.keys(CLASS_KEYS_BY_ALLOCATION).join(', ')}, ${ALLOCATION.GOLD}.`,
    );
  }

  const roleKey = role ? ROLE_TO_RATE_KEY[role] : null;
  if (roleKey && classKeys.has(roleKey)) return roleKey;

  return RATE_KEY_BY_COUNTRY_ALLOCATION[country]?.[allocation] ?? null;
}
