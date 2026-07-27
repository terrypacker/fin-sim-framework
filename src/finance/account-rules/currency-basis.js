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
 * currency-basis.js — design 87 phases 1 & 2.
 *
 * §988 on foreign-currency **cash**, the other half of design 86 G7/P8's debt leg.
 *
 * A US individual's functional currency is the dollar (§985(b)(1)). Everything else is
 * "nonfunctional currency", and §988(c)(1)(C)(ii) says that term **includes**
 * "nonfunctional currency denominated demand or time deposits or similar instruments
 * issued by a bank". §988(c)(1)(C)(i) then makes **any disposition** of it a §988
 * transaction whose gain or loss is foreign currency gain or loss — ordinary, per
 * §988(a)(1)(A).
 *
 * There is no threshold, no purpose test and no carve-out for ordinary banking in that
 * definition, so an AU savings account, an AU transaction account and an AU offset are
 * the same thing under it. What differs between them is *exposure*, which is
 * balance × holding period — see design 87 §2 for why that keeps the problem finite.
 *
 * ─── the arithmetic, and why it delegates ───────────────────────────────────────────
 *
 * With rates quoted as foreign units per USD (matching `effectiveExchangeRates.USD_AUD`)
 * a lot of `D` units acquired at `r_acq` and disposed at `r_disp` gives
 *
 *     gain(USD) = D × (1/r_disp − 1/r_acq)
 *
 * which is the exact negative of the debt leg's `P × (1/r_book − 1/r_pay)`. Holding an
 * appreciating currency is a gain; owing one is a loss. Rather than write the same
 * expression twice with the sign flipped — two implementations that would drift — this
 * delegates to `computeSection988Gain` with the rates transposed, and the transposition
 * is the whole content of the sign convention. Read {@link computeCurrencyDisposition}'s
 * body as "the deposit is the mirror of the debt".
 */

import { computeSection988Gain, blendSection988BookingRate } from './loan-classes.js';

/** Currency code of an account state entry ('USD'/'AUD'), tolerant of shape. */
export function accountCurrencyCode(entry) {
  return entry?.currency?.code ?? entry?.currency ?? null;
}

/**
 * Is this account a foreign-currency cash pool for §988 purposes?
 *
 * Deliberately keyed on **currency**, not on account type or role: the statute reaches
 * any bank deposit denominated in nonfunctional currency, so a savings account, a
 * transaction account and an offset all qualify on the same footing. Superannuation is
 * excluded by shape rather than by an explicit test — it is a pension interest, not a
 * deposit, and design 87 §5 keeps it out of scope on purpose (its cross-border
 * treatment is design 83's Art. 18 and design 84's s99B work, a different regime).
 */
export function isForeignCurrencyPool(account) {
  if (!account || account.type === 'super' || account.kind === 'real-property') return false;
  const ccy = accountCurrencyCode(account);
  return ccy != null && ccy !== 'USD';
}

/**
 * Exchange gain or loss on a **disposition of nonfunctional currency**.
 *
 * @param {number} units       foreign-currency units disposed of (> 0)
 * @param {number} acqRate     foreign units per USD when those units were acquired
 * @param {number} dispRate    foreign units per USD on the disposition date
 * @param {number} businessFrac 0..1 — the §988(e)(3) "to the extent … §162/§212" share
 * @returns {{ recognized: number, gross: number, disallowedLoss: number, deMinimis: number }}
 *          all USD; `recognized` is signed (what actually reaches the return).
 *
 * The §988(e) split is the same asymmetry the debt leg models, and this is the leg
 * Congress actually wrote §988(e)(2) for — see {@link computeSection988Gain}'s caveat
 * and design 87 §4. The personal share recognizes gain above the \$200 per-transaction
 * de minimis; the matching personal loss is disallowed under §165(c)
 * (Quijano v. United States, 93 F.3d 26 (1st Cir. 1996)).
 */
export function computeCurrencyDisposition(units, acqRate, dispRate, businessFrac) {
  // Transposed rates: the deposit is the mirror of the debt. See the header.
  return computeSection988Gain(units, dispRate, acqRate, businessFrac);
}

/**
 * Re-base a pool's acquisition rate when currency is ADDED.
 *
 * Identical algebra to the debt leg's booking-rate blend and shares its implementation:
 * a balance-weighted **harmonic** mean, because preserving the pool's total USD basis
 *
 *     newBalance / r_new  =  oldBalance / r_old  +  added / r_spot
 *
 * is the only blend that does not manufacture §988 later out of an accounting choice.
 * Leaving the old rate in place would measure the disposal of newly-acquired units
 * against a rate that never applied to them.
 */
export function blendCurrencyBasisRate(oldBalance, acqRate, added, spotRate) {
  return blendSection988BookingRate(oldBalance, acqRate, added, spotRate);
}

/**
 * The §988(e)(3) income-producing share of a currency pool.
 *
 * §988(e)(1) switches §988 off for an individual's **personal** transactions, and
 * §988(e)(3) defines personal "except **to the extent** that expenses properly allocable
 * to such transaction meet the requirements of section 162 … or 212". That is a
 * fraction, and this reads it from the account rather than inventing a second knob —
 * `deductibleFraction` is the same field the mortgage leg and the s8-1 deduction use.
 *
 * **Default is 0 (personal), and that is a real choice.** A household transaction
 * account funds living expenses; treating it as business by default would silently
 * grant deductions for personal currency losses that §165(c) denies. An offset backing
 * an income-producing property should be authored explicitly — design 87 open question 1
 * records why that answer is not as clean as the mortgage's.
 *
 * @returns {number} 0..1
 */
export function currencyPoolBusinessFraction(account) {
  const stated = account?.deductibleFraction;
  if (stated == null) return 0;
  return Math.min(1, Math.max(0, stated));
}

/**
 * The §988 leg of a debit from a foreign-currency cash pool: what to stamp on the
 * account, and what to book.
 *
 * Mirrors `_section988ForPayment` in loan-classes.js deliberately, including its
 * unstamped-account rule: a pool with no `fxBasisRate` is stamped at today's rate and
 * recognizes nothing this period. For a balance already present at t0 the true
 * acquisition history is unknowable to the model, so treating it as acquired now
 * **understates** §988 rather than inventing it. Author the real rate to fix that.
 *
 * @param {object} state
 * @param {string} accountKey  state key, stamped onto the action for the journal
 * @param {object} account     the pool's state entry
 * @param {number} units       units leaving the account (> 0); 0/negative is a no-op
 * @param {string|null} residency  §988(a)(3)(B) tax home — see section988Residence
 * @returns {{ patch: object, actions: object[] }}
 */
export function realizeCurrencyDisposition(state, accountKey, account, units, residency = null) {
  const none = { patch: {}, actions: [] };
  if (!isForeignCurrencyPool(account)) return none;

  const spot = state?.effectiveExchangeRates?.USD_AUD ?? 1.55;
  if (!(spot > 0)) return none;

  if (account.fxBasisRate == null) return { patch: { fxBasisRate: spot }, actions: [] };
  if (!(units > 0)) return none;

  const r = computeCurrencyDisposition(
    units, account.fxBasisRate, spot, currencyPoolBusinessFraction(account));
  if (Math.abs(r.recognized) <= 1e-9 && r.disallowedLoss <= 1e-9) return none;

  return {
    patch: {},
    actions: [{
      type: 'SECTION_988_GAIN',
      accountKey,
      currency: accountCurrencyCode(account),
      amount: r.recognized, gross: r.gross,
      disallowedLoss: r.disallowedLoss, deMinimis: r.deMinimis,
      residency,
    }],
  };
}

/**
 * The §988 leg of a CREDIT to a foreign-currency cash pool: acquiring currency
 * establishes basis and realizes nothing. Returns only a patch.
 *
 * `balanceBefore` is passed explicitly rather than derived from `account.balance`,
 * because callers differ on whether the credit has already been applied by the time
 * they reach here — `AccountService.transaction` mutates in place. Deriving it would
 * make the blend silently depend on call order, which is exactly the class of bug the
 * harmonic blend exists to prevent.
 *
 * @param {number} balanceBefore  pool balance BEFORE this credit, in foreign units
 * @param {number} units          units credited (> 0)
 */
export function acquireCurrencyBasis(state, account, balanceBefore, units) {
  if (!isForeignCurrencyPool(account) || !(units > 0)) return {};
  const spot = state?.effectiveExchangeRates?.USD_AUD ?? 1.55;
  if (!(spot > 0)) return {};
  if (account.fxBasisRate == null) return { fxBasisRate: spot };
  return {
    fxBasisRate: blendCurrencyBasisRate(
      Math.max(0, balanceBefore), account.fxBasisRate, units, spot),
  };
}
