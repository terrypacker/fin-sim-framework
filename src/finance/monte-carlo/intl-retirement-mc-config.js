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
import { INTL_RETIREMENT_DEFAULTS, INTL_RETIREMENT_PARAM_ALIASES, IntlRetirementScenario }
  from '../../scenarios/intl-retirement-scenario.js';
import { ScenarioParamGenerator }   from '../../scenarios/params/scenario-param-generator.js';
import { MARKET_GROWTH_PARAMS } from '../../scenarios/toolsets/economic-regimes-toolset.js';
import { SHOCK_LIBRARY }            from '../economic-shocks/shock-library.js';
import { get }                      from './mc-param-paths.js';
import { lookupLifeTable }          from './life-tables.js';
import { indexParamSchema, resolveSweepVariables, harvestSweepVariables } from '../param-schema-utils.js';

const D = INTL_RETIREMENT_DEFAULTS;

// Lazily index the full param schema by key so MC variables can inherit identity
// (label / options / visibleWhen) from it rather than duplicating it here.
let _schemaByKey = null;
function schemaByKey() {
  if (!_schemaByKey) _schemaByKey = indexParamSchema(IntlRetirementScenario.buildFullParamSchema());
  return _schemaByKey;
}

/**
 * Default MC distribution for a harvested row, by sweep kind (design 98 W3.4).
 * Year rows carry `integer: true` so perturbParams rounds the draw — without it,
 * `Date.UTC(year, …)` truncates and the axis runs half a year early (F10, W0b).
 * Enums have no categorical distribution, so they are Opt-only.
 */
function mcRowFor(kind, center) {
  switch (kind) {
    case 'year':
      return { type: DISTRIBUTION_TYPES.NORMAL, mean: center, stdDev: 1.5, integer: true };
    case 'rate':
      return { type: DISTRIBUTION_TYPES.NORMAL, mean: center,
        stdDev: Math.max(0.005, 0.2 * Math.abs(center)) };
    case 'amount':
      return center === 0 ? null
        : { type: DISTRIBUTION_TYPES.NORMAL, mean: center, stdDev: 0.1 * Math.abs(center) };
    case 'date': {
      const d   = new Date(center);
      const iso = dy => new Date(Date.UTC(d.getUTCFullYear() + dy, d.getUTCMonth(), d.getUTCDate()))
        .toISOString().slice(0, 10);
      return { type: DISTRIBUTION_TYPES.UNIFORM_DATE, min: iso(-2), max: iso(2) };
    }
    default:
      return null;
  }
}

/**
 * Static Monte Carlo variable configurations for the IntlRetirementScenario.
 *
 * Each entry maps a flat scenario parameter key to a distribution definition.
 * Shock variables are generated dynamically by buildShockMcConfigs() based on
 * the scenario's configured shocks array.
 *
 * enabled:true  → perturbed by default when MC runs.
 * enabled:false → included in the UI for toggling; off by default.
 *
 * `paramKey` MUST be the toolset parameter key the compiler reads (e.g.
 * `brokerageGrowthRate`, not the `usStockGrowthRate` scenario-default alias) —
 * the runner writes the sampled value to `cfg.parameters[paramKey]`, so a
 * non-toolset key is silently discarded. `label` may differ for clarity.
 *
 * Identity is the param schema's job: `visibleWhen` is always inherited from the
 * schema by paramKey (buildVariables → resolveSweepVariables), and `label` is
 * inherited when omitted here. A new entry needs only `paramKey` + distribution
 * metadata; add `label` only to override the schema's.
 */
export const DEFAULT_MC_VARIABLE_CONFIGS = [

  // ── Equity return uncertainty (design 98 M2) ─────────────────────────────
  // ONE systematic draw, added to all four market totals. Drawing the markets separately
  // (the interim after design 99 P2 drew US and AU independently) lets them cancel each
  // other, and the measured dispersion then depends on how many markets a plan happens to
  // hold (F3). sd 0.03 is the size the per-market axes used, so M2 changes the SHAPE of
  // the uncertainty, not its stated size; M3 revisits the size.
  {
    paramKey: 'equityAnchorShift',     label: 'Equity Return Shift (all markets)',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: 0, stdDev: 0.03,
    group: 'Market Rates',             enabled: true,
  },
  // The per-market totals and yields stay listed for anyone studying one market or yield
  // composition, but off: genuine per-market divergence is design 90 §7.4's job. A yield
  // draw changes how a return is TAXED, not its size (the price takes the rest).
  ...MARKET_GROWTH_PARAMS.flatMap(m => [
    {
      paramKey: m.key,                   label: m.label,
      type: DISTRIBUTION_TYPES.NORMAL,   mean: m.defaultValue, stdDev: 0.03,
      group: 'Market Rates',             enabled: false,
    },
    {
      paramKey: m.yieldKey,              label: m.yieldLabel,
      type: DISTRIBUTION_TYPES.NORMAL,   mean: m.yieldDefault, stdDev: 0.005,
      group: 'Market Rates',             enabled: false,
    },
  ]),

  // ── Central-bank Prime rates — THE systemic rate sweep (design 56 Decision 6 / §3.1) ──
  // One draw on Prime moves every Prime-linked cash account (and, in Phase 3, variable
  // loan) coherently via the per-account re-seed. The per-account/global savings interest
  // MC levers are RETIRED (replaced by Prime, not kept alongside — avoids the double-move);
  // fixed-income keeps its own rate knob (bonds are excluded from Prime, Decision 3).
  {
    paramKey: 'usPrimeRate',           label: 'US Prime Rate (Fed policy)',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.usPrimeRate, stdDev: 0.01,
    group: 'US Account Rates',         enabled: true,
  },
  {
    paramKey: 'fixedIncomeInterestRate', label: 'Fixed Income Interest Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.fixedIncomeInterestRate, stdDev: 0.01,
    group: 'US Account Rates',         enabled: true,
  },
  {
    paramKey: 'auPrimeRate',           label: 'AU Prime Rate (RBA policy)',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.auPrimeRate, stdDev: 0.01,
    group: 'AU Account Rates',         enabled: true,
  },

  // ── Equity return-path volatility (design 74 §5.2) ────────────────────────
  // The annualized sd of the shared equity MARKET factor. Sampling this makes the
  // *width* of the return path an MC axis; each iteration's own seed already gives it
  // a different return SEQUENCE (design 74 §5.2, once the per-iteration seed is
  // threaded). enabled:false so it is opt-in and single runs are unaffected. NOTE:
  // this only bites when `equityReturnStochastic` is ON in the scenario — with the
  // flag off no path is drawn and the sampled vol is inert.
  {
    paramKey: 'equityReturnVol',       label: 'Equity Return Volatility',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: 0.18, stdDev: 0.03,
    group: 'Return Paths',             enabled: false,
  },

  // ── House path & running-cost MC scalers (design 75 §6.4 B) ───────────────
  // The per-property return/repair inputs live in cfg.realProperties (not cfg.parameters), so
  // they can't be swept directly. These three global scalars in cfg.parameters ARE MC-able and
  // are threaded into the handlers as multipliers. All center on 1.0 and only bite when the
  // matching stochastic path/repair model is active in the scenario — inert on single runs and
  // opt-in (enabled:false) here. `propertyReturnIdioScale` is the honest housing-VOL axis
  // (equityReturnVol barely reaches the house through β≈0.03, since housing is ~99% idiosyncratic).
  {
    paramKey: 'propertyReturnIdioScale', label: 'Property Idiosyncratic Vol Scale',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: 1.0, stdDev: 0.2,
    group: 'Return Paths',             enabled: false,
  },
  {
    paramKey: 'repairSeverityScale',   label: 'House Repair Severity Scale',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: 1.0, stdDev: 0.3,
    group: 'Return Paths',             enabled: false,
  },
  {
    paramKey: 'repairFreqScale',       label: 'House Repair Frequency Scale',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: 1.0, stdDev: 0.3,
    group: 'Return Paths',             enabled: false,
  },

  // ── Inflation rates ───────────────────────────────────────────────────────
  {
    paramKey: 'inflationRate',         label: 'US Inflation Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.usInflationRate, stdDev: 0.01,
    group: 'Inflation',                enabled: true,
  },
  {
    paramKey: 'auInflationRate',       label: 'AU Inflation Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.auInflationRate, stdDev: 0.01,
    group: 'Inflation',                enabled: true,
  },

  // ── FX / transfer ─────────────────────────────────────────────────────────
  {
    paramKey: 'exchangeRateUsdToAud',  label: 'Exchange Rate USD→AUD',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.exchangeRateUsdToAud, stdDev: 0.15,
    group: 'Transfer & Expenses',      enabled: true,
  },
  {
    paramKey: 'intlTransferFeeUsd',    label: 'International Transfer Fee (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.intlTransferFeeUsd,
    group: 'Transfer & Expenses',      enabled: false,
  },

  // ── Monthly expenses (disabled by default — users adjust for sensitivity) ──
  {
    paramKey: 'monthlyExpenses',       label: 'Monthly Expenses',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.monthlyExpenses, stdDev: 200,
    group: 'Transfer & Expenses',      enabled: false,
  },

  // ── Wages (disabled by default) ───────────────────────────────────────────
  {
    paramKey: 'primaryMonthlyWage',    label: 'Primary Monthly Wage (USD)',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.primaryMonthlyWage, stdDev: 500,
    group: 'People',                   enabled: false,
  },
  {
    paramKey: 'spouseMonthlyWage',     label: 'Spouse Monthly Wage (USD)',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.spouseMonthlyWage, stdDev: 300,
    group: 'People',                   enabled: false,
  },

  // ── Account balances (disabled by default — starting values are known) ────
  // Every account bootstraps at least one holding at compile time, so its `balance` is
  // DERIVED from Σ holdings and is not a plain param (design 55 §13). These levers keep
  // their flat legacy keys — the names saved MC configs carry; they were first chosen
  // because mc-param-paths `set()` dropped dotted generated keys, which design 98 W0
  // fixed — and INTL_RETIREMENT_PARAM_ALIASES resolves each to the generated,
  // hidden `acct.<stateKey>.balanceTarget`, whose loader cascade rescales that account's
  // holdings to the sampled dollar total non-destructively. The sampled value is still an
  // absolute balance in the account's native currency.
  {
    paramKey: 'initialUsSavings',      label: 'US Savings Initial Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.initialUsSavings,
    group: 'US Account Balances',      enabled: false,
  },
  {
    paramKey: 'rothBalance',           label: 'Roth IRA Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.rothBalance,
    group: 'US Account Balances',      enabled: false,
  },
  {
    paramKey: 'iraBalance',            label: 'Traditional IRA Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.iraBalance,
    group: 'US Account Balances',      enabled: false,
  },
  {
    paramKey: 'k401Balance',           label: '401(k) Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.k401Balance,
    group: 'US Account Balances',      enabled: false,
  },
  {
    paramKey: 'stockBalance',          label: 'US Stock Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.stockBalance,
    group: 'US Account Balances',      enabled: false,
  },
  {
    paramKey: 'fixedIncomeBalance',    label: 'Fixed Income Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.fixedIncomeBalance,
    group: 'US Account Balances',      enabled: false,
  },
  {
    paramKey: 'auSavingsBalance',      label: 'AU Savings Initial Balance (AUD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.auSavingsBalance,
    group: 'AU Account Balances',      enabled: false,
  },
  {
    paramKey: 'superBalance',          label: 'Superannuation Balance (AUD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.superBalance,
    group: 'AU Account Balances',      enabled: false,
  },
  {
    paramKey: 'auStockBalance',        label: 'AU Stock Balance (AUD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.auStockBalance,
    group: 'AU Account Balances',      enabled: false,
  },
  {
    paramKey: 'spouseRothBalance',     label: 'Spouse Roth IRA Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.spouseRothBalance,
    group: 'Spouse Account Balances',  enabled: false,
  },
  {
    paramKey: 'spouseIraBalance',      label: 'Spouse Traditional IRA Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.spouseIraBalance,
    group: 'Spouse Account Balances',  enabled: false,
  },
  {
    paramKey: 'spouseK401Balance',     label: 'Spouse 401(k) Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.spouseK401Balance,
    group: 'Spouse Account Balances',  enabled: false,
  },
  {
    paramKey: 'spouseSuperBalance',    label: 'Spouse Superannuation Balance (AUD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.spouseSuperBalance,
    group: 'Spouse Account Balances',  enabled: false,
  },
];

/**
 * Build MC variables for real property sale years.
 *
 * Only emits a variable when the param is non-null — a null sale year has no
 * meaningful distribution center, so there is nothing to perturb.
 * stdDev of 1.5 years covers realistic uncertainty about timing (roughly ±3 yr
 * at 2σ).  `integer: true` has perturbParams round each draw (design 98 W0b);
 * applyRealPropertySaleYearParams also rounds, for the headless/library path.
 */
function buildRealPropertyMcConfigs(params) {
  const vars = [];
  if (params.usHouseSaleYear != null) {
    vars.push({
      paramKey: 'usHouseSaleYear', label: 'US House Sale Year',
      type: DISTRIBUTION_TYPES.NORMAL,
      mean:   params.usHouseSaleYear,
      stdDev: 1.5,
      integer: true,
      group:  'Real Properties',
      enabled: false,
    });
  }
  if (params.auHouseSaleYear != null) {
    vars.push({
      paramKey: 'auHouseSaleYear', label: 'AU House Sale Year',
      type: DISTRIBUTION_TYPES.NORMAL,
      mean:   params.auHouseSaleYear,
      stdDev: 1.5,
      integer: true,
      group:  'Real Properties',
      enabled: false,
    });
  }
  return vars;
}

/**
 * Build one set of MC variables per configured shock.
 *
 * For preset-form entries ({ preset, startDate }), severity is read from the
 * library template so the distribution has a meaningful default center even
 * when the entry doesn't carry an explicit severity field.
 */
function buildShockMcConfigs(params) {
  const shocks = params.shocks ?? [];
  return shocks.flatMap((entry, i) => {
    if (!entry) return [];
    const label         = entry.preset ?? entry.shockId ?? `Shock ${i + 1}`;
    const libraryShock  = entry.preset ? (SHOCK_LIBRARY[entry.preset] ?? {}) : {};
    const severityDefault = entry.severity ?? libraryShock.severity ?? 0.4;
    return [
      {
        paramKey: `shocks[${i}].severity`,
        label:    `${label}: severity`,
        type:     DISTRIBUTION_TYPES.NORMAL,
        mean:     severityDefault,
        stdDev:   0.10,
        group:    'Economic Shocks',
        enabled:  false,
        synthetic: true,   // array sub-path: legitimately schema-less (design 98 W3.5)
        // A preset entry with no explicit severity runs at the library's severity, so
        // that mean IS the effective value — not an unanchored default worth flagging
        // (see CENTER_SOURCES). Without a preset, 0.4 is arbitrary and stays flagged.
        effectiveDefault: (entry.severity ?? libraryShock.severity) != null,
      },
      {
        paramKey: `shocks[${i}].startDate`,
        label:    `${label}: start date`,
        type:     DISTRIBUTION_TYPES.UNIFORM_DATE,
        min:      '2028-01-01',
        max:      '2035-01-01',
        group:    'Economic Shocks',
        enabled:  false,
        synthetic: true,
      },
    ];
  });
}

/**
 * Build one MC variable per person for actuarial lifespan draws (design/27 §5).
 *
 * Table is residency-keyed at registration time (boot-time residency only;
 * no mid-run redraw per §10 Q1 Path A).  Variables are enabled:false by default
 * so single runs are unaffected — MC opt-in only.
 *
 * Expects params.people to be a { [personKey]: { lifeExpectancy, residency, sex } } map,
 * as populated by buildDefaultConfig's people parameter patch.
 */
function buildMortalityMcConfigs(params) {
  const people = params.people ?? {};
  return Object.entries(people).flatMap(([personKey, person]) => {
    if (person == null) return [];
    const table      = lookupLifeTable(person.residency ?? 'US');
    const sex        = person.sex ?? 'M';
    const currentAge = person.currentAge ?? 0;
    return [{
      paramKey: `people.${personKey}.lifeExpectancy`,
      label:    `${person.name ?? personKey} lifespan (years)`,
      type:     DISTRIBUTION_TYPES.ACTUARIAL_LIFESPAN,
      table,
      sex,
      currentAge,
      group:    'Mortality',
      enabled:  false,
      synthetic: true,   // nested people.<key> path: schema-less (design 98 W3.5)
    }];
  });
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
 *   center         — the numeric center actually used (undefined for UNIFORM_DATE)
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
                     : scenarioValue !== undefined ? CENTER_SOURCES.SCENARIO
                     :                               CENTER_SOURCES.DEFAULT;
  const centerDiverges =
    typeof center === 'number' && typeof scenarioValue === 'number'
      && Math.abs(center - scenarioValue) > 1e-9;
  return { centerSource, center, scenarioValue, centerDiverges };
}

/**
 * MC configuration for IntlRetirementScenario.
 *
 * Uses a contributor pattern so toolsets (design 26 healthcare, design 27
 * mortality) can register dynamic variable sets without changing the runner.
 *
 * buildVariables(params) produces the full variable list for a given param
 * snapshot, including dynamic per-shock variables from configured shocks[].
 */
export class IntlRetirementMcConfig {
  static contributors = [
    ()          => DEFAULT_MC_VARIABLE_CONFIGS,
    ({ params }) => buildShockMcConfigs(params),
    ({ params }) => buildRealPropertyMcConfigs(params),
    // State Move Year (and the cross-border moveYear) now arrive through the schema
    // harvest in buildVariables — `mc: true`, a year kind, so `integer: true` and
    // emitted only when set (design 98 W3.7 retired buildStateMoveMcConfigs).
    ({ params }) => buildMortalityMcConfigs(params),
  ];

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
   * - Tags each variable with `centerSource` provenance (see _centerSource).
   *
   * After the contributors it HARVESTS (design 98 W3) every `mc`-flagged schema entry
   * they do not already offer, as a disabled row centred on its value in `params`.
   * `cfg` (the loaded scenario) adds its generated per-record params to the schema
   * harvested from; a null `cfg` (library callers) harvests the static schema only.
   * Harvested rows then go through the same resolution / overrides / provenance.
   */
  buildVariables(params, { cfg = null } = {}) {
    const contributed = this.constructor.contributors.flatMap(fn => fn({ params }));
    const schema = [
      ...IntlRetirementScenario.buildFullParamSchema(),
      ...(cfg ? ScenarioParamGenerator.generate(cfg) : []),
    ];
    const harvested = harvestSweepVariables(contributed, schema, params,
      { flag: 'mc', aliases: INTL_RETIREMENT_PARAM_ALIASES, rowFor: mcRowFor });
    const resolved = [...contributed, ...harvested]
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
        console.warn(`[IntlRetirementMcConfig] dropping unresolvable MC variable: ${cfg.paramKey}`);
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
    return resolveSweepVariables(resolved, schemaByKey(), params);
  }

  /**
   * Create an IntlRetirementMcConfig with user states loaded from a flat
   * variableConfigs array (as produced by McConfigPanel).
   *
   * Rewrites legacy flat shock keys to nested paths:
   *   shockSeverity  → shocks[0].severity
   *   shockStartDate → shocks[0].startDate
   *
   * And a legacy scenario-default alias to the toolset key the compiler reads (the MC
   * variable was a silent no-op under the old key), so a saved MC config keeps the
   * user's enabled/distribution settings after the fix:
   *   usInflationRate   → inflationRate
   *
   * The retired equity axes (the per-wrapper growth rates, the per-account dividend
   * rates and their aliases — design 99 P2) need no entry: `applyOverride` only stores
   * settings for a paramKey, and a stored setting for a key no contributor emits is never
   * resolved into a variable — so a saved config's dead axes simply disappear.
   */
  static fromVariableConfigs(variableConfigs) {
    const ALIASES = {
      shockSeverity:        'shocks[0].severity',
      shockStartDate:       'shocks[0].startDate',
      usInflationRate:      'inflationRate',
    };
    const config = new IntlRetirementMcConfig();
    for (const v of variableConfigs) {
      const key = ALIASES[v.paramKey] ?? v.paramKey;
      config.applyOverride(key, v);
    }
    return config;
  }
}
