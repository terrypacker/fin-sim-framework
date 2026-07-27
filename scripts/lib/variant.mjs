/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * variant.mjs — apply a declarative LEVER BAG to a base scenario cfg.
 *
 * A decision study is a set of cfgs that differ along a few axes. Writing those
 * mutations inline per study is how you end up with eight near-identical drivers
 * that disagree subtly about what "spend $10k" means. This module is the single
 * definition of each lever, so a grid, a ceiling search and a Monte Carlo arm all
 * mutate the cfg the same way and their numbers are comparable.
 *
 * Every lever is OPTIONAL and OFF when absent — `buildVariant(cfg, {})` returns a
 * faithful deep clone. Levers carry no default scenario values of their own; the
 * caller supplies them (CLI flag or spec file), which is what keeps private plan
 * figures out of this repo.
 *
 * ─── the levers ──────────────────────────────────────────────────────────────
 *
 *   params            {name: value}    set any scenario param (the generic escape hatch)
 *   retire            {personId: year} retirement date → Jan 1 of that year
 *   moveYear          number           residency-change year
 *   equityShift       number           parallel shift on EVERY equity growth rate,
 *                                      in rate points (-0.03 turns 10% into 7%)
 *   equity            [{...}]          inject CompanyEquity records (tranches)
 *   companyEquity     {stateKey: {...}} per-equity overrides on tranches the scenario
 *                                      ALREADY carries (sale year, value, …)
 *   property          {stateKey: {...}} per-property overrides (sale year, value, costs)
 *   spendingStrategy  string           FIXED | GUARDRAIL | EXPLICIT_BANDS | …
 *   monthlyExpenses   number           the raw expense line (EXCLUDES loan payments)
 *   spendTotal        number           all-in monthly outflow INCLUDING mortgage
 *   stochastic        {...}            return/property path switches (see below)
 *
 * ─── the one lever that needs explaining: spendTotal ─────────────────────────
 *
 * `monthlyExpenses` is NOT total outflow. Mortgage and loan payments are separate
 * cash outflows (design 54 P2 moved property debt onto synthesized loan accounts),
 * so a household budgeting "$10k a month, all in" is asking for
 * `monthlyExpenses = 10000 − mortgage` while the house is owned, and the full
 * $10k once it sells and the payment stops. Setting `monthlyExpenses: 10000`
 * instead silently models ~35% more spending than intended.
 *
 * `spendTotal` implements the all-in reading via EXPLICIT_BANDS, whose
 * `monthlyAmount` is a base-year figure scaled by the price level — so the bands
 * stay REAL and must not be pre-inflated by the caller.
 */

/**
 * @param {object} cfg    base cfg (not mutated)
 * @param {object} levers see the table above
 * @returns {object} a new cfg
 */
export function buildVariant(cfg, levers = {}) {
  const out = structuredClone(cfg);
  const set = makeSetParam(out);

  if (levers.params) for (const [name, value] of Object.entries(levers.params)) set(name, value);

  if (levers.retire) {
    for (const [personId, year] of Object.entries(levers.retire)) {
      if (year == null) continue;
      applyRetirement(out, set, personId, year);
    }
  }

  if (levers.moveYear != null) set('moveYear', levers.moveYear);
  if (levers.equityShift) applyEquityShift(out, set, levers.equityShift);
  if (levers.equity) for (const rec of levers.equity) addCompanyEquity(out, rec);
  if (levers.companyEquity) {
    for (const [stateKey, o] of Object.entries(levers.companyEquity)) applyCompanyEquity(out, set, stateKey, o);
  }
  if (levers.property) {
    for (const [stateKey, o] of Object.entries(levers.property)) applyProperty(out, set, stateKey, o);
  }
  if (levers.stochastic) applyStochastic(out, set, levers.stochastic);

  // Spending last: spendTotal reads the property sale year and mortgage that the
  // property lever may just have changed.
  if (levers.monthlyExpenses != null) set('monthlyExpenses', levers.monthlyExpenses);
  if (levers.spendingStrategy) set('spendingStrategy', [levers.spendingStrategy]);
  if (levers.spendTotal != null) {
    // `spendTotal` is IMPLEMENTED as EXPLICIT_BANDS, so it collides with any other
    // requested strategy. Left implicit, the collision is silent and damaging: the
    // bands overwrite the strategy, GUARDRAIL never runs, and a study measuring
    // "what does an adaptive rule cost" quietly re-measures FIXED spending and finds
    // no difference. When the caller named a strategy, that wins — spendTotal then
    // contributes only its mortgage arithmetic, setting the expense LEVEL the
    // strategy adapts from.
    applySpendTotal(out, set, levers.spendTotal, levers.spendTotalProperty, {
      ownStrategy: !levers.spendingStrategy,
    });
  }

  return out;
}

// ─── param plumbing ──────────────────────────────────────────────────────────

/**
 * Set a param on BOTH `cfg.params` (the authored list) and `cfg.parameters` (the
 * flat compile-time bag). Both are read on different paths — writing only one
 * gives a lever that works in some tools and is inert in others.
 */
export function makeSetParam(cfg) {
  return (name, value) => {
    const p = (cfg.params ?? []).find(x => x.name === name);
    if (p) p.value = value;
    else (cfg.params ??= []).push({ name, value });
    cfg.parameters = { ...(cfg.parameters ?? {}), [name]: value };
  };
}

/**
 * Every numeric param, from BOTH stores, as name → value.
 *
 * Reading only one store is a real trap, because which one is populated depends on
 * where the cfg came from:
 *   · a workbench export carries an authored `params` LIST
 *   · `buildDefaultConfig()` carries only the flat `parameters` BAG (its `params`
 *     list is empty)
 * So a sweep that iterates `cfg.params` looks correct, works against a saved plan,
 * and is SILENTLY INERT against the built-in default — the worst kind of failure,
 * since it reports confident numbers from an unchanged scenario. Read through here.
 * The list wins on collision; it is the authored value.
 */
export function numericParams(cfg) {
  const out = new Map();
  for (const [k, v] of Object.entries(cfg.parameters ?? {})) {
    if (typeof v === 'number') out.set(k, v);
  }
  for (const p of cfg.params ?? []) {
    if (typeof p.value === 'number') out.set(p.name, p.value);
  }
  return out;
}

/**
 * The scenario's headline nominal equity rate, so a caller can express a sweep in
 * absolute rates rather than deltas. Prefers the named param; falls back to the
 * persisted effective-rate map, which is what actually drives the sim when present.
 */
export function baseEquityRate(cfg, dflt = 0.07) {
  const p = numericParams(cfg).get('brokerageGrowthRate');
  if (p != null) return p;
  const m = cfg.initialState?.effectiveGrowthRates ?? {};
  const eq = Object.entries(m).find(([k, v]) => k.startsWith('EQUITY') && typeof v === 'number');
  return eq ? eq[1] : dflt;
}

// ─── levers ──────────────────────────────────────────────────────────────────

function applyRetirement(cfg, set, personId, year) {
  const iso = `${year}-01-01T00:00:00.000Z`;
  const person = (cfg.persons ?? []).find(p => p.id === personId);
  if (!person) throw new Error(`retire lever: no person "${personId}" (have: ${(cfg.persons ?? []).map(p => p.id).join(', ')})`);
  person.retirementDate = iso;
  set(`person.${personId}.retirementDate`, iso);
}

/**
 * Shift every equity growth rate by `delta` rate points, floored at zero.
 *
 * Growth rates live in THREE places that must stay in step, and missing any one
 * of them yields a partly-inert lever:
 *   · the named scenario params (`brokerageGrowthRate`, `superGrowthRate`, …)
 *   · `initialState.baseGrowthRates`      — persisted per-sleeve map
 *   · `initialState.effectiveGrowthRates` — post-overlay map the sim actually reads
 *
 * The maps are keyed by sleeve (`EQUITY…`) including design/55's per-account
 * `<family>::<stateKey>` form, so this filters on the EQUITY prefix rather than
 * enumerating account names. On a file-sourced cfg the maps DOMINATE: without
 * them the params are overwritten at load and the shift does nothing.
 */
export function applyEquityShift(cfg, set, delta) {
  if (!delta) return;
  const bump = v => Math.max(0, v + delta);

  // Both param stores (see numericParams) — a saved plan populates the list, the
  // built-in default populates only the bag.
  for (const [name, value] of numericParams(cfg)) {
    if (/GrowthRate$/.test(name) && !/property|house/i.test(name)) set(name, bump(value));
  }
  for (const mapName of ['baseGrowthRates', 'effectiveGrowthRates']) {
    const m = cfg.initialState?.[mapName];
    if (!m) continue;
    for (const k of Object.keys(m)) {
      if (k.startsWith('EQUITY') && typeof m[k] === 'number') m[k] = bump(m[k]);
    }
  }
}

/**
 * Inject a CompanyEquity record — a lump-sum liquidity event at `saleYear`.
 *
 * Written to BOTH `cfg.companyEquities` and `cfg.initialState[key]`, because the
 * loader reads the record list while the sim reads state. `value` is a base-year
 * face value that the engine appreciates at `appreciationRate` until the sale, so
 * a sale in the base year yields exactly face.
 *
 * `destination` must be a state KEY, not a record id — design/72 Gap 2 was
 * exactly this bug: an id here never resolves and proceeds land in the generic
 * cash pool instead of the intended account.
 */
export function addCompanyEquity(cfg, {
  key, value, saleYear,
  costBasis = 0, appreciationRate = 0, destination = null,
  ownerId = 'primary', ownershipType = 'sole', country = 'US',
  currency = { code: 'USD', symbol: '$' },
} = {}) {
  if (!key) throw new Error('addCompanyEquity: key required');
  if (!value || value <= 0) return;                       // zero-value tranche ⇒ no record at all

  (cfg.companyEquities ??= []).push({
    __type: 'CompanyEquity', id: key, name: key,
    value, costBasis, appreciationRate,
    plannedSaleYear: saleYear, saleDestinationAccount: destination,
    ownershipType, ownerId, drawdownPriority: null, owners: [],
    country, currency, stateKey: key, appreciationSchedule: null,
  });
  (cfg.initialState ??= {})[key] = {
    kind: 'company', stateKey: key, value, costBasis,
    appreciationRate, plannedSaleYear: saleYear,
    ownershipType, ownerId, country, appreciationSchedule: null,
  };
}

/**
 * Per-equity overrides on a tranche the scenario ALREADY carries — the read/modify
 * sibling of `addCompanyEquity`'s create.
 *
 *   saleYear             number|null   null = never becomes sellable
 *   value                number        absolute override of the base-year face value
 *   valueMult            number        multiplier on the existing value
 *   appreciationRate     number
 *   costBasis            number
 *   destination          string        state KEY of the account taking the proceeds
 *
 * Sweeping a sale year is the whole point: a private tranche whose liquidity date is
 * decided by someone else is not a plan input, it is an axis. Use `addCompanyEquity`
 * only for a tranche the scenario does NOT model — injecting one that it does gives
 * you two, and the phantom sells while the real one sits there as dead paper.
 *
 * `saleYear: null` is meaningful and is the DEFAULT STATE of an unvested tranche, so
 * this distinguishes "absent" from "explicitly null" via `in`. It is also close to
 * inert for solvency: US_COMPANY_SALE schedules a COMPANY_SALE only when
 * `plannedSaleYear != null`, so a null tranche appreciates onto the balance sheet
 * forever and never converts to cash. Expect it to move `netWorth` a great deal and
 * `failed` not at all — which is exactly why `failed` is the primary outcome here.
 */
export function applyCompanyEquity(cfg, set, stateKey, o = {}) {
  const rec = (cfg.companyEquities ?? []).find(e => e.stateKey === stateKey || e.id === stateKey);
  const st  = cfg.initialState?.[stateKey];
  if (!rec && !st) {
    throw new Error(`companyEquity lever: no equity "${stateKey}" `
      + `(have: ${(cfg.companyEquities ?? []).map(e => e.stateKey ?? e.id).join(', ') || 'none'})`);
  }

  if ('saleYear' in o) {
    if (rec) rec.plannedSaleYear = o.saleYear;
    if (st)  st.plannedSaleYear  = o.saleYear;
    set(`equity.${stateKey}.plannedSaleYear`, o.saleYear);
  }
  if (o.value != null || o.valueMult != null) {
    const base = o.value ?? (rec?.value ?? st?.value ?? 0);
    const v = Math.round(o.valueMult != null ? base * o.valueMult : base);
    if (rec) rec.value = v;
    if (st)  st.value  = v;
    set(`equity.${stateKey}.value`, v);
  }
  for (const f of ['appreciationRate', 'costBasis']) {
    if (o[f] == null) continue;
    if (rec) rec[f] = o[f];
    if (st)  st[f]  = o[f];
  }
  // design/72 Gap 2: this is a state KEY. A record id here never resolves and the
  // proceeds land silently in the generic cash pool.
  if (o.destination != null && rec) rec.saleDestinationAccount = o.destination;
}

/**
 * Per-property overrides, applied to the record AND the state entry.
 *
 *   saleYear   number|null   null = never sells (a real case, not a no-op)
 *   value      number        absolute override
 *   valueMult  number        multiplier on the existing value — because a property
 *                            appreciates multiplicatively, a multiplier reads
 *                            identically as a haircut-at-sale or a scaled start
 *   annualRunningCost, runningCostGrowth,
 *   repairModel, repairProb, repairMedian, repairSigma, capitalizeRepairs
 *                            design/75 holding-cost model
 *
 * NOTE `saleYear: null` is meaningful, so this distinguishes "absent" from
 * "explicitly null" via `in`. A property that never sells never delivers
 * proceeds, which makes its value nearly irrelevant to solvency — expect a
 * price axis to go flat in that column.
 */
export function applyProperty(cfg, set, stateKey, o = {}) {
  const rec = (cfg.realProperties ?? []).find(p => p.stateKey === stateKey);
  const st  = cfg.initialState?.[stateKey];
  if (!rec && !st) throw new Error(`property lever: no property "${stateKey}"`);

  if ('saleYear' in o) {
    if (rec) rec.plannedSaleYear = o.saleYear;
    if (st)  st.plannedSaleYear  = o.saleYear;
    set(`prop.${stateKey}.plannedSaleYear`, o.saleYear);
  }
  if (o.value != null || o.valueMult != null) {
    const base = o.value ?? (rec?.value ?? st?.value ?? 0);
    const v = Math.round(o.valueMult != null ? base * o.valueMult : base);
    if (rec) rec.value = v;
    if (st)  st.value  = v;
    set(`prop.${stateKey}.value`, v);
  }
  for (const f of ['annualRunningCost', 'runningCostGrowth', 'repairModel',
                   'repairProb', 'repairMedian', 'repairSigma', 'capitalizeRepairs']) {
    if (o[f] == null) continue;
    if (rec) rec[f] = o[f];
    if (st)  st[f]  = o[f];
  }
}

/** design/74 + design/75 stochastic path switches. */
export function applyStochastic(cfg, set, s = {}) {
  if (s.equity) {
    set('equityReturnStochastic', true);
    if (s.equityVol   != null) set('equityReturnVol', s.equityVol);
    if (s.equityModel != null) set('equityReturnModel', s.equityModel);
    if (s.equityDrift != null) set('equityReturnDriftComp', s.equityDrift);
  }
  if (s.property) set('propertyReturnStochastic', true);
}

/**
 * Express an ALL-IN monthly spend target as EXPLICIT_BANDS.
 *
 * Two bands: while the mortgaged property is held the expense line is
 * (total − mortgage); from the sale year on it is the full total, because rent, a
 * new mortgage or travel absorbs the freed payment. With no sale year there is
 * one band and the payment runs for life.
 *
 * Band boundaries are expressed as an AGE, so this needs the reference person's
 * birth year. At the Jan-1 period advance of year Y the age is Y − (birthYear + 1)
 * — the advance fires before the birthday for any non-January birth date.
 *
 * With `ownStrategy: false` the bands are NOT installed and no strategy is set: only
 * `monthlyExpenses` moves, to the mortgage-adjusted level. Use that when another
 * spending strategy (GUARDRAIL, …) must stay in control — see the call site.
 */
export function applySpendTotal(cfg, set, total, propertyKey, { ownStrategy = true } = {}) {
  const mortgaged = (cfg.realProperties ?? []).filter(p => (p.monthlyMortgage ?? 0) > 0);
  const prop = propertyKey
    ? (cfg.realProperties ?? []).find(p => p.stateKey === propertyKey)
    : mortgaged[0];

  if (propertyKey && !prop) throw new Error(`spendTotal: no property "${propertyKey}"`);
  if (mortgaged.length > 1 && !propertyKey) {
    throw new Error(`spendTotal: ${mortgaged.length} mortgaged properties `
      + `(${mortgaged.map(p => p.stateKey).join(', ')}) — pass spendTotalProperty to pick one`);
  }

  const mortgage = prop?.monthlyMortgage ?? 0;
  const saleYear = prop
    ? (prop.plannedSaleYear ?? cfg.initialState?.[prop.stateKey]?.plannedSaleYear ?? null)
    : null;

  const preSale = Math.max(0, total - mortgage);

  if (!ownStrategy) {
    // Another strategy is in control; contribute only the expense LEVEL.
    set('monthlyExpenses', preSale);
    return;
  }

  const bands = [{ startAge: 0, monthlyAmount: preSale }];
  if (saleYear != null) {
    const ref = (cfg.persons ?? [])[0];
    if (!ref?.birthDate) throw new Error('spendTotal: need a person birthDate to place the post-sale band');
    const birthYear = new Date(ref.birthDate).getUTCFullYear();
    bands.push({ startAge: saleYear - (birthYear + 1), monthlyAmount: total });
  }

  set('spendingStrategy', ['EXPLICIT_BANDS']);
  set('spendingExpenseBands', bands);
  set('monthlyExpenses', bands[0].monthlyAmount);
}
