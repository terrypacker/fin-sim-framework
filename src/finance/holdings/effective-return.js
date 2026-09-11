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
 * effective-return.js — an account's EXPECTED equity return, derived from its holdings
 * (design 99 P3, §8 Q2).
 *
 * Since design 99 P2 an account has no growth rate of its own: each lot earns its market's
 * total return, with the yield inside it. This is the read-only view of what that adds up
 * to, for the account editor — the derivation made visible rather than hidden. It follows
 * the engine's own resolution so the number shown is the number the sim runs:
 *
 *   market  — the lot's instrument (security, then lot) `rateKey`, else the account's
 *             default for its role and country (`resolveRateKey`);
 *   total   — that market's total return (`marketRates`);
 *   yield   — the instrument's `dividendYield` (security, then lot), else the market's
 *             (the `baseDividendYield` chain);
 *
 * blended by market value. It is the EXPECTED return: the stochastic path and a security's
 * β/idiosyncratic overlay are mean-zero deviations around it, and regimes are episodes.
 *
 * Out of scope, and reported rather than guessed:
 *   - a lot on an authored `appreciationSchedule` — its rate is the schedule's, year by
 *     year, so it is counted in `scheduled` and left out of the blend;
 *   - non-equity lots — bonds, cash and gold earn coupons, interest and the commodity
 *     rate, which are not market equity returns (fixed income is design 99 P3b's).
 */

import { ALLOCATION }      from './allocation.js';
import { instrumentOf }    from './holding-utils.js';
import { resolveRateKey }  from './default-allocations.js';
import { ACCOUNT_ROLES }   from '../state/account-roles.js';

/** Roles whose dividend handler pays the yield OUT, so the lots grow by total − yield. */
const TAXABLE_ROLES = new Set([ACCOUNT_ROLES.US_STOCK, ACCOUNT_ROLES.AU_STOCK]);

const hasSchedule = s => (Array.isArray(s) ? s.length > 0 : !!s);

/**
 * @param {object} opts
 * @param {object[]} opts.holdings                 - the account's lots
 * @param {string|null} opts.country               - the account's country
 * @param {string|null} [opts.role]                - the account's ACCOUNT_ROLES value
 * @param {Object<string,object>|null} [opts.securities] - `id → Security`
 * @param {Object<string,{total:number,yield:number}>} opts.marketRates - by equity rate key
 * @returns {null|{ total: number, yield: number, price: number, taxable: boolean,
 *                  lots: number, scheduled: number }}
 *   null when no equity lot can be priced.
 */
export function effectiveEquityReturn({ holdings, country, role = null, securities = null, marketRates }) {
  const priced = [];
  let scheduled = 0;
  for (const h of holdings ?? []) {
    if ((h?.allocation ?? ALLOCATION.EQUITY) !== ALLOCATION.EQUITY) continue;
    if (hasSchedule(h.appreciationSchedule)) { scheduled++; continue; }
    const inst = instrumentOf(h, securities);
    let rateKey = inst.rateKey || null;
    if (!rateKey) {
      try { rateKey = resolveRateKey(country ?? null, ALLOCATION.EQUITY, role); } catch { rateKey = null; }
    }
    const m = rateKey ? marketRates?.[rateKey] : null;
    if (!m) continue;
    const ownYield = inst.dividendYield == null || inst.dividendYield === '' ? null : Number(inst.dividendYield);
    priced.push({
      mv:    Math.max(0, Number(h.marketValue) || 0),
      total: m.total,
      yield: Number.isFinite(ownYield) ? ownYield : m.yield,
    });
  }
  if (!priced.length) return null;

  // Blend by market value; a book of brand-new, unvalued lots weighs them equally.
  const mvSum  = priced.reduce((s, p) => s + p.mv, 0);
  const weight = p => (mvSum > 0 ? p.mv / mvSum : 1 / priced.length);
  const total  = priced.reduce((s, p) => s + weight(p) * p.total, 0);
  const yld    = priced.reduce((s, p) => s + weight(p) * p.yield, 0);
  return {
    total,
    yield:     yld,
    price:     total - yld,
    taxable:   TAXABLE_ROLES.has(role),
    lots:      priced.length,
    scheduled,
  };
}
