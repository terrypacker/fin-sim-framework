/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Currency normalisation for journal report aggregation.
 *
 * **The defect this closes.** A cross-border journal holds money in two
 * currencies, and every money field says which one it is:
 * `AU_TAX_PAYMENT_DEBIT.amount` is declared `ValueType.currency('AUD')`, its US
 * and US-state siblings `ValueType.currency('USD')`; account balances are
 * stamped with their account's code via `StateSchemaRegistry.registerAccount`.
 * The aggregation layer then summed those declarations away: "Tax Paid by Year"
 * with the country facet blank added A$ onto US$ and reported the arithmetic
 * sum, a number in no currency (it overstated lifetime tax by ~46% on a
 * mostly-AU-source run). The declaration existed; nothing read it.
 *
 * **The fix.** Reports that can span currencies declare the currency their
 * totals are expressed in (`ReportDefinition.reportCurrency(params)`); every
 * summed field is then converted into it, per row, at the row's own date,
 * before folding. Conversion writes to a DERIVED field (`amount` →
 * `amountInUSD`) and repoints the aggregate spec at it, so a drill-down row
 * still shows the native amount the journal actually recorded.
 *
 * **Which rate.** The USD/AUD rate the run itself recorded, at the row's date:
 * `state.effectiveExchangeRates.USD_AUD`, recovered from the journal (see
 * {@link JournalFxRates}). Not a rate invented by the report — reconciling a
 * report against `state.cumulativeTaxesPaid` (converted at each settle by
 * AccumulateTaxesPaidReducer) only works if both use the run's own rates.
 *
 * **What is deliberately NOT converted.** A report that declares no
 * `reportCurrency` is untouched, so single-currency reports (the cc-faceted
 * income/gain drills, whose accumulators are jurisdiction-fixed) stay
 * byte-identical and keep footing to the tax returns that link to them.
 */

import { fxRate } from '../fx/fx-conversion.js';

/** The state path carrying the run's live USD→AUD rate (AUD per USD). */
export const USD_AUD_PATH = 'effectiveExchangeRates.USD_AUD';

/** Tax settlements stamp the settle-date rate onto the action (design 71 §5.5). */
const SETTLE_TYPES = new Set(['US_TAX_SETTLE_APPLY', 'AU_TAX_SETTLE_APPLY', 'STATE_TAX_SETTLE_APPLY']);

/**
 * Per-diff row fields whose unit comes from the row's `stateKey` (the state
 * schema) rather than from the action payload (the type registry).
 */
const STATE_VALUED_FIELDS = new Set(['stateDelta', 'absStateDelta', 'stateBefore', 'stateAfter']);

/**
 * The run's USD/AUD rate history, recovered from a finished journal.
 *
 * Two sources, in order — the first that yields anything wins:
 *
 *  1. **State diffs on `effectiveExchangeRates.USD_AUD`.** Present in every run
 *     whose rate actually moves (FX process / regime shocks), headless included.
 *     The first diff's `before` seeds the opening rate.
 *  2. **`fxRate` stamped on tax settlements.** A static-FX run never diffs the
 *     rate, so source 1 is empty there; the settlements carry the same number
 *     the whole way through, which is exactly right when it never moves.
 *
 * A `fallbackRate` callback (the live sim state, via StateSchemaRegistry) covers
 * the remaining case: a run that records a rate in state but neither moves it
 * nor settles tax. When no source yields a rate, `convert()` returns null and
 * the caller must drop the row rather than sum two currencies as one.
 */
export class JournalFxRates {
  /**
   * @param {import('../../simulation-framework/journal.js').Journal} journal
   * @param {{ fallbackRate?: () => number|null }} [opts]
   */
  constructor(journal, { fallbackRate = null } = {}) {
    this._points       = _buildRatePoints(journal);
    this._fallbackRate = fallbackRate;
  }

  /** True when the journal recorded no rate at all. */
  get isEmpty() { return this._points.length === 0; }

  /**
   * AUD per USD in force at `ts`: the most recent recorded rate at or before it.
   * A `ts` earlier than the first recorded point reads that first point (the
   * opening rate of the run), and a journal with no rates at all falls back to
   * the live state — else null.
   *
   * @param {number} ts  epoch milliseconds
   * @returns {number|null}
   */
  rateAt(ts) {
    const pts = this._points;
    if (pts.length === 0) return this._fallbackRate?.() ?? null;
    if (!Number.isFinite(ts) || ts <= pts[0].ts) return pts[0].rate;

    // Binary search for the last point at or before ts.
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid].ts <= ts) lo = mid; else hi = mid - 1;
    }
    return pts[lo].rate;
  }

  /**
   * Convert `amount` between currencies at the rate in force at `ts`.
   * Returns null when a conversion is needed but no rate is known — never a
   * silent 1.0, which would reintroduce the raw-sum defect.
   *
   * @returns {number|null}
   */
  convert(amount, fromCcy, toCcy, ts) {
    if (amount == null) return null;
    if (fromCcy === toCcy) return amount;
    const rate = this.rateAt(ts);
    if (rate == null || !(rate > 0)) return null;
    return amount * fxRate(fromCcy, toCcy, rate);
  }
}

/**
 * Normalise every currency-typed aggregate field to `targetCurrency`.
 *
 * Returns the rows (shallow-copied when anything was converted, so the caller's
 * projected rows are never mutated) and the aggregate specs repointed at the
 * derived fields. Both come back untouched when there is nothing to do:
 * no target currency, no numeric aggregates, or no field that any row declares
 * a currency for.
 *
 * @param {object}   opts
 * @param {object[]} opts.rows
 * @param {Record<string,{fn:string,field?:string}>} opts.aggregates
 * @param {string|null} opts.targetCurrency         e.g. 'USD'
 * @param {import('../../simulation-framework/type-registry.js').TypeRegistry}   [opts.typeRegistry]
 * @param {import('../services/state-schema-registry.js').StateSchemaRegistry}   [opts.schemaRegistry]
 * @param {JournalFxRates} opts.fx
 * @param {(msg: string) => void} [opts.warn]
 * @returns {{rows: object[], aggregates: Record<string,{fn:string,field?:string}>}}
 */
export function normalizeAggregateCurrency({
  rows, aggregates, targetCurrency, typeRegistry = null, schemaRegistry = null, fx, warn = _warnOnce,
}) {
  if (!targetCurrency || !rows?.length || !aggregates) return { rows, aggregates };

  // Fields that get folded numerically. `count` has no field; `distinct` counts
  // identities, not money.
  const fields = [...new Set(
    Object.values(aggregates)
      .filter(a => a?.field && a.fn !== 'count' && a.fn !== 'distinct')
      .map(a => a.field),
  )];
  if (fields.length === 0) return { rows, aggregates };

  // Resolve each row's declared currency once per (row, field). A field no row
  // declares a currency for is left alone entirely — the report is summing
  // something that is not money (a count, a rate), and rewriting it would only
  // add a redundant derived column.
  const declared = new Map();   // field → (row → code|null)
  const converted = new Set();  // fields that will be rewritten
  for (const field of fields) {
    const codes = new Map();
    let anyCurrency = false;
    for (const row of rows) {
      const code = _rowCurrency(row, field, typeRegistry, schemaRegistry);
      if (code) anyCurrency = true;
      codes.set(row, code);
    }
    if (anyCurrency) { declared.set(field, codes); converted.add(field); }
  }
  if (converted.size === 0) return { rows, aggregates };

  const derivedName = f => `${f}In${targetCurrency}`;
  let dropped = 0;
  let unknown = 0;

  const outRows = rows.map((row) => {
    const copy = { ...row };
    for (const field of converted) {
      const value = row[field];
      if (typeof value !== 'number') { copy[derivedName(field)] = null; continue; }
      const code = declared.get(field).get(row);
      if (!code) {
        // Money whose unit was never declared. Assume it is already in the
        // target currency — the same assumption the display layer makes for a
        // code-less currency field — but say so, since an undeclared unit is a
        // gap in the schema rather than a fact about the value.
        unknown++;
        copy[derivedName(field)] = value;
        continue;
      }
      const conv = fx?.convert(value, code, targetCurrency, row.ts);
      // No rate for a genuine cross-currency row: drop it from the fold rather
      // than let it through in the wrong unit. `count` still sees the row, so
      // the loss is visible rather than silent.
      if (conv == null) { dropped++; copy[derivedName(field)] = null; continue; }
      copy[derivedName(field)] = conv;
    }
    return copy;
  });

  const outAggregates = {};
  for (const [name, spec] of Object.entries(aggregates)) {
    outAggregates[name] = (spec?.field && converted.has(spec.field))
      ? { ...spec, field: derivedName(spec.field) }
      : spec;
  }

  if (dropped) {
    warn(`[report-currency] ${dropped} row(s) excluded from the ${targetCurrency} total: `
       + 'no USD/AUD rate recorded in the journal at their date.');
  }
  if (unknown) {
    warn(`[report-currency] ${unknown} row(s) counted as ${targetCurrency} with no declared `
       + 'currency — declare the field in its toolset (ValueType.currency) or its state path '
       + '(StateSchemaRegistry) to make the unit explicit.');
  }

  return { rows: outRows, aggregates: outAggregates };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The currency a row's `field` is denominated in, or null when nothing declares
 * one. Per-diff rows carry a state value whose unit belongs to the `stateKey`
 * path (an AU account's balance is AUD); every other field is an action payload
 * field owned by the action type.
 */
function _rowCurrency(row, field, typeRegistry, schemaRegistry) {
  if (STATE_VALUED_FIELDS.has(field)) {
    if (!row.stateKey) return null;
    const vt = schemaRegistry?.resolve?.(row.stateKey);
    return vt?.kind === 'currency' ? (vt.currencyCode ?? null) : null;
  }
  if (!row.actionType) return null;
  return typeRegistry?.fieldCurrency?.(row.actionType, field) ?? null;
}

/** Build the sorted [{ts, rate}] history — see JournalFxRates for the sources. */
function _buildRatePoints(journal) {
  const entries = journal?.journal ?? [];
  const points  = [];

  for (const e of entries) {
    const diff = e.stateDiff?.find(d => d.field === USD_AUD_PATH);
    if (!diff) continue;
    if (points.length === 0 && typeof diff.before === 'number' && diff.before > 0) {
      // Seed the opening rate: everything before the first move ran on it.
      points.push({ ts: -Infinity, rate: diff.before });
    }
    if (typeof diff.after === 'number' && diff.after > 0) {
      points.push({ ts: _tsOf(e.date), rate: diff.after });
    }
  }
  if (points.length > 0) return _sortByTs(points);

  for (const e of entries) {
    if (!SETTLE_TYPES.has(e.action?.type)) continue;
    const rate = e.action?.data?.fxRate;
    if (typeof rate === 'number' && rate > 0) points.push({ ts: _tsOf(e.date), rate });
  }
  return _sortByTs(points);
}

function _sortByTs(points) {
  return points.sort((a, b) => a.ts - b.ts);
}

function _tsOf(date) {
  return date instanceof Date ? date.getTime() : new Date(date).getTime();
}

const _warned = new Set();

/** Warn once per distinct message — a report re-renders on every facet change. */
function _warnOnce(msg) {
  if (_warned.has(msg)) return;
  _warned.add(msg);
  console.warn(msg);
}
