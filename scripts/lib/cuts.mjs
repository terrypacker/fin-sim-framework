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
 * cuts.mjs — the balance-sheet cuts a study reads off `sim.state`, in ONE base
 * currency, with ONE scope vocabulary.
 *
 * ─── why this module exists ──────────────────────────────────────────────────
 *
 * Eleven study scripts across four studies had each written their own version of
 * this walk. They agreed on the shape and disagreed on the arithmetic:
 *
 *   const r = s.effectiveExchangeRates?.USD_AUD ?? 1.55;
 *   const u = x => v.currency?.code === 'AUD' ? x / r : x;
 *
 * Three of them (`offset-bond-pool`) used a **literal 1.55** instead of the run's
 * own rate, so their years-of-cover figures were not comparable with the
 * `offset-bucket-study` numbers they were quoted beside. That is invisible while
 * every study pins `fxProcessModel: NONE`, and wrong the moment one does not.
 *
 * `src/finance/fx/to-base-currency.js` already owns this conversion and says so in
 * its own header: *"Adding a copy of these six lines is therefore a bug waiting for
 * a currency — import this instead."* Design 82 §5.3 converged five in-engine copies
 * after one of them (`computeGuardrailPortfolioValue`) had already drifted — it
 * compared `val.currency` against a bare code, but a runtime account carries a
 * `{code, symbol}` descriptor, so the comparison never matched and every FOREIGN
 * drawdown account was silently valued at face. Nothing threw. Only the numbers
 * were wrong. This module is the scripts-side end of that convergence.
 *
 * ─── one behaviour change from the copies this replaces ──────────────────────
 *
 * A MISSING rate now falls back to **1:1**, not to 1.55. That is the engine's
 * convention (`toBaseCurrency`), and it is the right one — a hard-coded 1.55 is a
 * guess that reads as a measurement. But 1:1 on a real AUD book is a ~55% error, so
 * it must never happen silently: call `assertRatesSeeded(state)` (or run the
 * `preflight.mjs` gate, which calls it for you) before trusting any figure here.
 *
 * ─── the scope vocabulary ────────────────────────────────────────────────────
 *
 * Every cut below takes the same options, because the traps live in the scope, not
 * in the sum:
 *
 *   · `wrappers`  'exclude' (default) | 'include' | 'only'
 *     Age-gated retirement accounts. `'exclude'` is the default because the
 *     question a study usually asks — "how many years of spending can this
 *     household actually reach" — is a question about the taxable book. Bond
 *     interest is ordinary income, so Lever D's LOCATED policy pushes bonds INTO
 *     the wrappers, where they are not cover for an early retiree. A cut that
 *     forgets to exclude them reports a reserve that cannot be spent.
 *
 *   · `offsets`   'exclude' (default) | 'include'
 *     An offset facility's drawable balance is the backstop BELOW the accessible
 *     pool, and it is capped at the loan balance and amortises. Folding it into a
 *     cover figure double-counts the reserve being sized. Read it separately with
 *     `offsetDrawable`.
 *
 *   · `loans`     always excluded from asset cuts; subtracted by `netWorth`.
 *
 * @see ./preflight.mjs for the axis-liveness gate that should run before a grid.
 */

import { toBaseCurrency, currencyOf } from '../../src/finance/fx/to-base-currency.js';

/**
 * Account types and roles that are age-gated retirement wrappers.
 *
 * Both `type` and `role` are checked because saved scenarios carry the wrapper
 * identity in either field depending on when the account was authored, and
 * `k401` / `401k` are both live spellings.
 */
export const WRAPPER_TYPES = new Set(['ira', '401k', 'k401', 'roth', 'super']);

/** @returns {boolean} true if `account` is an age-gated retirement wrapper. */
export const isWrapper = (account) =>
  WRAPPER_TYPES.has(account?.type) || WRAPPER_TYPES.has(account?.role);

/**
 * Is this `state` entry an account? State is a flat bag holding accounts beside
 * scalars, arrays and metric blocks, so every walk needs this guard.
 *
 * The test is a numeric `balance`, matching every copy this module replaces.
 */
export const isAccount = (entry) =>
  !!entry && typeof entry === 'object' && typeof entry.balance === 'number';

/**
 * Value `amount`, denominated in `account`'s currency, in `base`.
 *
 * The single conversion seam: delegates to the engine's `toBaseCurrency`, which
 * owns the pair-id convention (`USD_AUD` = AUD per 1 USD, so value = amount/rate)
 * and the `{code}` descriptor normalization.
 */
export const valueIn = (state, account, amount, base = 'USD') =>
  toBaseCurrency(amount ?? 0, currencyOf(account, base), base, state);

/**
 * Throw unless every foreign currency held in `state` has a rate to `base`.
 *
 * `toBaseCurrency` falls back to 1:1 on a missing rate — correct for the display
 * paths it was built for, where refusing to value one account would take down a
 * whole readout, and dangerous for a study, where it silently prices an AUD book
 * at par and moves every figure by ~55%. A study should fail loudly instead.
 *
 * @param {object} state
 * @param {string} [base]
 * @throws {Error} naming the missing pair and an account that needed it.
 */
export function assertRatesSeeded(state, base = 'USD') {
  const rates = state?.effectiveExchangeRates ?? {};
  for (const [key, entry] of Object.entries(state ?? {})) {
    if (!isAccount(entry)) continue;
    const code = currencyOf(entry, base);
    if (!code || code === base) continue;
    if (!(`${base}_${code}` in rates)) {
      throw new Error(
        `cuts: no ${base}_${code} rate in state.effectiveExchangeRates, but "${key}" is denominated in ${code}. `
        + `Every ${code} figure would be valued 1:1. Seed the rate or set the account's currency.`,
      );
    }
  }
}

/**
 * Iterate the accounts in scope. Loans are never yielded — they are a liability,
 * and every asset cut here would be wrong to include them.
 *
 * @param {object} state
 * @param {object} [o]
 * @param {'exclude'|'include'|'only'} [o.wrappers='exclude']
 * @param {'exclude'|'include'}        [o.offsets='exclude']
 * @yields {[string, object]} `[stateKey, account]`
 */
export function* scopedAccounts(state, { wrappers = 'exclude', offsets = 'exclude' } = {}) {
  for (const [key, a] of Object.entries(state ?? {})) {
    if (!isAccount(a)) continue;
    if (a.type === 'loan') continue;
    if (a.type === 'offset') { if (offsets === 'include') yield [key, a]; continue; }
    const w = isWrapper(a);
    if (wrappers === 'exclude' && w) continue;
    if (wrappers === 'only' && !w) continue;
    yield [key, a];
  }
}

/**
 * Iterate every holding in scope, already valued in `base`.
 *
 * @param {object} state
 * @param {object} [o] scope options, plus:
 * @param {string[]|null} [o.classes=null] allocation classes to keep (`EQUITY`,
 *   `BOND`, `CASH`, `GOLD`); null keeps all.
 * @param {string} [o.base='USD']
 * @yields {{key: string, account: object, holding: object, value: number, costBasis: number}}
 */
export function* scopedHoldings(state, o = {}) {
  const { classes = null, base = 'USD' } = o;
  const keep = classes ? new Set(classes) : null;
  for (const [key, a] of scopedAccounts(state, o)) {
    for (const h of a.holdings ?? []) {
      if (keep && !keep.has(h.allocation)) continue;
      yield {
        key, account: a, holding: h,
        value:     valueIn(state, a, h.marketValue ?? 0, base),
        costBasis: valueIn(state, a, h.costBasis   ?? 0, base),
      };
    }
  }
}

/**
 * Total market value of the holdings in scope, in `base`.
 *
 * This is the workhorse: `sumHoldings(state, { classes: ['CASH','BOND'] })` is the
 * accessible bucket-2 figure four studies each rewrote.
 *
 * @param {object} state
 * @param {object} [o] see `scopedHoldings`
 * @returns {number}
 */
export function sumHoldings(state, o = {}) {
  let total = 0;
  for (const h of scopedHoldings(state, o)) total += h.value;
  return total;
}

/**
 * Market value AND cost basis of the holdings in scope, in `base`.
 *
 * Both together because their DIFFERENCE is the only clean read of "was this sold?"
 * — growth never moves cost basis, so a basis that falls is a disposal. A caller
 * that sums them in two passes over different scopes gets a meaningless residual.
 *
 * @returns {{value: number, costBasis: number}}
 */
export function sumHoldingsWithBasis(state, o = {}) {
  let value = 0, costBasis = 0;
  for (const h of scopedHoldings(state, o)) { value += h.value; costBasis += h.costBasis; }
  return { value, costBasis };
}

/**
 * The drawable balance sitting in offset facilities, in `base`.
 *
 * Reported separately from every cover figure on purpose: an offset is capped at
 * its loan balance and amortises alongside it, so it is a shrinking backstop below
 * the accessible pool rather than part of it.
 */
export function offsetDrawable(state, { base = 'USD' } = {}) {
  let total = 0;
  for (const [, a] of Object.entries(state ?? {})) {
    if (isAccount(a) && a.type === 'offset') total += valueIn(state, a, Math.max(0, a.balance ?? 0), base);
  }
  return total;
}

/**
 * Total loan liability, in `base`, as a POSITIVE number.
 *
 * Positive because that is how a loan account carries its balance (design 54 P1);
 * `netWorth` below is what applies the sign.
 */
export function loanLiability(state, { base = 'USD' } = {}) {
  let total = 0;
  for (const [, a] of Object.entries(state ?? {})) {
    if (isAccount(a) && a.type === 'loan') total += valueIn(state, a, Math.max(0, a.balance ?? 0), base);
  }
  return total;
}

/**
 * The whole-book net figure the studies call `net(s)`: every holding at market
 * value, plus offset drawable, minus loan balances, in `base`.
 *
 * NOT `computeNetWorth` and not `computeNetLiquidity`. Those are the engine's
 * golden-locked metrics with their own scopes (net liquidity is drawdown-eligible
 * and age-accessible only, design 88 §5). This is the study cut: the balance sheet
 * a table headed "2050 net" is showing. Use the engine metric when you want the
 * engine's answer; use this when you want the one every arm in a study shares.
 *
 * Wrappers are INCLUDED here by default — it is a wealth figure, not a cover
 * figure — which is the opposite of every other default in this module, so it does
 * not take the shared scope options.
 */
export function netWorth(state, { base = 'USD' } = {}) {
  const assets = sumHoldings(state, { base, wrappers: 'include', offsets: 'exclude' })
    + offsetDrawable(state, { base });
  return assets - loanLiability(state, { base });
}

/** Annual spending, in `base`, off the run's own `monthlyExpenses`. */
export const annualSpend = (state) => (state?.monthlyExpenses ?? 0) * 12;

/**
 * Years of spending an amount covers.
 *
 * The denominator is the run's CURRENT `monthlyExpenses`, which inflates, so a
 * cover figure is already in real terms relative to the plan's own standard of
 * living — the reason studies quote "years" rather than dollars.
 *
 * @param {object} state
 * @param {number} amount in the same base as the cut that produced it
 * @returns {number} `Infinity` if the plan spends nothing.
 */
export function yearsOfCover(state, amount) {
  const spend = annualSpend(state);
  return spend > 0 ? amount / spend : Infinity;
}

/**
 * Years of accessible cover: taxable CASH+BOND over annual spending.
 *
 * The single figure four studies each derived, hoisted so they cannot drift apart
 * again. Wrappers and the offset are both out of scope — see the module header.
 */
export function coverYears(state, { classes = ['CASH', 'BOND'], base = 'USD', ...scope } = {}) {
  return yearsOfCover(state, sumHoldings(state, { classes, base, ...scope }));
}

/**
 * The allocation mix over the holdings in scope: dollars and shares by class.
 *
 * Shares are of the scoped total, not of net worth — a denominator that omits
 * property and offsets is the right one for "what is the PORTFOLIO holding", and
 * the wrong one for anything else. `total` is returned so a caller can say which.
 *
 * @returns {{dollars: Record<string, number>, shares: Record<string, number>, total: number}}
 */
export function allocationMix(state, o = {}) {
  const dollars = { EQUITY: 0, BOND: 0, CASH: 0, GOLD: 0 };
  for (const h of scopedHoldings(state, o)) {
    if (h.holding.allocation in dollars) dollars[h.holding.allocation] += h.value;
  }
  const total = Object.values(dollars).reduce((a, c) => a + c, 0);
  const shares = {};
  for (const [k, v] of Object.entries(dollars)) shares[k] = total > 0 ? v / total : 0;
  return { dollars, shares, total };
}

/**
 * One allocation class split by WHERE it sits: taxable vs age-gated wrapper.
 *
 * This is the design-61 Lever-D reading. A whole-book BOND target says nothing
 * about cover, because LOCATED puts bond interest where it is tax-favoured — the
 * wrappers — and a study that reads only the total concludes it has a reserve it
 * cannot reach for twenty years.
 *
 * @returns {{taxable: number, wrapped: number, total: number}}
 */
export function locationSplit(state, allocationClass, { base = 'USD' } = {}) {
  const opts = { classes: [allocationClass], base, offsets: 'exclude' };
  const taxable = sumHoldings(state, { ...opts, wrappers: 'exclude' });
  const wrapped = sumHoldings(state, { ...opts, wrappers: 'only' });
  return { taxable, wrapped, total: taxable + wrapped };
}
