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
 * `JournalPriceLevels` — the run's own inflation history, recovered from a finished
 * journal. Design 89 §9.b.1.
 *
 * **Why this is not design 79's job.** The draft called design 79 (real vs nominal) a
 * dependency, and it is not: `state.inflationAccumulator.US` / `.AU` are diffed into the
 * journal — 88 diffs on the reference run, twice a year per country — so the price-level
 * history is recoverable from a finished journal by exactly the machinery
 * `JournalFxRates` already uses for the exchange rate. 79 remains the dependency for an
 * app-wide value-basis toggle; it was never the dependency for one report, and
 * conflating the two would have parked this behind an unstarted design.
 *
 * **Why a spending chart cannot skip it.** Design 82 could defer real-vs-nominal because
 * its headline view is a *share*, and shares are unitless. A spending chart has no such
 * escape — its entire subject is the level. The reference plan's terminal accumulator is
 * ~3.7x, so a nominal chart's last bar is nearly four times its first for **identical
 * real spending**. That is not a caveat; left alone it is the chart's dominant visual
 * signal, and it points the opposite way from the truth.
 *
 * Deliberately mirrors `JournalFxRates`: same construction from state diffs, same
 * binary search, same "seed the opening value from the first diff's `before`", and the
 * same refusal to invent a value it does not have. A caller that gets `null` must say so
 * rather than divide by 1.
 */

/** The state paths this reads. One per country the sim inflates. */
export const PRICE_LEVEL_PATHS = Object.freeze({
  US: 'inflationAccumulator.US',
  AU: 'inflationAccumulator.AU',
});

export class JournalPriceLevels {
  /**
   * @param {import('../../simulation-framework/journal.js').Journal} journal
   * @param {{ fallbackLevel?: (cc: string) => number|null }} [opts]
   *   Consulted only when the journal recorded no movement at all for that country —
   *   a run with inflation switched off, where the accumulator never diffs.
   */
  constructor(journal, { fallbackLevel = null } = {}) {
    this._points = new Map();      // cc → [{ts, level}] ascending
    for (const [cc, path] of Object.entries(PRICE_LEVEL_PATHS)) {
      this._points.set(cc, _buildPoints(journal, path));
    }
    this._fallbackLevel = fallbackLevel;
  }

  /** True when the journal recorded no price level for any country. */
  get isEmpty() {
    for (const points of this._points.values()) if (points.length > 0) return false;
    return true;
  }

  /** The countries this journal actually carries a history for. */
  countries() {
    return [...this._points].filter(([, p]) => p.length > 0).map(([cc]) => cc);
  }

  /**
   * The cumulative price level in force at `ts` — the index nominal money at that date
   * must be divided by to reach base-year (t=0) real money.
   *
   * A `ts` before the first recorded point reads that point (the opening level of the
   * run, seeded from its `before`), matching `JournalFxRates.rateAt`.
   *
   * @param {number} ts   epoch milliseconds
   * @param {string} [cc='US']
   * @returns {number|null} null when nothing recorded a level and no fallback supplied
   */
  levelAt(ts, cc = 'US') {
    const points = this._points.get(cc) ?? [];
    if (points.length === 0) {
      const fallback = this._fallbackLevel?.(cc) ?? null;
      return fallback != null && fallback > 0 ? fallback : null;
    }
    if (!Number.isFinite(ts) || ts <= points[0].ts) return points[0].level;

    let lo = 0, hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (points[mid].ts <= ts) lo = mid; else hi = mid - 1;
    }
    return points[lo].level;
  }

  /**
   * Nominal money at `ts` restated in base-year real money.
   *
   * Returns null rather than the nominal amount when no level is known — the same
   * contract as `JournalFxRates.convert`, and for the same reason: a silent pass-through
   * is a nominal number wearing a real label, which is precisely the defect this exists
   * to remove.
   *
   * @param {number} amount
   * @param {number} ts
   * @param {string} [cc='US']
   * @returns {number|null}
   */
  toReal(amount, ts, cc = 'US') {
    if (amount == null) return null;
    const level = this.levelAt(ts, cc);
    if (level == null || !(level > 0)) return null;
    return amount / level;
  }

  /**
   * The terminal level, for the page's "money at the end of the plan is worth 1/N of
   * money at the start" line. That sentence is what makes the real-terms default
   * defensible to a reader rather than merely applied to them.
   *
   * @param {string} [cc='US']
   * @returns {number|null}
   */
  terminalLevel(cc = 'US') {
    const points = this._points.get(cc) ?? [];
    return points.length > 0 ? points[points.length - 1].level : this._fallbackLevel?.(cc) ?? null;
  }
}

/**
 * Build the ascending [{ts, level}] history for one state path.
 *
 * The `before` seed matters more here than it does for FX: the accumulator starts at
 * exactly 1.0 and every debit before the first diff belongs at that level, so without
 * the seed the earliest — and largest, in real terms — bars would be deflated by the
 * level of the *first increment* instead.
 * @private
 */
function _buildPoints(journal, path) {
  const points = [];
  for (const entry of journal?.journal ?? []) {
    const diff = entry.stateDiff?.find(d => d.field === path);
    if (!diff) continue;
    if (points.length === 0 && typeof diff.before === 'number' && diff.before > 0) {
      points.push({ ts: -Infinity, level: diff.before });
    }
    if (typeof diff.after === 'number' && diff.after > 0) {
      points.push({ ts: _tsOf(entry.date), level: diff.after });
    }
  }
  return points.sort((a, b) => a.ts - b.ts);
}

function _tsOf(date) {
  return date instanceof Date ? date.getTime() : new Date(date).getTime();
}
