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
import { isGeneratedParamKey }      from '../../scenarios/params/generated-param-keys.js';
import { MARKET_GROWTH_PARAMS } from '../../scenarios/toolsets/economic-regimes-toolset.js';
import { SHOCK_LIBRARY }            from '../economic-shocks/shock-library.js';
import { lookupLifeTable }          from './life-tables.js';
import { McConfig, mcRowFor, CENTER_SOURCES, refineCenterSource, variablesMissingCenter }
  from './mc-config.js';
import { migrateMcVariableConfig } from '../../scenarios/year-date-migration.js';

const D = INTL_RETIREMENT_DEFAULTS;

// The scenario-agnostic catalog machinery moved to ./mc-config.js (design 134 §4). These were
// this module's public API, so they stay importable from here.
export { mcRowFor, CENTER_SOURCES, refineCenterSource, variablesMissingCenter };

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
  // hold (F3).
  //
  // sd 0.015 is ESTIMATION uncertainty about the long-run mean (design 98 M3), not total
  // return uncertainty: MC now runs the stochastic path (`mcSequenceRisk`), which supplies
  // the year-to-year risk, so the old 0.03 would count part of it twice (F4). 0.015 sits
  // between the CMA providers' disagreement (sd ≈ 1.4 points across the four markets,
  // docs/market-returns/SOURCES.md) and the sampling error of a 100-year historical mean
  // (18% / √100 ≈ 1.8 points).
  {
    paramKey: 'equityAnchorShift',     label: 'Equity Return Shift (all markets)',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: 0, stdDev: 0.015,
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
  // Design 121 §6 — gold's own yearly draw. Like equity vol, inert unless the equity path runs.
  // Design 131 §3.5 — centred on the default, history's 1969– sd.
  {
    paramKey: 'goldReturnVol',         label: 'Gold Return Volatility',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: 0.29, stdDev: 0.05,
    group: 'Return Paths',             enabled: false,
  },
  {
    paramKey: 'goldEquityCorrelation', label: 'Gold–Equity Correlation',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: 0,    stdDev: 0.15,
    group: 'Return Paths',             enabled: false,
  },
  // Design 129 §3.9 — "which world are we in": each path draws its own stock–bond ρ across the
  // measured eras (2000–20 −0.53, 1973–82 +0.42). Uniform, so it stays inside [−1, 1]. Inert
  // unless both the yield and the equity paths run.
  {
    paramKey: 'stockBondCorrelation',  label: 'Stock–Bond Correlation',
    type: DISTRIBUTION_TYPES.UNIFORM,  min: -0.5, max: 0.5,
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

  // ── Record levers: balances, wages, sale dates ────────────────────────────
  // Not listed here: every per-record lever comes from the harvest in buildVariables,
  // keyed by the record's own generated param — `acct.<sk>.balance` / the hidden
  // `acct.<sk>.balanceTarget` (design 55 §13), `person.<id>.monthlyWage`,
  // `prop.<sk>.plannedSaleDate` — and centred on the record by `resolveRecordCenters`.
  // The legacy rows that stood here (`rothBalance` …, `primaryMonthlyWage`,
  // `usHouseSaleYear`) aliased to the REFERENCE plan's record ids, so on another plan some
  // were inert and that plan's other records had no row. A blank sale date still gets an
  // UNSET row (`sweepUnset`). `fromVariableConfigs` maps a saved legacy key.
];

/** A saved shock-date sweep row, retired by design 126 §3.7 (the legacy flat key included). */
const RETIRED_SHOCK_DATE_KEY = /^(shockStartDate|shocks\[\d+\]\.startDate)$/;

/**
 * Build one set of MC variables per configured shock.
 *
 * Severity only. The `shocks[i].startDate` UNIFORM_DATE row is gone (design 126 §3.7): its
 * window was a fixed 2028–2035 whatever the plan's dates, and it drew from the parameter
 * sampler, so enabling it in one arm shifted every other variable that arm sampled. A shock
 * whose date should vary says so itself, with an `arrival` spec drawn on its own keyed stream.
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
 * A retired legacy row's generated successor (`rothBalance` → `acct.rothAccount.balanceTarget`,
 * `primaryMonthlyWage` → `person.primary.monthlyWage`), or undefined for any other
 * key. No MC row is keyed by a legacy alias any more, so every one with a generated
 * successor maps.
 */
function retiredLegacyKey(paramKey) {
  const target = INTL_RETIREMENT_PARAM_ALIASES[paramKey];
  return isGeneratedParamKey(target) ? target : undefined;
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
export class IntlRetirementMcConfig extends McConfig {
  static contributors = [
    ()          => DEFAULT_MC_VARIABLE_CONFIGS,
    ({ params }) => buildShockMcConfigs(params),
    // The State Move Date (and the cross-border moveDate) arrive through the schema
    // harvest in buildVariables — `mc: true`, a date kind pinned to its anchor day
    // (design 117 D5), emitted only when set (design 98 W3.7 retired buildStateMoveMcConfigs).
    ({ params }) => buildMortalityMcConfigs(params),
  ];

  static aliases = INTL_RETIREMENT_PARAM_ALIASES;

  static paramSchema() { return IntlRetirementScenario.buildFullParamSchema(); }

  /**
   * Create an IntlRetirementMcConfig with user states loaded from a flat
   * variableConfigs array (as produced by McConfigPanel).
   *
   * Rewrites the legacy flat shock key to its nested path:
   *   shockSeverity  → shocks[0].severity
   * A saved shock-DATE row (`shockStartDate`, `shocks[i].startDate`) is retired (design 126
   * §3.7) and skipped, with a warning when it was enabled.
   *
   * And a legacy scenario-default alias to the toolset key the compiler reads (the MC
   * variable was a silent no-op under the old key), so a saved MC config keeps the
   * user's enabled/distribution settings after the fix:
   *   usInflationRate   → inflationRate
   *
   * And a saved sale-YEAR row (`usHouseSaleYear`, `prop.<sk>.plannedSaleYear`, …) to its
 * sale-DATE row, a NORMAL year becoming a NORMAL_DATE (design 117 phase 2).
 *
 * And a retired legacy record row to the generated key it aliased
   * (`rothBalance` → `acct.rothAccount.balanceTarget`, `primaryMonthlyWage` →
   * `person.primary.monthlyWage`). On a plan with no such record the setting finds no row
   * and is dropped, which is what the legacy row did silently.
   *
   * The retired equity axes (the per-wrapper growth rates, the per-account dividend
   * rates and their aliases — design 99 P2) need no entry: `applyOverride` only stores
   * settings for a paramKey, and a stored setting for a key no contributor emits is never
   * resolved into a variable — so a saved config's dead axes simply disappear.
   */
  static fromVariableConfigs(variableConfigs) {
    const ALIASES = {
      shockSeverity:        'shocks[0].severity',
      usInflationRate:      'inflationRate',
    };
    const config = new IntlRetirementMcConfig();
    for (const saved of variableConfigs) {
      // Design 126 §3.7: a saved shock-date row no longer has a variable to land on. Dropping it
      // silently would run the arm with every shock on its authored date, so an enabled one says so.
      if (saved?.enabled && RETIRED_SHOCK_DATE_KEY.test(saved.paramKey ?? '')) {
        console.warn(`[IntlRetirementMcConfig] "${saved.paramKey}" is no longer an MC variable `
          + '(design 126): give the shock an arrival window instead. Its shock runs on its authored date.');
        continue;
      }
      // Design 117: a saved sale-YEAR row (generated or legacy flat key) becomes its
      // sale-DATE row, distribution converted so the saved sweep keeps its shape.
      const v   = migrateMcVariableConfig(saved);
      const key = ALIASES[v.paramKey] ?? retiredLegacyKey(v.paramKey) ?? v.paramKey;
      config.applyOverride(key, v);
    }
    return config;
  }
}
