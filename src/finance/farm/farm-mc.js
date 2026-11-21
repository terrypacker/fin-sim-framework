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
import { resolveRecordCenters, applyParamBagToConfig } from '../../scenarios/scenario-param-apply.js';
import { scenarioParamValues } from '../param-schema-utils.js';
import { ScenarioParamGenerator } from '../../scenarios/params/scenario-param-generator.js';
import { McConfig, variablesMissingCenter } from '../monte-carlo/mc-config.js';
import { McRunner, summarizeProvenance, median, percentile } from '../monte-carlo/mc-runner.js';
import { samplingSignature }   from '../monte-carlo/parallel/mc-worker-core.js';
import { FARM_CALIBRATION }    from './farm-calibration.js';
import { yieldYearPool }       from './farm-yield-history.js';

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
  static contributors = [
    ({ cfg }) => buildYieldMcConfigs(cfg),
    ({ cfg }) => buildPriceMcConfigs(cfg),
    ({ cfg }) => buildMultiplierMcConfigs(cfg),
  ];
  static aliases = {};
  static paramSchema() { return FarmScenario.getParamSchema(); }
}

/**
 * The farm's own spreads (design 134 §6, §13.8): the standard deviation of each drawn factor.
 * The two farm-wide yield shocks are calibrated from USDA NASS county history
 * (`FARM_CALIBRATION`, `npm run farm:calibrate`). The rest are 0, because no source on disk
 * sets them: a field's own yield shock needs the farm's yield history (owner question Q26),
 * and the cost multipliers and contracted share are levers to sweep, not uncertainties with a
 * published spread. A row switched on at 0 draws nothing.
 */
export const FARM_MC_SPREADS = Object.freeze({
  /** The farm-wide dryland yield shock, as a fraction of expected yield. */
  farmYieldShockSd: FARM_CALIBRATION.yieldShockSd,
  /** …and its skewness (a drought's long tail). */
  farmYieldShockSkew: FARM_CALIBRATION.yieldShockSkew,
  /** The shock irrigated fields share. */
  irrigatedYieldShockSd: FARM_CALIBRATION.irrigatedYieldShockSd,
  irrigatedYieldShockSkew: FARM_CALIBRATION.irrigatedYieldShockSkew,
  /** A field's own yield shock, dry and irrigated. */
  fieldYieldShockSd: Object.freeze({ dry: 0, irrigated: 0 }),
  /** A season cost multiplier, by lever field (`rentMultiplier`, `nitrogenMultiplier`, …). */
  multiplierSd: Object.freeze({}),
  /** A contract's share of the expected crop. */
  contractShareSd: 0,
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
  // The season shocks are skew-normal (§13.8): a drought's tail is longer than a bumper year's.
  const row = (paramKey, label, stdDev, calibrated = false, skew = null) => ({
    paramKey, label, mean: 0, stdDev, group: 'Farm · yield', enabled: false, calibrated,
    ...(skew != null && skew !== 0 ? { type: DISTRIBUTION_TYPES.SKEW_NORMAL, skew } : { type: DISTRIBUTION_TYPES.NORMAL }),
    // The centre IS what the model reads for a blank shock (`blankValue` 0), not a made-up mean.
    effectiveDefault: true,
  });
  // The historical year (§17.13): one NASS county-year per path, the farm's own county when it
  // names one NASS has. It writes both season shocks, so it replaces the two rows after it.
  const pool = yieldYearPool(farm);
  const yearRows = pool.rows.length ? farm.seasons.map(s => ({
    paramKey: `farm.season.${s.id}.yieldYear`,
    label: `Historical yield year (${pool.county ? `${pool.county[0]}${pool.county.slice(1).toLowerCase()} County` : 'any Nebraska county'})`,
    type: DISTRIBUTION_TYPES.EMPIRICAL, values: pool.rows, mean: 0, stdDev: 0,
    group: 'Farm · yield', enabled: false, calibrated: true, bootstrap: true,
    county: pool.county, years: pool.rows.length,
    replaces: [`farm.season.${s.id}.yieldShock`, `farm.season.${s.id}.irrigatedYieldShock`],
    effectiveDefault: true,
  })) : [];
  return [
    ...yearRows,
    ...farm.seasons.map(s => row(`farm.season.${s.id}.yieldShock`, 'Farm-wide yield shock', spreads.farmYieldShockSd,
      spreads === FARM_MC_SPREADS, spreads.farmYieldShockSkew)),
    ...((farm.fields ?? []).some(f => f.irrigated === true)
      ? farm.seasons.map(s => row(`farm.season.${s.id}.irrigatedYieldShock`, 'Irrigated yield shock', spreads.irrigatedYieldShockSd,
        spreads === FARM_MC_SPREADS, spreads.irrigatedYieldShockSkew))
      : []),
    ...(farm.cropPlans ?? []).map(p => row(`farm.plan.${p.id}.yieldShock`,
      `${(farm.fields ?? []).find(f => f.id === p.fieldId)?.name ?? p.fieldId} · ${p.crop} — yield shock`,
      irrigated.get(p.fieldId) ? spreads.fieldYieldShockSd.irrigated : spreads.fieldYieldShockSd.dry)),
  ];
}

/**
 * One row per price row for its path shock (design 134 §13.5): a STANDARD normal, by
 * definition, because the scale is the season's `priceVol`. So sd 1 is not a calibration; the
 * volatility is, and it is 0 until step 2e. Off until then too.
 *
 * @param {object|null} cfg the farm scenario
 */
export function buildPriceMcConfigs(cfg) {
  return (cfg?.farm?.prices ?? []).filter(p => p?.id != null).map(p => ({
    paramKey: `farm.price.${p.id}.shock`, label: `${p.crop} ${p.date} — price shock`,
    type: DISTRIBUTION_TYPES.NORMAL, mean: 0, stdDev: 1, group: 'Farm · prices', enabled: false,
    effectiveDefault: true,
    // A unit z: the scale is the season's priceVol, so the panel must not offer it as a spread.
    fixedSpread: true, crop: p.crop,
  }));
}

/**
 * One row per season multiplier the farm has, and per contract sized as a share (design 134
 * §13.6), centred on the record and at `FARM_MC_SPREADS`, so the harvest's generic spread never
 * reaches them. Read from the generated levers, so a row exists exactly where a lever does.
 *
 * @param {object|null} cfg the farm scenario
 */
export function buildMultiplierMcConfigs(cfg, spreads = FARM_MC_SPREADS) {
  if (!cfg?.farm) return [];
  return ScenarioParamGenerator.generate(cfg)
    .filter(e => /^farm\.season\.[^.]+\.\w+Multiplier$/.test(e.key) || /^farm\.contract\.[^.]+\.shareOfExpected$/.test(e.key))
    .map(e => {
      const field = e.key.split('.').at(-1);
      const sd = field === 'shareOfExpected' ? spreads.contractShareSd : (spreads.multiplierSd[field] ?? 0);
      return {
        paramKey: e.key, label: e.label, type: DISTRIBUTION_TYPES.NORMAL, mean: e.defaultValue,
        stdDev: sd, group: field === 'shareOfExpected' ? 'Farm · marketing' : 'Farm · multipliers',
        enabled: false, effectiveDefault: true,
      };
    });
}

/**
 * `{ crop: σ }` for each crop with a sampled price-shock row and no `priceVol` of its own on
 * the season: the calibrated vol a batch fills in.
 */
export function calibratedPriceVolFor(cfg, variables) {
  const authored = cfg?.farm?.seasons?.[0]?.priceVol ?? {};
  const out = {};
  for (const v of variables) {
    if (!v.enabled || !v.fixedSpread || authored[v.crop] != null) continue;
    const vol = FARM_CALIBRATION.priceVol[v.crop];
    if (vol != null) out[v.crop] = vol;
  }
  return out;
}

/** `cfg` with `priceVol` set on its season for each crop in `filled` (a copy; cfg is untouched). */
export function withPriceVol(cfg, filled) {
  if (!Object.keys(filled ?? {}).length) return cfg;
  const [s0, ...rest] = cfg.farm.seasons;
  return { ...cfg, farm: { ...cfg.farm, seasons: [{ ...s0, priceVol: { ...(s0.priceVol ?? {}), ...filled } }, ...rest] } };
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
    // A crop whose price shocks are sampled needs a vol to scale them. Where the season leaves
    // it blank, the calibrated one is filled in for this batch only (design 134 §13.8).
    const priceVolFilled = calibratedPriceVolFor(raw, variables);
    if (Object.keys(priceVolFilled).length) {
      Object.assign(cfgTemplate, withPriceVol(cfgTemplate, priceVolFilled));
    }
    const centerless = variablesMissingCenter(variables);
    if (centerless.length) {
      throw new Error('Monte Carlo cannot sample an enabled variable with no center: '
        + centerless.map(v => v.label ?? v.paramKey).join(', '));
    }
    const provenance = summarizeProvenance(variables, { ownParams, schemaDefaults: {}, who: 'FarmMcRunner' });
    // Design 134 §6: the harvested spreads are uncalibrated. Say which sampled rows use one.
    provenance.uncalibrated = variables.filter(v => v.enabled && v.harvested).map(v => v.paramKey);
    // To replay a path: applyFarmPath(cfg, path, priceVolFilled).
    provenance.priceVolFilled = priceVolFilled;
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
   * @returns {Promise<{ runs: Array<{ seed, params, metrics, scheduleF, cashSeries }>, summary: object }>}
   *   `scheduleF` is the path's export rows per operator (`exportOperators`, design 134 §8.2);
   *   `cashSeries` its cumulative cash net by month (`farmCashSeries`)
   */
  async run(baseParams = {}, onProgress) {
    const { ctx, provenance, mcRuns, erroredRuns } = await this._runAll(baseParams, onProgress);
    const runs = mcRuns.map(r => ({
      seed: r.seed, params: r.params, metrics: r.result.metrics, scheduleF: r.result.scheduleF ?? null,
      cashSeries: r.result.cashSeries ?? null,
    }));
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

// ─── Replaying one path on the live scenario (design 134 §17.12) ─────────────────

/**
 * The param bag that replays a path: its params without `endDate`, which every path carries
 * (it is where the batch stops, `FarmMcRunner._prepare`) and which the scenario's own
 * `simEnd` already says. Left in, a replay would write a Date into the scenario's params.
 *
 * @param {{ params: object }} run one path of `FarmMcRunner.run().runs`
 */
export function farmPathBag(run) {
  const { endDate: _end, ...bag } = run?.params ?? {};
  return bag;
}

/**
 * Write one path onto a farm scenario so a rebuild runs that season: the path's param bag on
 * both param stores (`applyParamBagToConfig`, as the worker builds a path), and the price
 * volatility the batch filled in for a crop whose season sets none (`priceVolFilled`). A path
 * is its bag plus that vol: a farm has no return paths and no sampler, so the sim's seed draws
 * nothing. Mutates and returns `cfg`.
 *
 * @param {object} cfg the active farm scenario
 * @param {{ params: object }} run one path
 * @param {Record<string, number>} [priceVolFilled] `summary.provenance.priceVolFilled`
 */
export function applyFarmPath(cfg, run, priceVolFilled = {}) {
  if (!cfg?.farm) return cfg;
  if (Object.keys(priceVolFilled ?? {}).length && cfg.farm.seasons?.length) {
    const s0 = cfg.farm.seasons[0];
    s0.priceVol = { ...(s0.priceVol ?? {}), ...priceVolFilled };
  }
  return applyParamBagToConfig(cfg, farmPathBag(run));
}

/** The first season's `priceVol`, as a replay may change it (a copy, or null when unset). */
export function snapshotFarmPriceVol(cfg) {
  const v = cfg?.farm?.seasons?.[0]?.priceVol;
  return v == null ? null : { ...v };
}

/**
 * Undo a replay's price volatility: put `before` back, unless the vol has been edited since the
 * replay wrote it (`after`), in which case the edit stays, as `restoreParamStores` keeps an
 * edited param. Mutates `cfg`.
 *
 * @returns {boolean} true when the vol was put back
 */
export function restoreFarmPriceVol(cfg, before, after) {
  const s0 = cfg?.farm?.seasons?.[0];
  if (!s0) return false;
  const now = s0.priceVol == null ? null : s0.priceVol;
  if (JSON.stringify(now) !== JSON.stringify(after) || JSON.stringify(now) === JSON.stringify(before)) return false;
  if (before == null) delete s0.priceVol;
  else s0.priceVol = { ...before };
  return true;
}
