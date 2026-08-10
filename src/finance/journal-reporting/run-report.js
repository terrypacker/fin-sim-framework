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
 * Headless execution of a ReportDefinition.
 *
 * This is the one place a report is turned into groups. The workbench plugin and
 * the CSV exporter both route through it, so a report exported from the command
 * line is the same computation the UI panel renders — if the two ever disagree,
 * that is a bug rather than two implementations drifting apart.
 */

import { JournalDataSource } from '../journal-data-source.js';
import { JournalQueryApi }   from '../journal-query-api.js';

/**
 * Build the three JournalQueryApi flavours a report may need: per-entry,
 * per-stateDiff (`perDiff` reports) and per-personTaxDetails (`perPerson`).
 * All three wrap the same journal; they differ only in how rows are projected.
 *
 * @param {import('../../simulation-framework/journal.js').Journal} journal
 * @param {object} [services] - ServiceRegistry instance (or a test stand-in)
 * @returns {{entry: JournalQueryApi, diff: JournalQueryApi, person: JournalQueryApi}|null}
 */
export function createReportApis(journal, services) {
  if (!journal) return null;
  const typeRegistry   = services?.typeRegistry   ?? null;
  const periodService  = services?.periodService  ?? null;
  const schemaRegistry = services?.schemaRegistry ?? null;
  const build = opts => new JournalQueryApi(
    new JournalDataSource(journal, opts), typeRegistry, periodService, schemaRegistry,
  );
  return {
    entry:  build({}),
    diff:   build({ perDiff:   true }),
    person: build({ perPerson: true }),
  };
}

/**
 * Pick the api flavour a definition declares. `perDiff` and `perPerson` are
 * mutually exclusive; `perPerson` wins if a definition ever sets both.
 *
 * @param {{entry: JournalQueryApi, diff: JournalQueryApi, person: JournalQueryApi}} apis
 * @param {import('./report-definition-registry.js').ReportDefinition} def
 */
export function apiFor(apis, def) {
  return def.perPerson ? apis.person
       : def.perDiff   ? apis.diff
       :                 apis.entry;
}

/**
 * Run one report and return its decorated groups.
 *
 * Reports that name a period type (`periodTypeFor`) roll up through
 * PeriodService rather than the generic groupBy path — that is what makes a
 * year-keyed report agree with the tax periods rather than raw UTC years.
 *
 * @param {import('./report-definition-registry.js').ReportDefinition} def
 * @param {object} params - resolved facet values (cc, period, personKeys, …)
 * @param {{entry: JournalQueryApi, diff: JournalQueryApi, person: JournalQueryApi}} apis
 * @returns {Promise<{groups: Array<object>, grandTotal: number|null, currency: string|null}>}
 *   `currency` is the code the money aggregates are expressed in (null when the
 *   definition declares none), so callers label totals with the unit that was
 *   actually folded rather than guessing from the facets.
 */
export async function runReport(def, params, apis) {
  const api        = apiFor(apis, def);
  const ast        = def.buildQuery(params, api);
  const periodType = def.periodTypeFor?.(params) ?? null;
  // The currency the report states its money in. Passed into the aggregation so
  // currency-typed fields are converted before they are folded (a report whose
  // rows span both countries would otherwise add AUD onto USD); null for the
  // single-currency reports, which then fold exactly as projected.
  const currency   = def.reportCurrency?.(params) ?? null;

  const result = periodType && api._periodService
    ? await api.aggregateByYear({
        query:      ast,
        periodType,
        aggregates: def.defaultAggregates,
        currency,
      })
    : await api.aggregate({
        query:      ast,
        groupBy:    def.defaultGroupBy,
        aggregates: def.defaultAggregates,
        dedupeBy:   def.dedupeBy,
        currency,
      });

  return {
    groups:     def.decorate(result.groups, api),
    grandTotal: result.grandTotal,
    currency,
  };
}
