/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ACCOUNT_TYPE } from '../assets/account.js';

/**
 * DESIGN 97 §24.2 — the ONE authority for "what would a penalty-free draw find here, now".
 *
 * This module holds no new rule. It is `AccountService.isWithdrawalEligible` and
 * `AccountService._penaltyFreeAvailable` moved out of the service, unchanged, so that the
 * SPEND side and the MEASUREMENT side answer the question from the same place.
 *
 * ─── why it had to move ──────────────────────────────────────────────────────────
 *
 * Design 97 §22.3 asked `pool-metrics.js` to report how much of a pool a Phase 1 draw could
 * actually reach, and named `net-liquidity.js#isAccessible` as the authority to reuse. §24.1
 * measured the two against each other and they do not agree — a household at 50, one balance
 * per wrapper:
 *
 *   | account | isDrawdownAccessible | what Phase 1 finds |
 *   |---------|----------------------|--------------------|
 *   | 401(k)  | true                 | 0                  |
 *   | Roth    | true                 | contributionBasis  |
 *   | IRA     | true                 | 0                  |
 *   | super   | false                | 0                  |
 *
 * The three US wrapper classes default `allowsEarlyWithdrawal: true` in their constructors,
 * and `isAccessible` returns true on that flag BEFORE it looks at the age. The Phase 1 walk
 * never reads the flag at all: `eligibleOf` calls `isWithdrawalEligible`, which is the age
 * test and nothing else. So a metric built on `isAccessible` reports the whole US wrapper
 * book as reachable while a draw finds none of it — which is the §22.3 defect renamed rather
 * than fixed, and it would have LOOKED fixed.
 *
 * The lesson is the one design 97 keeps paying for: **the metric and the draw must not answer
 * the same question from two places.** A third correct copy would reproduce the failure the
 * moment either rule moved, so this is an EXTRACTION — `AccountService` now calls these
 * functions rather than holding its own — and not a second implementation beside it.
 *
 * `isAccessible` keeps its own, wider meaning (design 88 §5: "is this account lever-reachable
 * at all, penalty included"), which is the right question for the control metric and the
 * wrong one for penalty-free cover. Design 97 §24.5 makes that distinction authorable as the
 * pool's `access` mode rather than leaving it as a divergence.
 */

/** Days-per-year the decimal-age gate is computed on. The 59.5 gate needs a decimal age. */
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Does this account have an age gate at all?
 *
 * ABSENT and `null` both mean "no gate", and neither is the same as `minimumAge: 0`: the `in`
 * test is what lets a plain brokerage — which carries no such field — take the same path as a
 * wrapper whose gate has been deliberately cleared.
 *
 * `=== null` and not `!= null`, deliberately: an account carrying `minimumAge: undefined`
 * falls through to the comparison, where `age >= undefined` is false, i.e. PERMANENTLY GATED.
 * That is what `isWithdrawalEligible` has always done, it is what the drawdown suites encode,
 * and this extraction is not the place to change it. Filed as §24.2 Q1 rather than fixed here.
 *
 * @param {object} account
 * @returns {boolean}
 */
export function hasAgeGate(account) {
  return !!account && ('minimumAge' in account) && account.minimumAge !== null;
}

/**
 * Is the owner past this account's age gate?
 *
 * The exact rule `AccountService.isWithdrawalEligible` has always applied: no gate ⇒ true;
 * otherwise decimal age at `asOfDate` against `minimumAge`. It does NOT read
 * `allowsEarlyWithdrawal` — that flag governs the PHASE 2 (penalised) draw, and conflating
 * the two is §24.1's measured defect.
 *
 * The date arithmetic is the original's, subtraction on the raw operands, and it is kept
 * rather than tidied because two of its edge cases are OBSERVABLE and this step is meant to
 * be provably behaviour-neutral:
 *
 *   - `birthDate: undefined` ⇒ NaN ⇒ NOT eligible (a gated account stays shut);
 *   - `birthDate: null`      ⇒ coerces to the epoch ⇒ ELIGIBLE, on a gated account.
 *
 * The second is wrong on its face — a missing birth date should not open a wrapper — and
 * today it is unreachable, because `eligibleOf` resolves an owner's date with `?? birthDate`
 * and the drawdown paths are entered with a real person. §24.3 makes it reachable for the
 * first time, because `poolMetrics` will resolve an owner per CLAIM and a claim can name an
 * account whose `ownerId` matches nobody. It is fixed there, with a test, as a behaviour
 * change on its own — not silently, inside a move. §24.2 Q1.
 *
 * @param {object}                  account
 * @param {Date|string|number|null} birthDate - the OWNER's birth date, not the household's
 * @param {Date|string|number}      asOfDate
 * @returns {boolean}
 */
export function isAgeEligible(account, birthDate, asOfDate) {
  if (!hasAgeGate(account)) return true;
  const ageDecimal = (asOfDate - birthDate) / MS_PER_YEAR;
  return ageDecimal >= account.minimumAge;
}

/**
 * Balance a source may give up: everything above its `minimumBalance` floor.
 *
 * Cash/savings keep their buffer; investments have a floor of 0, so this is a no-op for them.
 *
 * @param {object} account
 * @returns {number} in the account's OWN currency
 */
export function drawableBalance(account) {
  return Math.max(0, (account?.balance ?? 0) - (account?.minimumBalance ?? 0));
}

/**
 * Penalty-free amount currently withdrawable from a single account:
 *   - age-eligible accounts  → the drawable balance
 *   - Roth below minimumAge  → contribution basis (always penalty-free, capped at drawable)
 *   - everything else        → 0 (only reachable via the phase-2 early withdrawal)
 *
 * **Accessibility is an AMOUNT, not a boolean.** The Roth branch is the whole reason: a
 * predicate that called an under-age Roth "locked" would under-report cover the draw does in
 * fact produce, which is the same class of defect as §24.1's, pointing the other way.
 *
 * @param {object} account
 * @param {boolean} eligible - the result of {@link isAgeEligible} for this account's owner
 * @returns {number} in the account's OWN currency
 */
export function penaltyFreeAvailableFor(account, eligible) {
  const drawable = drawableBalance(account);
  if (eligible) return Math.max(0, drawable);
  if (account?.type === ACCOUNT_TYPE.ROTH) {
    return Math.max(0, Math.min(account.contributionBasis ?? 0, drawable));
  }
  return 0;
}

/**
 * {@link isAgeEligible} and {@link penaltyFreeAvailableFor} in one call — the form a caller
 * that has a date and a birth date (rather than a precomputed `eligible`) wants.
 *
 * @param {object} account
 * @param {{birthDate: Date|string|number|null, asOf: Date|string|number}} opts
 * @returns {number} in the account's OWN currency
 */
export function penaltyFreeAvailable(account, { birthDate, asOf } = {}) {
  return penaltyFreeAvailableFor(account, isAgeEligible(account, birthDate, asOf));
}

/**
 * The instant this account's age gate opens for `birthDate`, or null when there is no gate.
 *
 * Returned unconditionally — it is a property of the gate and the owner, not of today — so a
 * caller asking "when does this unlock" gets the same answer before and after the date
 * passes, and decides for itself whether the date is still in the future. A caller wanting
 * "the earliest gate still shut" filters on {@link penaltyFreeAvailable} first; see design 97
 * §24.3, where the pool-level `unlocksAt` is exactly that filter.
 *
 * @param {object}                  account
 * @param {Date|string|number|null} birthDate - the OWNER's birth date
 * @returns {Date|null}
 */
export function unlocksAt(account, birthDate) {
  if (!hasAgeGate(account)) return null;
  if (birthDate == null) return null;
  const born = birthDate instanceof Date ? birthDate.getTime() : new Date(birthDate).getTime();
  if (!Number.isFinite(born)) return null;
  // The INVERSE of `isAgeEligible`'s comparison on the same year length, so the date this
  // returns is the first instant that predicate flips. Deriving it any other way — calendar
  // years, a month offset for the ".5" — would put the panel's stated unlock date and the
  // draw's behaviour days apart, on the one figure whose whole job is to say when.
  return new Date(born + account.minimumAge * MS_PER_YEAR);
}
