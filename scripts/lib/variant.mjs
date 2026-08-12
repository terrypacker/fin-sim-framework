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
 *   loan              {loanKey: {...}}  per-loan overrides (balance, payment, rate,
 *                                       interestOnly) — works on a synthesized
 *                                       mortgage or a standalone LoanAccount
 *   offset            {offsetKey: {...}} offset balance, the drawn facility, and where
 *                                      the freed cash goes
 *   facility          {offsetKey: {...}} the whole drawn facility as ONE lever —
 *                                      liability + proceeds + where they sit, so
 *                                      facility SIZE and park/deploy/none are
 *                                      separately sweepable axes
 *   expenseEvents     [{...}]          dated one-off expenses in a chosen currency,
 *                                      optionally funded from a nominated account
 *                                      (design 86 G8/G9); APPENDS and auto-enables
 *                                      the EXPENSE_EVENTS spending strategy
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
  // Loans before offsets: `offset.deployTo` is a wealth-preserving MOVE, and sizing an
  // offset against its loan (the common case) needs the loan's final balance.
  if (levers.loan) {
    for (const [loanKey, o] of Object.entries(levers.loan)) applyLoan(out, set, loanKey, o);
  }
  // After `loan` (so the base lever supplies rate and term and this supplies the SIZE)
  // and before `offset` (so an explicit offset lever can still override the placement).
  if (levers.facility) {
    for (const [offsetKey, o] of Object.entries(levers.facility)) applyFacility(out, set, offsetKey, o);
  }
  if (levers.expenseEvents) applyExpenseEvents(out, set, levers.expenseEvents);
  if (levers.offset) {
    for (const [stateKey, o] of Object.entries(levers.offset)) applyOffset(out, stateKey, o);
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

// ─── debt levers (design 86) ─────────────────────────────────────────────────

/**
 * Per-loan overrides, keyed by the LOAN's state key.
 *
 *   balance        number   outstanding principal
 *   monthlyPayment number   fixed P&I payment (inert when interestOnly)
 *   primeSpread    number|null   rate = Prime(country,t) + spread; null ⇒ fixed
 *   interestRate   number   the fixed absolute rate (used only when primeSpread is null)
 *   interestOnly   boolean  pay exactly the accrued interest (design 86 G2)
 *   deductibleFraction number|null  income-producing share of the loan's purpose (G3)
 *
 * **Two places a loan can come from**, and this writes whichever exists:
 *
 *  1. A mortgage — the loan does not exist as an authored account at all. It is
 *     SYNTHESIZED at build time from the property record's `mortgage*` /
 *     `monthlyMortgage` fields (`synthesizeLoanForProperty`, design 54 P2), under the
 *     deterministic key `${propStateKey}Loan`. So the fields to write are on the
 *     PROPERTY, not on any account.
 *  2. A standalone `LoanAccount` in `cfg.accounts`.
 *
 * In both cases a *persisted* `initialState[loanKey]` may also exist — a workbench
 * export carries one — and it shadows whatever the toolset synthesizes. Writing the
 * record without the state entry gives a lever that is silently inert against exactly
 * the configs studies are run on.
 *
 * `monthlyPayment` is left alone when absent, which is a trap worth knowing:
 * a payment below the accrued interest does not error, it negatively amortizes
 * (design 86 G2). Raising `balance` without raising the payment is how a study
 * silently ends up measuring a runaway loan. Prefer `interestOnly: true`, which
 * derives the payment and cannot be set wrong.
 */
export function applyLoan(cfg, set, loanKey, o = {}) {
  const acct = (cfg.accounts ?? []).find(a => a.stateKey === loanKey);
  const prop = (cfg.realProperties ?? []).find(p => `${p.stateKey}Loan` === loanKey);
  const st   = cfg.initialState?.[loanKey];
  if (!acct && !prop && !st) throw new Error(`loan lever: no loan "${loanKey}" `
    + `(have: ${loanKeys(cfg).join(', ') || 'none'})`);

  // record field → (property field, loan/account field)
  const MAP = {
    balance:        ['mortgageBalance',      'balance'],
    monthlyPayment: ['monthlyMortgage',      'monthlyPayment'],
    primeSpread:    ['mortgagePrimeSpread',  'primeSpread'],
    interestRate:   ['mortgageInterestRate', 'interestRate'],
    interestOnly:   ['mortgageInterestOnly', 'interestOnly'],
    // design 86 G3 — income-producing share of the loan's purpose. `null` (default)
    // keeps the pre-86 rule: fully deductible while the property rents.
    deductibleFraction: ['mortgageDeductibleFraction', 'deductibleFraction'],
    // design 86 G6 — absolute calendar years, not durations.
    interestOnlyUntilYear: ['mortgageInterestOnlyUntilYear', 'interestOnlyUntilYear'],
    maturityYear:          ['mortgageMaturityYear',          'maturityYear'],
    // design 86 G7/P8 — foreign units per USD when the debt was INCURRED. §988 gain on
    // every principal repayment is measured from it, so a lever that moves `balance`
    // and leaves this alone prices newly-borrowed dollars against a rate that never
    // applied to them. See applyFacility, which re-books rather than making the caller
    // remember.
    bookingFxRate: ['mortgageBookingFxRate', 'bookingFxRate'],
  };

  for (const [field, [propField, loanField]] of Object.entries(MAP)) {
    if (!(field in o)) continue;          // `in`, not != null: primeSpread null is meaningful
    const v = o[field];
    if (prop) prop[propField] = v;
    if (acct) acct[loanField] = v;
    if (st)   st[loanField]   = v;
  }

  // No placeholder `monthlyMortgage` is needed to force a payment event: the real
  // -property toolsets now gate the LOAN_PAYMENT schedule on `propertyNeedsLoanPayment`,
  // which counts an interest-only or term-bearing mortgage as payable even though its
  // authored `monthlyMortgage` is inert (design 86 G6). A spec that sets `interestOnly`
  // and leaves the payment at 0 gets the derived interest payment, not a free loan.

  // `prop.*` params are read by the param→node cascade on the compile branch and
  // would otherwise re-stamp the record from a stale param value.
  if (prop && 'balance' in o) set(`prop.${prop.stateKey}.mortgageBalance`, o.balance);
}

/** Every loan state key this cfg can address, for a useful error message. */
function loanKeys(cfg) {
  const keys = new Set();
  for (const a of cfg.accounts ?? []) if (a.type === 'loan' || a.__type === 'LoanAccount') keys.add(a.stateKey);
  for (const p of cfg.realProperties ?? []) if ((p.mortgageBalance ?? 0) > 0) keys.add(`${p.stateKey}Loan`);
  for (const [k, v] of Object.entries(cfg.initialState ?? {})) if (v?.type === 'loan') keys.add(k);
  return [...keys];
}

/**
 * Offset-account overrides, keyed by the offset's state key.
 *
 *   fromBalance      number       the DRAWN FACILITY: seed the offset here first
 *   balance          number       the offset's cash balance
 *   deployTo         stateKey     where the DIFFERENCE goes (see below)
 *   drawdownPriority number|null  where the offset sits in the liquidation order
 *
 * **`fromBalance` is what makes a facility-size axis honest.** Studying a facility
 * larger than the one the scenario authors means the `loan` lever raises the
 * liability — and the proceeds have to land somewhere in EVERY arm, not just the one
 * that parks them. Set `fromBalance` to the facility size in both arms:
 *
 *   park:   { fromBalance: F, balance: F }
 *   deploy: { fromBalance: F, balance: 0, deployTo: 'usStockAccount' }
 *
 * Omit it and the parking arm receives the uplift (raising an offset with no
 * `deployTo` credits the difference, which is right — it IS the loan proceeds) while
 * the deploying arm starts from the authored balance and is short the uplift for the
 * whole horizon. That is not a small bias: it compounds.
 *
 * **`drawdownPriority` on an offset is a DECISION, not a detail.** It is tempting to
 * reason that an offset is a transaction account, so the money is liquid, so it ought
 * to carry a priority. Do not: giving it one models a third strategy that is neither
 * arm of an offset study — "park the money in the offset, then spend it down FIRST".
 * Measured on a real plan, `drawdownPriority: 2` drained a full A$500k offset to zero
 * within four years, before the brokerage was touched at all, and the arm that was
 * supposed to test parking the money quietly stopped testing anything.
 *
 * `null` (excluded from drawdown) is the correct expression of "it stays in the
 * offset". The liquidity is real, but it is optionality the strategy is choosing not
 * to exercise. Set a priority only when spending the offset down is the thing being
 * modelled — and then say so in the spec.
 *
 * **`deployTo` moves value, it does not create it.** Lowering an offset from X to Y
 * without a destination destroys `X − Y` of wealth, and arms that don't hold total
 * wealth constant are not comparable — the whole point of an offset study is *where*
 * a fixed pot sits, not how big it is. Raising the balance pulls the difference back
 * out of `deployTo` the same way.
 *
 * Holdings are kept in step with the balance on both sides. An account's balance and
 * its holdings' `marketValue` are separate stores that do NOT self-reconcile: editing
 * one leaves the other stale, and the next year-end sync silently reverts to whichever
 * the engine treats as authoritative. `costBasis` is scaled with `marketValue` so
 * moving cash into a taxable account does not manufacture a phantom capital gain.
 *
 * An AU offset is AUD and the obvious `deployTo` targets are often USD, so the move is
 * FX-converted at the scenario's `exchangeRateUsdToAud`. Moving the raw number across
 * a currency boundary would conserve *digits* rather than value — an A$500k offset
 * emptied into a USD brokerage would create roughly a third of itself out of nothing,
 * and every arm would be measuring a different-sized pot.
 */
export function applyOffset(cfg, stateKey, o = {}) {
  const target = resolveAccountPair(cfg, stateKey, 'offset lever');
  if ('drawdownPriority' in o) target.setField('drawdownPriority', o.drawdownPriority);
  // §988 acquisition rate for the AUD sitting in the offset (design 87 G3). An unstamped
  // pool is stamped at the spot of its FIRST DISPOSITION, which for an offset is the first
  // loan payment — potentially years after the money arrived. See applyFacility for why
  // that is not a detail.
  if ('fxBasisRate' in o) target.setField('fxBasisRate', o.fxBasisRate);
  // `fromBalance` credits the DRAWN FACILITY to the offset before anything is moved
  // out of it, and it is what makes a facility-size axis wealth-matched. Drawing a
  // loan is two entries: the `loan` lever writes the liability, this writes the cash.
  // Without it, only the arm that PARKS the proceeds ever receives them: raising the
  // offset with no `deployTo` credits the difference (correctly, as loan proceeds),
  // while the arm that deploys starts from the offset's authored balance and is short
  // the uplift for the whole horizon. On the study that found this (design 86 §8.6) the
  // head start compounded for the full 44-year horizon and was larger than the effect
  // the arms had been built to measure.
  if (o.fromBalance != null) target.setBalance(o.fromBalance);
  if (o.balance == null) return;
  const before = target.balance();
  const delta  = before - o.balance;      // > 0 ⇒ this much leaves the offset (source currency)

  target.setBalance(o.balance);

  if (o.deployTo && Math.abs(delta) > 0.005) {
    const dest = resolveAccountPair(cfg, o.deployTo, 'offset lever deployTo');
    const rate = fxFactor(cfg, target.currency(), dest.currency());
    dest.setBalance(dest.balance() + delta * rate);
  }
}

/**
 * `facility` lever — the whole drawn facility as ONE lever, keyed by the OFFSET's
 * state key.
 *
 *   loan     stateKey       the loan the offset stands against (required)
 *   size     number         facility size F: writes `loan.balance = F` AND credits the
 *                           offset with F before anything is moved out of it
 *   mode     'hold' | 'deploy' | 'none'
 *   deployTo stateKey       destination for `mode: "deploy"` (required there)
 *   drawdownPriority number|null  passed to the offset; default null, see applyOffset
 *   bookingFxRate number|null  §988 booking rate for the DEBT leg. Defaults to the
 *                           scenario's spot rate — the facility is drawn TODAY.
 *   fxBasisRate   number|null  §988 acquisition rate for the DEPOSIT leg (the offset's
 *                           own AUD). Defaults to the same spot, which is what makes the
 *                           two legs cancel. Setting one without the other is a bug.
 *
 * **Why this exists rather than "just write `loan` and `offset` yourself".** Sizing a
 * facility has to move the liability and the proceeds in LOCKSTEP, and a `variant-grid`
 * axis writes exactly one dotted path — so a size sweep had to be one grid per size,
 * with the two halves matched only by whoever wrote the spec files. Here `size` and
 * `mode` are separate sub-keys of one object, so a grid can put facility size on one
 * axis and the placement decision on another and the arms cannot come apart.
 *
 * **`mode: "none"` is the no-facility arm**, and it is a different question from
 * `"deploy"`. `deploy` vs `hold` asks *given that I borrowed, park it or invest it*;
 * `none` vs `hold` asks *should I take the facility at all* — which is the only pairing
 * in which the loan's RATE is the quantity under study, because a fully offset loan
 * accrues no interest and its rate is inert until the offset is drawn. `none` ignores
 * `size` and discharges the loan.
 *
 * **All three modes are wealth-matched at t0 by construction**, which is the property
 * the hand-written arms got wrong (design 86 §8.6, `fromBalance`): `hold` is +F cash
 * −F debt, `deploy` is +F elsewhere −F debt, `none` is neither. Any arm set built from
 * this lever nets to the same t0 balance sheet without the caller checking.
 *
 * **It also re-books the §988 rate on BOTH LEGS, and that is not a detail.** An offset
 * facility is a two-legged §988 position (design 87 §3): the AUD debt realizes exchange
 * gain on every principal repayment, measured from the rate at which the debt was
 * INCURRED, and the AUD deposit realizes the mirror image on every disposition, measured
 * from the rate at which the currency was ACQUIRED. Both legs are built.
 *
 * They cancel exactly — at every payment date, whatever the FX path does in between —
 * **if and only if the two rates are the same**:
 *
 *     gain(debt)    = P × (1/r_book − 1/r_pay)
 *     gain(deposit) = P × (1/r_pay  − 1/r_acq)
 *
 * which is design 87 §3's whole point: a fully offset facility is §988-neutral because it
 * is economically FX-neutral. So a lever positing a facility drawn TODAY has to stamp
 * today's spot on *both* legs. Setting only the debt's `bookingFxRate` is worse than
 * setting neither: the deposit is then stamped at the spot of its FIRST DISPOSITION —
 * for an offset, the first loan payment, which an interest-only period can defer by
 * years — and the legs are de-synchronised by construction.
 *
 * Measured on the study this was written for: booking the debt at 1.55 while the deposit
 * self-stamped at 1.78 five years later left US\$41k of recognized §988 on a facility that
 * should have recognized approximately nothing, and the DEPOSIT leg was the larger of the
 * two. Both `bookingFxRate` and `fxBasisRate` accept an explicit value to opt out.
 */
export function applyFacility(cfg, set, offsetKey, o = {}) {
  const { loan: loanKey, mode = 'hold', deployTo = null } = o;
  if (!loanKey) throw new Error(`facility lever: "${offsetKey}" needs a "loan" state key`);
  if (!['hold', 'deploy', 'none'].includes(mode)) {
    throw new Error(`facility lever: mode "${mode}" is not one of hold, deploy, none`);
  }
  if (mode === 'deploy' && !deployTo) {
    throw new Error('facility lever: mode "deploy" needs a deployTo account');
  }

  // `none` discharges the facility outright, so its size is not a thing that can be
  // asked. Reading `size` there would let a size axis silently move the baseline.
  const size = mode === 'none' ? 0 : Number(o.size ?? 0);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`facility lever: size ${JSON.stringify(o.size)} is not a non-negative number`);
  }

  // `bookingFxRate` in the LOAN's own convention (foreign units per USD), which is the
  // convention `exchangeRateUsdToAud` already uses. An unknown rate stays unstated: the
  // handler then books at the first payment's spot, which understates §988 rather than
  // inventing it (loan-classes.js).
  const spot    = numericParams(cfg).get('exchangeRateUsdToAud') ?? null;
  const booking = 'bookingFxRate' in o ? o.bookingFxRate : spot;
  const basis   = 'fxBasisRate'   in o ? o.fxBasisRate   : spot;

  applyLoan(cfg, set, loanKey, { balance: size, ...(booking != null ? { bookingFxRate: booking } : {}) });
  applyOffset(cfg, offsetKey, {
    fromBalance: size,
    balance: mode === 'hold' ? size : 0,
    ...(mode === 'deploy' ? { deployTo } : {}),
    drawdownPriority: 'drawdownPriority' in o ? o.drawdownPriority : null,
    // The deposit leg, stamped at the same rate as the debt leg — see the header.
    ...(basis != null ? { fxBasisRate: basis } : {}),
  });
}

/**
 * `expenseEvent` lever (design 86 G8/G9) — append dated one-off expenses and make
 * sure the strategy that consumes them is switched on.
 *
 * Two things it does beyond writing the list, both of which are silently-inert traps
 * if skipped:
 *
 *  1. **Enables `EXPENSE_EVENTS` in `spendingStrategy`.** That param is a MULTI-select
 *     array, so this appends rather than replaces — clobbering it would disable the
 *     scenario's real spending strategy and change every arm's spending, not just the
 *     one being tested.
 *  2. **Writes through `makeSetParam`**, hitting both param stores. `expenseEvents`
 *     authored into only one is read by some tools and not others.
 *
 * Events APPEND to any the scenario already authors, so an arm adds its shock without
 * deleting the plan's own events. Pass `replace: true` to author the list outright.
 *
 * @param {object} cfg
 * @param {function} set  makeSetParam(cfg)
 * @param {object|Array} spec  one event, an array of them, or
 *                             `{ replace?: boolean, events: [...] }`
 */
export function applyExpenseEvents(cfg, set, spec) {
  const replace = !Array.isArray(spec) && spec?.replace === true;
  const events  = Array.isArray(spec) ? spec : (spec?.events ?? [spec]);
  const clean   = events.filter(e => e && e.date && e.amount);
  if (clean.length === 0 && !replace) return;

  const existing = replace ? [] : (allParams(cfg).expenseEvents ?? []);
  set('expenseEvents', [...existing, ...clean.map(e => ({ ...e }))]);

  const strategies = allParams(cfg).spendingStrategy;
  const list = Array.isArray(strategies) ? [...strategies] : [strategies].filter(Boolean);
  if (!list.includes('EXPENSE_EVENTS')) set('spendingStrategy', [...list, 'EXPENSE_EVENTS']);
}

/**
 * Multiplier converting an amount in `from` into `to`, using the scenario's
 * USD→AUD rate. Unknown or equal currencies ⇒ 1.
 */
function fxFactor(cfg, from, to) {
  if (!from || !to || from === to) return 1;
  const usdToAud = numericParams(cfg).get('exchangeRateUsdToAud');
  if (!usdToAud) throw new Error(
    `offset lever: moving ${from} → ${to} needs exchangeRateUsdToAud, which this cfg does not set`);
  if (from === 'USD' && to === 'AUD') return usdToAud;
  if (from === 'AUD' && to === 'USD') return 1 / usdToAud;
  throw new Error(`offset lever: no rate for ${from} → ${to}`);
}

/**
 * Both representations of one account — the authored record in `cfg.accounts` and the
 * persisted `cfg.initialState` entry — behind a single balance accessor that keeps
 * them, and their holdings, consistent. Either may be absent; at least one must exist.
 */
function resolveAccountPair(cfg, stateKey, who) {
  const rec = (cfg.accounts ?? []).find(a => a.stateKey === stateKey);
  const st  = cfg.initialState?.[stateKey];
  if (!rec && !st) throw new Error(`${who}: no account "${stateKey}"`);

  const balance = () => (rec?.balance ?? rec?.initialValue ?? st?.balance ?? 0);

  // `currency` is a {code, symbol} object on a record and sometimes a bare string.
  const currency = () => {
    const c = rec?.currency ?? st?.currency;
    return (typeof c === 'string' ? c : c?.code) ?? null;
  };

  const setBalance = (next) => {
    const v = Math.round(next * 100) / 100;
    for (const node of [rec, st]) {
      if (!node) continue;
      const prev = node.balance ?? node.initialValue ?? 0;
      node.balance = v;
      if ('initialValue' in node) node.initialValue = v;
      scaleHoldings(node.holdings, prev, v);
    }
  };

  const setField = (field, value) => {
    for (const node of [rec, st]) if (node) node[field] = value;
  };

  return { balance, currency, setBalance, setField };
}

/**
 * Rescale an account's holdings from `prev` to `next` total, preserving the mix.
 * A holdings-less (plain cash) account is left alone. When `prev` is 0 there is no
 * mix to preserve, so a single holding absorbs the whole amount and a multi-holding
 * account is left for the caller to notice — silently inventing an allocation is
 * worse than an obviously untouched one.
 */
function scaleHoldings(holdings, prev, next) {
  if (!Array.isArray(holdings) || holdings.length === 0) return;
  if (prev > 0.005) {
    const k = next / prev;
    for (const h of holdings) {
      h.marketValue = Math.round((h.marketValue ?? 0) * k * 100) / 100;
      if (h.costBasis != null) h.costBasis = Math.round(h.costBasis * k * 100) / 100;
    }
    return;
  }
  if (holdings.length === 1) {
    const h = holdings[0];
    h.marketValue = next;
    if (h.costBasis != null) h.costBasis = next;   // fresh money: basis = market, no phantom gain
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
 *
 * ─── do NOT use spendTotal to compare loan structures ────────────────────────
 *
 * `spendTotal` splits one budget into an expense line that INFLATES (the bands are
 * real, scaled by the price level each year) and a debt-service line that does NOT
 * (a nominal interest or P&I figure on a nominal balance). The two arms of an offset
 * study therefore diverge enormously in REAL spending even though both were asked for
 * the same all-in number: a fully offset loan puts the whole budget on the inflating
 * line, while an unoffset one freezes a third of it in nominal terms for the horizon.
 * Measured on a real plan, that made the *unoffset* arm look ~4 percentage points more
 * robust to a market downturn — an artefact of it quietly spending far less in real
 * terms, with no economic content whatsoever.
 *
 * For any study varying loan structure, hold `monthlyExpenses` equal instead and let
 * total outflow differ. Debt service is then a genuine cost difference between the
 * arms, which is the thing being measured, and it shows up in terminal wealth rather
 * than hiding inside a spending assumption.
 *
 * An INTEREST-ONLY mortgage (design 86 G2) has no fixed payment to subtract — the
 * engine derives it monthly from the live rate and the offset-reduced principal — so
 * `monthlyMortgage` on such a property is a placeholder, not a cash flow. Its debt
 * service is estimated here at the t0 rate. That estimate drifts as Prime moves and as
 * an offset drains, which is a real limitation: arms that differ in loan structure do
 * not hold total outflow exactly constant, only approximately. Sweep the rate rather
 * than trusting one cell.
 */
/**
 * A mortgaged property's monthly debt service at t0, in the property's currency.
 *
 * P&I: the authored `monthlyMortgage`. Interest-only: the accrued interest on the
 * offset-reduced principal at the t0 rate, because `monthlyMortgage` is inert there.
 * A Prime-linked loan resolves `Prime(country) + spread` from the params, falling back
 * to the absolute `mortgageInterestRate`.
 */
function monthlyDebtService(cfg, prop) {
  if (!prop) return 0;
  if (!prop.mortgageInterestOnly) return prop.monthlyMortgage ?? 0;

  const params = numericParams(cfg);
  const prime  = params.get(prop.country === 'AU' ? 'auPrimeRate' : 'usPrimeRate');
  const rate   = (prop.mortgagePrimeSpread != null && prime != null)
    ? prime + prop.mortgagePrimeSpread
    : (prop.mortgageInterestRate ?? 0);

  // Offsets linked to this property suppress the interest-bearing principal 1:1.
  let offset = 0;
  for (const a of cfg.accounts ?? []) {
    if (a.offsetsPropertyKey === prop.stateKey) offset += Math.max(0, a.balance ?? 0);
  }
  return Math.max(0, (prop.mortgageBalance ?? 0) - offset) * rate / 12;
}

/**
 * A property whose mortgage is actually serviced — the same gate the real-property
 * toolsets schedule LOAN_PAYMENT on (`propertyNeedsLoanPayment`, loan-classes.js),
 * restated here because this module deliberately imports nothing from `src/`.
 * `monthlyMortgage > 0` alone is not it: an interest-only or term-bearing mortgage
 * derives its payment and leaves that field at 0, and missing those properties here
 * makes `spendTotal` subtract no debt service at all.
 */
function _isServicedMortgage(p) {
  if (!((p?.mortgageBalance ?? 0) > 0)) return false;
  return (p.monthlyMortgage ?? 0) > 0 || !!p.mortgageInterestOnly || p.mortgageMaturityYear != null;
}

export function applySpendTotal(cfg, set, total, propertyKey, { ownStrategy = true } = {}) {
  const mortgaged = (cfg.realProperties ?? []).filter(_isServicedMortgage);
  const prop = propertyKey
    ? (cfg.realProperties ?? []).find(p => p.stateKey === propertyKey)
    : mortgaged[0];

  if (propertyKey && !prop) throw new Error(`spendTotal: no property "${propertyKey}"`);
  if (mortgaged.length > 1 && !propertyKey) {
    throw new Error(`spendTotal: ${mortgaged.length} mortgaged properties `
      + `(${mortgaged.map(p => p.stateKey).join(', ')}) — pass spendTotalProperty to pick one`);
  }

  const mortgage = monthlyDebtService(cfg, prop);
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
