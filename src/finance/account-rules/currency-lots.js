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
 * currency-lots.js — design 87 phase 3 (G5). The §988 lot pool.
 *
 * A foreign-currency cash account's basis, tracked as lots rather than as the single
 * `fxBasisRate` scalar of phases 1–2. This is the shared core: it is imported BOTH by the
 * simulation (to project a future) and by `scripts/lib/section988-ledger.mjs` (to
 * reconstruct a past from real bank history). One implementation, so the two can be
 * compared to each other and so the engine's ledger inherits the ingest tool's test
 * suite — which has been run over a decade of real transactions.
 *
 * ─── why this file is convention-free ───────────────────────────────────────────────
 *
 * The pool stores **units and USD basis**, never a rate. That is not an accident of
 * factoring: the two callers quote exchange rates in opposite directions — the simulator's
 * `effectiveExchangeRates.USD_AUD` is foreign units per USD, while the ingest tool's
 * published H.10 series is USD per AUD — and a pool that stored a rate would have to pick
 * one and silently corrupt the other. Rates are applied by the caller on the way in
 * (`units × rate = basis`) and on the way out. Keep it that way.
 *
 * ─── the two conventions ────────────────────────────────────────────────────────────
 *
 * `§1.988-2(a)(2)(iii)(B)(1)` permits "any reasonable method that is consistently applied
 * from year to year by the taxpayer to **all accounts**", names FIFO, LIFO and pro rata,
 * and bars only a method that systematically withdraws the **highest basis first**. Both
 * supported methods satisfy that guardrail by construction.
 *
 * Design 87 G6 made pro-rata the incumbent because it is exactly what `fxBasisRate`
 * already implements:
 *
 *     basis consumed = units × (totalUsdBasis / totalUnits)
 *                    = aggregate basis × (units withdrawn ÷ total units)   ← the reg's own fraction
 *
 * FIFO buys exactly one thing — a **holding period** — which the personal capital branch
 * (G10) needs and which an aggregate cannot supply. Measured on real history the two
 * methods sat \$1,215 apart (7.6%) under per-account pooling, so the choice is a
 * parameter here rather than a decision baked in: it "is locked at adoption and binds all
 * future years, so the criterion is robustness across paths, not the winner on the path
 * that happened" (design 87 §5 G6).
 */

/** The two consumption conventions of `§1.988-2(a)(2)(iii)(B)(1)` that this pool supports. */
export const LEDGER_METHOD = { FIFO: 'fifo', PRO_RATA: 'pro-rata' };

/** Per-account pools vs one commingled pool — design 87 G11. */
export const POOLING = { PER_ACCOUNT: 'per-account', COMMINGLED: 'commingled' };

/** A capital gain is long-term above this, which only FIFO can ever know. */
export const LONG_TERM_DAYS = 366;

/** `§988(e)(2)`: personal gain of this much or less is excluded, per transaction. */
export const PERSONAL_DE_MINIMIS_USD = 200;

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * One pool of currency: units of foreign currency and the USD basis they carry.
 *
 * Pro-rata needs only the two totals — that is the whole method, and why design 87 calls
 * it stateless. FIFO additionally needs the lots, because a holding period is a fact
 * about *which* units left, which no aggregate can answer.
 */
export class CurrencyLotPool {
  constructor(method = LEDGER_METHOD.PRO_RATA) {
    this.method = method;
    this.units = 0;
    this.basis = 0;
    this.lots = [];
  }

  acquire(date, units, basis) {
    if (!(units > 0)) return;
    this.units += units;
    this.basis += basis;
    this.lots.push({ date, units, basis });
  }

  /**
   * Remove `units` and return the USD basis they carried, plus how long they were held.
   *
   * The `held` figure is units-weighted and is `null` under pro-rata — deliberately, and
   * not as a shortcut. Pro-rata cannot say which units left, so it cannot say how long
   * they were held; design 87 is careful that this is an inference from the method's
   * logic rather than a rule in the regulation. Returning a number here would invent a
   * holding period the method is not entitled to.
   */
  consume(date, units) {
    if (!(units > 0) || !(this.units > 0)) return { basis: 0, held: null, shortfall: units };
    const take = Math.min(units, this.units);
    const shortfall = units - take;

    if (this.method === LEDGER_METHOD.PRO_RATA) {
      const basis = this.basis * (take / this.units);
      this.units -= take;
      this.basis -= basis;
      if (this.units <= 1e-9) { this.units = 0; this.basis = 0; this.lots = []; }
      return { basis, held: null, shortfall };
    }

    let left = take;
    let basis = 0;
    let weightedDays = 0;
    while (left > 1e-9 && this.lots.length) {
      const lot = this.lots[0];
      const from = Math.min(left, lot.units);
      const lotBasis = lot.basis * (from / lot.units);
      basis += lotBasis;
      weightedDays += from * daysBetween(lot.date, date);
      lot.units -= from;
      lot.basis -= lotBasis;
      left -= from;
      if (lot.units <= 1e-9) this.lots.shift();
    }
    this.units -= take;
    this.basis -= basis;
    if (this.units <= 1e-9) { this.units = 0; this.basis = 0; this.lots = []; }
    return { basis, held: take > 0 ? weightedDays / take : null, shortfall };
  }
}

/**
 * Split one disposition's gain into where it actually lands on a return.
 *
 * The business share is ordinary `§988` gain or loss. The personal share is **not a §988
 * transaction at all** — `§1.988-1(a)(9)` excludes personal transactions from the
 * definition, so what survives is a CAPITAL gain, and `§988(e)(2)` excludes it from the
 * whole subtitle at \$200 or less **per transaction**. A personal LOSS is disallowed
 * outright: the floor is written for gain only, and personal-use property gets no loss
 * deduction (§165(c); *Quijano v. United States*, 93 F.3d 26 (1st Cir. 1996)).
 *
 * @param gross  total USD gain (positive) or loss (negative) on the units disposed of
 * @param frac   business share, 0..1
 * @param held   units-weighted days held, or null when the method cannot say
 */
export function allocateGain(gross, frac, held) {
  const f = Math.min(1, Math.max(0, frac ?? 0));
  const business = gross * f;
  const personal = gross * (1 - f);

  // `+ 0` normalises -0, which `gross * 0` produces for a negative gross and which then
  // leaks into JSON as "-0".
  const out = {
    ordinary: business + 0,
    capitalGain: 0,
    deMinimisExcluded: 0,
    disallowedPersonalLoss: 0,
    longTerm: held == null ? null : held >= LONG_TERM_DAYS,
  };

  if (personal >= 0) {
    // §988(e)(2) excludes the personal gain from the whole subtitle at or below \$200.
    if (personal <= PERSONAL_DE_MINIMIS_USD) out.deMinimisExcluded = personal;
    else out.capitalGain = personal;
  } else {
    // Personal loss: disallowed outright. The \$200 floor is written for gain only.
    out.disallowedPersonalLoss = -personal;
  }
  return out;
}
