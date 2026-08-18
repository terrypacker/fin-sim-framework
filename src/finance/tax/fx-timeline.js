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
 * fx-timeline — the run's own FX path, recovered from the journal.
 *
 * ## Why this exists
 *
 * A cross-border return converts foreign figures at the rate in force **when each
 * item accrued**, but the only rate the reporting layer had was `taxFxRate` — the
 * settle-date rate, stamped once a year. `taxFxRate`'s own header says as much:
 *
 * > It is NOT a weighted average of the rates applied to individual income items as
 * > they accrued: those were converted at each period's own rate as the year ran.
 *
 * With a static rate the two agree and nothing is lost. Once rates move within a year
 * — FX vol, a regime shock, a design 47 time-varying path — the settle rate is a
 * year-end benchmark, and using it to translate a January disposal onto Form 8949
 * silently restates the sale at a rate that never applied to it.
 *
 * ## Why the journal is the right source, and no payload stamp is needed
 *
 * Every disposal already carries its date: it is the date of the journal entry that
 * recorded it. What was missing was not the date but the **index** — a way to turn a
 * date back into the rate the run was actually using. The journal already holds that
 * too: `effectiveExchangeRates.USD_AUD` is state, so every move of it is recorded as a
 * `stateDiff` on the entry that moved it. Reading them back reconstructs the path
 * exactly, for runs already on disk as well as for new ones, with no manifest change
 * and no new payload field to keep in sync with the reducers that would stamp it.
 *
 * This is the same availability the AU CGT worksheet already relies on: it reads
 * per-person gains out of `stateDiff` (`_personSharesFor`). A journal without state
 * diffs cannot produce a tax document at all, so there is no configuration in which
 * this degrades silently while the rest of the return still works.
 *
 * ## Position, not date, is the primary key
 *
 * Several reducers can move the rate on a single date, in sequence — the FX refresh
 * mirrors `base → effective` at a period advance and the regime reducer then overwrites
 * it, so 1 Jan legitimately reads 1.55 → 1.63 → 1.55 → 1.63. "The rate on that date" is
 * therefore ambiguous; "the rate in force at journal position *i*" is not. Callers
 * walking the journal — which is how every disposal register is built — should use
 * {@link FxTimeline#at}. {@link FxTimeline#onDate} exists for callers that hold only a
 * date, and answers with the LAST rate in force on it, which is the settled value.
 */

import { TAX_FX_PAIR } from './tax-fx.js';

/** The state field an FX pair's rate lives on. */
const rateFieldFor = pair => `effectiveExchangeRates.${pair}`;

/**
 * The rate path of one currency pair over a run, indexed by journal position.
 *
 * Rates are quoted the way the state field is: for `USD_AUD`, AUD per USD.
 */
export class FxTimeline {
  /**
   * @param {object[]} journal          full journal entry array
   * @param {string}   [pair=USD_AUD]   `effectiveExchangeRates` key
   */
  constructor(journal, pair = TAX_FX_PAIR) {
    this.pair = pair;
    const field = rateFieldFor(pair);

    /**
     * `{ index, dateMs, rate }`, ascending by index — one point per recorded move.
     *
     * The FIRST point is seeded from that diff's `before`, not its `after`: the run
     * held a rate from its very first entry, and the journal only records the moment
     * it CHANGED. Without the seed, every disposal before the first move would fall
     * off the front of the timeline and take the null path, which on a scenario whose
     * rate never moves at all — the common case — is every disposal in the run.
     */
    this.points = [];
    for (let i = 0; i < (journal?.length ?? 0); i++) {
      const diff = journal[i].stateDiff?.find(d => d.field === field);
      if (diff == null) continue;
      if (this.points.length === 0 && diff.before != null) {
        this.points.push({ index: -1, dateMs: -Infinity, rate: diff.before });
      }
      if (diff.after == null) continue;
      this.points.push({ index: i, dateMs: _ms(journal[i].date), rate: diff.after });
    }
  }

  /** True when the run recorded no rate at all — a single-country scenario. */
  get isEmpty() { return this.points.length === 0; }

  /**
   * The rate in force at journal position `index` — the last move at or before it.
   *
   * A disposal at position `i` is converted by the reducer reading state as it stood
   * when that entry was written, so "at or before" is the exact rule, not an
   * approximation of one.
   *
   * @returns {number|null} null when the run records no rate — never a silent 1.0,
   *                        for the reason `taxFxRate` documents.
   */
  at(index) {
    let rate = null;
    for (const p of this.points) {
      if (p.index > index) break;
      rate = p.rate;
    }
    return rate;
  }

  /**
   * The rate settled on a calendar date — the last move at or before the END of it.
   *
   * For callers holding a date rather than a journal position. Where several reducers
   * moved the rate during the day this reports the value it came to rest on, which is
   * what an external lookup against a published daily series would return.
   *
   * @param {Date|number|string} date
   * @returns {number|null}
   */
  onDate(date) {
    const ms = _ms(date);
    if (ms == null) return null;
    let rate = null;
    for (const p of this.points) {
      if (p.dateMs > ms) break;
      rate = p.rate;
    }
    return rate;
  }
}

/**
 * Convert `amount` from `fromCcy` into `toCcy` at a rate quoted as `toCcy` per `USD`
 * against `fromCcy` per USD — i.e. the `USD_<X>` convention of `effectiveExchangeRates`.
 *
 * Only the USD/AUD pair exists today, so this handles the two crossings that pair
 * admits and returns the amount untouched for anything else. It is deliberately NOT a
 * general converter: `toCcy` in tax-fx.js is that, and it reads a state snapshot. This
 * one takes a bare rate, because the caller has recovered a HISTORICAL rate that no
 * live state snapshot carries any more.
 *
 * @param {number}  amount
 * @param {string}  fromCcy
 * @param {string}  toCcy
 * @param {?number} rate     foreign units per USD, from {@link FxTimeline}
 */
export function convertAtRate(amount, fromCcy, toCcy, rate) {
  if (amount == null || fromCcy === toCcy) return amount;
  if (!(rate > 0)) return amount;
  if (toCcy === 'USD') return amount / rate;
  if (fromCcy === 'USD') return amount * rate;
  return amount;
}

/** Milliseconds from a Date, epoch number or parseable string; null when unusable. */
function _ms(date) {
  if (date == null) return null;
  const ms = date instanceof Date ? date.getTime() : new Date(date).getTime();
  return Number.isFinite(ms) ? ms : null;
}
