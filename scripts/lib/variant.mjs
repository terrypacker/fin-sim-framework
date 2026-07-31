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
 *   rothDecant        {...}            scheduled pre-move Roth drawdown (design 84)
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
  // Accepts one spec or a LIST applied in order. The list form exists because a study
  // usually needs two passes: clear the authored Roth leg across the whole horizon,
  // then write the arm's own window on top. Expressed as a single spec the two
  // collapse — a swept `startYear` would move the clearing pass instead of the decant,
  // and the "hold" cell would quietly still be decanting.
  if (levers.rothDecant) {
    for (const spec of [].concat(levers.rothDecant)) applyRothDecant(out, set, spec);
  }

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
/**
 * Every param from BOTH stores as a plain object, any type — the non-numeric
 * companion to `numericParams` (rate METHODS are strings, schedules are arrays).
 * Same precedence: the authored list wins on collision.
 */
export function allParams(cfg) {
  const out = { ...(cfg.parameters ?? {}) };
  for (const p of cfg.params ?? []) out[p.name] = p.value;
  return out;
}

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

/**
 * Read one param from EITHER store, list first — the same precedence
 * `numericParams` uses, extended to non-numeric values (schedules are arrays).
 * A workbench export populates the authored list; `buildDefaultConfig()` populates
 * only the flat bag, so reading one store silently misses the other.
 */
function readParam(cfg, name) {
  const p = (cfg.params ?? []).find(x => x.name === name);
  if (p) return p.value;
  return cfg.parameters?.[name];
}

/**
 * "Draw whatever is there." The reducer caps every draw at the account's drawable
 * balance, so a sentinel far above any plausible balance empties the wrapper without
 * the lever needing to look one up — which is what keeps a committed spec free of
 * private figures. Survives the toolset's inflation compounding with room to spare.
 */
const EMPTY_DECANT_SENTINEL = 1e12;

// Roles the toolset resolves the decant's source and destination by. Kept as literals
// rather than importing ACCOUNT_ROLES so this module stays dependency-free, but they
// must track `us-early-withdrawal-toolset.js`'s `keyOf` calls.
const ROLE_ROTH     = 'roth-ira';
const ROLE_US_STOCK = 'us-stock';

/**
 * Roth decant (design 84 P2) — schedule a deliberate pre-move Roth drawdown.
 *
 * Fills the `rothAmount` leg of `earlyWithdrawalSchedule`, the design 45 lever built
 * for exactly this manoeuvre: draw the Roth while still US-resident, pay the IRC
 * §72(t) 10% additional tax on the earnings, and land the net in taxable brokerage at
 * cost basis = market, where the s855-45 residency step-up later forgives every dollar
 * of pre-move gain. Held instead, those earnings are s99B ordinary income to an
 * Australian resident, with no foreign tax credit.
 *
 *   { startYear, endYear = startYear, annual = 'EMPTY', owners = 'both', destinationKey }
 *
 * `annual` is REAL base-year USD GROSS — the toolset compounds it to the year's
 * nominal draw, so do NOT pre-inflate it. `'EMPTY'` draws the whole wrapper.
 *
 * ─── three things that will bite ────────────────────────────────────────────────
 *
 * **It MERGES.** The tax-deferred leg of this same schedule is a separate decision
 * that competes for the same pre-move years and the same cash. Overwriting the array
 * — which is what driving this through the generic `params` escape hatch does — would
 * silently destroy the authored tax-deferred plan and produce a study measuring the
 * wrong interaction. Existing years keep their `taxDeferredAmount` and their own
 * `destinationKey`; only `rothAmount` is written.
 *
 * **Amounts are PER OWNER.** `owners: 'both'` emits one event per person, each drawing
 * `annual`, so the household total is roughly double a single-owner arm at the same
 * number. It is not a household budget. Sweeping `annual` with `owners: 'both'` sweeps
 * two draws at once.
 *
 * **A partial decant spends CORPUS first.** `reduceLedgerForWithdrawal` draws
 * contributions before earnings, and contributions are the part that is *already* free
 * of s99B — corpus under s99B(2)(a) — and free of the §72(t) penalty. So a decant
 * smaller than the contribution basis moves the tax-free half and reduces the
 * Australian exposure by NOTHING, while still looking like action in the journal. The
 * lever cannot fix that (it is the statutory ordering), but a study that sweeps `annual`
 * must expect a flat region at the bottom of the range and must not read it as "the
 * decant does not help". Where a wrapper is all earnings and no basis, there is no flat
 * region at all — which is why per-owner basis composition matters more here than
 * balance does.
 *
 * ─── and one thing to check before trusting a result ────────────────────────────
 *
 * **Where the cash lands is resolved by ROLE, first match wins.** With no
 * `destinationKey` the toolset takes that owner's first `us-stock` account, which in a
 * household holding several taxable accounts may not be the one you meant — a Treasury
 * sleeve rather than the main brokerage, say. That changes the decant's post-move
 * growth and therefore the answer, without changing anything visible in the schedule.
 * So `destinationKey` takes either form (design 84 G6):
 *
 *     destinationKey: 'usStockAccount'                              // everyone
 *     destinationKey: { primary: 'usStockAccount',                  // per owner
 *                       spouse:  'sharedBrokerageAccount' }
 *
 * It must be a state KEY, not an account id or name — design/72 Gap 2 was exactly that
 * bug, where an id never resolved and proceeds landed in the generic cash pool. Both a
 * key that names no account and an owner with a Roth but no reachable destination are
 * rejected below, because the toolset would otherwise skip them without a word.
 */
export function applyRothDecant(cfg, set, o = {}) {
  const { startYear, endYear, annual = 'EMPTY', owners = 'both', destinationKey = null } = o;

  if (!Number.isFinite(startYear)) {
    throw new Error(`rothDecant: startYear must be a calendar year (got ${startYear})`);
  }
  const last = Number.isFinite(endYear) ? endYear : startYear;
  if (last < startYear) {
    throw new Error(`rothDecant: endYear ${last} precedes startYear ${startYear}`);
  }
  if (!['primary', 'spouse', 'both'].includes(owners)) {
    throw new Error(`rothDecant: owners must be 'primary' | 'spouse' | 'both' (got ${owners})`);
  }
  const isEmpty = annual === 'EMPTY';
  if (!isEmpty && !(Number.isFinite(annual) && annual >= 0)) {
    throw new Error(
      `rothDecant: annual must be a non-negative number of REAL base-year USD, or 'EMPTY' (got ${annual})`);
  }
  const amount = isEmpty ? EMPTY_DECANT_SENTINEL : annual;

  // `destinationKey` is a state key for everyone, or a per-owner map (design 84 G6).
  if (destinationKey != null
      && typeof destinationKey !== 'string'
      && typeof destinationKey !== 'object') {
    throw new Error(
      `rothDecant: destinationKey must be a state key or an { ownerId: stateKey } map (got ${typeof destinationKey})`);
  }
  const destFor = (ownerId) => (
    destinationKey == null ? null
      : typeof destinationKey === 'string' ? destinationKey
        : destinationKey[ownerId] ?? null);

  // Merge onto whatever the scenario already authored, keyed by year.
  const existing = readParam(cfg, 'earlyWithdrawalSchedule');
  const byYear = new Map();
  for (const e of Array.isArray(existing) ? existing : []) {
    if (e && Number.isFinite(e.year)) byYear.set(e.year, { ...e });
  }
  for (let y = startYear; y <= last; y++) {
    const prev = byYear.get(y) ?? {};
    byYear.set(y, {
      ...prev,
      year:              y,
      taxDeferredAmount: Number.isFinite(prev.taxDeferredAmount) ? prev.taxDeferredAmount : 0,
      rothAmount:        amount,
    });
    // NB no destinationKey here: a year in range may carry only a TAX-DEFERRED leg
    // (when `amount` is 0, or where the plan authored one), and routing that is a
    // decision this lever has no business making. The pass below writes the
    // destination onto exactly the years that end up with a Roth leg — including
    // these. Writing it here instead perturbs the zero-decant control arm, which is
    // how this was caught: two "hold" cells that must be identical differed.
  }

  // Routing is global to the decant, not per-year, so an explicit destination is
  // applied to EVERY year that already carries a Roth leg — not just the lever's own
  // range. Confining it to the range is what produces a split-destination decant: the
  // years you set route to the account you chose and the authored years keep pointing
  // wherever the role lookup landed them, which is the silent mis-routing this option
  // exists to prevent. Years with no Roth leg are left alone: routing a pure
  // tax-deferred year would change a decision this lever has no business touching.
  if (destinationKey) {
    for (const [y, e] of byYear) {
      if ((e.rothAmount ?? 0) > 0) byYear.set(y, { ...e, destinationKey });
    }
  }

  // Every owner in scope needs somewhere to land the cash. The toolset resolves an
  // unmapped owner's destination as "their first US_STOCK account" and, finding none,
  // `continue`s — emitting NO event for that person, silently. In a grid that reads as
  // "decanting this person's Roth changes nothing", which is a tax conclusion drawn
  // from a missing account. Fail here instead.
  {
    const people  = cfg.persons ?? [];
    const inScope = owners === 'both' ? people.slice(0, 2)
      : owners === 'spouse' ? people.slice(1, 2)
        : people.slice(0, 1);
    for (const person of inScope) {
      const hasRoth = (cfg.accounts ?? []).some(a => a.role === ROLE_ROTH && a.ownerId === person.id);
      if (!hasRoth) continue;                       // nothing to decant ⇒ nothing to land
      const mapped = destFor(person.id);
      if (mapped) {
        if (!(cfg.accounts ?? []).some(a => a.stateKey === mapped)) {
          throw new Error(
            `rothDecant: destination "${mapped}" for "${person.id}" is not an account in this `
            + `scenario. It must be a state KEY, not an account id or name — an unresolvable key `
            + `lands the proceeds in the generic cash pool instead of the intended account.`);
        }
        continue;
      }
      const dest = (cfg.accounts ?? []).find(a => a.role === ROLE_US_STOCK && a.ownerId === person.id);
      if (!dest) {
        throw new Error(
          `rothDecant: "${person.id}" has a Roth but no ${ROLE_US_STOCK} account to receive the `
          + `decant, so the toolset would skip them silently. Pass destinationKey, or give them one.`);
      }
    }
  }

  set('earlyWithdrawalSchedule', [...byYear.values()].sort((a, b) => a.year - b.year));
  set('earlyWithdrawalOwner', owners);
  // The schedule is inert without the master switch. Only flip it ON — a zero-amount
  // arm must not enable a lever the scenario deliberately left off, or the "no decant"
  // control arm stops being a control.
  if (amount > 0) set('earlyWithdrawalEnabled', true);
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
