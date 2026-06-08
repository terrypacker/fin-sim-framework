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
 * JournalDataSource — projects JournalEntry instances into flat JournalRow objects
 * suitable for QueryApi predicate evaluation.
 *
 * One row per journal entry.  The original entry is carried as `entry` so the UI
 * can drill further (open action detail, jump to config node, etc.) without a
 * second lookup.
 *
 * changedFields is stored as a comma-joined string so QueryApi's `contains`
 * predicate can match sub-strings like `usOrdinaryIncomeYTD` with a simple call:
 *   { op: 'contains', field: 'changedFields', value: 'usOrdinaryIncomeYTD' }
 */
export class JournalDataSource {
  /**
   * @param {import('../simulation-framework/journal.js').Journal} journal
   * @param {{ perDiff?: boolean, perPerson?: boolean }} [opts]
   *   perDiff: when true, getAll() emits one row per stateDiff entry instead of
   *   one row per journal entry.  Each per-diff row adds stateKey / stateBefore /
   *   stateAfter / stateDelta fields and is useful for state-centric reports like
   *   cash-flow-by-account.  Defaults to false.
   *   perPerson: when true, getAll() emits one row per `personTaxDetails` entry
   *   on the journal entry's action data (currently only set by
   *   `TAX_SETTLE_APPLY` for AU per-person filings).  Each row adds
   *   personKey / personName / personTaxAmount / taxableIncome / grossTax.
   *   Entries that lack `personTaxDetails` are dropped.  Mutually exclusive
   *   with perDiff.  Defaults to false.
   */
  constructor(journal, opts = {}) {
    this._journal   = journal;
    this._perDiff   = opts.perDiff   === true;
    this._perPerson = opts.perPerson === true;
  }

  /** @returns {JournalRow[]} — freshly projected on each call */
  getAll() {
    if (this._perPerson) return this._projectPerPerson();
    if (this._perDiff)   return this._projectPerDiff();
    return this._journal.journal.map(_project);
  }

  _projectPerPerson() {
    const rows = [];
    for (const entry of this._journal.journal) {
      const personTaxDetails = entry.action?.data?.personTaxDetails;
      if (!Array.isArray(personTaxDetails) || personTaxDetails.length === 0) continue;
      const base = _project(entry);
      for (let i = 0; i < personTaxDetails.length; i++) {
        const p  = personTaxDetails[i];
        const td = p.taxDetail ?? {};
        rows.push({
          ...base,
          personKey:       p.personKey       ?? null,
          personName:      p.personName      ?? p.personKey ?? null,
          personTaxAmount: td.netLiability   ?? 0,
          taxableIncome:   td.taxableIncome  ?? null,
          grossTax:        td.grossTax       ?? null,
          diffSeq:         i,
        });
      }
    }
    return rows;
  }

  _projectPerDiff() {
    const rows = [];
    for (const entry of this._journal.journal) {
      const base = _project(entry);
      if (!entry.stateDiff?.length) {
        // Emit the entry as-is with null diff fields so it isn't silently dropped.
        rows.push({ ...base, stateKey: null, stateBefore: null, stateAfter: null, stateDelta: null, diffSeq: 0 });
      } else {
        for (let i = 0; i < entry.stateDiff.length; i++) {
          const d = entry.stateDiff[i];
          rows.push({
            ...base,
            // Override changedFields to be just this field (single-field context for per-diff rows).
            changedFields: d.field,
            stateKey:      d.field,
            stateBefore:   d.before  ?? null,
            stateAfter:    d.after   ?? null,
            stateDelta:    d.delta   ?? null,
            diffSeq:       i,
          });
        }
      }
    }
    return rows;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _ccFromActionType(type) {
  if (!type) return null;
  if (type.startsWith('US_')) return 'US';
  if (type.startsWith('AU_')) return 'AU';
  return null;
}

// ─── Projection ───────────────────────────────────────────────────────────────

function _project(entry) {
  const d        = entry.action?.data ?? {};
  const dateObj  = entry.date instanceof Date ? entry.date : new Date(entry.date);
  return {
    // ── Identity / ordering ──────────────────────────────────────────────────
    seq:          entry.seq,
    id:           entry.id,

    // ── Time ────────────────────────────────────────────────────────────────
    date:         entry.date,
    ts:           dateObj.getTime(),
    // UTC calendar year — enables groupBy:['year'] for year-bucketed reports
    // like tax-paid-by-year and roth-conversions-by-year.
    year:         dateObj.getUTCFullYear(),

    // ── Classification ───────────────────────────────────────────────────────
    eventType:    entry.event?.type    ?? null,
    actionType:   entry.action?.type   ?? null,
    reducerName:  entry.reducer?.name  ?? null,
    executionId:  entry.executionId    ?? null,

    // ── Common action.data fields ─────────────────────────────────────────────
    cc:           d.cc            ?? _ccFromActionType(entry.action?.type) ?? null,
    amount:       d.amount        ?? null,
    proceeds:     d.proceeds      ?? null,
    costBasis:    d.costBasis     ?? null,
    gain:         d.gain          ?? null,
    isLongTerm:   d.isLongTerm    ?? null,
    isAuResident: d.isAuResident  ?? null,
    description:  d.description   ?? null,
    personKey:    d.personKey     ?? null,

    // ── Derived from stateDiff ────────────────────────────────────────────────
    // Stored as a comma-joined string for QueryApi `contains` predicate matching.
    changedFields: entry.stateDiff?.length
      ? entry.stateDiff.map(d => d.field).join(',')
      : '',

    // ── Back-references ───────────────────────────────────────────────────────
    nodeId:  entry.action?.nodeId ?? null,
    entry,
  };
}
