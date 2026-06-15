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

import { QueryApi } from '../query/query-api.js';

/**
 * JournalQueryApi — extends QueryApi with domain-aware helpers for journal queries.
 *
 * Helpers return pre-built AST nodes that can be composed into aggregate() or
 * search() calls without hand-crafting DSL strings.
 *
 * Also overrides _buildIndexes to add actionType and cc indexes on top of the
 * base id/name indexes (mirrors GraphQueryApi's _kindIndex / _layerIndex pattern).
 */
export class JournalQueryApi extends QueryApi {

  /**
   * @param {import('../query/query-api.js').DataSource} dataSource
   * @param {import('../simulation-framework/type-registry.js').TypeRegistry} [typeRegistry]
   * @param {import('./period/period-service.js').PeriodService} [periodService]
   */
  constructor(dataSource, typeRegistry, periodService) {
    super(dataSource);
    this._typeRegistry  = typeRegistry  ?? null;
    this._periodService = periodService ?? null;
  }

  /**
   * Delegates to TypeRegistry.familyTypes(). Returns [] when no registry is bound.
   * Use the result as the `value` of an `op:'in'` predicate on `actionType`.
   *
   * @param {string} family
   * @param {{ cc?: string }} [opts]
   * @returns {string[]}
   */
  familyTypes(family, { cc } = {}) {
    return this._typeRegistry?.familyTypes(family, { cc }) ?? [];
  }

  // ─── Domain helpers ────────────────────────────────────────────────────────

  /**
   * Build an AST node that filters rows with ts strictly between fromTs and toTs.
   * Pass the returned node as (part of) a query to search() or aggregate().
   * Use for calendar/FY date-range queries (auFy, usCalYear).
   *
   * For tax-period drill-down queries use periodOf() instead, which uses seq
   * ordering to correctly include same-day income entries that run before the
   * TAX_SETTLE_APPLY entry on the settlement date.
   *
   * @param {number} fromTs  - Lower bound (exclusive), milliseconds epoch.
   * @param {number} toTs    - Upper bound (exclusive), milliseconds epoch.
   * @returns {object} AST node
   */
  between(fromTs, toTs) {
    return {
      op: 'and',
      conditions: [
        { op: 'gt', field: 'ts', value: fromTs },
        { op: 'lt', field: 'ts', value: toTs   },
      ],
    };
  }

  /**
   * Build an AST node that filters rows with seq strictly between fromSeq and toSeq.
   * seq ordering is stable and avoids same-timestamp ambiguity on settlement days.
   *
   * @param {number} fromSeq  - Lower bound (exclusive)
   * @param {number} toSeq    - Upper bound (exclusive)
   * @returns {object} AST node
   */
  betweenSeq(fromSeq, toSeq) {
    return {
      op: 'and',
      conditions: [
        { op: 'gt', field: 'seq', value: fromSeq },
        { op: 'lt', field: 'seq', value: toSeq   },
      ],
    };
  }

  /**
   * Build an AST node for the AU fiscal year starting 1 July of `year`
   * and ending 30 June of `year + 1`.
   *
   * @param {number} year  - FY start year (e.g. 2025 = FY2025-26)
   * @returns {object} AST node
   */
  auFy(year) {
    const from = Date.UTC(year,     6,  1);  // 1 Jul year
    const to   = Date.UTC(year + 1, 6,  1);  // 1 Jul year+1
    return this.between(from, to);
  }

  /**
   * Build an AST node for the US calendar year.
   *
   * @param {number} year  - e.g. 2025
   * @returns {object} AST node
   */
  usCalYear(year) {
    const from = Date.UTC(year,     0, 1);
    const to   = Date.UTC(year + 1, 0, 1);
    return this.between(from, to);
  }

  /**
   * Resolve a period descriptor to a seq-based AST node that spans the period
   * bounded by the two TAX_SETTLE_APPLY journal entries.
   *
   * period = { fromEntryId?, toEntryId }
   *   - toEntryId   → id of the TAX_SETTLE_APPLY being reported (exclusive upper bound)
   *   - fromEntryId → id of the previous TAX_SETTLE_APPLY (exclusive lower bound)
   *                   null / absent → include everything before toEntry
   *
   * Using seq rather than ts correctly handles settlement days where income
   * entries and the TAX_SETTLE_APPLY share the same UTC timestamp — the income
   * entries always have lower seq values than the settle entry. It also
   * excludes "post-settle, same-day" entries (e.g. month-end income that lands
   * after Dec 31's settle), which semantically belong to the next tax year.
   *
   * **Use this for income / capital-gain reports** that should match the
   * modal's pre-settle YTD totals. For reports that want the settle itself
   * and its chained downstream (TAX_PAYMENT_DEBIT etc.), use
   * {@link periodOfTaxYear} instead.
   *
   * @param {object} period   - { fromEntryId?: string, toEntryId?: string }
   * @returns {object} AST node suitable for search() or aggregate()
   */
  periodOf(period) {
    const entries = this._dataSource._journal.journal;
    let fromSeq = -1;
    let toSeq   = entries.length; // default: include all remaining entries

    if (period?.toEntryId) {
      const e = entries.find(e => e.id === period.toEntryId);
      if (e) toSeq = e.seq;
    }

    if (period?.fromEntryId) {
      const e = entries.find(e => e.id === period.fromEntryId);
      if (e) fromSeq = e.seq;
    }

    return this.betweenSeq(fromSeq, toSeq);
  }

  /**
   * Like {@link periodOf}, but returns a timestamp-bounded AST spanning the
   * full tax year (calendar year for US, July-anchored fiscal year for AU)
   * containing the period's settle entry. This includes the settle ITSELF and
   * any actions chained from it that share the trigger date —
   * TAX_PAYMENT_DEBIT and RECORD_BALANCE being the common cases. It also
   * sweeps in any other cc's entries that happen to fall in the same date
   * window (e.g. US payments in an AU FY); reports that want a single cc
   * should add `eq(cc, …)` to their predicate.
   *
   * Use this for reports keyed on the settle or its downstream:
   *   - `AU Tax by Person & Year`            (queries TAX_SETTLE_APPLY itself)
   *   - `Tax Paid by Year`                   (chained TAX_PAYMENT_DEBIT)
   *   - `Cash Flow by Account` and friends   (chained debit moves cash)
   *
   * Period descriptor semantics:
   *   - toEntryId present                → CY/FY containing the toEntry's date.
   *   - fromEntryId only (Current)       → starts at the end of fromEntry's
   *                                        tax year; no upper bound.
   *   - both null (Whole simulation)     → identity-true predicate.
   */
  periodOfTaxYear(period) {
    const entries = this._dataSource._journal.journal;

    if (!period || (period.fromEntryId == null && period.toEntryId == null)) {
      return { op: 'gt', field: 'seq', value: -1 };
    }

    if (period.toEntryId) {
      const toEntry = entries.find(e => e.id === period.toEntryId);
      if (!toEntry) return { op: 'gt', field: 'seq', value: -1 };
      const cc     = _ccFromEntry(toEntry);
      const window = _taxYearRange(cc, toEntry.date);
      return {
        op: 'and',
        conditions: [
          { op: 'gt', field: 'ts', value: window.start - 1 },
          { op: 'lt', field: 'ts', value: window.end       },
        ],
      };
    }

    const fromEntry = entries.find(e => e.id === period.fromEntryId);
    if (!fromEntry) return { op: 'gt', field: 'seq', value: -1 };
    const cc     = _ccFromEntry(fromEntry);
    const window = _taxYearRange(cc, fromEntry.date);
    return { op: 'gt', field: 'ts', value: window.end - 1 };
  }

  /**
   * Enumerate every tax-settle entry matching `cc` and pair it with its
   * predecessor to produce a list of settled periods. Returned in reverse
   * chronological order so the most recent period is first — matches the
   * "default to most recent" UX in the period facet.
   *
   * Pass cc = '' (or null/undefined) to list settles across all countries.
   *
   * Labels follow design §9 Phase 3 task 3:
   *   - US: `CY <year>`            (calendar year of toEntryDate)
   *   - AU: `FY <start>–<end2>`    (July-anchored fiscal year containing
   *                                 toEntryDate; `end2` is the FY-end year's
   *                                 last two digits)
   *   - cross-cc: falls back to the per-entry cc when emitting each label so
   *     the list stays readable when both countries are mixed in.
   *
   * @param {string} [cc]  — 'US' | 'AU' | falsy for all
   * @returns {Array<{fromEntryId: string|null, toEntryId: string, toEntryDate: Date, label: string}>}
   */
  listSettledPeriods(cc) {
    const entries = this._dataSource._journal.journal;
    const matchesCc = cc
      ? (e => _ccFromEntry(e) === cc)
      : (() => true);
    const settles = entries.filter(e =>
      _isSettleEntry(e) && matchesCc(e)
    );

    const periods = [];
    for (let i = 0; i < settles.length; i++) {
      const curr = settles[i];
      const prev = i > 0 ? settles[i - 1] : null;
      const entryCc = _ccFromEntry(curr) ?? cc ?? null;
      periods.push({
        fromEntryId: prev?.id ?? null,
        toEntryId:   curr.id,
        toEntryDate: curr.date,
        label:       _formatPeriodLabel(entryCc, curr.date),
      });
    }
    return periods.reverse();
  }

  /**
   * Describe the "in progress" period — the slice of the journal between the
   * last settle for `cc` and the current end of the journal. Used by the
   * period facet to expose mid-year state (the user has rewound or simulation
   * is still running).
   *
   * Returns null when:
   *   - the journal is empty, or
   *   - no settle exists yet for `cc` (Whole simulation already covers that
   *     case, so no duplicate option), or
   *   - the last settle IS the last journal entry (no post-settle activity).
   *
   * @param {string} [cc]  — 'US' | 'AU' | falsy for all
   * @returns {{fromEntryId: string|null, toEntryId: null, label: string}|null}
   */
  currentInProgressPeriod(cc) {
    const entries = this._dataSource._journal.journal;
    if (!entries.length) return null;

    const matchesCc = cc ? (e => _ccFromEntry(e) === cc) : (() => true);
    const settles = entries.filter(e =>
      _isSettleEntry(e) && matchesCc(e)
    );
    if (!settles.length) return null;

    const lastSettle  = settles[settles.length - 1];
    const hasPostSettleActivity = entries.some(e => e.seq > lastSettle.seq);
    if (!hasPostSettleActivity) return null;

    return {
      fromEntryId: lastSettle.id,
      toEntryId:   null,
      label:       'Current (in progress)',
    };
  }

  // ─── Period-based aggregation ─────────────────────────────────────────────

  /**
   * Aggregate filtered journal rows into year-level groups, delegating the
   * per-year rollup to PeriodService.aggregate() rather than ad-hoc date math.
   *
   * Each year period of `periodType` becomes one result group. Totals are
   * rolled up from monthly leaf periods: for each row the owning MONTH period
   * is found via PeriodService.getPeriodsAt(), then PeriodService.aggregate()
   * sums leaf contributions up to the year level.
   *
   * Falls back to the generic QueryApi.aggregate() with `groupBy:['year']`
   * when no PeriodService is available so callers need not branch.
   *
   * @param {object}   opts
   * @param {string|object} opts.query         - DSL or pre-built AST
   * @param {string}   opts.periodType         - 'YEAR_US' | 'YEAR_AU'
   * @param {Record<string,{fn:string,field?:string}>} opts.aggregates
   * @returns {Promise<{groups: Array, grandTotal: number|null}>}
   */
  async aggregateByYear({ query, periodType, aggregates }) {
    if (!this._periodService) {
      return this.aggregate({ query, groupBy: ['year'], aggregates });
    }

    const where     = typeof query === 'string' ? this._parse(query) : query;
    const predicate = this._buildPredicate(where);
    const rows      = this._dataSource.getAll().filter(predicate);

    const yearPeriods = this._periodService.getAllPeriods()
      .filter(p => p.type === periodType)
      .sort((a, b) => a.startMs - b.startMs);

    // Build a per-leaf (month) metric map from the filtered rows.
    // Each row is assigned to the single MONTH period that contains its ts.
    const leafTotals = new Map();
    const leafCounts = new Map();
    const sumField   = aggregates.total?.field;
    for (const row of rows) {
      const month = this._periodService.getPeriodsAt(row.ts).find(p => p.type === 'MONTH');
      if (!month) continue;
      const val = sumField != null ? (row[sumField] ?? 0) : 0;
      if (typeof val === 'number') {
        leafTotals.set(month.id, (leafTotals.get(month.id) ?? 0) + val);
      }
      leafCounts.set(month.id, (leafCounts.get(month.id) ?? 0) + 1);
    }

    // Roll up totals to the year level using PeriodService.aggregate(), then
    // collect the raw row items so expanded drill-down rows work unchanged.
    const groups = [];
    for (const yp of yearPeriods) {
      const total = this._periodService.aggregate(yp.id, p => leafTotals.get(p.id) ?? 0);
      const count = this._periodService.aggregate(yp.id, p => leafCounts.get(p.id) ?? 0);
      if (count === 0) continue;
      const items = rows.filter(r => r.ts >= yp.startMs && r.ts < yp.endMs);
      groups.push({ key: { year: _yearFromPeriod(yp) }, total, count, items });
    }

    const grandTotal = aggregates.total
      ? groups.reduce((s, g) => s + (g.total ?? 0), 0)
      : null;

    return { groups, grandTotal };
  }

  // ─── Index optimisation ────────────────────────────────────────────────────

  _buildIndexes() {
    const all = this._dataSource.getAll();
    super._buildIndexesFrom(all);

    this._actionTypeIndex = new Map();
    this._ccIndex         = new Map();

    for (const row of all) {
      if (row.actionType) {
        if (!this._actionTypeIndex.has(row.actionType))
          this._actionTypeIndex.set(row.actionType, []);
        this._actionTypeIndex.get(row.actionType).push(row);
      }
      if (row.cc) {
        if (!this._ccIndex.has(row.cc))
          this._ccIndex.set(row.cc, []);
        this._ccIndex.get(row.cc).push(row);
      }
    }
    this.rebuildIndexes = false;
  }

  _extractIndexCandidates(node) {
    if (!node) return null;

    if (node.op === 'eq' && node.field === 'actionType') {
      return this._actionTypeIndex?.get(String(node.value)) ?? [];
    }
    if (node.op === 'eq' && node.field === 'cc') {
      return this._ccIndex?.get(String(node.value)) ?? [];
    }

    return super._extractIndexCandidates(node);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the display year (integer) from a YEAR_US or YEAR_AU period.
 * US-2024 → 2024; AU-2023-2024 → 2024 (last numeric segment = FY end year).
 * This matches the `year: dateObj.getUTCFullYear()` convention used in
 * JournalDataSource._project() so the key format stays consistent with the
 * generic groupBy:['year'] fallback path.
 */
function _yearFromPeriod(period) {
  const parts = period.id.split('-').filter(s => /^\d+$/.test(s));
  return parseInt(parts[parts.length - 1], 10);
}

const SETTLE_ACTION_TYPES = new Set(['US_TAX_SETTLE_APPLY', 'AU_TAX_SETTLE_APPLY']);

/** Returns true when the journal entry is a tax-settle entry (either country). */
function _isSettleEntry(e) {
  return SETTLE_ACTION_TYPES.has(e.action?.type);
}

/**
 * Derive the country code from a journal entry, checking `action.data.cc`
 * first for backward compatibility, then inferring from the action type prefix.
 */
function _ccFromEntry(e) {
  const dc = e.action?.data?.cc;
  if (dc) return dc;
  const type = e.action?.type ?? '';
  if (type.startsWith('US_')) return 'US';
  if (type.startsWith('AU_')) return 'AU';
  return null;
}

/**
 * Format a period label from a settle entry's `cc` + `toEntryDate`.
 *   US → `CY 2026`           (calendar year of toEntryDate)
 *   AU → `FY 2025–26`        (July-anchored fiscal year containing toEntryDate)
 *   other / unknown cc → ISO date as a safe fallback so the label is unique.
 */
/**
 * Compute the [start, end) timestamp window for the tax year containing
 * `date`, anchored to `cc`'s tax-year convention:
 *   - US (and any non-AU): calendar year — Jan 1 (start) to Jan 1 next year (end).
 *   - AU: July-anchored fiscal year — Jul 1 to Jul 1 next year. Dates in Jan–Jun
 *     belong to the FY that ended in `year`; dates in Jul–Dec belong to the FY
 *     that ends in `year + 1`.
 *
 * `end` is the exclusive upper bound (first instant of the next tax year), so
 * `ts < end` correctly excludes the next period's settle.
 *
 * @returns {{start: number, end: number}}  millisecond UTC timestamps
 */
function _taxYearRange(cc, date) {
  const d     = date instanceof Date ? date : new Date(date);
  const year  = d.getUTCFullYear();
  const month = d.getUTCMonth();

  if (cc === 'AU') {
    const fyStartYear = month >= 6 ? year : year - 1;
    return {
      start: Date.UTC(fyStartYear,     6, 1),
      end:   Date.UTC(fyStartYear + 1, 6, 1),
    };
  }
  return {
    start: Date.UTC(year,     0, 1),
    end:   Date.UTC(year + 1, 0, 1),
  };
}

function _formatPeriodLabel(cc, date) {
  const d = date instanceof Date ? date : new Date(date);
  const year  = d.getUTCFullYear();
  const month = d.getUTCMonth();
  if (cc === 'AU') {
    // FY ends 30 June. A date in Jul–Dec belongs to FY ending year+1; Jan–Jun
    // belongs to FY ending year. Prefix with `AU` so the implied country is
    // explicit when the report mixes both ccs in the period dropdown.
    const fyEnd = month >= 6 ? year + 1 : year;
    return `AU FY ${fyEnd - 1}–${String(fyEnd).slice(-2)}`;
  }
  if (cc === 'US') return `US CY ${year}`;
  return d.toISOString().slice(0, 10);
}
