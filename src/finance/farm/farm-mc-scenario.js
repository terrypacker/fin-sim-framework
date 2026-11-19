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
import { jobCostReport } from './farm-reports.js';

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
  evaluate:  () => (sim, cfg) => ({ metrics: farmPathMetrics(cfg, sim) }),
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
 *   `<scope>.breakevenPrice.<basis>`   (total cost − non-grain revenue) ÷ expected bushels
 *   `<scope>.breakevenUnpricedPrice.<basis>`  what the unpriced bushels must fetch
 *   `<scope>.breakevenYield.<basis>`   bushels per acre that cover cost
 *   `operator.<id>.scheduleF`          the crop year's cash net after §464(d) (Schedule F)
 *   `<scope>.insurance`                crop insurance indemnity for the crop year (§15.2)
 *   `<scope>.insurancePays`            1 when that indemnity is above 0, else 0: its mean is
 *                                      the probability a claim pays
 *
 * where `<scope>` is `farm`, `operator.<id>`, `crop.<CROP>` or `plan.<id>`, and `<basis>` is
 * `custom` or `actual`. A breakeven is null where the report's is (a mixed-crop group, a crop
 * fully contracted).
 *
 * @param {object} cfg the path's loaded cfg (its params applied to `cfg.farm`)
 * @param {object} sim the path's stepped simulation
 * @returns {Record<string, number|null>}
 */
export function farmPathMetrics(cfg, sim) {
  const base = farmReports(cfg, sim, { machineryBasis: FARM_BASES.custom });
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
  };
  for (const [basis, r] of Object.entries(reports)) {
    put('farm', basis, r.farm);
    for (const row of r.byOperator) put(`operator.${row.operatorId}`, basis, row);
    for (const row of r.byCrop) put(`crop.${row.crop}`, basis, row);
    for (const row of r.plans) if (row.planId) put(`plan.${row.planId}`, basis, row);
  }
  const y = base.jobCost.cropYear;
  // Crop insurance per scope, from the ledger: a plan's indemnity is charged to the plan.
  const planRow = new Map(base.jobCost.plans.filter(r => r.planId).map(r => [r.planId, r]));
  const indemnity = { farm: 0 };
  for (const r of base.jobCost.plans) {
    if (!r.planId) continue;
    for (const scope of [`operator.${r.operatorId}`, `crop.${r.crop}`, `plan.${r.planId}`]) indemnity[scope] ??= 0;
  }
  for (const p of base.ledger) {
    if (p.category !== 'CROP_INSURANCE_PROCEEDS' || p.cropYear !== y) continue;
    const r = planRow.get(p.jobId);
    indemnity.farm += p.amount;
    if (!r) continue;
    indemnity[`operator.${r.operatorId}`] += p.amount;
    indemnity[`crop.${r.crop}`] += p.amount;
    indemnity[`plan.${r.planId}`] += p.amount;
  }
  for (const [scope, v] of Object.entries(indemnity)) {
    out[`${scope}.insurance`] = v;
    out[`${scope}.insurancePays`] = v > 0 ? 1 : 0;
  }
  for (const row of base.cash) {
    if (row.year === y) out[`operator.${row.operatorId}.scheduleF`] = row.net;
  }
  return out;
}
