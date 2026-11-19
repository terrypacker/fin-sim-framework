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
 * farm-import.mjs — one operator's slice of a farm result export, as a household plan's
 * business-income row (design 134 §8.3, step 4c). The CLI is `scripts/scenario/import-farm.mjs`.
 *
 * What it builds:
 *
 * - **one `cfg.businessIncome` row** from the deterministic run's crop year, the only full
 *   Schedule F a one-season run gives. It repeats from `startDate` (design 134 §16.1).
 * - **one `cfg.businessIncomePaths` row per MC path**, when the export has paths: the same
 *   crop-year figures from that path, joined to the row by `businessIncomeId`. A household MC
 *   draws one of them per year (step 4d). Flat rows joined by id, as every record table is.
 *
 * Nothing else in the plan is touched: a re-import replaces the row with the same id, and its
 * paths, and leaves every other row alone.
 */

import { validateFarmExport, fullYearRow } from '../../src/finance/farm/farm-export.js';
import { validateBusinessIncome } from '../../src/finance/payroll/business-income.js';

/**
 * @param {object} doc a farm result export
 * @param {object} opts
 * @param {string} opts.operatorId which operator's slice
 * @param {string} opts.personId the household person who files that Schedule F
 * @param {object} opts.plan the household cfg the row is for (its persons are checked)
 * @param {string} [opts.rowId] default `farm-<operatorId>`
 * @param {string} [opts.startDate] default 1 January of the export's crop year
 * @param {string} [opts.endDate]
 * @param {string} [opts.name]
 * @returns {{ row, paths, years, summary, errors: string[], warnings: string[] }}
 */
export function buildFarmImport(doc, { operatorId, personId, plan, rowId, startDate, endDate, name } = {}) {
  const errors = [];
  const warnings = [];
  try { validateFarmExport(doc); } catch (e) { return { errors: [e.message], warnings, row: null, paths: [], years: [], summary: null }; }

  const operator = doc.operators.find(o => o.id === operatorId);
  if (!operator) {
    errors.push(`operator "${operatorId}" is not in the export (it has: ${doc.operators.map(o => o.id).join(', ')})`);
  }
  const person = (plan?.persons ?? []).find(p => p.id === personId);
  if (!person) {
    errors.push(`person "${personId}" is not in the plan (it has: ${(plan?.persons ?? []).map(p => p.id).join(', ')})`);
  }
  if (errors.length) return { errors, warnings, row: null, paths: [], years: [], summary: null };

  const years = doc.deterministic.operators[operatorId] ?? [];
  const full = fullYearRow(years, doc.cropYear);
  if (!full) {
    errors.push(`operator "${operatorId}" has no full ${doc.cropYear} Schedule F in the export`);
    return { errors, warnings, row: null, paths: [], years, summary: null };
  }

  const id = rowId ?? `farm-${operatorId}`;
  const row = {
    id,
    personId,
    name: name ?? `Farm — ${operator.name}`,
    kind: 'SCHEDULE_F',
    startDate: startDate ?? `${doc.cropYear}-01-01`,
    ...(endDate ? { endDate } : {}),
    net: full.net,
    neCommunityCollegeTax: full.household.neCommunityCollegeTaxPaid ?? 0,
    source: {
      farmResultVersion: doc.farmResultVersion,
      farm: doc.source,
      operatorId,
      cropYear: doc.cropYear,
      paths: doc.mc?.n ?? 0,
    },
  };
  errors.push(...validateBusinessIncome([row], plan.persons));

  const paths = [];
  for (const p of doc.mc?.paths ?? []) {
    const y = fullYearRow(p.operators?.[operatorId], doc.cropYear);
    if (!y) { errors.push(`MC path ${p.seed} has no full ${doc.cropYear} Schedule F for "${operatorId}"`); continue; }
    paths.push({
      businessIncomeId: id,
      seed: p.seed,
      net: y.net,
      neCommunityCollegeTax: y.household.neCommunityCollegeTaxPaid ?? 0,
    });
  }

  if (row.neCommunityCollegeTax > 0 && person.residencyState !== 'NE') {
    warnings.push(`the export has Nebraska community-college tax, but person "${personId}" is not a `
      + `Nebraska resident (residencyState ${person.residencyState ?? 'blank'}), so no Nebraska credit applies`);
  }
  if (plan.simStart && row.startDate < String(plan.simStart).slice(0, 10)) {
    warnings.push(`startDate ${row.startDate} is before the plan starts (${String(plan.simStart).slice(0, 10)}); `
      + 'the row pays from the first year inside the plan, in that year\'s money');
  }
  if (doc.mc?.provenance?.uncalibrated?.length) {
    warnings.push(`${doc.mc.provenance.uncalibrated.length} sampled farm variable(s) use a generic spread, `
      + 'not a calibrated one (design 134 §6): the paths are a sensitivity run');
  }

  const nets = paths.map(p => p.net).sort((a, b) => a - b);
  const q = (f) => (nets.length ? nets[Math.min(nets.length - 1, Math.floor(f * nets.length))] : null);
  const summary = {
    net: full.net,
    neCommunityCollegeTax: row.neCommunityCollegeTax,
    paths: nets.length,
    ...(nets.length ? {
      p10: q(0.10), p50: q(0.50), p90: q(0.90),
      lossProbability: nets.filter(x => x < 0).length / nets.length,
    } : {}),
  };
  return { row, paths, years, summary, errors, warnings };
}

/**
 * Splice an import into a plan cfg: replace the row with the same id and its paths, keep the
 * rest. Returns a new cfg; the input is not mutated.
 *
 * @param {object} plan household cfg
 * @param {{ row: object, paths: object[] }} imp `buildFarmImport(...)`
 */
export function applyFarmImport(plan, imp) {
  const out = structuredClone(plan);
  out.businessIncome = [...(out.businessIncome ?? []).filter(r => r.id !== imp.row.id), imp.row];
  const paths = [...(out.businessIncomePaths ?? []).filter(p => p.businessIncomeId !== imp.row.id), ...imp.paths];
  if (paths.length) out.businessIncomePaths = paths;
  else delete out.businessIncomePaths;
  return out;
}
