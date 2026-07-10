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
import { EconomicShockHandler }           from '../../finance/economic-regimes/economic-shock-handler.js';
import { EconomicRecoveryTickHandler }    from '../../finance/economic-regimes/economic-recovery-tick-handler.js';
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
 * Build a rateKey → [stateKey, ...] map from the scenario's registered accounts,
 * real properties, and collectibles.
 *
 * Accounts: role → ROLE_TO_RATE_KEY → rateKey.
 * Real properties: resolvePropertyRateKey() (market-aware; design 28 §4 Step 8).
 * Collectibles: RATE_KEYS.COLLECTIBLE.
 */
function buildRateKeyToStateKeys(accounts, realProperties = [], collectibles = []) {
  const map = {};
  const addEntry = (rateKey, stateKey) => {
    if (!rateKey || !stateKey) return;
    if (!map[rateKey]) map[rateKey] = [];
    map[rateKey].push(stateKey);
  };

  for (const acct of accounts) {
    addEntry(ROLE_TO_RATE_KEY[acct.role], acct.stateKey);
  }
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
    handlers: [EconomicShockHandler, EconomicRecoveryTickHandler],
    reducers: [RegimeApplyReducer, PrimeRelinkReducer, AddRegimeReducer, RemoveRegimeReducer, RevalueAssetReducer, BondPriceAdjustReducer],
    actions: [
      { type: 'ADD_REGIME_APPLY',    fields: { regime: ValueType.any() } },
      { type: 'REMOVE_REGIME_APPLY', fields: { regimeId: ValueType.text() } },
      {
        type: 'REVALUE_ASSET_APPLY',
        fields: {
          rateKey:         ValueType.text(),
          multiplier:      ValueType.number(),
          targetStateKeys: ValueType.any(),
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
    return {
      activeRegimes:               [],
      primeLinks,
      baseGrowthRates,
      baseInterestRates,
      baseInflationRates,
      baseAppreciationRates:       {},
      effectiveGrowthRates:        { ...baseGrowthRates },
      effectiveInterestRates:      { ...baseInterestRates },
      effectiveInflationRates:     { ...baseInflationRates },
      effectiveAppreciationRates:  {},
      effectiveDividendAdjustments:{},
      priorMarkRates:              {},
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
      context.accounts,
      context.realProperties ?? [],
      context.collectibles   ?? [],
    );
    const behavioralHandlers = (context.parameters.behavioralStrategies ?? [])
      .flatMap(k => BEHAVIORAL_STRATEGY_REGISTRY[k]?.handlers(context) ?? []);
    return [
      new EconomicShockHandler({ rateKeyToStateKeys }),
      new EconomicRecoveryTickHandler(),
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
      new BondPriceAdjustReducer(),
      ...behavioralReducers,
    ];
  },
};
