/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { FarmScenario }  from '../../scenarios/farm-scenario.js';
import { farmReports }   from './farm-run.js';
import { jobCostReport, farmCashSeries } from './farm-reports.js';
import { exportOperators } from './farm-export.js';

/**
 * The farm's worker-side Monte Carlo descriptor (design 134 §4, phase 2): how one path is
 * built and what it reports. The batch half is `FarmMcRunner`.
 *
 * A path is built at telemetry `journal`, because the ledger IS the journal (§12.2): the
 * reports read it, and at `off` they would be empty. A farm season is a few hundred events, so
 * the journal costs nothing next to a retirement path.
 *
 * A farm has no return paths, so `paths` is the identity: Monte Carlo writes nothing into a
 * path's params beyond the sampled variables.
 */
export const FARM_MC_SCENARIO = {
  createScenario: (opts) => new FarmScenario(opts),
  paths:     (p) => p,
  telemetry: () => 'journal',
  sampler:   () => null,
  // `scheduleF` is the path's export rows (design 134 §8.2): each operator's calendar-year
  // Schedule F, which the farm export carries per path for the household to draw.
  // `cashSeries` is the path's cumulative cash net by month (`farmCashSeries`), which the
  // Farm MC panel draws as a fan.
  evaluate:  () => (sim, cfg) => {
    const r = farmReports(cfg, sim);
    return {
      metrics:    farmPathMetrics(cfg, sim, r),
      scheduleF:  exportOperators(r.farm, r.ledger, r.cash),
      cashSeries: farmCashSeries(r.farm, r.ledger),
    };
  },
};

/** The two machinery bases (design 134 §5.3); every net is reported under both. */
export const FARM_BASES = Object.freeze({ custom: 'CUSTOM', actual: 'ACTUAL' });

/**
 * One path's farm results as a FLAT map, metric key → number or null, so the batch can
 * aggregate every metric the same way and a path costs a few hundred numbers.
 *
 * Keys (ids carry no dot, `validateFarm`):
 *
 *   `<scope>.net.<basis>`              net income, crop-year job-cost view
 *   `<scope>.netPerAcre.<basis>`       per planted acre
 *   `<scope>.revenue`                  grain + other revenue (basis-free)
 *   `<scope>.grainRevenue`             grain only: without insurance and program payments
 *   `<scope>.breakevenPrice.<basis>`   (total cost − non-grain revenue) ÷ expected bushels
 *   `<scope>.breakevenUnpricedPrice.<basis>`  what the unpriced bushels must fetch
 *   `<scope>.breakevenYield.<basis>`   bushels per acre that cover cost
 *   `operator.<id>.scheduleF`          the crop year's cash net after §464(d) (Schedule F)
 *   `<scope>.insurance`                crop insurance indemnity for the crop year (§15.2)
 *   `<scope>.insurancePays`            1 when that indemnity is above 0, else 0: its mean is
 *                                      the probability a claim pays
 *   `<scope>.arc`, `<scope>.arcPays`   the same for this crop's ARC-County payment
 *
 * where `<scope>` is `farm`, `operator.<id>`, `crop.<CROP>` or `plan.<id>`, and `<basis>` is
 * `custom` or `actual`. A breakeven is null where the report's is (a mixed-crop group, a crop
 * fully contracted).
 *
 * @param {object} cfg the path's loaded cfg (its params applied to `cfg.farm`)
 * @param {object} sim the path's stepped simulation
 * @param {object} [base] `farmReports(cfg, sim)` at the custom basis, when the caller has it
 * @returns {Record<string, number|null>}
 */
export function farmPathMetrics(cfg, sim, base = farmReports(cfg, sim, { machineryBasis: FARM_BASES.custom })) {
  const reports = {
    custom: base.jobCost,
    actual: jobCostReport(base.farm, base.ledger, {
      machineryBasis: FARM_BASES.actual,
      pools:       sim.state.farm?.pools ?? {},
      receivables: sim.state.farm?.receivables ?? {},
    }),
  };
  const out = {};
  const put = (scope, basis, row) => {
    out[`${scope}.net.${basis}`]                    = row.net;
    out[`${scope}.netPerAcre.${basis}`]             = row.perAcre?.net ?? null;
    out[`${scope}.breakevenPrice.${basis}`]         = row.breakevenPrice ?? null;
    out[`${scope}.breakevenUnpricedPrice.${basis}`] = row.breakevenUnpricedPrice ?? null;
    out[`${scope}.breakevenYield.${basis}`]         = row.breakevenYield ?? null;
    out[`${scope}.revenue`]                         = row.revenue.total;
    out[`${scope}.grainRevenue`]                    = row.revenue.grain;
  };
  for (const [basis, r] of Object.entries(reports)) {
    put('farm', basis, r.farm);
    for (const row of r.byOperator) put(`operator.${row.operatorId}`, basis, row);
    for (const row of r.byCrop) put(`crop.${row.crop}`, basis, row);
    for (const row of r.plans) if (row.planId) put(`plan.${row.planId}`, basis, row);
  }
  const y = base.jobCost.cropYear;
  // Program revenue per scope, from the ledger: crop insurance and ARC-County (design 134
  // §15). A posting charged to a plan counts on its plan, operator and crop; one on an
  // operator's job counts on the farm and the operator.
  const planRow = new Map(base.jobCost.plans.filter(r => r.planId).map(r => [r.planId, r]));
  const PROGRAMS = { insurance: 'CROP_INSURANCE_PROCEEDS', arc: 'PROGRAM_PAYMENT' };
  const sourceIds = { insurance: null, arc: new Set((base.farm.arcBase ?? []).map(b => b.id)) };
  for (const [name, category] of Object.entries(PROGRAMS)) {
    const sum = { farm: 0 };
    for (const r of base.jobCost.plans) {
      if (!r.planId) continue;
      for (const scope of [`operator.${r.operatorId}`, `crop.${r.crop}`, `plan.${r.planId}`]) sum[scope] ??= 0;
    }
    for (const p of base.ledger) {
      if (p.category !== category || p.cropYear !== y) continue;
      if (sourceIds[name] && !sourceIds[name].has(p.sourceId)) continue;   // not last year's carry-in rows
      sum.farm += p.amount;
      const r = planRow.get(p.jobId);
      if (r) {
        sum[`operator.${r.operatorId}`] += p.amount;
        sum[`crop.${r.crop}`] += p.amount;
        sum[`plan.${r.planId}`] += p.amount;
      } else {
        sum[`operator.${p.operatorId}`] = (sum[`operator.${p.operatorId}`] ?? 0) + p.amount;
      }
    }
    for (const [scope, v] of Object.entries(sum)) {
      out[`${scope}.${name}`] = v;
      out[`${scope}.${name}Pays`] = v > 0 ? 1 : 0;
    }
  }
  for (const row of base.cash) {
    if (row.year === y) out[`operator.${row.operatorId}.scheduleF`] = row.net;
  }
  return out;
}
