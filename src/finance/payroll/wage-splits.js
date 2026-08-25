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
 * wage-splits.js — design 95 §6, phase 2. Direct deposit across several accounts.
 *
 * A person's pay stops being one credit to one account and becomes an ordered list
 * of allocations with a remainder. `person.wageSplits` is:
 *
 *     [{ destinationKey: 'usSavingsAccount', mode: 'PERCENT', value: 0.60 },
 *      { destinationKey: 'brokerageAccount', mode: 'FIXED',   value: 1000 }]
 *
 * ─── this is cash routing and NOTHING else ───────────────────────────────────
 *
 * Splitting has **no tax consequence whatever**. The tax chain keeps carrying the
 * gross wage; only the destination of the cash changes. The standing temptation is
 * to derive taxable income from what landed where, which fuses two independent axes
 * the way design 73 §6b found source and residency fused — right up until someone
 * splits across accounts with different tax characters, at which point the return is
 * quietly wrong. Nothing in this module returns anything a tax reducer reads.
 *
 * ─── the order of operations, and why ────────────────────────────────────────
 *
 * 1. FIXED allocations, in list order, each capped at what is left.
 * 2. PERCENT allocations, in list order, computed on the **original** total.
 * 3. Whatever remains goes to the fallback (the earner's transaction account).
 *
 * Percentages are taken on the original rather than on the post-fixed remainder
 * because a percentage of a shrinking base is both unintuitive and order-dependent:
 * "put 20% in savings" should mean 20% of pay, not 20% of what survived the rent
 * transfer. The two passes are what make the list order matter only *within* a mode.
 *
 * ─── conservation is structural ──────────────────────────────────────────────
 *
 * The remainder is computed as `total − Σ allocated`, so rounding dust lands in the
 * fallback automatically and Σ(credited) === total to the cent for every input,
 * including the degenerate ones. There is no separate reconciliation step that could
 * disagree with the allocation, which is the property WAGE-SPLIT-CONSERVE asserts.
 *
 * ─── never overdraw, never drop ──────────────────────────────────────────────
 *
 * A wage event is not a spending event. If fixed allocations exceed pay they are
 * satisfied in list order until the money runs out and later entries get nothing —
 * this must never push the cash pool negative and escalate into the drawdown
 * cascade, selling assets to fund a direct deposit. Equally, a destination that
 * names nothing in `state` falls back rather than vanishing: money is never created
 * and never destroyed by a routing decision.
 */

import { ACCOUNT_ROLES } from '../state/account-roles.js';

/** Cents, so an allocation cannot leave sub-cent dust in an account balance. */
const cents = n => +n.toFixed(2);

export const SPLIT_MODE = { PERCENT: 'PERCENT', FIXED: 'FIXED' };

/**
 * The account roles a paycheque can actually be deposited into (design 95 §17 phase 10).
 *
 * `creditPay` credits a balance and does nothing else — no contribution basis, no
 * deduction, no cap, no tax leg — which is exactly right for a cash or taxable
 * account and exactly WRONG everywhere else:
 *
 *  - A tax-advantaged wrapper (401(k), IRA, Roth, super, or an inherited one) is
 *    reachable only through a CONTRIBUTION. Money routed in as a wage split would
 *    land inside the wrapper having escaped §402(g)/§415(c) and Div 291 alike, with
 *    no basis credited and no deduction taken — a contribution nothing accounted for.
 *  - A LOAN carries a positive balance representing debt (design 54), so crediting
 *    one would *increase* what is owed. "Send 20% of my pay to the mortgage" would
 *    grow the mortgage.
 *
 * An OFFSET account is on the list deliberately: it is a cash account whose whole
 * purpose is to hold cash against a loan, and depositing pay into it is an ordinary
 * arrangement rather than a contribution.
 *
 * Exported for the editor, which uses it to keep an invalid split from being
 * authored at all (§17.5). `splitWage` does not enforce it — a hand-authored
 * scenario is the user's own, and refusing one silently at run time would be a
 * routing decision that loses money rather than a warning.
 */
export const DEPOSITABLE_ROLES = Object.freeze(new Set([
  ACCOUNT_ROLES.US_SAVINGS, ACCOUNT_ROLES.AU_SAVINGS,
  ACCOUNT_ROLES.US_STOCK,   ACCOUNT_ROLES.AU_STOCK,
  ACCOUNT_ROLES.FIXED_INCOME, ACCOUNT_ROLES.AU_FIXED_INCOME,
  ACCOUNT_ROLES.US_OFFSET,  ACCOUNT_ROLES.AU_OFFSET,
]));

/** Can a paycheque be deposited into this account? See {@link DEPOSITABLE_ROLES}. */
export function isDepositable(account) {
  return DEPOSITABLE_ROLES.has(account?.role);
}


/**
 * One warning per session per kind, not one per person per month — a 40-year run
 * fires this handler ~500 times and would otherwise bury the console.
 */
const _warned = new Set();
function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`[design 95 §6] ${message}`);
}

/** Test seam: forget which warnings have been issued. */
export function _resetSplitWarnings() { _warned.clear(); }

/** The ISO code of an account's currency, tolerating both descriptor and string. */
function currencyCodeOf(account) {
  const c = account?.currency;
  // `account.currency` is a {code, symbol} DESCRIPTOR, not a string — summing or
  // comparing it raw is the bug the guardrail FX work had to unpick.
  return (typeof c === 'string' ? c : c?.code) ?? null;
}

/**
 * Validate one split entry against `state`, returning the usable destination key or
 * null when the entry cannot be honoured.
 *
 * Two rejections, both of which fall back to the transaction account rather than
 * dropping the allocation:
 *
 *  - **unknown destination** — names nothing in `state`. `ScenarioLoader` normalizes
 *    the account-id form to a state key up front, so anything still unresolved here
 *    is a genuinely stale reference (a deleted or renamed account).
 *  - **currency mismatch** — a cross-currency split is an international transfer
 *    with an FX leg and a §988 disposal attached. Routing one through a wage credit
 *    would conjure currency from nowhere: the AUD would leave nothing and arrive as
 *    USD at an implied rate of 1.0. It must be refused, not silently converted.
 */
function resolveDestination(entry, state, wageCurrency, personLabel) {
  const key = entry?.destinationKey;
  if (!key || state?.[key] == null) {
    warnOnce(`missing:${key}`,
      `${personLabel}: wage split destination "${key}" names no account in state; `
      + `that share falls back to the transaction account.`);
    return null;
  }
  const code = currencyCodeOf(state[key]);
  if (code != null && wageCurrency != null && code !== wageCurrency) {
    warnOnce(`currency:${key}`,
      `${personLabel}: wage split destination "${key}" is denominated in ${code} but the `
      + `wage is paid in ${wageCurrency}. A cross-currency split is an international `
      + `transfer with an FX leg, not a payroll routing choice, so that share falls back `
      + `to the transaction account.`);
    return null;
  }
  return key;
}

/**
 * Allocate `total` across `splits`, with the remainder to `fallbackKey`.
 *
 * @param {number}  total         the amount being credited (gross today; net of
 *                                withholding and deferrals once phases 4-5 land —
 *                                this function does not care which, it splits what
 *                                it is given)
 * @param {Array|null} splits     `person.wageSplits`; null/empty ⇒ no split
 * @param {string}  fallbackKey   the earner's transaction account
 * @param {object}  opts
 * @param {object}  opts.state
 * @param {string}  [opts.wageCurrency]
 * @param {string}  [opts.personLabel='a person']  for warning messages
 * @returns {Array<{targetKey: string, amount: number}>|null}
 *          null when there is nothing to split across (the caller then uses the
 *          single-target path and the action stays byte-identical to phase 1)
 */
export function splitWage(total, splits, fallbackKey, { state, wageCurrency = null,
                                                        personLabel = 'a person' } = {}) {
  if (!Array.isArray(splits) || splits.length === 0) return null;
  if (!(total > 0)) return null;

  // Resolve destinations first so a rejected entry cannot consume any of the pay:
  // its share must fall to the remainder, not be allocated and then discarded.
  const entries = [];
  for (const s of splits) {
    const key = resolveDestination(s, state, wageCurrency, personLabel);
    if (key == null) continue;
    const value = Number(s.value);
    if (!Number.isFinite(value) || value <= 0) continue;
    entries.push({ key, mode: s.mode === SPLIT_MODE.FIXED ? SPLIT_MODE.FIXED
                                                          : SPLIT_MODE.PERCENT, value });
  }
  if (entries.length === 0) return null;

  // Percentages over 100% are normalised rather than truncated, so the relative
  // intent survives. Truncating would silently favour whichever entries happened to
  // come first in the list.
  const pctTotal = entries.filter(e => e.mode === SPLIT_MODE.PERCENT)
                          .reduce((a, e) => a + e.value, 0);
  const pctScale = pctTotal > 1 ? 1 / pctTotal : 1;
  if (pctTotal > 1) {
    warnOnce(`over100:${personLabel}`,
      `${personLabel}: wage split percentages sum to ${(pctTotal * 100).toFixed(1)}%; `
      + `scaling them to 100%. Nothing is left for the transaction account.`);
  }

  const out       = [];
  let   remaining = total;

  const allocate = (key, want) => {
    const amount = cents(Math.min(Math.max(0, want), remaining));
    if (amount <= 0) return;              // shortfall: later entries get nothing
    remaining = cents(remaining - amount);
    out.push({ targetKey: key, amount });
  };

  // Pass 1 — FIXED, in list order.
  for (const e of entries) {
    if (e.mode === SPLIT_MODE.FIXED) allocate(e.key, e.value);
  }
  // Pass 2 — PERCENT, on the ORIGINAL total (see the header).
  for (const e of entries) {
    if (e.mode === SPLIT_MODE.PERCENT) allocate(e.key, total * e.value * pctScale);
  }

  // Pass 3 — the remainder, including any rounding dust. This is what makes
  // Σ(credited) === total structurally rather than by reconciliation.
  if (remaining > 0) out.push({ targetKey: fallbackKey, amount: remaining });

  // Merge allocations to the same account, preserving first-mention order. A list
  // that names one account twice — or, more commonly, allocates a percentage to the
  // transaction account and then leaves it the remainder as well — would otherwise
  // emit two credits to one balance. They are arithmetically equivalent, but the
  // journal reads as though the account were paid twice, and it hides the case
  // below.
  const merged = [];
  const byKey  = new Map();
  for (const row of out) {
    const seen = byKey.get(row.targetKey);
    if (seen) { seen.amount = cents(seen.amount + row.amount); continue; }
    const copy = { ...row };
    byKey.set(row.targetKey, copy);
    merged.push(copy);
  }

  // A single allocation to the fallback is exactly what the un-split path already
  // does, so return null and let the caller emit the phase-1 action shape. Checked
  // AFTER merging, because "50% to the transaction account, remainder to the
  // transaction account" only collapses to that case once the two are combined.
  if (merged.length === 1 && merged[0].targetKey === fallbackKey) return null;
  return merged;
}

/**
 * Credit a pay action's amount, honouring `splits` when present.
 *
 * The single credit path for all four pay-apply reducers (US/AU wages, US/AU
 * self-employment), which previously each spelled out
 * `transaction(state[targetKey] ?? state[fallback], amount)` for themselves.
 *
 * **Conservation is enforced here, not assumed.** The splits computed by
 * `splitWage` always sum to the action's amount, but actions are persisted and
 * replayed (design 81), so this reducer can be handed a stale or hand-edited action
 * whose splits do not. Rather than silently creating or destroying money, any
 * discrepancy is credited to the fallback and warned about once. Reconciling is the
 * lesser evil: an unbalanced split that silently loses cash is invisible in every
 * downstream number, while a warning plus a balanced ledger is merely untidy.
 *
 * @param {object} accountService
 * @param {object} state
 * @param {object} action        the *_APPLY action
 * @param {string} fallbackKey   country cash pool, already resolved by the caller
 */
export function creditPay(accountService, state, action, fallbackKey) {
  const { splits, targetKey, amount, netAmount } = action;
  const at = key => state[key] ?? state[fallbackKey];
  // What actually reaches the household. `amount` stays the GROSS wage because the
  // tax chain reads it; `netAmount` appears only once phase 5 withholds something,
  // so an un-withheld action credits `amount` exactly as before.
  const credited = netAmount ?? amount;

  if (!Array.isArray(splits) || splits.length === 0) {
    accountService.transaction(at(targetKey), credited, null);
    return;
  }

  let creditedSoFar = 0;
  for (const s of splits) {
    if (!(s?.amount > 0)) continue;
    accountService.transaction(at(s.targetKey), s.amount, null);
    creditedSoFar = cents(creditedSoFar + s.amount);
  }

  const residual = cents((netAmount ?? amount ?? 0) - creditedSoFar);
  if (residual !== 0) {
    warnOnce('residual',
      `a pay action's splits sum to ${creditedSoFar} but its net pay is ${netAmount ?? amount}; `
      + `crediting the ${residual > 0 ? 'shortfall' : 'excess'} to "${fallbackKey}" so the `
      + `ledger balances. This means a stored action was edited or predates its splitter.`);
    accountService.transaction(at(fallbackKey), residual, null);
  }
}
