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
 * CSV projection of report groups, shared by the workbench download button and
 * the headless exporter so both emit the same shape.
 *
 * Two granularities:
 *   'entries' — one row per child journal entry, group key columns prepended
 *               (the panel's download; a group with no children degrades to a
 *               summary row so it is never silently dropped).
 *   'groups'  — one row per group carrying the declared aggregates. This is the
 *               validation shape: stack many periods into one file and pivot.
 */

const _esc = v => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Project groups into flat row objects.
 *
 * @param {Array<object>} groups
 * @param {import('./report-definition-registry.js').ReportDefinition} [def]
 * @param {object}  [opts]
 * @param {'entries'|'groups'} [opts.detail='entries']
 * @param {object}  [opts.lead]  - columns prepended to every row (e.g. taxYear)
 * @returns {Array<object>}
 */
export function buildReportRows(groups, def, { detail = 'entries', lead = null } = {}) {
  if (!groups?.length) return [];
  const groupByFields = def?.defaultGroupBy ?? ['actionType'];
  return detail === 'groups'
    ? _groupRows(groups, def, groupByFields, lead)
    : _entryRows(groups, groupByFields, lead);
}

/**
 * One row per group: the key columns, any display label the definition's
 * decorate() attached, then every aggregate the definition declares.
 */
function _groupRows(groups, def, groupByFields, lead) {
  // Only emit a `<field>Name` column when some group actually carries a label —
  // account reports do (design 70), most reports don't.
  const labelled = groupByFields.filter(f => groups.some(g => g.labels?.[f] != null));

  // Declared order first, then anything the aggregation added (aggregateByYear
  // always produces total/count regardless of what the definition declared).
  const declared = Object.keys(def?.defaultAggregates ?? {});
  const extras   = [...new Set(groups.flatMap(g => Object.keys(g)))]
    .filter(k => !declared.includes(k) && ['count', 'total'].includes(k));
  const aggFields = [...declared, ...extras];

  return groups.map(g => {
    const row = { ...(lead ?? {}) };
    for (const f of groupByFields) {
      row[f] = g.key?.[f] ?? null;
      if (labelled.includes(f)) row[`${f}Name`] = g.labels?.[f] ?? null;
    }
    for (const a of aggFields) row[a] = g[a] ?? null;
    return row;
  });
}

/** One row per child journal entry, in chronological order within each group. */
function _entryRows(groups, groupByFields, lead) {
  const rows = [];
  for (const g of groups) {
    const keyObj = g.key ?? {};

    if (g.items?.length) {
      for (const item of _chronological(g.items)) {
        const row = { ...(lead ?? {}) };
        for (const f of groupByFields) row[f] = keyObj[f] ?? null;
        row.date        = item.date ? new Date(item.date).toISOString().slice(0, 10) : null;
        row.seq         = item.seq         ?? null;
        row.executionId = item.executionId ?? null;
        row.actionType  = item.actionType  ?? null;
        row.description = item.description ?? null;
        row.amount      = item.amount      ?? null;
        row.proceeds    = item.proceeds    ?? null;
        row.gain        = item.gain        ?? null;
        row.stateKey    = item.stateKey    ?? null;
        row.stateDelta  = item.stateDelta  ?? null;
        rows.push(row);
      }
    } else {
      // Group with no children — emit a summary row.
      const row = { ...(lead ?? {}) };
      for (const f of groupByFields) row[f] = keyObj[f] ?? null;
      row.count = g.count ?? null;
      row.total = g.total ?? null;
      rows.push(row);
    }
  }
  return rows;
}

function _chronological(items) {
  return [...items].sort((a, b) => {
    const ta = a.ts ?? (a.date ? new Date(a.date).getTime() : 0);
    const tb = b.ts ?? (b.date ? new Date(b.date).getTime() : 0);
    return ta - tb;
  });
}

/**
 * Serialize row objects to an RFC 4180 CSV string. Columns are the union of the
 * rows' keys in first-seen order, so a report whose later periods carry a field
 * the first one lacked still gets a column for it.
 *
 * @param {Array<object>} rows
 * @returns {string} CSV text without a trailing newline; '' when there are no rows
 */
export function rowsToCsv(rows) {
  if (!rows?.length) return '';
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  return [
    cols.join(','),
    ...rows.map(row => cols.map(c => _esc(row[c])).join(',')),
  ].join('\n');
}

/**
 * Convenience: groups → CSV text in one call.
 *
 * @param {Array<object>} groups
 * @param {import('./report-definition-registry.js').ReportDefinition} [def]
 * @param {object} [opts] - see buildReportRows
 * @returns {string}
 */
export function generateReportCsv(groups, def, opts) {
  return rowsToCsv(buildReportRows(groups, def, opts));
}
