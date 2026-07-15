/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OPT_PARAM_TYPES }            from './optimization-objectives.js';
import { INTL_RETIREMENT_DEFAULTS, DRAWDOWN_STRATEGIES, buildDrawdownWeightSchema, IntlRetirementScenario,
         presentDrawdownWeightRoles, drawdownWeightKey, DRAWDOWN_WEIGHT_PREFIX, DRAWDOWN_WEIGHT_SEP } from '../../scenarios/intl-retirement-scenario.js';
import { SHOCK_LIBRARY }              from '../economic-shocks/shock-library.js';
import { indexParamSchema, resolveSweepVariables } from '../param-schema-utils.js';

// Lazily index the full param schema by key so Opt variables can inherit identity
// (label / options / visibleWhen) from it rather than duplicating it here.
let _schemaByKey = null;
function schemaByKey() {
  if (!_schemaByKey) _schemaByKey = indexParamSchema(IntlRetirementScenario.buildFullParamSchema());
  return _schemaByKey;
}

const D = INTL_RETIREMENT_DEFAULTS;

// Valid US MFJ ordinary-income bracket marginal rates
const US_MFJ_BRACKET_RATES = [0.10, 0.12, 0.22, 0.24, 0.32, 0.35];

/**
 * Static optimization variable configurations for the IntlRetirementScenario.
 *
 * Economic shock variables are NOT listed here — they are generated dynamically
 * by buildOptVariables() based on the scenario's configured shocks array.
 *
 * enabled:true  → included in the search grid by default.
 * enabled:false → available in the UI for the user to toggle on.
 *
 * Config shapes by type:
 *   ENUM       — { values: [...] }
 *   INTEGER    — { min, max, step }
 *   CONTINUOUS — { min, max, step }   (discretised for grid search)
 *
 * Identity is the param schema's job: `visibleWhen` is always inherited from the
 * schema by paramKey (buildOptVariables → resolveSweepVariables), and `label` is
 * inherited when omitted here. A new entry needs only `paramKey` + sweep
 * metadata (type/range/group/enabled); add `label` only to override the schema's
 * or for orphan keys that have no schema entry.
 */
export const DEFAULT_OPTIMIZATION_CONFIGS = [

  // ── Roth Conversion (primary optimization levers) ─────────────────────────
  {
    paramKey: 'rothConversionMaxBracket',
    label:    'Roth Conversion Max Bracket Rate',
    type:     OPT_PARAM_TYPES.ENUM,
    values:   US_MFJ_BRACKET_RATES,
    group:    'Roth Conversion',
    enabled:  true,
    // The bracket ceiling is forward-adjustable each year (design 38 §6.0/§6.3),
    // so design 39's MPC can re-decide it from realized state.
    controllable: true,
  },
  {
    paramKey: 'rothConversionStartYear',
    label:    'Roth Conversion Start Year',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 2026, max: 2036, step: 1,
    group:    'Roth Conversion',
    enabled:  false,
  },
  {
    paramKey: 'rothConversionEndYear',
    label:    'Roth Conversion End Year',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 2032, max: 2046, step: 1,
    group:    'Roth Conversion',
    enabled:  false,
  },

  // ── Monthly expenses (sensitivity / what-if) ──────────────────────────────
  {
    paramKey: 'monthlyExpenses',
    label:    'Monthly Expenses',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 3_000, max: 8_000, step: 500,
    group:    'Transfer & Expenses',
    enabled:  false,
  },

  // ── Cash buffer thresholds ────────────────────────────────────────────────
  {
    paramKey: 'acct.usSavingsAccount.minimumBalance',
    label:    'US Savings Min Balance (USD)',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 10_000, max: 100_000, step: 10_000,
    group:    'Min Balances',
    enabled:  false,
  },
  {
    paramKey: 'acct.auSavingsAccount.minimumBalance',
    label:    'AU Savings Min Balance (AUD)',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 10_000, max: 100_000, step: 10_000,
    group:    'Min Balances',
    enabled:  false,
  },

  // ── Central-bank Prime rates (design 56 Decision 6 / §3.1) ────────────────
  // Prime is THE systemic rate sweep: one axis per central bank moves every
  // Prime-linked cash account (and, in Phase 3, variable loan) coherently. The
  // per-account/global savings interest-rate opt levers are retired in favour of
  // these (primeSpread stays an idiosyncratic Opt residual, not a systemic sweep).
  {
    paramKey: 'usPrimeRate',
    label:    'US Prime Rate (Fed policy)',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.0, max: 0.10, step: 0.005,
    group:    'Rates',
    enabled:  false,
  },
  {
    paramKey: 'auPrimeRate',
    label:    'AU Prime Rate (RBA policy)',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.0, max: 0.10, step: 0.005,
    group:    'Rates',
    enabled:  false,
  },

  // ── Migration timing ──────────────────────────────────────────────────────
  {
    paramKey: 'moveYear',
    label:    'US→AU Move Year',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 2026, max: 2035, step: 1,
    group:    'People',
    enabled:  false,
  },

  // ── State move (design 34 §9 — establish residency in a destination state) ─
  {
    paramKey: 'stateMoveYear',
    label:    'State Move Year',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 2026, max: 2035, step: 1,
    group:    'US Tax',
    enabled:  false,
  },
  {
    // Categorical axis — the destination state. SD (no income tax) is a valid
    // choice, so the optimizer can land on "establish SD residency".
    paramKey: 'stateMoveDestination',
    label:    'State Move Destination',
    type:     OPT_PARAM_TYPES.ENUM,
    values:   ['NE', 'HI', 'SD'],
    group:    'US Tax',
    enabled:  false,
  },

  // ── Real Property sale timing ─────────────────────────────────────────────
  {
    paramKey: 'usHouseSaleYear',
    label:    'US House Sale Year',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 2027, max: 2045, step: 1,
    group:    'Real Properties',
    enabled:  false,
  },
  {
    paramKey: 'auHouseSaleYear',
    label:    'AU House Sale Year',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 2030, max: 2045, step: 1,
    group:    'Real Properties',
    enabled:  false,
  },

  // ── Drawdown order (decision lever) ───────────────────────────────────────
  {
    paramKey: 'drawdownStrategy',
    label:    'Drawdown Strategy',
    type:     OPT_PARAM_TYPES.ENUM,
    values:   Object.keys(DRAWDOWN_STRATEGIES),
    group:    'Spending',
    enabled:  false,
  },
  // Cross-border drawdown mode (design 58 Lever A). Sweep LOCAL_FIRST vs GLOBAL —
  // AUTO is omitted as a sweep value since it just resolves to one of the two via
  // the strategy; the optimizer should search the actual behaviors.
  {
    paramKey: 'crossBorderDrawdown',
    label:    'Cross-Border Drawdown',
    type:     OPT_PARAM_TYPES.ENUM,
    values:   ['LOCAL_FIRST', 'GLOBAL'],
    group:    'Spending',
    enabled:  false,
  },
  // Within-tier draw policy (design 58 Lever C). Categorical sweep over how a
  // shared drawdown tier is split; SEQUENTIAL is the byte-identical default.
  {
    paramKey: 'withinTierDraw',
    label:    'Within-Tier Draw',
    type:     OPT_PARAM_TYPES.ENUM,
    values:   ['SEQUENTIAL', 'EQUAL', 'PROPORTIONAL'],
    group:    'Spending',
    enabled:  false,
  },
  // Drawdown weights (design 58 Lever B — optimize-the-order mode). One CONTINUOUS
  // axis per investment role; the draw order is the ascending sort of the weights,
  // so the solver *searches* the order rather than picking a preset. These are
  // gated by the schema's visibleWhen (drawdownStrategy=WEIGHTED), so they drop out
  // of the sweep unless WEIGHTED is the selected strategy. The named strategies are
  // warm-starts (drawdownWeightsFromStrategy); each is one setting of these weights.
  ...buildDrawdownWeightSchema().map(s => ({
    paramKey: s.key,
    label:    s.label,
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min:      s.min, max: s.max, step: s.step,
    group:    'Spending',
    enabled:  false,
  })),

  // Inheritance — the inherited-RA drawdown knobs (design 63 §6.2) are now GENERATED
  // per inherited-RA asset (`raAsset.<stateKey>.fillCeiling` opt:true, design 63
  // §12.3), so they are opt-able via the generated schema rather than hand-listed
  // here as global keys.

  // ── Spending Strategies ────────────────────────────────────────────────────
  // Each ENUM value is an array — matches the EnumMulti param type.
  {
    paramKey: 'spendingStrategy',
    label:    'Spending Strategy',
    type:     OPT_PARAM_TYPES.ENUM,
    values:   [['FIXED'], ['REGIME_AWARE'], ['GUARDRAIL'], ['FIXED', 'REGIME_AWARE'], ['GUARDRAIL', 'REGIME_AWARE']],
    group:    'Spending Strategies',
    enabled:  false,
  },
  {
    paramKey: 'regimeAwareCutPct',
    label:    'Regime-Aware Spending Cut',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.05, max: 0.40, step: 0.05,
    group:    'Spending Strategies',
    enabled:  false,
  },
  {
    paramKey: 'guardrailCutThreshold',
    label:    'Guardrail Cut Threshold',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.10, max: 0.40, step: 0.05,
    group:    'Spending Strategies',
    enabled:  false,
  },
  {
    paramKey: 'guardrailRaiseThreshold',
    label:    'Guardrail Raise Threshold',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.10, max: 0.40, step: 0.05,
    group:    'Spending Strategies',
    enabled:  false,
  },
  {
    paramKey: 'guardrailCutPct',
    label:    'Guardrail Cut %',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.05, max: 0.25, step: 0.05,
    group:    'Spending Strategies',
    enabled:  false,
  },
  {
    paramKey: 'guardrailRaisePct',
    label:    'Guardrail Raise %',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.05, max: 0.25, step: 0.05,
    group:    'Spending Strategies',
    enabled:  false,
  },

  // ── Behavioral Strategies ─────────────────────────────────────────────────
  {
    paramKey: 'behavioralStrategies',
    label:    'Behavioral Strategies',
    type:     OPT_PARAM_TYPES.ENUM,
    values:   [
      [],
      ['PANIC_SELL'],
      ['TAX_LOSS_HARVEST'],
      ['CONTRIBUTION_SUSPENSION'],
      ['OPPORTUNISTIC_REBALANCE'],
      ['DOWNTURN_ROTH_CONVERSION'],
      ['TAX_GAIN_HARVEST'],
      ['PANIC_SELL', 'TAX_LOSS_HARVEST'],
      ['PANIC_SELL', 'TAX_LOSS_HARVEST', 'CONTRIBUTION_SUSPENSION'],
    ],
    group:    'Behavioral Strategies',
    enabled:  false,
  },
  {
    paramKey: 'panicFraction',
    label:    'Panic Sell Fraction',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.10, max: 0.60, step: 0.05,
    group:    'Behavioral Strategies',
    enabled:  false,
  },
  {
    paramKey: 'taxLossHarvestCap',
    label:    'TLH Cap ($/yr)',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 1_000, max: 10_000, step: 1_000,
    group:    'Behavioral Strategies',
    enabled:  false,
  },
  {
    paramKey: 'rebalanceDriftBand',
    label:    'Rebalance Drift Band',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.02, max: 0.15, step: 0.01,
    group:    'Behavioral Strategies',
    enabled:  false,
  },
  {
    paramKey: 'downturnConversionAmount',
    label:    'Downturn Roth Conversion ($)',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 5_000, max: 50_000, step: 5_000,
    group:    'Behavioral Strategies',
    enabled:  false,
  },
  {
    paramKey: 'taxGainHarvestBracketCeiling',
    label:    'Tax-Gain Harvest Ceiling ($)',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 0, max: 100_000, step: 10_000,
    group:    'Behavioral Strategies',
    enabled:  false,
  },
];

/**
 * Build one optimization severity variable per configured shock.
 * The search range is centred on the shock's configured severity.
 */
function buildShockOptConfigs(params) {
  const shocks = params.shocks ?? [];
  return shocks.flatMap((entry, i) => {
    if (!entry) return [];
    const label         = entry.preset ?? entry.shockId ?? `Shock ${i + 1}`;
    const libraryShock  = entry.preset ? (SHOCK_LIBRARY[entry.preset] ?? {}) : {};
    const severityBase  = entry.severity ?? libraryShock.severity ?? 0.4;
    return [
      {
        paramKey: `shocks[${i}].severity`,
        label:    `${label}: severity`,
        type:     OPT_PARAM_TYPES.CONTINUOUS,
        min:      Math.max(0.05, parseFloat((severityBase - 0.30).toFixed(2))),
        max:      Math.min(0.95, parseFloat((severityBase + 0.30).toFixed(2))),
        step:     0.05,
        group:    'Economic Shocks',
        enabled:  false,
      },
    ];
  });
}

/**
 * Build one optimization variable per EXPLICIT_BANDS expense band (design 38
 * §6.2), sibling of buildShockOptConfigs. Each emits a nested-path variable
 * `spendingExpenseBands[i].monthlyAmount` that _applyCandidate's set() routes
 * correctly — no engine change. The search range is centred on the band's
 * configured amount. Marked `controllable` (design 38 §6.0): a band's monthly
 * amount is forward-adjustable mid-run, so design 39's MPC can actuate it.
 */
function buildExpenseBandOptConfigs(params) {
  // Array.isArray guard (not `?? []`): a stale non-array value can't reach
  // .flatMap and abort the sim build — degrade to "no bands" instead.
  const bands = Array.isArray(params.spendingExpenseBands) ? params.spendingExpenseBands : [];
  return bands.flatMap((band, i) => {
    if (!band) return [];
    const base = band.monthlyAmount ?? 5000;
    return [
      {
        paramKey:     `spendingExpenseBands[${i}].monthlyAmount`,
        label:        `Band ${i + 1} (age ${band.startAge ?? '?'}+): monthly amount`,
        type:         OPT_PARAM_TYPES.INTEGER,
        min:          Math.max(0, Math.round((base * 0.5) / 500) * 500),
        max:          Math.round((base * 1.5) / 500) * 500,
        step:         500,
        group:        'Spending Bands',
        enabled:      false,
        controllable: true,
        visibleWhen:  { param: 'spendingStrategy', includes: 'EXPLICIT_BANDS' },
      },
    ];
  });
}

/**
 * Build one optimization variable per `rothConversionSchedule` entry (design 39
 * §12 / Step 9), sibling of buildExpenseBandOptConfigs. Each emits a continuous
 * `rothConversionSchedule[i].incomeTarget` variable (real base-year USD income
 * fill level) that the batch optimizer (design 38) can sweep alongside — or
 * instead of — the legacy single `rothConversionMaxBracket` ENUM. `min: 0`
 * encodes "no conversion that year" (OFF). Marked `controllable` so design 39's
 * MPC can actuate it; `enabled: false` so it only appears when the scenario
 * carries a per-year schedule.
 */
function buildRothScheduleOptConfigs(params) {
  // Guard with Array.isArray, not `?? []`: a stale non-array value (e.g. the
  // "[object Object],…" string a pre-RothScheduleList free-text editor could
  // write) would otherwise throw `flatMap is not a function` and abort the whole
  // sim build. A malformed schedule means "no schedule", not a crash. (The
  // toolset's schedules() and the cockpit controller already guard the same way.)
  const schedule = Array.isArray(params.rothConversionSchedule) ? params.rothConversionSchedule : [];
  return schedule.flatMap((entry, i) => {
    if (!entry) return [];
    return [
      {
        paramKey:     `rothConversionSchedule[${i}].incomeTarget`,
        label:        `Roth ${entry.year ?? '?'}: income fill target (real $)`,
        type:         OPT_PARAM_TYPES.CONTINUOUS,
        min:          0,
        max:          500_000,
        step:         5_000,
        group:        'Roth Conversion Schedule',
        enabled:      false,
        controllable: true,
      },
    ];
  });
}

/**
 * Build one optimization variable per inherited retirement account (design 63
 * §6.2 / §12.3), sibling of buildRothScheduleOptConfigs. The inherited-RA
 * distribution knobs are GENERATED per asset (`raAsset.<stateKey>.<field>`), so —
 * like the drawdown-weight axes — they aren't in DEFAULT_OPTIMIZATION_CONFIGS.
 * Discover each inherited RA from its always-present `distributionMode` param and
 * emit a CONTINUOUS `fillCeiling` (the primary bracketFill scalar) + an INTEGER
 * `lumpYear` axis. `enabled: false` so they surface only when the scenario carries
 * an inherited retirement account; the ceiling is REAL base-year USD.
 */
function buildInheritedRaOptConfigs(params) {
  const stateKeys = new Set();
  for (const k of Object.keys(params ?? {})) {
    const m = /^raAsset\.(.+)\.distributionMode$/.exec(k);
    if (m) stateKeys.add(m[1]);
  }
  return [...stateKeys].flatMap(sk => [
    {
      paramKey:     `raAsset.${sk}.fillCeiling`,
      label:        `Inherited RA (${sk}): bracketFill ceiling (real $)`,
      type:         OPT_PARAM_TYPES.CONTINUOUS,
      min: 40_000, max: 400_000, step: 20_000,
      group:        'Inheritance',
      enabled:      false,
      controllable: true,
    },
    {
      paramKey:     `raAsset.${sk}.lumpYear`,
      label:        `Inherited RA (${sk}): lump year`,
      type:         OPT_PARAM_TYPES.INTEGER,
      min: 0, max: 9, step: 1,
      group:        'Inheritance',
      enabled:      false,
      controllable: true,
    },
  ]);
}

/**
 * Build the full optimization variable list for a given param snapshot.
 *
 * Returns DEFAULT_OPTIMIZATION_CONFIGS plus one severity entry per configured
 * shock, one monthly-amount entry per configured expense band, and the inherited-RA
 * drawdown axes per inherited retirement account.  Dynamic entries only appear
 * when the scenario actually has them.
 */
export function buildOptVariables(params, accounts = null) {
  // User-authored drawdown strategies (intl-retirement-scenario customDrawdownStrategies)
  // become additional sweep values for the drawdownStrategy ENUM, alongside the
  // built-ins. Non-mutating: clone the one affected config entry.
  const customDrawdownNames = (params?.customDrawdownStrategies ?? [])
    .map(s => s?.name).filter(Boolean);
  let list = [
    ...DEFAULT_OPTIMIZATION_CONFIGS.map(cfg =>
      cfg.paramKey === 'drawdownStrategy' && customDrawdownNames.length > 0
        ? { ...cfg, values: [...Object.keys(DRAWDOWN_STRATEGIES), ...customDrawdownNames] }
        : cfg),
    ...buildShockOptConfigs(params),
    ...buildExpenseBandOptConfigs(params),
    ...buildRothScheduleOptConfigs(params),
    ...buildInheritedRaOptConfigs(params),
  ];
  // Build-time filter (design 58): when the caller supplies the scenario's accounts,
  // drop the Lever-B weight axes for roles no account backs. Those dimensions are
  // flat in the objective (nothing consumes their rank), so sweeping them only
  // wastes CEM budget and reports non-identifiable weights. A null `accounts`
  // (programmatic callers that can't reach them) keeps the full role set.
  if (accounts) {
    const present    = new Set((accounts ?? []).map(a => a?.role).filter(Boolean));
    const allowedKeys = new Set(presentDrawdownWeightRoles(present).map(drawdownWeightKey));
    const weightPrefix = `${DRAWDOWN_WEIGHT_PREFIX}${DRAWDOWN_WEIGHT_SEP}`;
    list = list.filter(cfg =>
      !String(cfg.paramKey ?? '').startsWith(weightPrefix) || allowedKeys.has(cfg.paramKey));
  }
  // Inherit identity (label / options / visibleWhen) from the param schema and
  // drop variables hidden by an unsatisfied visibleWhen (e.g. a strategy knob
  // whose strategy isn't selected). Identity is maintained once, in the schema.
  return resolveSweepVariables(list, schemaByKey(), params);
}
