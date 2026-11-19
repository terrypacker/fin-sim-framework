/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { DISTRIBUTION_TYPES }       from '../../simulation-framework/distributions.js';
import { ScenarioParamGenerator }   from '../../scenarios/params/scenario-param-generator.js';
import { get }                      from './mc-param-paths.js';
import { indexParamSchema, resolveSweepVariables, harvestSweepVariables,
         groupWithAliasSuccessor } from '../param-schema-utils.js';

/**
 * The scenario-agnostic half of a Monte Carlo variable catalog (design 134 §4).
 *
 * A catalog is a `McConfig` subclass that supplies three static hooks:
 *
 *   contributors   — functions `({ params }) => rows`: the curated rows and any rows built
 *                    from the plan (one per shock, one per person, one per farm category);
 *   paramSchema()  — the scenario's full static param schema, which the harvest reads and
 *                    from which every row inherits its label, options and visibleWhen;
 *   aliases        — legacy key → successor key, so a row is not offered twice.
 *
 * Everything else is shared: the schema harvest of `mc`-flagged entries (design 98 W3), the
 * centre resolution against the batch's base bag, overrides from the panel, and the
 * provenance every row carries (`CENTER_SOURCES`). `IntlRetirementMcConfig` was the only
 * catalog until the farm (design 134 phase 2), and this class is its body unchanged.
 */

/**
 * Default MC distribution for a harvested row, by sweep kind (design 98 W3.4).
 * Year rows carry `integer: true` so perturbParams rounds the draw — without it,
 * `Date.UTC(year, …)` truncates and the axis runs half a year early (F10, W0b).
 * Enums have no categorical distribution, so they are Opt-only.
 */
export function mcRowFor(kind, center, entry) {
  // A grid-only lever (design 133: the bootstrap window) is an axis, never a per-path draw:
  // drawing it per path would mix windows inside one batch, which the pairing record
  // (one window per batch) could not describe.
  if (entry?.gridOnly) return null;
  switch (kind) {
    case 'year':
      // An UNSET year (a sale that does not happen) has nothing to sample around: the row
      // carries its spread and no mean, and cannot run enabled until the user types one.
      if (center === null) return { type: DISTRIBUTION_TYPES.NORMAL, stdDev: 1.5, integer: true };
      return { type: DISTRIBUTION_TYPES.NORMAL, mean: center, stdDev: 1.5, integer: true };
    case 'rate':
      return { type: DISTRIBUTION_TYPES.NORMAL, mean: center,
        stdDev: Math.max(0.005, 0.2 * Math.abs(center)) };
    case 'amount':
      return center === 0 ? null
        : { type: DISTRIBUTION_TYPES.NORMAL, mean: center, stdDev: 0.1 * Math.abs(center) };
    case 'date': {
      // A date pinned to one day of the year (`dateAnchor`, design 117 D5) rides on the
      // row, so every draw snaps to that day.
      const anchor = entry?.dateAnchor ? { anchor: entry.dateAnchor } : {};
      // An UNSET date, like an unset year: the spread and no center (NORMAL_DATE, σ in
      // days), so it cannot run enabled until the user types a mean date.
      if (center === null) return { type: DISTRIBUTION_TYPES.NORMAL_DATE, stdDev: 548, ...anchor };
      const d   = new Date(center);
      const iso = dy => new Date(Date.UTC(d.getUTCFullYear() + dy, d.getUTCMonth(), d.getUTCDate()))
        .toISOString().slice(0, 10);
      return { type: DISTRIBUTION_TYPES.UNIFORM_DATE, min: iso(-2), max: iso(2), ...anchor };
    }
    default:
      return null;
  }
}

/**
 * Where a variable's distribution CENTER came from. A run sampled around the
 * wrong center is not a weaker answer — it is an answer about a different plan,
 * and nothing downstream can tell, so every variable carries its provenance.
 *
 *   scenario — the loaded scenario's own value at this paramKey. The normal case.
 *   schema   — the cfg carries no value, so the param SCHEMA default supplied it.
 *              Still coherent: ScenarioLoader materializes that same default into
 *              the cfg, so the sim runs at exactly this center.
 *   override — an explicit user/caller center (panel edit, applyOverride({mean})).
 *              Deliberate; may legitimately differ from the scenario.
 *   default  — the framework's hardcoded MC-template mean, used because the
 *              paramKey isn't resolvable in the params passed to buildVariables().
 *              The silent-wrong-answer case: nothing ties it to what the sim runs.
 *   n/a      — no single numeric center (UNIFORM_DATE carries min/max instead).
 *   unset    — the plan leaves it null because the event does not happen (a blank sale
 *              year, `sweepUnset`). There is no center until the user types one, and an
 *              enabled unset row with none cannot run (`variablesMissingCenter`).
 *
 * `schema` is never emitted by buildVariables — which sees one merged bag and cannot
 * tell the layers apart — only by refineCenterSource(), given those layers.
 */
export const CENTER_SOURCES = {
  SCENARIO: 'scenario',
  SCHEMA:   'schema',
  OVERRIDE: 'override',
  DEFAULT:  'default',
  NA:       'n/a',
  UNSET:    'unset',
};

/**
 * Split a variable's `scenario` center into `scenario` vs `schema`, given the layers
 * its value could have come from.
 *
 * buildVariables() resolves against ONE merged bag, so it can only say "the value was
 * there" — it cannot say which layer put it there. Whoever owns the layering calls
 * this. Both the runner (for `summary.provenance`) and the MC panel (for its per-row
 * source tag) do, through this one function, so the two can't drift into telling the
 * user different stories about the same variable.
 *
 * @param {object} v                    a resolved variable from buildVariables()
 * @param {object} [layers]
 * @param {object} [layers.ownParams]      the loaded scenario's own param bag
 * @param {object} [layers.schemaDefaults] key → param-schema defaultValue
 * @returns {string} a CENTER_SOURCES value
 */
export function refineCenterSource(v, { ownParams = null, schemaDefaults = null } = {}) {
  if (v.centerSource === CENTER_SOURCES.SCENARIO
      && ownParams && !(v.paramKey in ownParams)
      && schemaDefaults && (v.paramKey in schemaDefaults)) {
    return CENTER_SOURCES.SCHEMA;
  }
  // `effectiveDefault` is a contributor saying "my mean is what the sim runs at
  // anyway" (e.g. a preset shock's library severity) — coherent, not synthetic.
  if (v.centerSource === CENTER_SOURCES.DEFAULT && v.effectiveDefault) return CENTER_SOURCES.SCHEMA;
  return v.centerSource;
}

/**
 * Tag one resolved variable with center provenance:
 *   centerSource   — see CENTER_SOURCES
 *   center         — the center actually used: a number, or a NORMAL_DATE's mean date
 *                    (undefined for UNIFORM_DATE)
 *   scenarioValue  — the loaded scenario's value at this paramKey (undefined when absent)
 *   centerDiverges — center and scenarioValue are both numeric and differ
 */
function centerProvenance(resolved, scenarioValue, override) {
  if (resolved.type === DISTRIBUTION_TYPES.UNIFORM_DATE) {
    return { centerSource: CENTER_SOURCES.NA, center: undefined, scenarioValue, centerDiverges: false };
  }
  const overridden = override.mean !== undefined || override.value !== undefined;
  const center = resolved.type === DISTRIBUTION_TYPES.CONSTANT ? resolved.value : resolved.mean;
  // The MC panel emits a center for EVERY row, so a naive read makes every UI run
  // look like 40 deliberate overrides and hides the ones that actually are. A row
  // the user never typed into says so (`centerDirty:false`) and carries the source
  // the panel resolved — honour it, or a synthetic center silently reclassifies as
  // "the user meant that" the moment it goes through the UI.
  const declared = overridden && override.centerDirty === false ? override.centerSource : null;
  const centerSource = declared                 ? declared
                     : overridden               ? CENTER_SOURCES.OVERRIDE
                     : resolved.unset           ? CENTER_SOURCES.UNSET
                     : scenarioValue !== undefined ? CENTER_SOURCES.SCENARIO
                     :                               CENTER_SOURCES.DEFAULT;
  const dayOf = x => (typeof x === 'string' || x instanceof Date) && !Number.isNaN(new Date(x).getTime())
    ? new Date(x).toISOString().slice(0, 10) : null;
  const centerDiverges =
    typeof center === 'number' && typeof scenarioValue === 'number'
      ? Math.abs(center - scenarioValue) > 1e-9
      // A NORMAL_DATE's center is a date (design 117 D10): compare the days.
      : dayOf(center) != null && dayOf(scenarioValue) != null && dayOf(center) !== dayOf(scenarioValue);
  return { centerSource, center, scenarioValue, centerDiverges };
}

/**
 * The enabled variables that have nothing to sample around — an unset row (a blank sale
 * year) the user switched on without typing a mean. Sampling one would draw from
 * `N(undefined, σ)` and write NaN as the year, so the runner refuses it and the panel
 * says which row before it gets that far.
 *
 * @param {Array<object>} variables  resolved variables (buildVariables output)
 * @returns {Array<object>} the offending variables
 */
export function variablesMissingCenter(variables) {
  const isDate = x => typeof x === 'string' && !Number.isNaN(Date.parse(x));
  const hasCenter = v => {
    switch (v.type) {
      case DISTRIBUTION_TYPES.CONSTANT:     return Number.isFinite(v.value) || isDate(v.value);
      case DISTRIBUTION_TYPES.NORMAL:
      case DISTRIBUTION_TYPES.LOG_NORMAL:   return Number.isFinite(v.mean);
      case DISTRIBUTION_TYPES.NORMAL_DATE:  return isDate(v.mean);
      case DISTRIBUTION_TYPES.UNIFORM_DATE: return isDate(v.min) && isDate(v.max);
      default:                              return true;   // a range or a table, not a center
    }
  };
  return (variables ?? []).filter(v => v.enabled && !hasCenter(v));
}

/**
 * A Monte Carlo variable catalog. Subclass it and set the static hooks above.
 */
export class McConfig {
  /** `({ params }) => rows[]`, run in order; their rows come first. */
  static contributors = [];
  /** Legacy key → successor key. */
  static aliases = {};
  /** The scenario's full static param schema. */
  static paramSchema() { return []; }

  /** The static schema indexed by key, built once per catalog class. */
  static schemaByKey() {
    if (!Object.hasOwn(this, '_schemaIndex')) this._schemaIndex = indexParamSchema(this.paramSchema());
    return this._schemaIndex;
  }

  constructor() {
    // paramKey → user override object (enabled, mean, stdDev, etc.)
    this._overrides = new Map();
  }

  /** Store a user override for a specific variable by paramKey. */
  applyOverride(paramKey, override) {
    // Strip paramKey from the override — it must never clobber the resolved path.
    const { paramKey: _ignored, ...rest } = override;
    this._overrides.set(paramKey, { ...(this._overrides.get(paramKey) ?? {}), ...rest });
  }

  /**
   * Build the resolved variable list for a given param snapshot.
   *
   * - Runs all contributors with the params.
   * - Drops variables whose path doesn't resolve in the params tree
   *   (prevents stale shock[N] configs from poisoning a run).
   * - Fills `defaultValue` and resolves `mean` from the scenario value
   *   when the config omits it.
   * - Applies any user overrides stored via applyOverride().
   * - Tags each variable with `centerSource` provenance (see centerProvenance).
   *
   * After the contributors it HARVESTS (design 98 W3) every `mc`-flagged schema entry
   * they do not already offer, as a disabled row centred on its value in `params`.
   * `cfg` (the loaded scenario) adds its generated per-record params to the schema
   * harvested from; a null `cfg` (library callers) harvests the static schema only.
   * Harvested rows then go through the same resolution / overrides / provenance.
   */
  buildVariables(params, { cfg = null } = {}) {
    const C = this.constructor;
    const contributed = C.contributors.flatMap(fn => fn({ params }));
    const schema = [
      ...C.paramSchema(),
      ...(cfg ? ScenarioParamGenerator.generate(cfg) : []),
    ];
    const harvested = harvestSweepVariables(contributed, schema, params,
      { flag: 'mc', aliases: C.aliases, rowFor: mcRowFor });
    const resolved = groupWithAliasSuccessor([...contributed, ...harvested], schema, C.aliases)
      .filter(cfg => {
        // Non-array-indexed keys (flat or dot-separated): always keep.
        // Their cfg.value/cfg.mean acts as the reference when the key is absent
        // from params, so r.params stays complete even with sparse baseParams.
        if (!cfg.paramKey.includes('[')) return true;
        // Array-indexed paths (e.g. shocks[0].severity): keep only when the
        // parent array entry exists — drops stale shock[N] configs without error.
        const val = get(params, cfg.paramKey);
        if (val !== undefined) return true;
        const arrayMatch = cfg.paramKey.match(/^(\w+\[\d+\])/);
        if (arrayMatch) return get(params, arrayMatch[1]) !== undefined;
        console.warn(`[${C.name}] dropping unresolvable MC variable: ${cfg.paramKey}`);
        return false;
      })
      .map(cfg => {
        const defaultValue = get(params, cfg.paramKey);
        const override     = this._overrides.get(cfg.paramKey) ?? {};
        const resolved = {
          ...cfg,
          defaultValue,
          // Preset the sweep center to the live scenario value so the panel inputs
          // reflect the current config (balances and rates), falling back to the
          // template's hardcoded default only when the param isn't resolvable in
          // `params`. A user override (from the panel) still wins via the spread below.
          mean:  defaultValue ?? cfg.mean,
          value: defaultValue ?? cfg.value,
          ...override,
        };
        return { ...resolved, ...centerProvenance(resolved, defaultValue, override) };
      });

    // Inherit identity (label / options / visibleWhen) from the param schema and
    // drop variables hidden by an unsatisfied visibleWhen (e.g. a strategy knob
    // whose strategy isn't selected). Identity is maintained once, in the schema.
    return resolveSweepVariables(resolved, C.schemaByKey(), params);
  }
}
