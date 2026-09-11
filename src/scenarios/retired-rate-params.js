/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * retired-rate-params.js — design 99 P2 (§4): the equity rates an ACCOUNT used to carry.
 *
 * Accounts no longer have a growth rate or a dividend rate: each holding earns its
 * market's total return, and the yield inside it is the market's (design 99 §2). This
 * module drops the retired inputs from a config on load —
 *
 *   - the six per-role growth params and the two per-role dividend params (plus the
 *     intl scenario's aliases for two of them);
 *   - `growthRate`, `dividendRate` and `dividendYield` on an equity account record.
 *
 *   - `interestRate` on every account that is not a bank account or a loan (design 99
 *     P3b): a wrapper's cash and bond sleeves and a fixed-income account's bonds now earn
 *     the country's savings / fixed-income rates (or a bond's own coupon);
 *
 * — and WARNS when a dropped value differs from what the market now gives that account.
 * A value that matches is dropped silently: that is every library default (design 99
 * §2.1), which is why the cut-over moves no golden. A value that differs was someone's
 * statement about their plan, and a silent change would betray it (D-2: warn, do not
 * convert — a rate on a wrapper of mixed holdings has no single holding to move to).
 */

import { ACCOUNT_ROLES }        from '../finance/state/account-roles.js';
import { RATE_KEYS }            from '../finance/economic-regimes/rate-keys.js';
import { MARKET_GROWTH_PARAMS } from './toolsets/economic-regimes-toolset.js';

/**
 * The market each equity role's holdings track by default, and whether its dividend is
 * paid out (taxable) or is a slice of the return (wrapper). Design 99 §2.1's table.
 */
const ROLE_MARKET = Object.freeze({
  [ACCOUNT_ROLES.ROTH]:     { rateKey: RATE_KEYS.EQUITY_US, taxable: false },
  [ACCOUNT_ROLES.IRA]:      { rateKey: RATE_KEYS.EQUITY_US, taxable: false },
  [ACCOUNT_ROLES.K401]:     { rateKey: RATE_KEYS.EQUITY_US, taxable: false },
  [ACCOUNT_ROLES.US_STOCK]: { rateKey: RATE_KEYS.EQUITY_US, taxable: true  },
  [ACCOUNT_ROLES.AU_STOCK]: { rateKey: RATE_KEYS.EQUITY_AU, taxable: true  },
  [ACCOUNT_ROLES.SUPER]:    { rateKey: RATE_KEYS.EQUITY_AU, taxable: false },
});

/** Every retired flat param, and what it described. */
export const RETIRED_RATE_PARAMS = Object.freeze({
  rothGrowthRate:        { kind: 'growth', role: ACCOUNT_ROLES.ROTH },
  iraGrowthRate:         { kind: 'growth', role: ACCOUNT_ROLES.IRA },
  k401GrowthRate:        { kind: 'growth', role: ACCOUNT_ROLES.K401 },
  brokerageGrowthRate:   { kind: 'growth', role: ACCOUNT_ROLES.US_STOCK },
  usStockGrowthRate:     { kind: 'growth', role: ACCOUNT_ROLES.US_STOCK },   // intl-retirement alias
  auStockGrowthRate:     { kind: 'growth', role: ACCOUNT_ROLES.AU_STOCK },
  superGrowthRate:       { kind: 'growth', role: ACCOUNT_ROLES.SUPER },
  brokerageDividendRate: { kind: 'yield',  rateKey: RATE_KEYS.EQUITY_US },
  stockDividendRate:     { kind: 'yield',  rateKey: RATE_KEYS.EQUITY_US },   // intl-retirement alias
  auStockDividendRate:   { kind: 'yield',  rateKey: RATE_KEYS.EQUITY_AU },
});

/** The retired equity fields on an equity account record (design 99 P2). */
const RETIRED_ACCOUNT_FIELDS = Object.freeze(['growthRate', 'dividendRate', 'dividendYield']);

/**
 * Design 99 P3b (§3.4): which rates an account's own `interestRate` used to feed, by role —
 * named by the param each reader now uses instead. On a US or AU retirement wrapper it
 * was BOTH the cash sleeve's rate and the bond sleeve's coupon (one field, two meanings);
 * on a fixed-income account it was the whole account's bond rate. A bank account's rate
 * (savings, checking) and a loan's are NOT here: they keep theirs (D-5).
 */
const INTEREST_FED_BY_ROLE = Object.freeze({
  [ACCOUNT_ROLES.ROTH]:            ['usSavingsInterestRate', 'fixedIncomeInterestRate'],
  [ACCOUNT_ROLES.IRA]:             ['usSavingsInterestRate', 'fixedIncomeInterestRate'],
  [ACCOUNT_ROLES.K401]:            ['usSavingsInterestRate', 'fixedIncomeInterestRate'],
  [ACCOUNT_ROLES.US_STOCK]:        ['usSavingsInterestRate'],
  [ACCOUNT_ROLES.AU_STOCK]:        ['auSavingsInterestRate', 'auFixedIncomeInterestRate'],
  [ACCOUNT_ROLES.SUPER]:           ['auSavingsInterestRate', 'auFixedIncomeInterestRate'],
  [ACCOUNT_ROLES.FIXED_INCOME]:    ['fixedIncomeInterestRate'],
  [ACCOUNT_ROLES.AU_FIXED_INCOME]: ['auFixedIncomeInterestRate'],
});

/**
 * Those params' schema defaults — the value a plan that never authored one runs at.
 * Mirrored here rather than read from the toolset schemas to keep this module free of
 * toolset imports; `retired-rate-params.test.mjs` RRP-8 pins them against the schemas.
 */
export const INTEREST_DEFAULTS = Object.freeze({
  usSavingsInterestRate:     0.03,
  auSavingsInterestRate:     0.045,
  fixedIncomeInterestRate:   0.04,
  auFixedIncomeInterestRate: 0.04,
});

function market(parameters, rateKey) {
  const m = MARKET_GROWTH_PARAMS.find(x => x.rateKey === rateKey);
  return {
    total: parameters?.[m.key]      ?? m.defaultValue,
    yld:   parameters?.[m.yieldKey] ?? m.yieldDefault,
  };
}

/** What a retired growth rate for `role` would have had to be to change nothing. */
function equivalentGrowth(parameters, role) {
  const { rateKey, taxable } = ROLE_MARKET[role];
  const { total, yld } = market(parameters, rateKey);
  return taxable ? total - yld : total;
}

const same = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

const pct = v => `${+(v * 100).toFixed(4)}%`;

/**
 * Drop every retired equity rate from `cfg` in place, warning for each that differs from
 * what the market now gives. Safe to call twice.
 *
 * @param {object} cfg
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.warn=console.warn]
 * @returns {string[]} the warnings issued
 */
export function retireRateParams(cfg, { warn = console.warn } = {}) {
  if (!cfg) return [];
  const params = cfg.parameters ?? {};
  const notes  = [];

  const equivalentOf = key => {
    const r = RETIRED_RATE_PARAMS[key];
    return r.kind === 'growth' ? equivalentGrowth(params, r.role) : market(params, r.rateKey).yld;
  };

  // Flat params — read from `cfg.parameters` (the typed `cfg.params` array has already
  // been synced into it by the time the loader calls this), then removed from both.
  for (const key of Object.keys(RETIRED_RATE_PARAMS)) {
    if (!(key in params)) continue;
    const v = params[key];
    const want = equivalentOf(key);
    if (v != null && !same(v, want)) {
      notes.push(`'${key}' (${pct(v)}) is retired: equity rates now come from each market `
        + `(Market Rates). The equivalent under the current market rates is ${pct(want)}, so this plan `
        + `will earn a different return than it was authored with.`);
    }
    delete params[key];
  }
  if (Array.isArray(cfg.params)) {
    cfg.params = cfg.params.filter(p => !(p?.name in RETIRED_RATE_PARAMS));
  }

  for (const acct of cfg.accounts ?? []) {
    const name = acct?.stateKey ?? acct?.name;

    // Equity account records (design 99 P2).
    const rm = ROLE_MARKET[acct?.role];
    if (rm) {
      for (const field of RETIRED_ACCOUNT_FIELDS) {
        if (!(field in acct)) continue;
        const v = acct[field];
        if (v != null) {
          const want = field === 'growthRate' ? equivalentGrowth(params, acct.role) : market(params, rm.rateKey).yld;
          if (!same(v, want)) {
            notes.push(`Account '${name}': its own ${field} (${pct(v)}) is retired — an `
              + `account now earns what its holdings' markets earn. The equivalent is ${pct(want)}.`);
          }
        }
        delete acct[field];
      }
    }

    // An account's own interestRate outside the bank accounts (design 99 P3b). Silent only
    // when it equals EVERY rate it fed — otherwise some sleeve now earns a different rate.
    const fed = INTEREST_FED_BY_ROLE[acct?.role];
    if (fed && 'interestRate' in acct) {
      const v = acct.interestRate;
      if (v != null) {
        const wants = fed.map(k => params[k] ?? INTEREST_DEFAULTS[k]);
        if (!wants.every(w => same(v, w))) {
          notes.push(`Account '${name}': its own interestRate (${pct(v)}) is retired — its cash `
            + `earns the country's savings rate and its bonds their own coupon, else the `
            + `country's fixed-income rate (${fed.map((k, i) => `${k} ${pct(wants[i])}`).join(', ')}).`);
        }
      }
      delete acct.interestRate;
    }
  }

  for (const n of notes) warn(`[design 99] ${n}`);
  return notes;
}
