/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { DISTRIBUTION_TYPES }  from '../../simulation-framework/distributions.js';
import { FarmScenario }        from '../../scenarios/farm-scenario.js';
import { ScenarioSerializer }  from '../../scenarios/scenario-serializer.js';
import { resolveRecordCenters } from '../../scenarios/scenario-param-apply.js';
import { scenarioParamValues } from '../param-schema-utils.js';
import { McConfig, variablesMissingCenter } from '../monte-carlo/mc-config.js';
import { McRunner, summarizeProvenance, median, percentile } from '../monte-carlo/mc-runner.js';
import { samplingSignature }   from '../monte-carlo/parallel/mc-worker-core.js';

/**
 * Monte Carlo for a farm season (design 134 phase 2): the farm's variable catalog and batch.
 *
 * The catalog is the farm records' generated levers, `farm.<kind>.<id>.<field>`, harvested from
 * the `mc` flags on `FARM_PARAM_TEMPLATES` (design 98 W3), each centred on its record's value.
 * Every harvested row starts DISABLED, with the harvest's generic spread (±10% on an amount,
 * ±20% on a rate). Those spreads are placeholders, not calibrations: design 134 §6 has the
 * distributions set from public sources fetched into `docs/` first, and that is a later step.
 * A batch that switches a row on is therefore a sensitivity run, and says so in its provenance.
 */
export class FarmMcConfig extends McConfig {
  static contributors = [({ cfg }) => buildYieldMcConfigs(cfg)];
  static aliases = {};
  static paramSchema() { return FarmScenario.getParamSchema(); }
}

/**
 * The farm's own spreads (design 134 §6, §13.1 step 2e): the standard deviation of each drawn
 * factor. **All 0 until calibrated**: no spread is set before its source is on disk, so a row
 * switched on at 0 draws nothing and the path is the plan. Step 2e replaces these from USDA
 * NASS yields and the price sources, and records where each came from.
 */
export const FARM_MC_SPREADS = Object.freeze({
  /** The farm-wide yield shock, as a fraction of expected yield. */
  farmYieldShockSd: 0,
  /** A field's own yield shock, dry and irrigated. */
  fieldYieldShockSd: Object.freeze({ dry: 0, irrigated: 0 }),
});

/**
 * One row for the season's farm-wide yield shock and one per crop plan for its own (design 134
 * §13.3), keyed on the generated levers so a draw lands on the record. Off, and at
 * `FARM_MC_SPREADS`, so the harvest's generic ±20% never reaches them.
 *
 * @param {object|null} cfg the farm scenario
 */
export function buildYieldMcConfigs(cfg, spreads = FARM_MC_SPREADS) {
  const farm = cfg?.farm;
  if (!farm?.seasons?.length) return [];
  const irrigated = new Map((farm.fields ?? []).map(f => [f.id, f.irrigated === true]));
  const row = (paramKey, label, stdDev) => ({
    paramKey, label, type: DISTRIBUTION_TYPES.NORMAL, mean: 0, stdDev, group: 'Farm · yield', enabled: false,
    // The centre IS what the model reads for a blank shock (`blankValue` 0), not a made-up mean.
    effectiveDefault: true,
  });
  return [
    ...farm.seasons.map(s => row(`farm.season.${s.id}.yieldShock`, 'Farm-wide yield shock', spreads.farmYieldShockSd)),
    ...(farm.cropPlans ?? []).map(p => row(`farm.plan.${p.id}.yieldShock`, `${p.id} — yield shock`,
      irrigated.get(p.fieldId) ? spreads.fieldYieldShockSd.irrigated : spreads.fieldYieldShockSd.dry)),
  ];
}

/**
 * The farm batch. Reuses the scenario-agnostic `McRunner`: paths are index-seeded and built by
 * the worker core from the `us-farm` descriptor (`farm-mc-scenario.js`), so a sharded run is
 * bit-identical to a serial one, as for a retirement batch.
 */
export class FarmMcRunner extends McRunner {
  static scenarioKind = 'us-farm';

  /**
   * @param {object} opts everything `McRunner` takes. `cfgTemplate` defaults to the demo farm,
   *   and `simStart` / `simEnd` to the template's own window (the season's three years, §5.2).
   */
  constructor({ mcConfig = new FarmMcConfig(), ...opts } = {}) {
    super({ ...opts, mcConfig });
  }

  _prepare(baseParams = {}) {
    const raw      = this.cfgTemplate ?? FarmScenario.buildDefaultConfig();
    const simStart = this.simStart ?? new Date(raw.simStart);
    const simEnd   = this.simEnd ?? new Date(raw.simEnd);
    // Plain JSON, so it crosses postMessage to a worker (see IntlRetirementMcRunner._prepare).
    const cfgTemplate = ScenarioSerializer.serializeScenario(raw);
    const ownParams   = scenarioParamValues(raw);
    // Every farm lever is a record field, so the record centres are the base. The scenario's
    // own params win over them, and the caller's over both. `endDate` is where every path
    // stops (`ScenarioRunner.runScenario`), as on a retirement batch.
    const base = { ...resolveRecordCenters(raw), ...ownParams, ...baseParams, endDate: simEnd };
    const variables  = this.mcConfig.buildVariables(base, { cfg: raw });
    const centerless = variablesMissingCenter(variables);
    if (centerless.length) {
      throw new Error('Monte Carlo cannot sample an enabled variable with no center: '
        + centerless.map(v => v.label ?? v.paramKey).join(', '));
    }
    const provenance = summarizeProvenance(variables, { ownParams, schemaDefaults: {}, who: 'FarmMcRunner' });
    // Design 134 §6: the harvested spreads are uncalibrated. Say which sampled rows use one.
    provenance.uncalibrated = variables.filter(v => v.enabled && v.harvested).map(v => v.paramKey);
    return {
      ctx: { cfgTemplate, base, variables, simStart, simEnd, scenarioKind: FarmMcRunner.scenarioKind },
      provenance,
    };
  }

  /**
   * Run the batch.
   *
   * @param {object}   [baseParams={}]  param overrides (`farm.<kind>.<id>.<field>` keys)
   * @param {Function} [onProgress]     `(completed, total)`
   * @returns {Promise<{ runs: Array<{ seed, params, metrics }>, summary: object }>}
   */
  async run(baseParams = {}, onProgress) {
    const { ctx, provenance, mcRuns, erroredRuns } = await this._runAll(baseParams, onProgress);
    const runs = mcRuns.map(r => ({ seed: r.seed, params: r.params, metrics: r.result.metrics }));
    return {
      runs,
      summary: {
        n: runs.length,
        metrics: summarizeFarmMetrics(runs),
        provenance,
        erroredRuns: erroredRuns.map(r => ({ seed: r.seed, params: r.params, message: r.error.message })),
        // Design 100 §5–6: the facts that define the random stream, so a later batch can be
        // checked for pairing against this one instead of assumed paired.
        pairing: { n: runs.length, seeds: runs.map(r => r.seed), sampled: samplingSignature(ctx.variables) },
      },
    };
  }
}

/** A metric is an income (its loss probability is reported) when it is a net. */
export const isFarmIncomeMetric = (key) => /\.net\.(custom|actual)$|\.scheduleF$/.test(key);

/**
 * Distribution of every metric across the paths: mean, p10, p50, p90, min and max, and for an
 * income the probability of a loss (design 134 §5.4: "the distribution of net income and the
 * probability of a loss"). A metric null on a path (a breakeven with no divisor) is left out of
 * that metric's statistics, and `n` says how many paths it had.
 *
 * @param {Array<{ metrics: Record<string, number|null> }>} runs
 * @returns {Record<string, { n, mean, p10, p50, p90, min, max, lossProbability? }>}
 */
export function summarizeFarmMetrics(runs) {
  const keys = new Set();
  for (const r of runs) for (const k of Object.keys(r.metrics ?? {})) keys.add(k);
  const out = {};
  for (const k of [...keys].sort()) {
    const xs = runs.map(r => r.metrics?.[k]).filter(x => x != null && Number.isFinite(x));
    const s = {
      n:    xs.length,
      mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
      p10:  percentile(xs, 0.10),
      p50:  median(xs),
      p90:  percentile(xs, 0.90),
      min:  xs.length ? Math.min(...xs) : null,
      max:  xs.length ? Math.max(...xs) : null,
    };
    if (isFarmIncomeMetric(k)) s.lossProbability = xs.length ? xs.filter(x => x < 0).length / xs.length : null;
    out[k] = s;
  }
  return out;
}
