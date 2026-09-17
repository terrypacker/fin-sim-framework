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
import { MarketIndexReducer }            from '../../finance/economic-regimes/market-index.js';
import { DateUtils }                      from '../../simulation-framework/date-utils.js';
import { ValueType }                      from '../../simulation-framework/type-registry.js';
import { RATE_KEYS, RATE_KEY_META, ROLE_TO_RATE_KEY, MEMBER_RATE_KEY_BY_ROLE, INTEREST_RATE_KEYS, CASH_PRIME_KEY_BY_RATE_KEY, SAVINGS_KEY_BY_COUNTRY, EQUITY_SLEEVES, PROPERTY_SLEEVES, DEFAULT_EQUITY_BETA, DEFAULT_EQUITY_IDIO, DEFAULT_RE_BETA, DEFAULT_RE_IDIO } from '../../finance/economic-regimes/rate-keys.js';
import { ACCOUNT_ROLES } from '../../finance/state/account-roles.js';
import { MARKET_GROWTH_PARAMS, marketReturnFor } from '../../finance/economic-regimes/market-returns.js';
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
import { EquityReturnTickHandler, EQUITY_RETURN_MODEL_IDS, EQUITY_RETURN_MODEL_LABELS } from '../../finance/economic-regimes/equity-return-tick-handler.js';
import { InflationTickHandler, INFLATION_MODEL_IDS, INFLATION_MODEL_LABELS, jointInflationActive } from '../../finance/economic-regimes/inflation-tick-handler.js';
import { InflationStepReducer }           from '../../finance/economic-regimes/inflation-step-reducer.js';
import { InflationPathReducer }           from '../../finance/economic-regimes/inflation-path-reducer.js';
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
 * The four per-MARKET equity growth params (design 90 §7.2; declared by design 98 W1 —
 * before that `collectBaseGrowthRates` read them but no schema declared them, so the
 * market axis ran at four constants nobody could set).
 *
 * One table feeds both `paramSchema()` and `collectBaseGrowthRates`, so the editable
 * default and the value the sim falls back to cannot drift apart. The ORDER is
 * load-bearing: it is the key order of `baseGrowthRates`, and whole-state fixtures
 * compare that JSON exactly.
 */
//
// Design 99 §2: each market authors its TOTAL return and the dividend YIELD inside it.
// They are the ONLY equity rates — accounts carry none and derive their growth from
// their holdings. Price growth is `total − yield` where a dividend handler pays the yield
// out (taxable accounts); a wrapper grows by the total and reports the yield as a slice
// of it. The keys keep their W1 names (`*GrowthRate`) so saved values carry over.
//
// The table itself lives in `finance/economic-regimes/market-returns.js` (design 99 P3)
// so the account editor can read it without importing this toolset; re-exported here for
// every existing importer.
export { MARKET_GROWTH_PARAMS, marketReturnFor };

/** Per-market dividend yields, `rateKey → yield` (design 99 §2). Read by `baseDividendYield`. */
function collectMarketDividendYields(p) {
  return Object.fromEntries(MARKET_GROWTH_PARAMS.map(m => [m.rateKey, p[m.yieldKey] ?? m.yieldDefault]));
}

/**
 * Collect base growth rates from scenario parameters.
 */
function collectBaseGrowthRates(p) {
  // Design 98 M2 — ONE systematic draw on the equity return, added to every market's
  // total. Here, upstream of regimes and the design 74 path, so it reaches every holding
  // on a market key and nothing else (gold, bonds and cash are their own keys).
  const anchor = p.equityAnchorShift ?? 0;
  return {
    // Per-MARKET total return (design 90 §7.2; design 99 §2). The ONLY equity rate: a
    // holding earns the market it tracks, in any account — no per-account or per-wrapper
    // override is seeded since design 99 P2. A regime shock on a market key therefore
    // reaches every holding on it directly.
    ...Object.fromEntries(MARKET_GROWTH_PARAMS.map(m => [m.rateKey, (p[m.key] ?? m.defaultValue) + anchor])),
    // Gold (design 56 §7) — a commodity return on its own key, decoupled from equity
    // and Prime. A GOLD holding (rateKey='GOLD') grows at this rate via
    // computeHoldingsGrowth; regime shocks may target GOLD directly (it is not a
    // member of any equity class, so an equity crash does not touch it).
    [RATE_KEYS.GOLD]:                p.goldGrowthRate      ?? 0.05,
  };
}

/*
 * The per-ROLE wrapper growth rates (`rothGrowthRate` … `superGrowthRate`) and the
 * `collectRoleGrowthRates` / `ROLE_GROWTH_PARAMS` that seeded them are RETIRED by design
 * 99 P2. Design 90 §7.5 kept them only until the §7.3 market sub-axis could express an
 * account's mix; it can, so an account now earns what its holdings' markets earn. A
 * saved value is dropped by `retireRateParams`, with a warning when it differs from what
 * the market now gives.
 */

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
function seedPerAccountRates(accounts, baseInterestRates) {
  const primeLinks = [];
  for (const acct of accounts ?? []) {
    const stateKey  = acct?.stateKey;
    if (!stateKey) continue;
    const memberKey = MEMBER_RATE_KEY_BY_ROLE[acct?.role];

    // 1. Primary sleeve rate from the account's role member key (equity growth, or
    //    savings/fixed-income interest). Cash accounts take their `Prime + primeSpread`
    //    here (their member key is a cash key); everything else uses its absolute rate.
    //
    //    CASH accounts only since design 99 P3b. An equity account seeds nothing (P2): its
    //    holdings resolve to their bare market keys. A fixed-income account seeds nothing
    //    either: its bonds earn their own coupons, else the country's FIXED_INCOME_* level.
    //    A bank account's rate is a contract with one institution (D-5), so it alone
    //    keeps an account-level rate — Prime + spread, or a legacy absolute.
    if (memberKey && CASH_PRIME_KEY_BY_RATE_KEY[memberKey] != null) {
      const baseMap    = baseInterestRates;
      const primeKey = CASH_PRIME_KEY_BY_RATE_KEY[memberKey];
      const prime    = primeKey != null ? baseInterestRates[primeKey] : undefined;
      let perVal;
      if (primeKey != null && acct.primeSpread != null && prime != null) {
        perVal = prime + acct.primeSpread;
        primeLinks.push({ stateKey, savKey: memberKey, primeKey, spread: acct.primeSpread });
      } else {
        perVal = acct.interestRate ?? baseMap[memberKey];
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
  const headline = Math.abs(shock.severity ?? 0);
  const target   = Math.abs(severity);
  if (!headline) return { ...shock, severity };

  // `severity` is the episode's TROUGH DEPTH, and since design 21 §21 the trough is
  // composed from a level break PLUS a forward-return drag rather than being the level
  // break alone. So severity can no longer just overwrite the multiplier: it scales the
  // whole shock — every level entry and every leg's returnAdjustment — by the ratio to
  // the preset's own headline depth. Scaling only the level would sweep a preset toward
  // its old instant-break shape at one end of an MC range and away from it at the other,
  // which is a change of SHAPE disguised as a change of magnitude.
  const k = target / headline;

  const scaleLevel = (lv) => {
    if (!lv) return lv;
    const one = (e) => ({ ...e, multiplier: -Math.abs((e?.multiplier ?? 0) * k) });
    return Array.isArray(lv) ? lv.map(one) : one(lv);
  };
  const scaleReturns = (regime) => {
    if (!regime?.returnAdjustment) return regime;
    const scaled = {};
    for (const [rk, v] of Object.entries(regime.returnAdjustment)) scaled[rk] = v * k;
    return { ...regime, returnAdjustment: scaled };
  };

  const out = { ...shock, severity };
  if (shock.levelEffects?.equityRevaluation) {
    out.levelEffects = { ...shock.levelEffects,
      equityRevaluation: scaleLevel(shock.levelEffects.equityRevaluation) };
  }
  if (Array.isArray(shock.legs)) {
    out.legs = shock.legs.map(leg => ({ ...leg, regime: scaleReturns(leg.regime) }));
  } else if (shock.regime) {
    out.regime = scaleReturns(shock.regime);
  }
  return out;
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
  // Ticks have to span the LONGEST leg (design 21 §18.6). A multi-leg shock whose ticks stopped
  // at the equity leg's horizon would leave the slower leg's recovery factor un-recomputed
  // between period boundaries — it would still decay, but in yearly steps, which is exactly
  // the resolution the tick series exists to provide.
  const legDurations = (Array.isArray(shock.legs) && shock.legs.length)
    ? shock.legs.map(l => l.recovery?.durationMonths ?? 12)
    : [shock.recovery?.durationMonths ?? 12];
  const durationMonths = Math.max(...legDurations);

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
    handlers: [EconomicShockHandler, EconomicRecoveryTickHandler, YieldCurveTickHandler, EquityReturnTickHandler, PropertyReturnTickHandler, InflationTickHandler],
    reducers: [RegimeApplyReducer, PrimeRelinkReducer, AddRegimeReducer, RemoveRegimeReducer, RevalueAssetReducer, YieldCurveReducer, YieldCurveStepReducer, EquityReturnReducer, EquityReturnStepReducer, PropertyReturnStepReducer, InflationStepReducer, InflationPathReducer, BondPriceAdjustReducer, BondMaturityReducer],
    actions: [
      { type: 'ADD_REGIME_APPLY',    fields: { regime: ValueType.any() } },
      { type: 'REMOVE_REGIME_APPLY', fields: { regimeId: ValueType.text() } },
      { type: 'YIELD_CURVE_STEP_APPLY', fields: { country: ValueType.text(), deviation: ValueType.number() } },
      // `bootstrap` is the HISTORICAL_BOOTSTRAP block cursor (design 102 §4.3); other models omit it.
      { type: 'EQUITY_RETURN_STEP_APPLY', fields: { marketDev: ValueType.number(), deviation: ValueType.any(), driftComp: ValueType.any(), bootstrap: ValueType.any() } },
      { type: 'PROPERTY_RETURN_STEP_APPLY', fields: { marketDev: ValueType.number(), deviation: ValueType.any(), driftComp: ValueType.any() } },
      // Design 103 §4.2. `historicalYear` only in joint mode; `passThrough` only when set.
      // Design 104 adds `primeDeviation` / `primeFloor`, only in "follows inflation" prime mode.
      // Design 103 §10 adds `latent`, the standardized global and per-country factors.
      { type: 'INFLATION_STEP_APPLY', fields: { deviation: ValueType.any(), latent: ValueType.any(), floor: ValueType.number(), historicalYear: ValueType.number(), passThrough: ValueType.any(), primeDeviation: ValueType.any(), primeFloor: ValueType.any() } },
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
          // design 94 §8.1h — a substitute the account does not hold yet. Declared because
          // `pickPayload` keeps only declared fields, so an undeclared one never reaches the
          // reducer that has to open the lot.
          substituteSecurityId: ValueType.text(),
          purpose:             ValueType.text(),
          residency:           ValueType.text(),
        },
      },
      // Journal-only: the losing lots the harvester skipped for want of a substitute
      // (design 101 §7.1, replacing `metrics.tlh_skipped_no_substitute`). Declared so
      // `pickPayload` keeps the fields; reduced by a no-op.
      {
        type: 'TLH_NO_SUBSTITUTE',
        fields: {
          count:      ValueType.number(),
          holdingIds: ValueType.any(),
          stateKeys:  ValueType.any(),
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
        // Design 107 §5 — the paycheck trigger. It carries no amount: the destination pool's
        // own `target` plus `amount.toTarget` resolve the demand from the LIVE spend line, so
        // an amount here would be a second answer to a question the pool already answers.
        // `date` is declared because a quarterly paycheck fires three times inside one tax
        // period, and without it the reducer would date all three to the period's start.
        type: 'SPENDING_REFILL',
        fields: { date: ValueType.any() },
      },
      {
        // Design 97 §12.4 — executor 2, the cross-account pool flow. Declared because
        // `pickPayload` keeps only declared fields, and in strict mode an UNDECLARED type
        // throws: the design-97 panel reads this action out of the journal as the record of
        // a refill that actually fired, against `gatedFlows` for the ones that did not.
        type: 'POOL_FLOW_APPLY',
        fields: {
          flowId:     ValueType.text(),
          from:       ValueType.text(),
          to:         ValueType.text(),
          amountBase: ValueType.number(),
          year:       ValueType.number(),
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
        mc:           false,
        opt:          false,
        options:      SHOCK_PRESET_OPTIONS,
        defaultValue: [],
        description:  'List of financial shocks to apply. Each entry can reference a library preset or define a custom shock.',
      },
      {
        // Design 104: EITHER the schedule OR the inflation link, never both. The default is
        // the schedule mode so a saved plan with a schedule keeps it; with no rows, it's
        // the flat prime setting, as before.
        key:          'primeRateModel',
        label:        'Prime Rate Mode',
        type:         'Enum',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        options:      ['SCHEDULE', 'INFLATION_LINKED'],
        optionLabels: {
          SCHEDULE:         'Fixed, or stepped by the Prime Rate Schedule (default)',
          INFLATION_LINKED: 'Follows inflation — the Prime Rate Schedule is ignored',
        },
        defaultValue: 'SCHEDULE',
        description:  'How the US and AU prime (central-bank policy) rates move during the run. Choose ONE. "Fixed, or stepped by the Prime Rate Schedule": the rates stay at US / AU Prime Rate, except where a Prime Rate Schedule row sets them for a year. "Follows inflation": each year the rates move toward the inflation path the way central banks have since 1955 (design 104), and the schedule is ignored. That mode needs Stochastic Inflation on; Monte Carlo turns inflation on by default. Either way, prime-linked cash accounts and variable-rate loans follow prime plus their spread.',
      },
      {
        key:          'primeSchedule',
        label:        'Prime Rate Schedule',
        type:         'PrimeScheduleList',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: [],
        visibleWhen:  { param: 'primeRateModel', equals: 'SCHEDULE' },
        description:  'Used only when Prime Rate Mode is "Fixed, or stepped by the Prime Rate Schedule" (not with "Follows inflation"). Optional per-year central-bank policy path: each row sets the absolute PRIME_US / PRIME_AU rate taking effect that year and holding until the next row. A step compiles into a scheduled Prime move that fans out to every Prime-linked cash account and variable loan (design 56 §5).',
      },
      {
        key:          'primeInflationResponseUs',
        label:        'Prime Follows Inflation — US Response (β)',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 1.3,
        visibleWhen:  { param: 'primeRateModel', equals: 'INFLATION_LINKED' },
        description:  'How far the US policy rate eventually moves per point of inflation above or below its anchor: 1.3 means a sustained +1 point of inflation ends up raising prime 1.3 points. Measured at 1.27–1.31 on US rates 1955–2025 (1.98 since 1983). Above 1 is the "Taylor principle": real rates rise when inflation does. Only used when Prime Rate Mode is "Follows inflation".',
      },
      {
        key:          'primeInflationResponseAu',
        label:        'Prime Follows Inflation — AU Response (β)',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 1.3,
        visibleWhen:  { param: 'primeRateModel', equals: 'INFLATION_LINKED' },
        description:  'How far the AU cash rate eventually moves per point of AU inflation above or below its anchor. Defaults to the US post-war value; the RBA measured 1.76 over 1991–2024, a short and calm sample. Only used when Prime Rate Mode is "Follows inflation".',
      },
      {
        key:          'primeInflationSmoothingUs',
        label:        'Prime Follows Inflation — US Smoothing (ρ)',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0.6,
        visibleWhen:  { param: 'primeRateModel', equals: 'INFLATION_LINKED' },
        description:  'How gradually the US rate moves: the share of last year\'s gap it keeps. 0.6 closes 40% of the gap to its target each year; 0 moves all the way at once; closer to 1 is slower. Measured at 0.61–0.63 on US rates 1955–2025. Only used when Prime Rate Mode is "Follows inflation".',
      },
      {
        key:          'primeInflationSmoothingAu',
        label:        'Prime Follows Inflation — AU Smoothing (ρ)',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0.75,
        visibleWhen:  { param: 'primeRateModel', equals: 'INFLATION_LINKED' },
        description:  'How gradually the AU cash rate moves: the share of last year\'s gap it keeps. 0.75 is the RBA\'s measured value for 1991–2024 (25% of the gap a year). Only used when Prime Rate Mode is "Follows inflation".',
      },
      {
        key:          'primeFloorUs',
        label:        'Prime Follows Inflation — US Floor',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0.0025,
        visibleWhen:  { param: 'primeRateModel', equals: 'INFLATION_LINKED' },
        description:  'The lowest the US policy rate can go when following inflation (0.0025 = 0.25%, where the Fed held it in 2009–15 and 2020–21). Only used when Prime Rate Mode is "Follows inflation".',
      },
      {
        key:          'primeFloorAu',
        label:        'Prime Follows Inflation — AU Floor',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0.001,
        visibleWhen:  { param: 'primeRateModel', equals: 'INFLATION_LINKED' },
        description:  'The lowest the AU cash rate can go when following inflation (0.001 = 0.10%, the RBA\'s 2020–22 low). Only used when Prime Rate Mode is "Follows inflation".',
      },
      {
        key:          'primePolicyNoiseUs',
        label:        'Prime Follows Inflation — US Policy Noise',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0,
        visibleWhen:  { param: 'primeRateModel', equals: 'INFLATION_LINKED' },
        description:  'Optional yearly random policy moves that inflation doesn\'t explain, as a standard deviation (0.013 = 1.3 points, the size history shows around the inflation rule). 0 (default) = off: the rate answers inflation only. Only used when Prime Rate Mode is "Follows inflation".',
      },
      {
        key:          'primePolicyNoiseAu',
        label:        'Prime Follows Inflation — AU Policy Noise',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0,
        visibleWhen:  { param: 'primeRateModel', equals: 'INFLATION_LINKED' },
        description:  'Optional yearly random AU policy moves that inflation doesn\'t explain, as a standard deviation (history: about 0.9 points since 1991). 0 (default) = off. Only used when Prime Rate Mode is "Follows inflation".',
      },
      {
        key:          'mcPrimeRateModel',
        label:        'Monte Carlo: Prime Rate Mode',
        type:         'Enum',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        options:      ['AUTO', 'SCENARIO', 'SCHEDULE', 'INFLATION_LINKED'],
        optionLabels: {
          AUTO:             'Automatic — follows inflation unless the plan uses a Prime Rate Schedule (default)',
          SCENARIO:         'Same as single runs (Prime Rate Mode)',
          SCHEDULE:         'Fixed, or stepped by the Prime Rate Schedule',
          INFLATION_LINKED: 'Follows inflation — the Prime Rate Schedule is ignored',
        },
        defaultValue: 'AUTO',
        description:  'The prime rate mode every Monte Carlo path runs. Automatic (default): a plan that set Prime Rate Mode to "Follows inflation", or has no Prime Rate Schedule, follows each path\'s inflation. A plan with a schedule keeps it, since the two modes are either/or. Following inflation needs Monte Carlo: Stochastic Inflation Path on.',
      },
      {
        key:          'usYieldCurveShape',
        label:        'US Yield Curve Shape',
        type:         'YieldCurveShape',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: null,
        description:  'Optional US term-structure overlay (design 67): an array of { tenor, spread } anchor points added to the FIXED_INCOME_US level, linearly interpolated and clamped to the endpoints. The 5-year point is the level anchor (spread 0). Absent/empty ⇒ a flat curve (every tenor = the level), identical to a single fixed-income rate.',
      },
      {
        key:          'auYieldCurveShape',
        label:        'AU Yield Curve Shape',
        type:         'YieldCurveShape',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: null,
        description:  'Optional AU term-structure overlay (design 67): an array of { tenor, spread } anchor points added to the FIXED_INCOME_AU level, linearly interpolated and clamped to the endpoints. Independent of the US shape. Absent/empty ⇒ a flat curve.',
      },
      {
        key:          'yieldCurveSchedule',
        label:        'Yield Curve Schedule',
        type:         'YieldCurveSchedule',
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
        description:  'When on (design 74), each year draws its own equity return from a seeded process instead of holding one constant rate for the whole run — so Monte Carlo measures sequence-of-returns risk, not just uncertainty about the long-run average. One shared market factor drives every equity sleeve (via per-sleeve beta), so systematic risk survives portfolio aggregation. Off by default ⇒ no randomness drawn, runs stay byte-identical. Reproducible: the rng cursor is snapshot-safe. NOTE (Phase 1): the anchor is treated as an ARITHMETIC mean, so turning this on lowers the realized geometric return by ≈σ²/2 (volatility drag). Geometric drift compensation is design 74 Phase 3. Monte Carlo turns this on for every iteration regardless (see "Monte Carlo: Stochastic Return Path"); this switch governs single runs.',
      },
      {
        // Design 98 M3. A separate switch, not a reading of `equityReturnStochastic: false`:
        // the loader materializes every schema default into the typed params list, so a plan
        // that never touched the path and one that switched it off look the same to MC.
        key:          'mcSequenceRisk',
        label:        'Monte Carlo: Stochastic Return Path',
        type:         'Boolean',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: true,
        description:  'When on (default), every Monte Carlo iteration runs the stochastic equity return path — its own year-by-year returns, with the markets able to diverge — on top of the sampled long-run mean (Equity Return Shift). Single runs are unaffected. Turn off to make Monte Carlo sample the long-run mean only.',
      },
      {
        // Design 102 §7 Q3: Monte Carlo gets its OWN process choice rather than reading
        // `equityReturnModel`. The same reason `mcSequenceRisk` exists: the loader
        // materializes the schema default into every saved plan, so a plan that never chose
        // WHITE_NOISE and one that did look the same, and changing that default would not
        // reach plans already saved.
        key:          'mcEquityReturnModel',
        label:        'Monte Carlo: Equity Return Process',
        type:         'Enum',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        options:      ['SCENARIO', ...EQUITY_RETURN_MODEL_IDS],
        // WHITE_NOISE is the single-run default, not this one's, so its "(default)" is dropped here.
        optionLabels: { SCENARIO: 'Same as single runs (Equity Return Process Model)', ...EQUITY_RETURN_MODEL_LABELS,
                        WHITE_NOISE: 'White noise — independent years',
                        HISTORICAL_BOOTSTRAP: `${EQUITY_RETURN_MODEL_LABELS.HISTORICAL_BOOTSTRAP} (default)` },
        defaultValue: 'HISTORICAL_BOOTSTRAP',
        visibleWhen:  { param: 'mcSequenceRisk', truthy: true },
        description:  'The equity return process every Monte Carlo path runs. The default, Historical bootstrap, replays blocks of real historical years (US 1871–2023, and AU\'s own history from 1958) re-centred on your anchor, and matches history better than white noise on autocorrelation, multi-year pull-back and crash skew (design 102 §2). "Same as single runs" uses Equity Return Process Model instead. Only used when Monte Carlo: Stochastic Return Path is on.',
      },
      // ── Stochastic inflation path (design 103) ──────────────────────────────────
      {
        key:          'inflationStochastic',
        label:        'Stochastic Inflation',
        type:         'Boolean',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: false,
        description:  'When on (design 103), each country\'s inflation wanders around its anchor (Inflation Rate / AU Inflation Rate) year by year, with post-war persistence: a high-inflation year tends to be followed by another. Everything priced in today\'s money follows it: expenses, wages, Social Security, tax brackets, TIPS and house running costs. Off by default, so runs stay byte-identical. Monte Carlo turns it on for every path (Monte Carlo: Stochastic Inflation Path); this switch governs single runs.',
      },
      {
        key:          'inflationModel',
        label:        'Inflation Process Model',
        type:         'Enum',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        options:      INFLATION_MODEL_IDS,
        optionLabels: INFLATION_MODEL_LABELS,
        defaultValue: 'GAUSSIAN',
        visibleWhen:  { param: 'inflationStochastic', truthy: true },
        description:  'Gaussian (default): a mean-reverting walk calibrated to post-war inflation, with US and AU correlated. Historical, joint with equity: each year\'s inflation surprise is the one from the SAME post-war historical year (1951–2023) the equity bootstrap is replaying, so a 1970s stretch brings its high inflation and its poor real returns together. Nominal equity returns also carry the inflation surprise, and bond yields follow that year\'s 10-year yield change when Stochastic Yield Curve is on. Joint mode needs the equity path on with Historical bootstrap; otherwise it runs as Gaussian.',
      },
      {
        key:          'inflationPathVolUs',
        label:        'Inflation Path Volatility — US',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0.028,
        visibleWhen:  { param: 'inflationStochastic', truthy: true },
        description:  'How far US inflation wanders from its anchor: the long-run standard deviation of the yearly rate (0.028 = 2.8 points, measured on US CPI 1951–2023, design 103 §2). The swings are skewed, bigger upward than downward, and shrink when the anchor sits close to Inflation Lower Bound (design 103 §10.1).',
      },
      {
        key:          'inflationPathVolAu',
        label:        'Inflation Path Volatility — AU',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0.03,
        visibleWhen:  { param: 'inflationStochastic', truthy: true },
        description:  'How far AU inflation wanders from its anchor. AU\'s post-war measurement (4.4 points) is dominated by the 1970s–80s wage spiral and the 1951 wool boom, so 3.0 is the default (design 103 §4.1). The swings are skewed, bigger upward than downward, and shrink when the anchor sits close to Inflation Lower Bound (design 103 §10.1).',
      },
      {
        key:          'inflationReversionSpeedUs',
        label:        'Inflation Reversion Speed — US (k)',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0.33,
        visibleWhen:  { param: 'inflationStochastic', truthy: true },
        description:  'How quickly a US inflation surprise fades, per year. This year\'s deviation keeps e^(−k) of last year\'s: 0.33 keeps 0.72, a half-life of about 2 years, matching US CPI 1951–2023. Lower is more persistent. Unlike the equity persistence knob, this runs on a LEVEL, so it genuinely mean-reverts.',
      },
      {
        key:          'inflationReversionSpeedAu',
        label:        'Inflation Reversion Speed — AU (k)',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0.33,
        visibleWhen:  { param: 'inflationStochastic', truthy: true },
        description:  'How quickly an AU inflation surprise fades, per year. Defaults to the US value; AU\'s own post-war measurement is 0.46 (half-life about 1.5 years).',
      },
      {
        key:          'inflationPathCorrelation',
        label:        'Inflation Path US–AU Correlation',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0.35,
        visibleWhen:  [{ param: 'inflationStochastic', truthy: true }, { param: 'inflationModel', equals: 'GAUSSIAN' }],
        description:  'Correlation between each year\'s US and AU inflation surprises (0.35 = the measured correlation of their year-on-year changes, 1951–2024). Gaussian only; joint mode uses the historical years\' own correlation.',
      },
      {
        key:          'inflationPathFloor',
        label:        'Inflation Path Floor',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: -0.05,
        visibleWhen:  { param: 'inflationStochastic', truthy: true },
        description:  'A hard lower clamp on the yearly inflation rate, applied after everything else, including shocks and regimes (−0.05 = 5% deflation). The path itself approaches Inflation Lower Bound instead and practically never reaches this.',
      },
      {
        key:          'inflationLowerBoundUs',
        label:        'Inflation Lower Bound — US',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: -0.01,
        visibleWhen:  { param: 'inflationStochastic', truthy: true },
        description:  'The rate US inflation approaches in its lowest years but never crosses (design 103 §10.1). Inflation is modelled as this bound plus a skewed distance above it, so it can spike up but only drifts gently down, and its swings grow when it runs high, as it has since 1951 (2.7% of US years below 0, none below −0.7%). −0.01 puts about 1% of years below zero.',
      },
      {
        key:          'inflationLowerBoundAu',
        label:        'Inflation Lower Bound — AU',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: -0.01,
        visibleWhen:  { param: 'inflationStochastic', truthy: true },
        description:  'The rate AU inflation approaches in its lowest years but never crosses (1.4% of AU years since 1951 were below 0, none below −0.3%). −0.01 puts about 1% of years below zero.',
      },
      {
        key:          'inflationGlobalShare',
        label:        'Inflation Path Global Share',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0.4,
        visibleWhen:  { param: 'inflationStochastic', truthy: true },
        description:  'How much of each country\'s inflation swings comes from a slow global cycle shared by the US and AU, from 0 (none) to 1 (all). History has both high together in the 1970s and low together since the 1990s: their inflation LEVELS correlated at 0.59 over 1951–2023, even though their yearly surprises correlated at only 0.26–0.35. 0.4 reproduces that (design 103 §10.2). 0 lets the two countries drift apart for years.',
      },
      {
        key:          'inflationGlobalReversionSpeed',
        label:        'Inflation Path Global Reversion Speed (k)',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0.1,
        visibleWhen:  [{ param: 'inflationStochastic', truthy: true }, { param: 'inflationGlobalShare', gt: 0 }],
        description:  'How quickly the shared global inflation cycle fades, per year: 0.1 keeps 0.90 of it each year, a half-life of about 7 years, so it moves on the scale of decades. Only used when Inflation Path Global Share is above 0.',
      },
      {
        key:          'inflationGlobalShareJoint',
        label:        'Inflation Path Global Share (joint mode)',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0.2,
        visibleWhen:  [{ param: 'inflationStochastic', truthy: true }, { param: 'inflationModel', equals: 'HISTORICAL_JOINT' }],
        description:  'The global cycle\'s share when inflation is historical and joint with equity (Monte Carlo\'s default). It is smaller than Inflation Path Global Share because in this mode the global cycle is built from the same historical years as each country\'s own surprises, so it already moves with them. 0.2 reproduces history\'s 0.59 US–AU level correlation; 0.4 would give about 0.73 (design 103 §10.4).',
      },
      {
        // Design 103 §6 — a separate switch for the same loader reason as mcSequenceRisk.
        key:          'mcInflationPath',
        label:        'Monte Carlo: Stochastic Inflation Path',
        type:         'Boolean',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: true,
        description:  'When on (default), every Monte Carlo path runs the stochastic inflation path on top of its sampled inflation anchor, so each path lives through its own inflation history, including high-inflation decades. Single runs are unaffected. Turn off to hold each path\'s inflation at its sampled rate.',
      },
      {
        key:          'mcInflationModel',
        label:        'Monte Carlo: Inflation Process',
        type:         'Enum',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        options:      ['AUTO', 'SCENARIO', ...INFLATION_MODEL_IDS],
        optionLabels: { AUTO: 'Automatic — joint with equity under the historical bootstrap, Gaussian otherwise (default)',
                        SCENARIO: 'Same as single runs (Inflation Process Model)',
                        ...INFLATION_MODEL_LABELS,
                        GAUSSIAN: 'Gaussian — persistent, US and AU correlated' },
        defaultValue: 'AUTO',
        visibleWhen:  { param: 'mcInflationPath', truthy: true },
        description:  'The inflation process every Monte Carlo path runs. Automatic (default) samples inflation jointly with equity whenever the Monte Carlo equity process is the historical bootstrap, so each path\'s inflation surprises, equity returns and yield changes come from the same historical years.',
      },
      {
        key:          'equityReturnVol',
        label:        'Equity Return Volatility',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           true,
        opt:          false,
        defaultValue: 0.18,
        description:  'Annualized standard deviation (in rate units, e.g. 0.18 = 18%) of the shared equity MARKET factor — the US market\'s own volatility (0.18 is the mean of J.P. Morgan\'s and BlackRock\'s, design 90 §7.4). Each market loads on it by its beta (US 1.0; intl ex-US 0.85; intl ex-AU 0.81; AU 0.43) and adds its own idiosyncratic volatility. Only used when Stochastic Equity Returns is on.',
      },
      {
        key:          'rngStreams',
        label:        'Paired RNG Streams',
        type:         'Boolean',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: false,
        description:  'Draw each stochastic process from its OWN year-keyed stream instead of one shared '
          + 'cursor, so that two scenarios differing in policy experience the SAME realised path. Off (the '
          + 'default) every process draws from `sim.rng` in whatever order the event queue runs them, which '
          + 'is fine for one run and misleading for a comparison: measured on a paycheck-vs-no-paycheck pair, '
          + 'both arms drew the identical 1,862 values in the identical order and still diverged, because the '
          + 'same value landed on a different DATE in each — a z that is 2035\'s equity shock in one arm is '
          + '2036\'s in the other. On, a draw is a pure function of (seed, process, year), so nothing another '
          + 'process does can shift it and the difference between two arms is causal. Turning it on CHANGES '
          + 'the path a given seed produces, so it is a property of a STUDY, not a better setting: switch it '
          + 'on for every arm of a comparison, or none.',
      },
      {
        key:          'randomSeed',
        label:        'Random Seed',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: null,
        description:  'Seed for the simulation\'s in-loop RNG — the single sequence every stochastic process draws from: FX (design 47), the yield curve (design 67) and equity return paths (design 74). null = 1, so a default run is unchanged. Changing it draws a DIFFERENT path from the same distribution, which is how a single deterministic run is varied without a Monte Carlo. Monte Carlo ignores this: it supplies its own per-iteration seed, and must, or every path would collapse onto one ordering.',
      },
      {
        key:          'equityReturnModel',
        label:        'Equity Return Process Model',
        type:         'Enum',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        // Design 102 §3: the ids are what saved scenarios store, so they stay; the labels
        // say what each process does to a RETURN.
        options:      EQUITY_RETURN_MODEL_IDS,
        optionLabels: EQUITY_RETURN_MODEL_LABELS,
        defaultValue: 'WHITE_NOISE',
        description:  'Process for the market factor. White noise (WHITE_NOISE, default) draws an independent shock each year. Annual US returns since 1871 have a lag-1 autocorrelation of +0.01, so this matches history year to year. Historical bootstrap (HISTORICAL_BOOTSTRAP, design 102) replays blocks of consecutive real historical years (US 1871–2023), re-centred on your anchor and rescaled to Equity Return Volatility; the AU market replays its own history for the same year from 1958 (Historical Bootstrap — Replay AU Market History). That keeps history\'s fat left tail and its mild multi-year pull-back without fitting a parameter to either. Persistent returns (MEAN_REVERTING) applies an Ornstein-Uhlenbeck step to the RETURN, so consecutive years are POSITIVELY correlated at e^(-k): +0.74 at the default k=0.3, against history\'s +0.01. Long-run outcomes spread about 3.5× wider than white noise, so treat it as a stress test, not a realistic world (design 97 §20.9, design 102 §2). No process makes a crash predict a rebound. Only used when Stochastic Equity Returns is on. Monte Carlo turns that on for every path, and uses its own process setting (Monte Carlo: Equity Return Process, default Historical bootstrap) unless that is set to "Same as single runs".',
      },
      {
        key:          'equityReturnBootstrapBlock',
        label:        'Historical Bootstrap Block Length (years)',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 5,
        visibleWhen:  { param: 'equityReturnModel', equals: 'HISTORICAL_BOOTSTRAP' },
        description:  'How many consecutive historical years are replayed before jumping to a new random start year (design 102 §4.3). Longer blocks keep more of history\'s multi-year runs and pull-backs, but draw from fewer distinct sequences. 1 replays single years in random order, which throws away any link between neighbouring years. The default of 5 is the usual n^(1/3) rule for a 153-year series. Only used with the Historical bootstrap model.',
      },
      {
        key:          'equityReturnBootstrapAuReplay',
        label:        'Historical Bootstrap — Replay AU Market History',
        type:         'Boolean',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: true,
        visibleWhen:  { param: 'equityReturnModel', equals: 'HISTORICAL_BOOTSTRAP' },
        description:  'When on (default), the AU market replays its OWN history in the same historical year the US market is replaying (OECD Australian share prices, 1958–2023, after inflation), instead of following the US market through its beta plus random noise. So AU-specific episodes, such as the 11-year recovery after 2008, come through. Rescaled so the AU market\'s volatility matches your beta and idiosyncratic settings. Historical years before 1958 use the random noise. Price-only data, so year-to-year dividend variation is not included (design 102 §6).',
      },
      {
        key:          'equityReturnReversionSpeed',
        // Named for what it DOES, not for the enum it belongs to. The value it controls is the
        // autocorrelation of returns, which is positive — calling it "mean-reversion speed"
        // (as the FX and yield-curve knobs correctly are, because those run on levels) sends
        // exactly the person testing a bucket strategy in the wrong direction. design 97 §20.9.
        label:        'Equity Return Persistence (OU pull-back speed k)',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: 0.3,
        // Design 102 §3: read only by the persistent-returns process.
        visibleWhen:  { param: 'equityReturnModel', equals: 'MEAN_REVERTING' },
        description:  'Ornstein-Uhlenbeck pull-back speed k, per year. Consecutive annual returns end up correlated at e^(-k), which is POSITIVE — so a LOWER k is MORE persistent (k=0.15 measures +0.83; k=0.9 measures +0.41), and this is a momentum knob, not a rebound one. Unlike the FX and yield-curve reversion speeds, which run on levels and do mean-revert, this runs on a return. Ignored under WHITE_NOISE. No setting of it makes a down year predict an up year: see design 97 §20.9 for what that rules out. Only used when Stochastic Equity Returns is on with MEAN_REVERTING.',
      },
      {
        key:          'equityReturnBeta',
        label:        'Equity Return Betas',
        type:         'RateKeyMap',
        options:      EQUITY_SLEEVES,
        optionDefaults: DEFAULT_EQUITY_BETA,
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: null,
        description:  'Optional per-market override of each equity market\'s loading on the shared market factor (the US market), keyed by MARKET rate key (EQUITY_US, EQUITY_AU, EQUITY_INTL_EX_US, EQUITY_INTL_EX_AU). Absent keys use the sourced defaults (design 90 §7.4): US 1.0 / intl ex-US 0.85 / intl ex-AU 0.81 / AU 0.43. The CO-MOVEMENT half — the idiosyncratic volatility is the dispersion half. Only used when Stochastic Equity Returns is on.',
      },
      {
        key:          'equityReturnIdioVol',
        label:        'Equity Return Idiosyncratic Volatility',
        type:         'RateKeyMap',
        options:      EQUITY_SLEEVES,
        optionDefaults: DEFAULT_EQUITY_IDIO,
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: null,
        description:  'Optional per-market override of each equity market\'s own (idiosyncratic) return sd, keyed by MARKET rate key. It is what lets one market fall while another rises. Absent keys use the sourced defaults (design 90 §7.4): US 0 (it is the market factor) / intl ex-US 8.5% / intl ex-AU 2.0% / AU 13.0%. Set a market to 0 to make it a pure multiple of the US market. Only used when Stochastic Equity Returns is on.',
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
        type:         'RateKeyMap',
        options:      PROPERTY_SLEEVES,
        optionDefaults: DEFAULT_RE_BETA,
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        defaultValue: null,
        description:  'Optional per-sleeve override of each real-estate sleeve\'s loading on the shared market factor, keyed by rate key (REAL_ESTATE_US, REAL_ESTATE_AU). Absent keys fall back to the near-zero defaults (US 0.03 / AU 0.05). Raise a beta to model a standing correlation with equities; the default assumes almost none (design 75 §4.1). Only used when Stochastic Property Returns is on.',
      },
      {
        key:          'propertyReturnIdioVol',
        label:        'Property Return Idiosyncratic Volatility',
        type:         'RateKeyMap',
        options:      PROPERTY_SLEEVES,
        optionDefaults: DEFAULT_RE_IDIO,
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
      // Per-MARKET equity return (design 98 W1, made the ONLY equity rate by design 99 P2).
      // A total and the yield inside it, per market. MC-sweepable; not Opt levers — a
      // market's return is an uncertainty, not a decision.
      ...MARKET_GROWTH_PARAMS.flatMap(m => [{
        key:          m.key,
        label:        m.label,
        type:         'Number',
        group:        'Market Rates',
        mc:           true,
        opt:          false,
        defaultValue: m.defaultValue,
        description:  `Expected annual TOTAL return of the ${m.label.replace(/ Total Return$/, '')} market — price `
          + 'growth plus dividends. Every equity holding tracking this market earns it, in any account: a taxable '
          + 'account grows by this minus the dividend yield and pays the yield out as a dividend; a retirement '
          + 'account or super grows by the whole of it.',
      }, {
        key:          m.yieldKey,
        label:        m.yieldLabel,
        type:         'Number',
        group:        'Market Rates',
        mc:           true,
        opt:          false,
        defaultValue: m.yieldDefault,
        description:  `The part of the ${m.label.replace(/ Total Return$/, '')} total return paid as dividends. `
          + 'Changes how the return is TAXED, not its size: a taxable account pays it out as a dividend and grows '
          + 'by the rest. A security or lot that names its own yield overrides this.',
      }]),
      // Design 98 M2 — the equity return UNCERTAINTY, as one draw. A plan input it is not:
      // at its default of 0 nothing moves; Monte Carlo samples it.
      {
        key:          'equityAnchorShift',
        label:        'Equity Return Shift (all markets)',
        type:         'Number',
        group:        'Market Rates',
        mc:           true,
        opt:          false,
        defaultValue: 0,
        description:  'Added to every equity market\'s total return at once — one systematic draw, so the markets '
          + 'rise and fall together rather than cancelling out. Monte Carlo samples it; leave it at 0 for a '
          + 'single run. Reaches every holding that tracks a market; not an authored appreciation schedule, '
          + 'and not gold, bonds or cash.',
      },
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
    const primeLinks = seedPerAccountRates(context.accounts, baseInterestRates);
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
      // Design 99 §2 — the dividend yield inside each market's total return.
      marketDividendYields:        collectMarketDividendYields(p),
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
    // Design 104: the schedule and the inflation link are either/or. In "follows inflation"
    // mode the schedule is ignored, not composed.
    if (p.primeRateModel !== 'INFLATION_LINKED') {
      schedulePrimeRateSteps(p.primeSchedule, p, context.startDate, context.endDate, events);
    }

    // Optional yield-curve path (design 67 §6) → scheduled curve twists.
    scheduleYieldCurveSteps(p.yieldCurveSchedule, p, context.endDate, events);

    // Optional stochastic curve evolution (design 67 §6) — an annual tick series that
    // drives the seeded-RNG level walk. Scheduled only when on, so default runs draw
    // no randomness and stay byte-identical.
    // Design 103 §5.1: in joint mode the yield tick reads the equity bootstrap's year, so
    // it must fire AFTER the equity tick (order 0). Only in joint mode, so every other run
    // keeps its exact event order.
    const joint = jointInflationActive(p);
    if (p.yieldCurveStochastic) {
      events.push(new EventSeries({
        name:     'Yield Curve Tick',
        type:     'YIELD_CURVE_TICK',
        interval: 'year-end',
        startOffset: 1,
        ...(joint ? { order: 3 } : {}),
        enabled:  true,
        color:    '#7E57C2',
      }));
    }

    // Optional stochastic inflation path (design 103 §4.2). Annual, `order: 2` so it fires
    // after the equity tick (0) and the property tick (1) on the same year-end; joint mode
    // reads the equity cursor that tick just advanced. Scheduled only when on.
    if (p.inflationStochastic) {
      events.push(new EventSeries({
        name:     'Inflation Tick',
        type:     'INFLATION_TICK',
        interval: 'year-end',
        startOffset: 1,
        order:    2,
        enabled:  true,
        color:    '#FFA726',
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

    // ── design 107 §5 / §15.3 — THE PAYCHECK, following residency ────────────────────
    //
    // Scheduled only when `paycheckEnabled`, so a plan that has not opted in draws no extra
    // event and stays byte-identical. That matters more here than usual: the event queue
    // orders by `date || order` with no final tie-break, so an unconditional series would
    // re-resolve same-date ties in every scenario that has one (design 100 §9 measured the
    // cost of exactly that).
    //
    // BOTH calendars are scheduled — 1 January and 1 July — and the handler emits on whichever
    // one is the current residency's income-year start (§15.3). Two series rather than one
    // rescheduled series because the schedule is built once, before the run, and the residency
    // it must follow is a fact about year 5.
    //
    // `month`/`day` anchor each to the START of an income year. Neither is reachable through
    // an interval snap, all of which land on period ENDS, which is why `EventBuilder` grew the
    // two accessors.
    //
    // `order: 1` puts the paycheck AFTER every order-0 event it shares a date with, and both
    // of the ones that matter are order 0: `PERIOD_ADVANCE_*` and, on the move date itself,
    // `CHANGE_RESIDENCY`. Two things follow, and both are the reason for the number:
    //
    //   · **the move year works at all.** The household moves on 1 July. Running first, the
    //     paycheck would read the OLD residency, decline to fire on the AU calendar, and leave
    //     the AU float unfunded for a year. Running last, the residency change has landed and
    //     the same firing IS §15.3's move-year top-up — no separate event needed.
    //   · **it reads the right spend line.** The advance inflates `state.monthlyExpenses`
    //     first, so a `YEARS_OF_SPEND` target now sizes the year AHEAD rather than the year
    //     just ended, which is what a paycheck is for.
    //
    // Sitting after an order-0 event is a strict `order` comparison, not a tie-break, so this
    // does not depend on the queue's ordering of equal keys.
    if (p.paycheckEnabled) {
      const interval = p.paycheckCadence === 'QUARTERLY' ? 'quarterly' : 'annually';
      for (const [cc, month] of [['US', 1], ['AU', 7]]) {
        events.push(new EventSeries({
          name:     `Spending Refill (paycheck, ${cc})`,
          type:     `PAYCHECK_${cc}`,
          interval,
          month,
          day:      1,
          order:    1,
          enabled:  true,
          color:    '#7E57C2',
        }));
      }
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
    // Design 103 §5.1: joint mode ties equity (POSTWAR window), inflation and yields to the
    // same historical year. The same rule the schedule used.
    const joint = jointInflationActive(p);
    return [
      new EconomicShockHandler({ rateKeyToStateKeys, allAccountStateKeys }),
      new EconomicRecoveryTickHandler(),
      // Stochastic curve evolution (design 67 §6) — only when on, so the sim.rng is
      // untouched otherwise and runs stay byte-identical.
      ...(p.yieldCurveStochastic
        ? [new YieldCurveTickHandler({ vol: p.yieldCurveVol ?? 0.01, reversionSpeed: p.yieldCurveReversionSpeed ?? 0.3, historical: joint })]
        : []),
      // Stochastic inflation path (design 103 §4) — only when on.
      ...(p.inflationStochastic
        ? [new InflationTickHandler({
            vol:            { US: p.inflationPathVolUs ?? 0.028, AU: p.inflationPathVolAu ?? 0.03 },
            reversionSpeed: { US: p.inflationReversionSpeedUs ?? 0.33, AU: p.inflationReversionSpeedAu ?? 0.33 },
            correlation:    p.inflationPathCorrelation ?? 0.35,
            // Design 103 §10: the shared global cycle and the skew's lower bounds.
            globalShare:          p.inflationGlobalShare          ?? 0.4,
            globalShareJoint:     p.inflationGlobalShareJoint     ?? 0.2,
            globalReversionSpeed: p.inflationGlobalReversionSpeed ?? 0.1,
            lowerBound:     { US: p.inflationLowerBoundUs ?? -0.01, AU: p.inflationLowerBoundAu ?? -0.01 },
            model:          joint ? 'HISTORICAL_JOINT' : 'GAUSSIAN',
            floor:          p.inflationPathFloor ?? -0.05,
            passThrough:    joint,
            // Design 104: the prime rate follows inflation — only in that mode.
            prime: p.primeRateModel === 'INFLATION_LINKED'
              ? {
                  beta:  { US: p.primeInflationResponseUs  ?? 1.3,    AU: p.primeInflationResponseAu  ?? 1.3 },
                  rho:   { US: p.primeInflationSmoothingUs ?? 0.6,    AU: p.primeInflationSmoothingAu ?? 0.75 },
                  noise: { US: p.primePolicyNoiseUs        ?? 0,      AU: p.primePolicyNoiseAu        ?? 0 },
                  floor: { US: p.primeFloorUs              ?? 0.0025, AU: p.primeFloorAu              ?? 0.001 },
                }
              : null,
          })]
        : []),
      // Stochastic equity return path (design 74 §5.1) — only when on, so the sim.rng is
      // untouched otherwise and runs stay byte-identical.
      ...(p.equityReturnStochastic
        ? [new EquityReturnTickHandler({
            vol:            p.equityReturnVol   ?? 0.18,
            model:          p.equityReturnModel ?? 'WHITE_NOISE',
            // Unwired until design 97 §20: the handler has always accepted it and nothing
            // passed it, so MEAN_REVERTING ran at the constructor's 0.3 whatever the scenario
            // said. A process switch whose one tuning knob cannot be reached is a switch with
            // a hidden constant behind it.
            reversionSpeed: p.equityReturnReversionSpeed ?? 0.3,
            beta:           p.equityReturnBeta      ?? {},
            idioVol:        p.equityReturnIdioVol   ?? {},
            driftComp:      p.equityReturnDriftComp ?? 'GEOMETRIC',
            blockLength:    p.equityReturnBootstrapBlock ?? 5,
            // Design 103 §5.1: joint mode draws only post-war years, the era the inflation
            // and yield series share.
            window:         joint ? 'POSTWAR' : 'FULL',
            // Design 102 §6: the AU market replays its own history where the year has data.
            auReplay:       p.equityReturnBootstrapAuReplay ?? true,
          })]
        : []),
      // Stochastic property return path (design 75 §4) — only when on. `marketVol` matches
      // equityReturnVol so the property betas mean the same thing whether or not the equity
      // path is active; `shareMarketFactor` reuses the equity market shock when equity is on.
      ...(p.propertyReturnStochastic
        ? [new PropertyReturnTickHandler({
            marketVol:         p.equityReturnVol   ?? 0.18,
            model:             p.equityReturnModel ?? 'WHITE_NOISE',
            // Same knob, same reason: property already borrows the equity model and vol, and
            // leaving the speed behind would make the two walks disagree about what
            // MEAN_REVERTING means whenever `shareMarketFactor` is off.
            reversionSpeed:    p.equityReturnReversionSpeed ?? 0.3,
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
      new MarketIndexReducer(),     // design 101 §6 — steps marketIndex/securityIndex at each period advance (10.5)
      new PropertyReturnStepReducer(),// design 75 §4 — stores the per-sleeve property deviation (AssetAppreciationHandler reads it; no fold reducer)
      new InflationPathReducer(),   // design 103 §4.2 — folds the inflation deviation onto effectiveInflationRates (11.5)
      new InflationStepReducer(),   // design 103 §4.2 — stores the inflation deviation, floor and equity pass-through
      new BondPriceAdjustReducer(),
      new BondMaturityReducer(),
      ...behavioralReducers,
    ];
  },
};
