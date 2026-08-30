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
 * path.mjs — reading the PATH a run took, not just where it ended.
 *
 * Terminal wealth is measured after the recovery, so it rewards whoever carried the
 * most equity through it. On that metric a cash-or-bond reserve can only lose, which
 * is arithmetic about the equity premium and not a finding about reserves. The
 * numbers that answer a risk question all live on the path: the TROUGH, the years of
 * cover at the worst moment, what each sleeve actually PAID. In the `offset-bond-pool`
 * study the terminal and trough tables disagree in SIGN in the lost-decade column.
 *
 * Everything here is small. It is committed because each piece has a trap in it that
 * cost a wrong answer at least once, and because three studies each rebuilt it.
 *
 * ─── on `walkYearEnds` vs. openSim's sampler ─────────────────────────────────
 *
 * `openSim({ sampler, samplerCadence: 'year-boundary' })` already collects a series
 * off the run. Prefer it when a fixed record per year is all you need. Use the walk
 * here when the loop must decide what to do next — stop early, snapshot only in a
 * window, compare consecutive states — which is most of what studies actually do,
 * and which is why every one of them hand-rolled the loop anyway.
 */

import { quiet } from './run.mjs';

/**
 * Step `sim` to the end of each year in turn, calling `on(state, year)` after each.
 *
 * Two things it gets right that hand-rolled loops did not:
 *
 *  · **It clamps to simEnd.** Stepping past the horizon throws `SimulationHorizonError`,
 *    and past it income and tax stop while balances keep growing — a run read beyond
 *    its horizon reports a net worth ~45% too high.
 *  · **It starts in the simStart year.** A loop that begins at `simStart + 1` closes
 *    its first measured interval at the end of year TWO, so anything dated in year one
 *    has already happened inside it, invisibly. A 2027 crash column once read
 *    identical to no-crash for exactly this reason.
 *
 * @param {object} sim
 * @param {object} o
 * @param {string|Date} o.simStart
 * @param {string|Date} o.simEnd
 * @param {number} [o.from]  first year to stop at (default: the simStart year)
 * @param {number} [o.to]    last year to stop at (default: the simEnd year)
 * @param {(state:object, year:number)=>void|boolean} o.on
 *        Return `false` to stop early.
 */
export function walkYearEnds(sim, { simStart, simEnd, from = null, to = null, on }) {
  const end = new Date(simEnd);
  const firstYear = from ?? new Date(simStart).getUTCFullYear();
  const lastYear = to ?? end.getUTCFullYear();
  for (let y = firstYear; y <= lastYear; y++) {
    const at = new Date(Date.UTC(y, 11, 31));
    const stop = at > end ? end : at;
    quiet(() => sim.stepTo(stop));
    if (on(sim.state, y) === false) return;
    if (stop >= end) return;
  }
}

/**
 * Track the minimum of a reading across a path.
 *
 * Trivial, and worth a name: `Math.min(trough, f(state))` written inline is where the
 * "which window?" question goes to die. A trough over the whole horizon and a trough
 * over the vulnerable decade are different numbers answering different questions, and
 * an inline expression records neither. `window` makes the choice explicit and keeps
 * it beside the answer.
 *
 * @param {(state:object, year:number)=>number} read
 * @param {[number, number]|null} [window]  inclusive year range; null = all years
 */
export function troughTracker(read, window = null) {
  let value = Infinity, year = null;
  return {
    observe(state, y) {
      if (window && (y < window[0] || y > window[1])) return;
      const v = read(state, y);
      if (v < value) { value = v; year = y; }
    },
    get value() { return value; },
    get year() { return year; },
    get window() { return window; },
  };
}

/**
 * Snapshot every EQUITY/BOND lot: what `sleeveReturn` needs, and nothing else.
 *
 * Deliberately UNCONVERTED — see `sleeveReturn`.
 */
export function lotSnapshot(state, classes = ['EQUITY', 'BOND']) {
  const keep = new Set(classes);
  const out = {};
  for (const [k, a] of Object.entries(state ?? {})) {
    if (!a || typeof a !== 'object' || !Array.isArray(a.holdings)) continue;
    for (const h of a.holdings) {
      if (!keep.has(h.allocation)) continue;
      out[`${k}::${h.id}`] = {
        mv: h.marketValue ?? 0, cb: h.costBasis ?? 0, cls: h.allocation,
        couponRate: h.couponRate, faceValue: h.faceValue,
        currency: a.currency?.code ?? a.currency,
      };
    }
  }
  return out;
}

/**
 * A year's TOTAL return for one sleeve, measured on the lots NOBODY TOUCHED.
 *
 * Price is measured, income is authored. Two reasons it has to be split that way:
 *
 *  · **PRICE** — `ΔmarketValue` over lots whose `costBasis` did not move. Restricting
 *    to untouched lots is not fussiness: selling an appreciated lot drops market value
 *    by the proceeds and basis by only the basis share, so a whole-book estimator reads
 *    a SALE as a loss and the arm that sells most looks like it lived through the worst
 *    market.
 *  · **INCOME** — coupons and dividends are paid OUT to cash in this model; they never
 *    accrue into a lot's market value. A price-only reading therefore scores bonds at
 *    ~0%/yr, which is not a small error, it is the whole of a bond's return. Coupon is
 *    exact (`couponRate × faceValue`, both on the lot); the equity dividend is the
 *    scenario's authored yield.
 *
 * Returns null when nothing was left untouched, rather than falling back to an
 * estimator that cannot tell a sale from a crash.
 *
 * ─── why this one does NOT convert currency ──────────────────────────────────
 *
 * It is a RATIO over a fixed set of lots, and both legs are the same lots, so a per-lot
 * conversion at one rate cancels. It does not cancel when the rate MOVES within the
 * year (a stagflation column moves USD_AUD by 10%) or across a mixed-currency sleeve —
 * so a cross-currency sleeve return read this way carries an FX component it does not
 * name. Every study using it so far holds its equity and bonds in USD accounts and pins
 * FX; `mixedCurrency` reports when that stops being true rather than silently
 * absorbing it.
 *
 * @param {object} prev   from `lotSnapshot`
 * @param {object} next   from `lotSnapshot`
 * @param {string} cls    'EQUITY' | 'BOND'
 * @param {number} [dividendRate]  authored equity yield
 * @returns {{value: number|null, lots: number, mixedCurrency: boolean}}
 */
export function sleeveReturn(prev, next, cls, dividendRate = 0) {
  let mv0 = 0, mv1 = 0, income = 0, lots = 0;
  const currencies = new Set();
  for (const [id, p] of Object.entries(prev)) {
    const q = next[id];
    if (!q || p.cls !== cls || p.mv <= 0) continue;
    if (Math.abs(q.cb - p.cb) > 1) continue;          // basis moved ⇒ a flow ⇒ not a clean read
    mv0 += p.mv; mv1 += q.mv; lots++;
    currencies.add(p.currency);
    income += (cls === 'BOND')
      ? (p.couponRate ?? 0) * (p.faceValue ?? p.mv)   // exact: both fields live on the lot
      : (cls === 'EQUITY' ? dividendRate * p.mv : 0); // authored yield (GOLD/CASH: none here)
  }
  return {
    value: mv0 > 0 ? (mv1 - mv0 + income) / mv0 : null,
    lots,
    mixedCurrency: currencies.size > 1,
  };
}

/**
 * Accumulate `sleeveReturn` across a path into a compounded CAGR per class.
 *
 * Compounds the yearly readings rather than averaging them, and divides by the number
 * of years that produced a reading — not the number of years walked. A year where
 * every lot was touched contributes nothing and must not be counted as a flat year,
 * or an arm that rebalances often reads as an arm that earned nothing.
 *
 * @param {object} o
 * @param {string[]} [o.classes]
 * @param {number}   [o.dividendRate]
 */
export function sleeveReturnTracker({ classes = ['EQUITY', 'BOND'], dividendRate = 0 } = {}) {
  const acc = {};
  for (const c of classes) acc[c] = { cum: 1, n: 0, yearly: [], mixedCurrency: false };
  let prev = null;

  return {
    /** Call once BEFORE the first step, then once after each. */
    observe(state) {
      const lots = lotSnapshot(state, classes);
      if (prev) {
        for (const c of classes) {
          const r = sleeveReturn(prev, lots, c, dividendRate);
          if (r.value == null) continue;
          acc[c].cum *= (1 + r.value);
          acc[c].n++;
          acc[c].yearly.push(Math.round(r.value * 100));
          if (r.mixedCurrency) acc[c].mixedCurrency = true;
        }
      }
      prev = lots;
    },
    cagr(c) { return acc[c].n > 0 ? Math.pow(acc[c].cum, 1 / acc[c].n) - 1 : null; },
    yearly(c) { return acc[c].yearly; },
    mixedCurrency(c) { return acc[c].mixedCurrency; },
  };
}
