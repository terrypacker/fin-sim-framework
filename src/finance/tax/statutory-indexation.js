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
 * statutory-indexation.js — design 95 §10, phase 9. Projecting a published limit
 * past the last year an authority has published it for.
 *
 * ─── the rule, and both countries state it the same way ──────────────────────
 *
 * ITAA97 **s960-285(2)** is the clearest statement of it anywhere in either statute:
 *
 *   > (a) first, multiplying its base amount ... by its indexation factor; and
 *   > (b) next, rounding the result in paragraph (a) DOWN to the nearest multiple of
 *   >     its rounding amount.
 *
 * Multiply, then round the RESULT down — once, on the level, not on each year's
 * increment. The US provisions are drafted the other way round ("any INCREASE ...
 * which is not a multiple of \$500 shall be rounded to the next lowest multiple of
 * \$500" — §402(g)(4)) but reach the same place, because their base amounts are
 * themselves multiples of the step and the increase is measured from the base ONCE,
 * not compounded year by year.
 *
 * **Rounding the level rather than each year's increment is what keeps a long
 * projection honest.** Round-down applied annually loses up to a full step every
 * year and compounds: on the §402(g) limit that is up to \$499 a year, and over a
 * forty-year run it would drift the projected limit thousands of dollars below any
 * defensible figure while looking like careful arithmetic.
 *
 * ─── caps never fall ─────────────────────────────────────────────────────────
 *
 * **s960-285(4)**: *"You do not index the amount if the indexation factor is 1 or
 * less."* This is the rule behind the note under s291-20(2) — *"annual indexation
 * does not necessarily increase the amount of the cap"* — and it makes every limit
 * here monotonic non-decreasing. A deflationary year leaves the cap where it was; it
 * never claws it back. The US provisions are equivalent by construction, since they
 * index an "increase" that cannot be negative.
 *
 * ─── what this is NOT ────────────────────────────────────────────────────────
 *
 * This is a projection in the statutes' STYLE, not the statutes' arithmetic. The real
 * calculations run off published index numbers — AWOTE for the AU concessional cap
 * (s960-285(7) item 2), CPI for the transfer balance cap, the §415(d) CPI method for
 * the US limits — measured from a fixed base quarter, and they are applied to the
 * ORIGINAL statutory base rather than to the most recent published figure.
 *
 * Reproducing that would need those index series on disk and would still not
 * reproduce a published number, because the authority applies its own rounding at
 * each publication. So this indexes forward from the LAST PUBLISHED figure, which is
 * the published-base guard's rule: transcribe the cumulative amount from the
 * authority, and project only past where the authority stops.
 *
 * ─── the factor is the SCENARIO'S OWN inflation ──────────────────────────────
 *
 * Design 95 §10 is explicit, and it is the more important of the two decisions here:
 * *"a run whose salaries grow at one rate while its contribution caps grow at another
 * is measuring the gap between two assumptions, not a policy outcome."* So the factor
 * comes from `state.limitIndexAccumulator`, which compounds the same effective
 * inflation rate that already drives wages and expenses — not a second series, and
 * not a hard-coded 2.5%.
 */

/**
 * Project a published limit forward.
 *
 * @param {number} published  the last published figure
 * @param {number} factor     cumulative indexation factor since that publication
 * @param {number} step       the statutory rounding amount
 * @returns {number}
 */
export function indexLimit(published, factor, step) {
  const base = Math.max(0, published ?? 0);
  // s960-285(4) — a factor of 1 or less does not index at all. Guarding rather than
  // letting the arithmetic through matters for the round-down: a factor of 0.999
  // would otherwise round the cap DOWN a whole step, turning a mild deflation into a
  // real cut in contribution room that no statute authorises.
  if (!(factor > 1) || !(step > 0) || base === 0) return base;
  // s960-285(2)(b) — round the RESULT down, once, on the level.
  return Math.floor((base * factor) / step) * step;
}

/**
 * The rounding amounts, each verified against the provision that states it.
 *
 * Kept together because they are the one thing a reader is most likely to guess at,
 * and every one of them differs: three distinct steps across four US provisions, and
 * two more across the two AU caps.
 */
export const ROUNDING = {
  /** §402(g)(4) — elective deferrals. */
  US_ELECTIVE_DEFERRAL: 500,
  /** §414(v)(2)(C) — the age-50 and age-60-to-63 catch-ups. */
  US_CATCH_UP: 500,
  /** §415(d)(4)(B) — the \$40,000 amount, i.e. §415(c)(1)(A) annual additions. */
  US_ANNUAL_ADDITIONS: 1_000,
  /** §401(a)(17)(B) — the compensation limit. */
  US_COMPENSATION: 5_000,
  /** §414(v)(7)(A) — the prior-year FICA wage threshold for the Roth catch-up mandate. */
  US_ROTH_CATCHUP_WAGES: 5_000,
  /** §219(b)(5)(C) — the IRA contribution limit. */
  US_IRA: 500,
  /** §219(b)(5)(C)(ii) — the IRA catch-up, indexed from 2024 by SECURE 2.0 §108. */
  US_IRA_CATCHUP: 100,
  /** s960-285(7) item 2 — the concessional contributions cap (indexed to AWOTE). */
  AU_CONCESSIONAL_CAP: 2_500,
  /** s960-285(7) item 3 — the general transfer balance cap (indexed to CPI). */
  AU_TRANSFER_BALANCE_CAP: 100_000,
};
