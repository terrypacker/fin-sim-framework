/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { SCHEDULE_F_LINES } from './schedule-f.js';

/**
 * The farm result export (design 134 §8.2, step 4a): what a household plan imports.
 *
 * One file per farm run. For each operator and calendar year it carries that year's Schedule F
 * (the lines, the gross, the expenses, the §464(d) deferral and the net) and the inputs the
 * household's return needs from it (§7.2–§7.3). Under Monte Carlo it carries every path, each
 * with its seed and params, so a household draws one coherent farm history at a time rather
 * than a percentile of each line (§8.2).
 *
 * Only the season's crop year is a full Schedule F (§5.5). The years either side are carried,
 * marked `partial`, for reading; the household record repeats the full year (§16.1).
 *
 * ```js
 * {
 *   farmResultVersion: 1,
 *   source, cropYear,
 *   operators: [{ id, name }],
 *   deterministic: { operators: { <id>: [<year row>] } },
 *   mc: null | { n, pairing, provenance, paths: [{ seed, params, operators: { <id>: [<year row>] } }] },
 *   // a path's `params` are its SAMPLED params only; with the farm scenario they replay it
 * }
 * ```
 *
 * A year row:
 *
 * ```js
 * { year, partial,
 *   income:  { <line>: $ },   // Schedule F lines 1–8, memo lines (4a, 6a) included, `memo` marks them
 *   expense: { <line>: $ },   // lines 10–32 and the mixed machinery line (Q17)
 *   grossIncome, totalExpenses, section464Deferred, net,
 *   household: { scheduleSeLine1a, qbiBeforeAdjustments, neCommunityCollegeTaxPaid } }
 * ```
 *
 * The household inputs, and why each is what it is:
 *
 * - `scheduleSeLine1a` is the Schedule F net: Schedule SE line 1a is "net farm profit or (loss)
 *   from Schedule F, line 34" (docs/us-tax/IRS-Schedule-SE-Instructions-2026.txt). The 92.35%
 *   factor and the wage-base coordination are the household's, since they depend on its wages.
 * - `qbiBeforeAdjustments` is also the Schedule F net. QBI is reduced by "the deductible part of
 *   self-employment tax, self-employment health insurance deduction, and contributions to
 *   qualified retirement plans" (Form 8995 instructions 2025, on disk), all of which are figured
 *   on the household's return, so the household makes those adjustments (step 4e).
 * - `neCommunityCollegeTaxPaid` is the community-college tax in the year's property tax
 *   payments, which 77-6706(4) credits at 100% for taxes "paid by the eligible taxpayer during
 *   the taxable year" (docs/ne-law/). It follows the property tax postings' dates.
 */
export const FARM_RESULT_VERSION = 1;

/**
 * The community-college tax paid per operator and calendar year: each owned field's
 * `communityCollegeTax` (its share of the bill, design 134 Q29) spread over that field's
 * property tax payments in proportion to their amounts, so the credit lands on the dates the
 * bill is paid.
 *
 * @param {object} farm normalized farm
 * @param {object[]} ledger `farmLedger(...)`
 * @returns {Map<string, number>} `${operatorId}|${year}` → $
 */
export function communityCollegeTaxPaid(farm, ledger) {
  const byField = new Map(farm.fields.filter(f => f.communityCollegeTax > 0).map(f => [f.id, f]));
  const paid = new Map();
  if (byField.size === 0) return paid;
  const totals = new Map();
  const posts = ledger.filter(p => p.cash && p.category === 'PROPERTY_TAX' && byField.has(p.sourceId));
  for (const p of posts) totals.set(p.sourceId, (totals.get(p.sourceId) ?? 0) + p.amount);
  for (const p of posts) {
    const total = totals.get(p.sourceId);
    if (!(total > 0)) continue;
    const k = `${p.operatorId}|${Number(p.date.slice(0, 4))}`;
    paid.set(k, (paid.get(k) ?? 0) + byField.get(p.sourceId).communityCollegeTax * (p.amount / total));
  }
  return paid;
}

/**
 * One operator-year of the export from a `cashReport` row.
 *
 * @param {object} row a `cashReport` row
 * @param {number} ccTaxPaid community-college tax paid that year (`communityCollegeTaxPaid`)
 */
export function exportYear(row, ccTaxPaid = 0) {
  // JSON objects list integer-like keys first, so `SCHEDULE_F_LINE_ORDER` is the order to
  // print them in, not the order they are stored in.
  return {
    year: row.year,
    partial: row.partial,
    income: { ...row.income },
    memoLines: Object.keys(row.income).filter(l => SCHEDULE_F_LINES[l]?.memo),
    expense: { ...row.expense },
    grossIncome: row.grossIncome,
    totalExpenses: row.totalExpenses,
    section464Deferred: row.section464?.deferred ?? 0,
    net: row.net,
    household: {
      scheduleSeLine1a: row.net,
      qbiBeforeAdjustments: row.net,
      neCommunityCollegeTaxPaid: ccTaxPaid,
    },
  };
}

/**
 * Every operator's year rows for one farm run.
 *
 * @param {object} farm normalized farm
 * @param {object[]} ledger `farmLedger(...)`
 * @param {object[]} cash `cashReport(...)`
 * @returns {Record<string, object[]>} operator id → year rows, by year; an operator with no
 *   cash flows has an empty list
 */
export function exportOperators(farm, ledger, cash) {
  const cc = communityCollegeTaxPaid(farm, ledger);
  const out = Object.fromEntries(farm.operators.map(o => [o.id, []]));
  const seen = new Set();
  for (const row of cash) {
    const k = `${row.operatorId}|${row.year}`;
    seen.add(k);
    (out[row.operatorId] ??= []).push(exportYear(row, cc.get(k) ?? 0));
  }
  // A credit in a year with no Schedule F flows still reaches the household.
  for (const [k, v] of cc) {
    if (seen.has(k)) continue;
    const [op, year] = k.split('|');
    (out[op] ??= []).push(exportYear({
      operatorId: op, year: Number(year), partial: Number(year) !== farm.season.cropYear,
      income: {}, expense: {}, grossIncome: 0, totalExpenses: 0, net: 0,
    }, v));
  }
  for (const rows of Object.values(out)) rows.sort((a, b) => a.year - b.year);
  return out;
}

/**
 * The export document.
 *
 * @param {object} args
 * @param {string} args.source what was run (a file and index, or the demo farm)
 * @param {object} args.det `runFarm(...)` result: `{ farm, ledger, cash }`
 * @param {object} [args.mc] `FarmMcRunner.run(...)` result; its runs carry `scheduleF`
 */
export function buildFarmExport({ source, det, mc = null }) {
  const { farm } = det;
  const doc = {
    farmResultVersion: FARM_RESULT_VERSION,
    source,
    cropYear: farm.season.cropYear,
    operators: farm.operators.map(o => ({ id: o.id, name: o.name ?? o.id })),
    deterministic: { operators: exportOperators(farm, det.ledger, det.cash) },
    mc: null,
  };
  if (mc) {
    const missing = mc.runs.filter(r => !r.scheduleF).length;
    if (missing) throw new Error(`${missing} MC path(s) carry no Schedule F: run the batch with FarmMcRunner`);
    // A path's params hold every lever, most at its centre. Only the sampled ones are kept:
    // with the farm scenario they replay the path, and they keep a 1,000-path file small.
    const sampled = new Set((mc.summary.pairing?.sampled ?? []).map(v => v.key));
    const keep = (params) => Object.fromEntries(Object.entries(params ?? {}).filter(([k]) => sampled.has(k)));
    doc.mc = {
      n: mc.runs.length,
      pairing: mc.summary.pairing,
      provenance: mc.summary.provenance,
      erroredRuns: mc.summary.erroredRuns,
      paths: mc.runs.map(r => ({ seed: r.seed, params: keep(r.params), operators: r.scheduleF })),
    };
  }
  return doc;
}

/**
 * Check an export before it is imported: the version, and that every path has the same
 * operators and years as the deterministic run.
 *
 * @param {object} doc
 * @returns {object} the same document
 */
export function validateFarmExport(doc) {
  if (doc?.farmResultVersion !== FARM_RESULT_VERSION) {
    throw new Error(`not a farm result export version ${FARM_RESULT_VERSION} (farmResultVersion: ${doc?.farmResultVersion})`);
  }
  const ids = new Set((doc.operators ?? []).map(o => o.id));
  for (const id of Object.keys(doc.deterministic?.operators ?? {})) {
    if (!ids.has(id)) throw new Error(`farm export: deterministic run names unknown operator "${id}"`);
  }
  for (const p of doc.mc?.paths ?? []) {
    for (const id of Object.keys(p.operators ?? {})) {
      if (!ids.has(id)) throw new Error(`farm export: path ${p.seed} names unknown operator "${id}"`);
    }
  }
  return doc;
}

/**
 * The year row an operator's household record repeats (design 134 §16.1): the crop year, the
 * only full Schedule F a one-season run gives.
 *
 * @param {object[]} rows an operator's year rows
 * @param {number} cropYear
 * @returns {object|null}
 */
export function fullYearRow(rows, cropYear) {
  return (rows ?? []).find(r => r.year === cropYear && !r.partial) ?? null;
}
