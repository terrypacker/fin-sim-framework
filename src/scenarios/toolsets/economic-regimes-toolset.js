/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OneOffEvent }                    from '../../simulation-framework/events/one-off-event.js';
import { EventSeries }                   from '../../simulation-framework/events/event-series.js';
import { DateUtils }                      from '../../simulation-framework/date-utils.js';
import { ValueType }                      from '../../simulation-framework/type-registry.js';
import { RATE_KEYS, RATE_KEY_META, ROLE_TO_RATE_KEY, MEMBER_RATE_KEY_BY_ROLE, INTEREST_RATE_KEYS, CASH_PRIME_KEY_BY_RATE_KEY, SAVINGS_KEY_BY_COUNTRY } from '../../finance/economic-regimes/rate-keys.js';
import { RegimeApplyReducer }             from '../../finance/economic-regimes/regime-apply-reducer.js';
import { PrimeRelinkReducer }             from '../../finance/economic-regimes/prime-relink-reducer.js';
import { AddRegimeReducer }               from '../../finance/economic-regimes/add-regime-reducer.js';
import { RemoveRegimeReducer }            from '../../finance/economic-regimes/remove-regime-reducer.js';
import { RevalueAssetReducer }            from '../../finance/economic-regimes/revalue-asset-reducer.js';
import { BondPriceAdjustReducer }         from '../../finance/economic-regimes/bond-price-adjust-reducer.js';
import { BondMaturityReducer }            from '../../finance/economic-regimes/bond-maturity-reducer.js';
import { YieldCurveReducer }              from '../../finance/economic-regimes/yield-curve-reducer.js';
import { YieldCurveStepReducer }          from '../../finance/economic-regimes/yield-curve-step-reducer.js';
import { YieldCurveTickHandler }          from '../../finance/economic-regimes/yield-curve-tick-handler.js';
import { EquityReturnReducer }            from '../../finance/economic-regimes/equity-return-reducer.js';
import { EquityReturnStepReducer }        from '../../finance/economic-regimes/equity-return-step-reducer.js';
import { EquityReturnTickHandler }        from '../../finance/economic-regimes/equity-return-tick-handler.js';
import { PropertyReturnStepReducer }      from '../../finance/economic-regimes/property-return-step-reducer.js';
import { PropertyReturnTickHandler }      from '../../finance/economic-regimes/property-return-tick-handler.js';
import { shapeDelta }                     from '../../finance/economic-regimes/yield-curve.js';
import { EconomicShockHandler }           from '../../finance/economic-regimes/economic-shock-handler.js';
import { EconomicRecoveryTickHandler }    from '../../finance/economic-regimes/economic-recovery-tick-handler.js';
import { FX_PROCESS_MODEL_IDS }           from '../../finance/fx/fx-process-models.js';
import { SHOCK_LIBRARY, SHOCK_PRESET_OPTIONS } from '../../finance/economic-shocks/shock-library.js';
import { BEHAVIORAL_STRATEGY_REGISTRY }       from '../../finance/behavioral/behavioral-strategy-registry.js';

/**
 * Resolve the rate key for a RealProperty or Collectible (design 28 §4, Step 8).
 *
 * When a RealProperty has a `market` code, the rate key is `REAL_ESTATE_{market}`,
 * enabling regional shocks (e.g. `REAL_ESTATE_US-SF-BAY`). Falls back to the
 * country-level key (`REAL_ESTATE_US` / `REAL_ESTATE_AU`) when `market` is null.
 * Collectibles always use `RATE_KEYS.COLLECTIBLE`.
 */
export function resolvePropertyRateKey(asset) {
  if (asset.kind === 'collectible') return RATE_KEYS.COLLECTIBLE;
  const country = (asset.country ?? 'US').toUpperCase();
  if (asset.market) return `REAL_ESTATE_${asset.market}`;
  return RATE_KEYS[`REAL_ESTATE_${country}`] ?? `REAL_ESTATE_${country}`;
}

/**
 * Build the rateKey → [stateKey, ...] map for SCALAR assets — real properties and
 * collectibles. These carry a single `value` and no holdings, so a rate key is the
 * only signal available for deciding whether a shock touches them.
 *
 * Real properties: resolvePropertyRateKey() (market-aware; design 28 §4 Step 8).
 * Collectibles: RATE_KEYS.COLLECTIBLE.
 *
 * Accounts are deliberately ABSENT. They used to be mapped here by
 * `ROLE_TO_RATE_KEY[acct.role]`, which made a shock's level effect select whole
 * accounts: a −40 % EQUITY_US crash marked down every sleeve of every equity-role
 * account, including its cash and bonds. Accounts are now scanned holding-by-holding
 * (see `allAccountStateKeys` and RevalueAssetReducer), so the sleeve's own
 * allocation decides, and the account's role is irrelevant.
 */
function buildRateKeyToStateKeys(realProperties = [], collectibles = []) {
  const map = {};
  const addEntry = (rateKey, stateKey) => {
    if (!rateKey || !stateKey) return;
    if (!map[rateKey]) map[rateKey] = [];
    map[rateKey].push(stateKey);
  };

  for (const prop of realProperties) {
    addEntry(resolvePropertyRateKey(prop), prop.stateKey);
  }
  for (const col of collectibles) {
    addEntry(resolvePropertyRateKey(col), col.stateKey);
  }
  return map;
}

/**
 * Collect base growth rates from scenario parameters.
 */
function collectBaseGrowthRates(p) {
  return {
    // Per-account-type base growth (members of EQUITY_US / EQUITY_AU). Each
    // account keeps its own baseline; RegimeApplyReducer fans a class-level
    // return shock out to all members, so a US-equity crash still hits every
    // US-equity account on top of its own rate.
    [RATE_KEYS.EQUITY_US_ROTH]:      p.rothGrowthRate      ?? 0.07,
    [RATE_KEYS.EQUITY_US_IRA]:       p.iraGrowthRate       ?? 0.07,
    [RATE_KEYS.EQUITY_US_K401]:      p.k401GrowthRate      ?? 0.07,
    [RATE_KEYS.EQUITY_US_BROKERAGE]: p.brokerageGrowthRate ?? 0.05,
    [RATE_KEYS.EQUITY_AU_STOCK]:     p.auStockGrowthRate   ?? 0.06,
    [RATE_KEYS.EQUITY_AU_SUPER]:     p.superGrowthRate     ?? p.spouseSuperGrowthRate ?? 0.07,
    // Gold (design 56 §7) — a commodity return on its own key, decoupled from equity
    // and Prime. A GOLD holding (rateKey='GOLD') grows at this rate via
    // computeHoldingsGrowth; regime shocks may target GOLD directly (it is not a
    // member of any equity class, so an equity crash does not touch it).
    [RATE_KEYS.GOLD]:                p.goldGrowthRate      ?? 0.05,
  };
}

/**
 * Collect base interest rates from scenario parameters.
 */
function collectBaseInterestRates(p) {
  const rates = {};
  if (p.usSavingsInterestRate    != null) rates[RATE_KEYS.SAVINGS_US]      = p.usSavingsInterestRate;
  if (p.fixedIncomeInterestRate  != null) rates[RATE_KEYS.FIXED_INCOME_US] = p.fixedIncomeInterestRate;
  if (p.auSavingsInterestRate    != null) rates[RATE_KEYS.SAVINGS_AU]      = p.auSavingsInterestRate;
  if (p.auFixedIncomeInterestRate != null) rates[RATE_KEYS.FIXED_INCOME_AU] = p.auFixedIncomeInterestRate;
  // Central-bank Prime rates (design 56 §3). Seeded here so the per-account
  // `Prime + primeSpread` derivation (seedPerAccountRates) and, in Phase 2,
  // RegimeApplyReducer can move them like any other interest series.
  if (p.usPrimeRate              != null) rates[RATE_KEYS.PRIME_US]        = p.usPrimeRate;
  if (p.auPrimeRate              != null) rates[RATE_KEYS.PRIME_AU]        = p.auPrimeRate;
  return rates;
}

/**
 * Collect the per-country yield-curve SHAPE overlays (design 67 §3, representation C).
 * Each is an array of `{ tenor, spread }` anchor points added on top of the
 * `FIXED_INCOME_{country}` level. An absent/empty shape ⇒ a flat curve (every spread
 * 0 ⇒ every tenor returns the level anchor), byte-identical to the pre-67 single rate.
 */
function collectYieldCurves(p) {
  return {
    US: Array.isArray(p.usYieldCurveShape) ? p.usYieldCurveShape : DEFAULT_YIELD_CURVE_SHAPE,
    AU: Array.isArray(p.auYieldCurveShape) ? p.auYieldCurveShape : DEFAULT_YIELD_CURVE_SHAPE,
  };
}

/**
 * Default upward-sloping curve shape (design 67 §5). Anchored at the 5y level point
 * (spread 0): shorter bonds yield less, longer bonds earn a term premium. Applied to
 * both countries unless a scenario overrides `usYieldCurveShape` / `auYieldCurveShape`.
 */
const DEFAULT_YIELD_CURVE_SHAPE = Object.freeze([
  { tenor: 1,  spread: -0.010 },
  { tenor: 5,  spread:  0.000 },
  { tenor: 10, spread:  0.006 },
  { tenor: 30, spread:  0.012 },
]);

/**
 * Seed per-account rate keys `<memberKey>::<stateKey>` (design 55 §8) into the
 * already-built base growth/interest maps. Each account's own `growthRate` /
 * `interestRate` (set via its generated per-account param) overrides the shared
 * type-level baseline; an unset rate inherits the baseline, so single-rate
 * scenarios stay byte-for-byte identical. `computeHoldingsGrowth` reads the
 * `<memberKey>::<stateKey>` key and RegimeApplyReducer fans class shocks onto it,
 * so per-account rates coexist with regimes.
 *
 * Prime-relative cash (design 56 §5): when a cash account's member key is
 * Prime-linkable (`CASH_PRIME_KEY_BY_RATE_KEY`) and it carries a `primeSpread`, the
 * per-account rate is `Prime(country) + primeSpread` instead of its absolute
 * `interestRate` — so a Prime move fans out to every linked cash account. The Prime
 * series must already be seeded into `baseInterestRates` (collectBaseInterestRates
 * runs first). An absent spread (or missing Prime) falls back to the legacy absolute
 * path, keeping pre-56 scenarios byte-for-byte identical.
 *
 * Returns the Prime **links** — `{ stateKey, savKey, primeKey, spread }` for every cash
 * key seeded as `Prime + spread` — so PrimeRelinkReducer can re-derive each account's
 * effective rate when Prime moves at runtime (design 56 §5, Phase 2b). Cash accounts
 * (step 1) and cash sleeves on non-cash accounts (step 2) both produce a link.
 *
 * Mutates `baseGrowthRates` / `baseInterestRates` in place.
 */
function seedPerAccountRates(accounts, baseGrowthRates, baseInterestRates) {
  const primeLinks = [];
  for (const acct of accounts ?? []) {
    const stateKey  = acct?.stateKey;
    if (!stateKey) continue;
    const memberKey = MEMBER_RATE_KEY_BY_ROLE[acct?.role];

    // 1. Primary sleeve rate from the account's role member key (equity growth, or
    //    savings/fixed-income interest). Cash accounts take their `Prime + primeSpread`
    //    here (their member key is a cash key); everything else uses its absolute rate.
    if (memberKey) {
      const isInterest = INTEREST_RATE_KEYS.has(memberKey);
      const baseMap    = isInterest ? baseInterestRates : baseGrowthRates;
      const primeKey = CASH_PRIME_KEY_BY_RATE_KEY[memberKey];
      const prime    = primeKey != null ? baseInterestRates[primeKey] : undefined;
      let perVal;
      if (primeKey != null && acct.primeSpread != null && prime != null) {
        perVal = prime + acct.primeSpread;
        primeLinks.push({ stateKey, savKey: memberKey, primeKey, spread: acct.primeSpread });
      } else {
        const ownRate = isInterest ? acct.interestRate : acct.growthRate;
        perVal = ownRate ?? baseMap[memberKey];
      }
      if (perVal != null) baseMap[`${memberKey}::${stateKey}`] = perVal;
    }

    // 2. Cash-sleeve rate for a NON-cash account carrying a `primeSpread` (design 56 §6):
    //    a `CASH` holding resolves to `SAVINGS_{country}` and reads the per-account key,
    //    so seed `SAVINGS_{country}::<stateKey> = Prime + primeSpread`. Cash accounts
    //    already covered this in step 1 (their member key IS the cash key).
    // A loan's `primeSpread` is a *loan* rate resolved by LoanPaymentHandler
    // (design 56 Phase 3), NOT a cash-sleeve earnings rate — skip it here so it never
    // seeds a bogus `SAVINGS_*::<loanKey>`. Offsets carry no primeSpread (Decision 7).
    const isCashAccount = CASH_PRIME_KEY_BY_RATE_KEY[memberKey] != null;
    const isLiability   = acct.type === 'loan' || acct.type === 'offset';
    if (acct.primeSpread != null && !isCashAccount && !isLiability) {
      const savKey   = SAVINGS_KEY_BY_COUNTRY[acct.country];
      const primeKey = savKey ? CASH_PRIME_KEY_BY_RATE_KEY[savKey] : null;
      const prime    = primeKey != null ? baseInterestRates[primeKey] : undefined;
      if (savKey && prime != null) {
        baseInterestRates[`${savKey}::${stateKey}`] = prime + acct.primeSpread;
        primeLinks.push({ stateKey, savKey, primeKey, spread: acct.primeSpread });
      }
    }
  }
  return primeLinks;
}

/**
 * Apply a severity value to a resolved FinancialShock, re-deriving the
 * equityRevaluation multiplier so severity is the single canonical knob.
 */
function applySeverity(shock, severity) {
  const lv = shock.levelEffects?.equityRevaluation;
  return {
    ...shock,
    severity,
    ...(lv && {
      levelEffects: {
        ...shock.levelEffects,
        equityRevaluation: { ...lv, multiplier: -Math.abs(severity) },
      },
    }),
  };
}

/**
 * Resolve a single shock array entry into a full FinancialShock object.
 *
 * Two forms are accepted:
 *   { preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01' }
 *     → looks up the template from SHOCK_LIBRARY and merges in startDate
 *   { shockId: '...', startDate: ..., levelEffects: ..., ... }
 *     → used as-is (custom / legacy full-object form)
 *
 * When item.severity is set (e.g. written by an MC sweep via set()), it is
 * applied to the resolved shock and the equityRevaluation multiplier is
 * re-derived.  This makes severity the single canonical knob for any shock index.
 *
 * Returns null if the entry is empty or cannot be resolved.
 */
function resolveShockEntry(item) {
  if (!item) return null;

  // Library-reference form: { preset, startDate[, severity] }
  if (item.preset && item.preset !== 'none') {
    const template = SHOCK_LIBRARY[item.preset];
    if (!template) return null;
    const startDate = item.startDate instanceof Date
      ? item.startDate
      : (item.startDate ? new Date(item.startDate) : null);
    if (!startDate || Number.isNaN(startDate.getTime())) return null;
    let resolved = { ...template, startDate };
    if (item.severity != null) resolved = applySeverity(resolved, item.severity);
    return resolved;
  }

  // Full custom-object form: must have shockId; apply severity if present
  if (item.shockId) {
    if (item.severity != null) return applySeverity(item, item.severity);
    return item;
  }

  return null;
}

/**
 * Schedule ECONOMIC_SHOCK + ECONOMIC_RECOVERY_TICK events for one resolved shock.
 */
function scheduleShock(shock, events) {
  const startDate = shock.startDate instanceof Date ? shock.startDate : new Date(shock.startDate);
  const durationMonths = shock.recovery?.durationMonths ?? 12;

  events.push(new OneOffEvent({
    name:    shock.name ?? `Economic Shock (${shock.shockId})`,
    type:    'ECONOMIC_SHOCK',
    date:    startDate,
    data:    { shock },
    enabled: true,
    color:   '#B71C1C',
  }));

  for (let m = 1; m <= durationMonths; m++) {
    events.push(new OneOffEvent({
      name:    `Recovery Tick ${m}/${durationMonths} (${shock.shockId})`,
      type:    'ECONOMIC_RECOVERY_TICK',
      date:    DateUtils.addMonths(startDate, m),
      data:    { shockId: shock.shockId },
      enabled: true,
      color:   '#E57373',
    }));
  }
}

/**
 * Compile an optional Prime **schedule** (design 56 §3/§5, Phase 2b item 3) into scheduled
 * regime adjustments on `PRIME_US`/`PRIME_AU`. The schedule is an array of
 * `[{ year, PRIME_US, PRIME_AU }]` **absolute** policy rates, each taking effect at the
 * start of its `year` and holding until the next entry (a step / boxcar path).
 *
 * Each entry becomes a permanent (L-profile) regime spanning `[year_i, year_{i+1})` whose
 * `interestRateAdjustment` is the entry's absolute rate **minus the Prime seed**
 * (`usPrimeRate`/`auPrimeRate`). Because the windows don't overlap, exactly one is active
 * at a time, so `effective[PRIME] = seed + (absolute − seed) = absolute` during its window
 * — and PrimeRelinkReducer then fans that move onto every linked cash account. An entry
 * names only the countries it moves; the last entry runs through sim end. Reuses the shock
 * scheduling path (EconomicShockHandler → ADD_REGIME_APPLY), so no new event type.
 */
function schedulePrimeRateSteps(schedule, p, startDate, endDate, events) {
  if (!Array.isArray(schedule) || schedule.length === 0) return;
  const seed = { PRIME_US: p.usPrimeRate ?? 0.045, PRIME_AU: p.auPrimeRate ?? 0.0435 };
  const entries = schedule
    .filter(e => e && Number.isFinite(e.year))
    .sort((a, b) => a.year - b.year);
  const endBoundYear = endDate.getUTCFullYear() + 1;   // cover through the final period

  for (let i = 0; i < entries.length; i++) {
    const entry    = entries[i];
    const nextYear = (i + 1 < entries.length) ? entries[i + 1].year : endBoundYear;
    const durationMonths = (nextYear - entry.year) * 12;
    if (durationMonths <= 0) continue;                 // duplicate / out-of-order year

    const interestRateAdjustment = {};
    for (const key of ['PRIME_US', 'PRIME_AU']) {
      if (entry[key] != null) interestRateAdjustment[key] = entry[key] - seed[key];
    }
    if (Object.keys(interestRateAdjustment).length === 0) continue;

    scheduleShock({
      shockId:   `PRIME_SCHED_${entry.year}`,
      name:      `Prime Schedule ${entry.year}`,
      startDate: new Date(Date.UTC(entry.year, 0, 1)),
      regime:    { interestRateAdjustment },
      recovery:  { profile: 'L', durationMonths },
    }, events);
  }
}

/**
 * Compile an optional yield-curve **schedule** (design 67 §6, Phase 3) into scheduled
 * curve-shape twists. The schedule is an array of `[{ year, US:[{tenor,spread}], AU:[…] }]`
 * **absolute** target shapes, each taking effect at the start of its `year` and holding
 * until the next entry (a step / boxcar path, mirroring `schedulePrimeRateSteps`).
 *
 * Each entry becomes a permanent (L-profile) regime spanning `[year_i, year_{i+1})` whose
 * `yieldCurveTwist[cc]` is the **delta** `absShape − baseShape` (`shapeDelta`). Because the
 * windows don't overlap, exactly one is active at a time and composes at factor 1, so
 * `yieldCurve[cc] = base + (abs − base) = abs` during its window — the scheduled shape.
 * An entry names only the countries it moves; the last entry runs through sim end.
 */
function scheduleYieldCurveSteps(schedule, p, endDate, events) {
  if (!Array.isArray(schedule) || schedule.length === 0) return;
  const base = collectYieldCurves(p);
  const entries = schedule
    .filter(e => e && Number.isFinite(e.year))
    .sort((a, b) => a.year - b.year);
  const endBoundYear = endDate.getUTCFullYear() + 1;

  for (let i = 0; i < entries.length; i++) {
    const entry    = entries[i];
    const nextYear = (i + 1 < entries.length) ? entries[i + 1].year : endBoundYear;
    const durationMonths = (nextYear - entry.year) * 12;
    if (durationMonths <= 0) continue;                 // duplicate / out-of-order year

    const yieldCurveTwist = {};
    for (const cc of ['US', 'AU']) {
      if (Array.isArray(entry[cc])) yieldCurveTwist[cc] = shapeDelta(entry[cc], base[cc]);
    }
    if (Object.keys(yieldCurveTwist).length === 0) continue;

    scheduleShock({
      shockId:   `YCURVE_SCHED_${entry.year}`,
      name:      `Yield Curve Schedule ${entry.year}`,
      startDate: new Date(Date.UTC(entry.year, 0, 1)),
      regime:    { yieldCurveTwist },
      recovery:  { profile: 'L', durationMonths },
    }, events);
  }
}

/**
 * ECONOMIC_REGIMES toolset — adds a shock-and-regime layer on top of the
 * existing pipeline.
 *
 * The `shocks` parameter accepts an array of shock entries. Each entry can be:
 *   - A library reference: `{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01' }`
 *   - A full FinancialShock object with `shockId`, `startDate`, etc.
 *
 * The param schema includes `options: SHOCK_PRESET_OPTIONS` so the UI can
 * render a ShockList editor with a preset dropdown per row.
 *
 * Capabilities: economic-regimes
 * Dependencies: (none; regime layer sits beneath everything)
 */
export const ECONOMIC_REGIMES = {
  id: 'ECONOMIC_REGIMES',
  capabilities: ['economic-regimes'],
  dependencies: [],

  types: {
    handlers: [EconomicShockHandler, EconomicRecoveryTickHandler, YieldCurveTickHandler, EquityReturnTickHandler, PropertyReturnTickHandler],
    reducers: [RegimeApplyReducer, PrimeRelinkReducer, AddRegimeReducer, RemoveRegimeReducer, RevalueAssetReducer, YieldCurveReducer, YieldCurveStepReducer, EquityReturnReducer, EquityReturnStepReducer, PropertyReturnStepReducer, BondPriceAdjustReducer, BondMaturityReducer],
    actions: [
      { type: 'ADD_REGIME_APPLY',    fields: { regime: ValueType.any() } },
      { type: 'REMOVE_REGIME_APPLY', fields: { regimeId: ValueType.text() } },
      { type: 'YIELD_CURVE_STEP_APPLY', fields: { country: ValueType.text(), deviation: ValueType.number() } },
      { type: 'EQUITY_RETURN_STEP_APPLY', fields: { marketDev: ValueType.number(), deviation: ValueType.any(), driftComp: ValueType.any() } },
      { type: 'PROPERTY_RETURN_STEP_APPLY', fields: { marketDev: ValueType.number(), deviation: ValueType.any(), driftComp: ValueType.any() } },
      {
        type: 'REVALUE_ASSET_APPLY',
        fields: {
          rateKey:           ValueType.text(),
          multiplier:        ValueType.number(),
          targetStateKeys:   ValueType.any(),
          holdingsStateKeys: ValueType.any(),
        },
      },
      { type: 'RECOMPUTE_REGIMES', fields: {} },
      // ── Behavioral strategy action types (design/29) ──────────────────────
      {
        type: 'STOCK_HARVEST_APPLY',
        fields: {
          stateKey:            ValueType.text(),
          sellAmount:          ValueType.number(),
          sourceHoldingId:     ValueType.text(),
          substituteHoldingId: ValueType.text(),
          purpose:             ValueType.text(),
          residency:           ValueType.text(),
        },
      },
      {
        type: 'BEHAVIORAL_PANIC_SELL_APPLY',
        fields: {
          stateKey:        ValueType.text(),
          sourceHoldingId: ValueType.text(),
          sellAmount:      ValueType.number(),
        },
      },
      {
        type: 'OPPORTUNISTIC_REBALANCE_APPLY',
        fields: {
          stateKey: ValueType.text(),
          legs:     ValueType.any(),
        },
      },
      {
        // Design 61 Lever C — taxable-aware target-allocation rebalance.
        type: 'REBALANCE_TO_TARGET_APPLY',
        fields: {
          stateKey: ValueType.text(),
          role:     ValueType.text(),
          taxable:  ValueType.any(),
          country:  ValueType.text(),
          legs:     ValueType.any(),
        },
      },
      {
        type: 'ASSET_LOCATION_REBALANCE_APPLY',
        fields: {
          fromStateKey:  ValueType.text(),
          fromHoldingId: ValueType.text(),
          toStateKey:    ValueType.text(),
          toHoldingId:   ValueType.text(),
          swapAmount:    ValueType.number(),
        },
      },
    ],
  },

  paramSchema(_context) {
    const behavioralStrategyKeys = Object.keys(BEHAVIORAL_STRATEGY_REGISTRY);
    return [
      {
        key:          'shocks',
        label:        'Economic Shocks',
        type:         'ShockList',
        group:        'Economic Shocks',
        mc:           true,
        opt:          true,
        options:      SHOCK_PRESET_OPTIONS,
        defaultValue: [],
        description:  'List of financial shocks to apply. Each entry can reference a library preset or define a custom shock.',
      },
      {
        key:          'primeSchedule',
        label:        'Prime Rate Schedule',
        type:         'PrimeScheduleList',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: [],
        description:  'Optional per-year central-bank policy path: each row sets the absolute PRIME_US / PRIME_AU rate taking effect that year and holding until the next row. A step compiles into a scheduled Prime move that fans out to every Prime-linked cash account and variable loan (design 56 §5).',
      },
      {
        key:          'usYieldCurveShape',
        label:        'US Yield Curve Shape',
        type:         'Object',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: null,
        description:  'Optional US term-structure overlay (design 67): an array of { tenor, spread } anchor points added to the FIXED_INCOME_US level, linearly interpolated and clamped to the endpoints. The 5-year point is the level anchor (spread 0). Absent/empty ⇒ a flat curve (every tenor = the level), identical to a single fixed-income rate.',
      },
      {
        key:          'auYieldCurveShape',
        label:        'AU Yield Curve Shape',
        type:         'Object',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: null,
        description:  'Optional AU term-structure overlay (design 67): an array of { tenor, spread } anchor points added to the FIXED_INCOME_AU level, linearly interpolated and clamped to the endpoints. Independent of the US shape. Absent/empty ⇒ a flat curve.',
      },
      {
        key:          'yieldCurveSchedule',
        label:        'Yield Curve Schedule',
        type:         'Object',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: null,
        description:  'Optional per-year yield-curve path (design 67 §6): an array of { year, US:[{tenor,spread}], AU:[…] } ABSOLUTE target shapes, each taking effect that year and holding until the next row (a step path). Each compiles to a scheduled curve twist that composes with the level move. Empty ⇒ the static default shape.',
      },
      {
        key:          'yieldCurveStochastic',
        label:        'Stochastic Yield Curve',
        type:         'Boolean',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: false,
        description:  'When on (design 67 §6), the fixed-income LEVEL evolves as a seeded mean-reverting (Ornstein-Uhlenbeck) walk each year via the in-loop sim.rng, giving bonds realistic year-to-year rate risk. Off by default ⇒ no randomness drawn, runs stay byte-identical. Reproducible: the rng cursor is snapshot-safe.',
      },
      {
        key:          'yieldCurveVol',
        label:        'Yield Curve Volatility',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0.01,
        description:  'Annualized standard deviation (in rate units, e.g. 0.01 = 100 bps) of the stochastic level walk. Only used when Stochastic Yield Curve is on.',
      },
      {
        key:          'yieldCurveReversionSpeed',
        label:        'Yield Curve Mean-Reversion Speed',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0.3,
        description:  'Ornstein-Uhlenbeck pull-back speed per year toward the anchor level. Higher ⇒ the level snaps back faster. Only used when Stochastic Yield Curve is on.',
      },
      {
        key:          'equityReturnStochastic',
        label:        'Stochastic Equity Returns',
        type:         'Boolean',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: false,
        description:  'When on (design 74), each year draws its own equity return from a seeded process instead of holding one constant rate for the whole run — so Monte Carlo measures sequence-of-returns risk, not just uncertainty about the long-run average. One shared market factor drives every equity sleeve (via per-sleeve beta), so systematic risk survives portfolio aggregation. Off by default ⇒ no randomness drawn, runs stay byte-identical. Reproducible: the rng cursor is snapshot-safe. NOTE (Phase 1): the anchor is treated as an ARITHMETIC mean, so turning this on lowers the realized geometric return by ≈σ²/2 (volatility drag). Geometric drift compensation is design 74 Phase 3.',
      },
      {
        key:          'equityReturnVol',
        label:        'Equity Return Volatility',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           true,
        opt:          false,
        defaultValue: 0.18,
        description:  'Annualized standard deviation (in rate units, e.g. 0.18 = 18%) of the shared equity MARKET factor. Each sleeve scales this by its beta (US large-cap 1.0; AU stock 0.9; super 0.7 by default). Only used when Stochastic Equity Returns is on.',
      },
      {
        key:          'equityReturnModel',
        label:        'Equity Return Process Model',
        type:         'Enum',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        options:      FX_PROCESS_MODEL_IDS,
        defaultValue: 'WHITE_NOISE',
        description:  'Process for the market factor. WHITE_NOISE (default) draws an independent shock each year — equity returns are close to IID. MEAN_REVERTING (Ornstein-Uhlenbeck) imposes some year-to-year predictability for a valuation-based view; not the default because the evidence does not support it. Only used when Stochastic Equity Returns is on.',
      },
      {
        key:          'equityReturnBeta',
        label:        'Equity Return Betas',
        type:         'Object',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: null,
        description:  'Optional per-sleeve override of each equity sleeve\'s loading on the market factor, keyed by rate key (EQUITY_US_ROTH, EQUITY_AU_SUPER, …). Absent keys fall back to the defaults (US 1.0 / AU stock 0.9 / super 0.7). Only used when Stochastic Equity Returns is on.',
      },
      {
        key:          'equityReturnIdioVol',
        label:        'Equity Return Idiosyncratic Volatility',
        type:         'Object',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: null,
        description:  'Optional per-sleeve idiosyncratic (sleeve-specific) return sd, keyed by rate key. Adds independent noise on top of the shared market factor so sleeves are not perfectly correlated. Absent ⇒ 0 (pure single-factor). Only used when Stochastic Equity Returns is on.',
      },
      {
        key:          'equityReturnDriftComp',
        label:        'Equity Return Drift Compensation',
        type:         'Enum',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        options:      ['GEOMETRIC', 'NONE'],
        defaultValue: 'GEOMETRIC',
        description:  'How the growth-rate anchor is interpreted once returns are stochastic (design 74 §5.3). Adding a mean-0 shock to a multiplicatively-applied rate lowers the realized geometric (compounded) return by ≈σ²/2. GEOMETRIC (default) adds σ²/2 back per sleeve so the anchor reads as the CAGR you expect to earn and turning volatility on changes only the SPREAD, not the centre. NONE interprets the anchor as an ARITHMETIC mean and leaves the ≈σ²/2 volatility drag in (at σ=0.18 that is ≈−1.6pp/yr). Also governs the stochastic PROPERTY return path (design 75). Only used when Stochastic Equity Returns or Stochastic Property Returns is on.',
      },
      {
        key:          'propertyReturnStochastic',
        label:        'Stochastic Property Returns',
        type:         'Boolean',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: false,
        description:  'When on (design 75), each real property draws its own appreciation each year from a seeded process instead of ramping at a constant appreciationRate — so a house has real sale-price variance at its sale date (the sequence/timing risk on the binding asset). When Stochastic Equity Returns is ALSO on, property REUSES the same market factor so housing co-moves with equities (design 74 §7); when equity is off, property draws its own market shock. Default betas are near zero (US 0.03 / AU 0.05) because the historical house↔equity correlation is ~0.04 — the joint crash is authored via shocks[], not the beta — so housing is ~99% idiosyncratic. Off by default ⇒ no randomness drawn, runs stay byte-identical. Reproducible: the rng cursor is snapshot-safe.',
      },
      {
        key:          'propertyReturnBeta',
        label:        'Property Return Betas',
        type:         'Object',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: null,
        description:  'Optional per-sleeve override of each real-estate sleeve\'s loading on the shared market factor, keyed by rate key (REAL_ESTATE_US, REAL_ESTATE_AU). Absent keys fall back to the near-zero defaults (US 0.03 / AU 0.05). Raise a beta to model a standing correlation with equities; the default assumes almost none (design 75 §4.1). Only used when Stochastic Property Returns is on.',
      },
      {
        key:          'propertyReturnIdioVol',
        label:        'Property Return Idiosyncratic Volatility',
        type:         'Object',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: null,
        description:  'Optional per-sleeve idiosyncratic (property-specific) appreciation sd, keyed by rate key. This is where most of a single home\'s price variance comes from under the near-zero betas. Absent ⇒ the defaults (US 0.09 / AU 0.10, giving a total single-home σ ≈ 9–10%). Only used when Stochastic Property Returns is on.',
      },
      {
        // Design 75 §6.4 B. A scalar multiplier on EVERY property sleeve's idiosyncratic vol,
        // exposed so Monte Carlo can sweep the WIDTH of house-price variance. Housing is ~99%
        // idiosyncratic under the near-zero betas, so equityReturnVol (which only reaches the
        // house through β≈0.03) barely moves it — this is the honest housing-vol MC axis. A
        // scalar in cfg.parameters (unlike the per-property idioVol object) is MC-sweepable.
        key:          'propertyReturnIdioScale',
        label:        'Property Idiosyncratic Vol Scale',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           true,
        opt:          false,
        defaultValue: 1.0,
        description:  'Monte Carlo multiplier on every property sleeve\'s idiosyncratic appreciation vol (design 75 §6.4). 1.0 = the calibrated defaults (US 0.09 / AU 0.10); sweeping it widens/narrows single-home price variance — the sequence/timing risk on the house at its sale date. Only bites when Stochastic Property Returns is on; inert (1.0) otherwise.',
      },
      {
        // Design 75 §6.4 B. Global multiplier on the repair-event median size. Per-property
        // repairMedian/repairValuePct live in cfg.realProperties and can't be swept directly,
        // so this cfg.parameters scalar is the MC seam for repair severity.
        key:          'repairSeverityScale',
        label:        'House Repair Severity Scale',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           true,
        opt:          false,
        defaultValue: 1.0,
        description:  'Monte Carlo multiplier on the median size of every stochastic house-repair event (design 75 §5.2/§6.4). 1.0 = each property\'s configured repairMedian/repairValuePct; sweeping it stress-tests how the lumpy repair cost bites liquidity. Only bites when a property has a repair model; inert (1.0) otherwise.',
      },
      {
        // Design 75 §6.4 B. Global multiplier on the repair-event probability/rate.
        key:          'repairFreqScale',
        label:        'House Repair Frequency Scale',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           true,
        opt:          false,
        defaultValue: 1.0,
        description:  'Monte Carlo multiplier on the annual probability (Bernoulli) or rate (Poisson) of a stochastic house repair (design 75 §5.2/§6.4). 1.0 = each property\'s configured repairProb/repairLambda; sweeping it varies how OFTEN the lump lands. Only bites when a property has a repair model; inert (1.0) otherwise.',
      },
      {
        key:          'behavioralStrategies',
        label:        'Behavioral Strategies',
        type:         'EnumMulti',
        group:        'Behavioral',
        mc:           false,
        opt:          true,
        options:      behavioralStrategyKeys,
        defaultValue: [],
        description:  'Active behavioral strategies: portfolio reactions to regimes and tax opportunities (design/29). PANIC_SELL rotates equity to cash on crash entry; TAX_LOSS_HARVEST realizes losses at year-end; CONTRIBUTION_SUSPENSION halts contributions under stress; and more.',
      },
      ...behavioralStrategyKeys.flatMap(k => BEHAVIORAL_STRATEGY_REGISTRY[k].paramSchema()),
    ];
  },

  state(context) {
    const p = context.parameters;
    const baseGrowthRates    = collectBaseGrowthRates(p);
    const baseInterestRates  = collectBaseInterestRates(p);
    // Per-account rate overrides (design 55 §8) — extend the base maps with
    // `<memberKey>::<stateKey>` entries derived from each account's own rate. The
    // returned Prime links let PrimeRelinkReducer re-derive linked cash keys when
    // Prime moves at runtime (design 56 §5, Phase 2b).
    const primeLinks = seedPerAccountRates(context.accounts, baseGrowthRates, baseInterestRates);
    const baseInflationRates = {
      US: p.usInflationRate ?? p.inflationRate ?? 0.03,
      AU: p.auInflationRate ?? p.inflationRate ?? 0.03,
    };
    // Yield-curve shape overlay (design 67). `baseYieldCurve` is the base→effective
    // seed (symmetric with baseInterestRates), ready for the Phase-3 twist reducer;
    // in Phases 1–2 the shape is static so effective == base.
    const yieldCurve = collectYieldCurves(p);
    return {
      activeRegimes:               [],
      primeLinks,
      baseGrowthRates,
      baseInterestRates,
      baseInflationRates,
      baseAppreciationRates:       {},
      baseYieldCurve:              { US: [...yieldCurve.US], AU: [...yieldCurve.AU] },
      effectiveGrowthRates:        { ...baseGrowthRates },
      effectiveInterestRates:      { ...baseInterestRates },
      effectiveInflationRates:     { ...baseInflationRates },
      effectiveAppreciationRates:  {},
      effectiveDividendAdjustments:{},
      yieldCurve,
      // Stochastic level deviation per country (design 67 §6, Phase 3). Mean-0 OU walk
      // seeded at 0; stays 0 (and thus a no-op) unless `yieldCurveStochastic` is on.
      yieldCurveLevelDev:          { US: 0, AU: 0 },
      // Stochastic equity return path (design 74 §5.1/§5.3). Per-sleeve mean-0 deviation,
      // the deterministic σ²/2 drift compensation, and the shared market factor — all
      // seeded empty/0 so EquityReturnReducer no-ops and runs stay byte-identical unless
      // `equityReturnStochastic` is on.
      equityReturnDev:             {},
      equityReturnDriftComp:       {},
      equityReturnMarketDev:       0,
      // Stochastic property return path (design 75 §4). Per-sleeve mean-0 deviation, the
      // deterministic σ²/2 drift compensation, and the market factor — seeded empty/0 so
      // AssetAppreciationHandler adds a zero deviation and runs stay byte-identical unless
      // `propertyReturnStochastic` is on.
      propertyReturnDev:           {},
      propertyReturnDriftComp:     {},
      propertyReturnMarketDev:     0,
      priorMarkRates:              {},
      priorMarkCurve:              {},
    };
  },

  schedules(context) {
    const events    = [];
    const p         = context.parameters;
    const shocks    = p.shocks ?? [];
    const strats    = p.behavioralStrategies ?? [];

    for (const entry of shocks) {
      const shock = resolveShockEntry(entry);
      if (!shock) continue;
      scheduleShock(shock, events);
    }

    // Optional Prime rate path (design 56 §5, Phase 2b) → scheduled PRIME_* moves.
    schedulePrimeRateSteps(p.primeSchedule, p, context.startDate, context.endDate, events);

    // Optional yield-curve path (design 67 §6) → scheduled curve twists.
    scheduleYieldCurveSteps(p.yieldCurveSchedule, p, context.endDate, events);

    // Optional stochastic curve evolution (design 67 §6) — an annual tick series that
    // drives the seeded-RNG level walk. Scheduled only when on, so default runs draw
    // no randomness and stay byte-identical.
    if (p.yieldCurveStochastic) {
      events.push(new EventSeries({
        name:     'Yield Curve Tick',
        type:     'YIELD_CURVE_TICK',
        interval: 'year-end',
        startOffset: 1,
        enabled:  true,
        color:    '#7E57C2',
      }));
    }

    // Optional stochastic equity return path (design 74 §5.1) — an annual tick series
    // that drives the seeded-RNG market-factor draw. Scheduled only when on, so default
    // runs draw no randomness and stay byte-identical.
    if (p.equityReturnStochastic) {
      events.push(new EventSeries({
        name:     'Equity Return Tick',
        type:     'EQUITY_RETURN_TICK',
        interval: 'year-end',
        startOffset: 1,
        enabled:  true,
        color:    '#EF5350',
      }));
    }

    // Optional stochastic property return path (design 75 §4). Annual tick, `order: 1` so it
    // fires AFTER the equity tick (default order 0) on the same year-end — each event fully
    // reduces before the next runs, so when sharing the market factor the equity tick has
    // already stored state.equityReturnMarketDev for this year. Scheduled only when on, so
    // default runs draw no randomness and stay byte-identical.
    if (p.propertyReturnStochastic) {
      events.push(new EventSeries({
        name:     'Property Return Tick',
        type:     'PROPERTY_RETURN_TICK',
        interval: 'year-end',
        startOffset: 1,
        order:    1,
        enabled:  true,
        color:    '#8D6E63',
      }));
    }

    if (strats.includes('TAX_LOSS_HARVEST')) {
      events.push(new EventSeries({
        name:     'Tax-Loss Harvest',
        type:     'TAX_LOSS_HARVEST',
        interval: 'year-end',
        startOffset: 1,
        enabled:  true,
        color:    '#26A69A',
      }));
    }

    if (strats.includes('TAX_GAIN_HARVEST')) {
      events.push(new EventSeries({
        name:     'Tax-Gain Harvest',
        type:     'TAX_GAIN_HARVEST',
        interval: 'year-end',
        startOffset: 1,
        enabled:  true,
        color:    '#66BB6A',
      }));
    }

    return events;
  },

  handlers(context) {
    const rateKeyToStateKeys = buildRateKeyToStateKeys(
      context.realProperties ?? [],
      context.collectibles   ?? [],
    );
    // Every account is in scope for every level effect; the reducer filters by each
    // holding's own allocation. Passing them all is what makes the account's role
    // irrelevant — including for sleeves the rebalancer creates mid-run, which a
    // role-derived map built at construction time could never have anticipated.
    const allAccountStateKeys = (context.accounts ?? []).map(a => a.stateKey).filter(Boolean);
    const behavioralHandlers = (context.parameters.behavioralStrategies ?? [])
      .flatMap(k => BEHAVIORAL_STRATEGY_REGISTRY[k]?.handlers(context) ?? []);
    const p = context.parameters;
    return [
      new EconomicShockHandler({ rateKeyToStateKeys, allAccountStateKeys }),
      new EconomicRecoveryTickHandler(),
      // Stochastic curve evolution (design 67 §6) — only when on, so the sim.rng is
      // untouched otherwise and runs stay byte-identical.
      ...(p.yieldCurveStochastic
        ? [new YieldCurveTickHandler({ vol: p.yieldCurveVol ?? 0.01, reversionSpeed: p.yieldCurveReversionSpeed ?? 0.3 })]
        : []),
      // Stochastic equity return path (design 74 §5.1) — only when on, so the sim.rng is
      // untouched otherwise and runs stay byte-identical.
      ...(p.equityReturnStochastic
        ? [new EquityReturnTickHandler({
            vol:            p.equityReturnVol   ?? 0.18,
            model:          p.equityReturnModel ?? 'WHITE_NOISE',
            beta:           p.equityReturnBeta      ?? {},
            idioVol:        p.equityReturnIdioVol   ?? {},
            driftComp:      p.equityReturnDriftComp ?? 'GEOMETRIC',
          })]
        : []),
      // Stochastic property return path (design 75 §4) — only when on. `marketVol` matches
      // equityReturnVol so the property betas mean the same thing whether or not the equity
      // path is active; `shareMarketFactor` reuses the equity market shock when equity is on.
      ...(p.propertyReturnStochastic
        ? [new PropertyReturnTickHandler({
            marketVol:         p.equityReturnVol   ?? 0.18,
            model:             p.equityReturnModel ?? 'WHITE_NOISE',
            beta:              p.propertyReturnBeta    ?? {},
            idioVol:           p.propertyReturnIdioVol ?? {},
            idioScale:         p.propertyReturnIdioScale ?? 1,
            driftComp:         p.equityReturnDriftComp ?? 'GEOMETRIC',
            shareMarketFactor: !!p.equityReturnStochastic,
          })]
        : []),
      ...behavioralHandlers,
    ];
  },

  reducers(context) {
    const behavioralReducers = (context.parameters.behavioralStrategies ?? [])
      .flatMap(k => BEHAVIORAL_STRATEGY_REGISTRY[k]?.reducers(context) ?? []);
    return [
      new RegimeApplyReducer(),
      new PrimeRelinkReducer(),
      new AddRegimeReducer(),
      new RemoveRegimeReducer(),
      new RevalueAssetReducer(),
      new YieldCurveReducer(),      // design 67 §6 — composes twists + folds stochastic level (11.5, before the mark)
      new YieldCurveStepReducer(),  // design 67 §6 — stores the stochastic level deviation
      new EquityReturnReducer(),    // design 74 §5.1 — folds the stochastic equity path onto effective growth (11.5)
      new EquityReturnStepReducer(),// design 74 §5.1 — stores the per-sleeve equity deviation
      new PropertyReturnStepReducer(),// design 75 §4 — stores the per-sleeve property deviation (AssetAppreciationHandler reads it; no fold reducer)
      new BondPriceAdjustReducer(),
      new BondMaturityReducer(),
      ...behavioralReducers,
    ];
  },
};
