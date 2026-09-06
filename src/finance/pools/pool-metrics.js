/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { toBaseCurrency, currencyOf } from '../fx/to-base-currency.js';
import { POOL_TARGET_MODE, POOL_CAPACITY_MODE, POOL_SPEND_BASIS } from './liquidity-graph.js';
import { ACCOUNT_TYPE }           from '../assets/account.js';
import { isDrawdownAccessible }   from '../derived-metrics/net-liquidity.js';

/**
 * DESIGN 97 §12.1 — a pool is not a balance.
 *
 * `FINDINGS.md` §6.3: the offset is `min(cash parked, outstanding debt)`, and the cap falls
 * on a schedule nobody authored — which is why its decay was invisible until it was plotted.
 * Nothing in the model expressed a pool that shrinks without anyone spending from it.
 *
 * So every pool carries BOTH numbers:
 *   - `balance`  — what is in it now;
 *   - `capacity` — the most it could hold, derived every period from live state.
 *
 * Capacity is **derived, never stored as truth**. The offset's ceiling is loan arithmetic and
 * has to stay so: a stored capacity drifts the moment the loan re-amortises (which it does —
 * see `offset-loan-reamortises-never-retires`).
 *
 * Two consequences downstream, both load-bearing:
 *   - a refill never fills a pool past its capacity, so the model cannot author the exact
 *     mistake the study warned against (pushing cash into a facility that suppresses no
 *     interest and earns nothing);
 *   - cover reporting reads CAPACITY, not balance.
 *
 * FX: every figure returned here is in the valuation BASE currency. A pool spanning an AUD
 * offset and a USD brokerage sleeve is the ordinary case, and a years-of-cover figure
 * computed on a mixed-currency sum means nothing.
 */

/**
 * The pool's live, value-weighted market return — Σ(mv × rate) / Σ mv over the claimed lots,
 * reading `state.effectiveGrowthRates` (the authored rate AFTER the period's shock
 * adjustment). Null when the pool holds no rated lots, which makes any gate reading it inert
 * rather than shut.
 *
 * ─── why this exists, and why a trailing high does not replace it ────────────
 *
 * `gate.sourceDrawdownUnder` measures the pool against its own peak BALANCE, and in a
 * DECUMULATION plan that conflates two different things: the market falling, and the
 * household spending the pool down. Measured on the reference plan, the growth pool sat 9–16 %
 * below its high in 2033–2040 — years in which the market had fully recovered — purely because
 * the spending had permanently removed capital from it. A 5 % gate therefore **latched shut
 * forever after the first crash**, which is not "harvest in up markets"; it is "never harvest
 * again".
 *
 * A live return has no such confound: a withdrawal does not change it.
 *
 * **Superseded in part (design 97 §20.14).** The confound above belongs to the SERIES, not to
 * the gate: `gate.drawdownBasis: 'INDEX'` measures the same threshold against the pool's
 * compounded return — a unit-value series no flow can move — and measured across 300 paired
 * paths it beats this return gate on median, win rate, left tail and interest paid. Read the
 * paragraph above as an argument against the trailing BALANCE, not against a drawdown gate.
 */
export function poolMarketReturn(state, pool) {
  const rates = state?.effectiveGrowthRates;
  if (!rates) return null;
  let weighted = 0, total = 0;
  for (const { key, sleeves } of pool.claims ?? []) {
    const account = state?.[key];
    for (const h of (account?.holdings ?? [])) {
      if (sleeves && !sleeves.includes(h?.allocation)) continue;
      const rate = rates[h?.rateKey];
      const mv   = h?.marketValue ?? 0;
      if (!Number.isFinite(rate) || !(mv > 0)) continue;
      weighted += mv * rate;
      total    += mv;
    }
  }
  return total > 0 ? weighted / total : null;
}

/** Σ market value of the lots of `account` inside `sleeves` (null ⇒ every lot). */
function holdingsValue(account, sleeves) {
  const holdings = account?.holdings;
  if (!Array.isArray(holdings) || holdings.length === 0) return null;
  let total = 0;
  for (const h of holdings) {
    if (sleeves && !sleeves.includes(h?.allocation)) continue;
    total += h?.marketValue ?? 0;
  }
  return total;
}

/**
 * The value one claim contributes, in the claimed account's OWN currency.
 *
 * Holdings are the authority when the account has any — that is what the disposal primitive
 * actually consumes, and a sleeve-narrowed claim has no other reading. `balance` is the
 * authority for cash-like accounts (savings, offset), which hold no lots. The two can
 * disagree on a brokerage (`holdings-balance-desync`); the pool follows what a draw would
 * really find.
 */
function claimValueNative(account, sleeves) {
  const fromHoldings = holdingsValue(account, sleeves);
  if (fromHoldings != null) return fromHoldings;
  if (sleeves) return 0;      // a sleeve-narrowed claim on an account with no lots holds nothing
  return Math.max(0, account?.balance ?? 0);
}

/**
 * The loan a given offset account reduces, or null.
 *
 * The join is property-keyed and mirrors `offsetBalanceForLoan` in the opposite direction:
 * an offset links to a PROPERTY (`offsetsPropertyKey`), a loan links to the same property
 * (`linkedPropertyKey`). Same-currency only, for the reason that function gives — a
 * misconfigured cross-currency link must not suppress principal 1:1 ignoring FX.
 */
export function loanForOffset(state, offset) {
  const propKey = offset?.offsetsPropertyKey;
  if (!propKey || !state) return null;
  const ccy = offset?.currency?.code ?? offset?.currency ?? null;
  for (const v of Object.values(state)) {
    if (v && typeof v === 'object' && v.type === 'loan'
        && v.linkedPropertyKey === propKey
        && (ccy == null || (v.currency?.code ?? v.currency) === ccy)) {
      return v;
    }
  }
  return null;
}

/**
 * The household's annual spend in base currency — the same reading `RebalanceToTargetReducer`
 * takes, deliberately: a years-of-spend TARGET and a years-of-spend COVER figure that read
 * different spend lines would silently disagree about what "4 years" means.
 *
 * `state.monthlyExpenses` is inflated every year by `InflationAdjustReducer`, which is the
 * whole point of a target expressed in years — the reserve grows with the spend line rather
 * than with the book.
 */
export function annualSpendBase(state, { expensesCurrency = 'RESIDENCE', baseCurrency = 'USD' } = {}) {
  const monthly = Number(state?.monthlyExpenses);
  if (!Number.isFinite(monthly) || monthly <= 0) return 0;
  const ccy = (expensesCurrency === 'RESIDENCE') ? baseCurrency : expensesCurrency;
  return toBaseCurrency(monthly * 12, ccy, baseCurrency, state);
}

/**
 * The spend line a YEARS_OF_SPEND spec reads (design 97 §12.2).
 *
 * `LIVE` is what §9 built and measured and stays the default. `TRAILING` is
 * `FINDINGS.md` §6.1's second-order concern made authorable: a guardrail strategy that cuts
 * spending in a bad year would otherwise shrink the reserve at the moment it is needed. The
 * trailing series is kept on pool state (`spendHistory`) rather than recomputed, because a
 * window that predates the run's start is not knowable from the journal.
 */
function spendForSpec(spec, ctx, poolState) {
  if (spec?.spendBasis !== POOL_SPEND_BASIS.TRAILING) return ctx.annualSpend;
  const hist = poolState?.spendHistory;
  if (!Array.isArray(hist) || hist.length === 0) return ctx.annualSpend;
  const n = Math.min(hist.length, Math.round(spec.trailingYears ?? 3));
  const window = hist.slice(-n);
  return window.reduce((s, v) => s + v, 0) / window.length;
}

/** Resolve a `{ mode, value }` size spec to a base-currency figure. */
function resolveSize(spec, ctx, poolState) {
  if (!spec) return null;
  switch (spec.mode) {
    case POOL_TARGET_MODE.YEARS_OF_SPEND: return spec.value * spendForSpec(spec, ctx, poolState);
    case POOL_TARGET_MODE.PERCENT:        return spec.value * (ctx.bookBase ?? 0);
    case POOL_TARGET_MODE.AMOUNT:         return spec.value;
    // YEARS_OF_SPEND_REMAINDER needs the OTHER pools' figures, which do not exist yet on this
    // per-pool pass. Left null here and filled by `resolveRemainderTargets` below; null is the
    // honest intermediate, and the rebalancer already reads a null target as "this pool sizes
    // nothing" rather than "size it to zero" (rebalance-to-target-reducer.js:365).
    default:                              return null;
  }
}

/**
 * Second pass: resolve every `YEARS_OF_SPEND_REMAINDER` target against the first pass.
 *
 * Design 97 §12.2b. A remainder pool holds whatever of an AGGREGATE cover target the pools it
 * names do not already provide, so it cannot be resolved until they are — which is why this is
 * a pass over `allPoolMetrics`' output rather than another case in `resolveSize`.
 *
 * **An UNCAPPED pool contributes its `target` when it has one, its balance when it does not.
 * A CAPPED pool always contributes its `utilised` cover.**
 *
 * The first half is the claim/cover distinction: a target is what the refill flows keep true,
 * so a cash pool sitting under it between refills must not move this target — reacting would
 * start a rebalance to fix what an edge is already fixing.
 *
 * The second half is why a capped pool is different, and it took the reference plan to show it.
 * A pool with a real ceiling cannot promise its target: the ceiling is not something a flow can
 * lift. An offset that should "hold as much as possible" is nonetheless authored WITH a target
 * — a `toTarget` edge into a pool with none is rejected at config time, since it would move
 * nothing every period — so its target is a number far above what it can hold, and counting it
 * would peg this remainder at zero forever.
 *
 * Its CAPACITY is no better, which is the part that is not obvious. On the reference plan the
 * offset reached a year with balance 0 and capacity ~$149k: the loan was still outstanding, so
 * the room existed, but the `growth → offset` refill was gated shut because the growth pool sat
 * 34% below its high. Crediting that room as cover under-provisioned the bond pool by the full
 * amount PRECISELY IN A DOWN MARKET — inverted from what a reserve is for. An empty pool is not
 * cover, however much room it has. So a capped pool counts `utilised` = min(balance, capacity),
 * the same figure §12.1 already defines as the cover this feature reports.
 *
 * Chains were rejected at config time, so one pass is enough and the order cannot matter.
 *
 * @param {object} out   - `allPoolMetrics` output, keyed by pool id; MUTATED in place
 * @param {Array}  pools - the graph's normalized pools
 * @param {object} ctx   - the metrics context (for the spend line)
 */
function resolveRemainderTargets(out, pools, ctx) {
  for (const pool of pools) {
    const spec = pool.target;
    if (spec?.mode !== POOL_TARGET_MODE.YEARS_OF_SPEND_REMAINDER) continue;
    const m = out[pool.id];
    if (!m) continue;
    const aggregate = spec.value * spendForSpec(spec, ctx, m);
    let covered = 0;
    for (const ref of spec.after) {
      const r = out[ref];
      if (!r) continue;                       // validated at config time; defensive here
      // `capped` distinguishes a REAL ceiling (OFFSET_CAP / AMOUNT / YEARS_OF_SPEND) from
      // `capacity` being the balance restated, and `poolMetrics` already records which.
      covered += r.capped
        ? (r.utilised ?? 0)
        : (Number.isFinite(r.target) ? r.target : (r.balance ?? 0));
    }
    m.target    = Math.max(0, aggregate - covered);
    // Everything downstream of `target` on this record was computed with it null, so the two
    // would disagree — and `shortfall` is what a `toTarget` refill moves. Recomputed, not
    // patched, so there is one expression of each.
    m.shortfall = Math.max(0, m.target - m.balance);
  }
}

/**
 * Metrics for one pool, all in base currency.
 *
 * @returns {{id, balance, capacity, target, floor, headroom, shortfall, yearsOfCover}}
 */
export function poolMetrics(state, pool, ctx) {
  let balance    = 0;
  let offsetCap  = 0;
  let hasOffsetCap = pool.capacity?.mode === POOL_CAPACITY_MODE.OFFSET_CAP;

  for (const { key, sleeves } of pool.claims) {
    const account = state?.[key];
    if (!account || typeof account !== 'object') continue;
    const fx     = (v) => toBaseCurrency(v, currencyOf(account, ctx.baseCurrency), ctx.baseCurrency, state);
    const native = claimValueNative(account, sleeves);
    balance += fx(native);
    if (hasOffsetCap) {
      // The CEILING is what is OWED. Cash above the debt suppresses no interest and earns
      // nothing, so it is money sitting in the wrong place — but that is a statement about
      // the balance being too big, not about the ceiling being small.
      //
      // Design 97 §12.1 wrote this as `min(balance, loan)` and §20 found what that does: a
      // ceiling that is never above the balance makes `headroom` identically zero, in BOTH
      // regimes, so **no flow can ever refill an offset pool** — least of all a drained one,
      // which is the only time a refill is wanted. It is the exact failure the BALANCE branch
      // below carries a warning about, one branch down and shipped.
      //
      // `min(balance, loan)` is still the right number for "how much of this pool is doing
      // work"; it is reported as `utilised`, which is what the cover reporting wants.
      const loan = loanForOffset(state, account);
      offsetCap += fx(Math.max(0, loan?.balance ?? 0));
    }
  }

  const poolState = state?.liquidityPools?.[pool.id];
  const target    = resolveSize(pool.target, ctx, poolState);
  const floor     = resolveSize(pool.floor,  ctx, poolState) ?? 0;

  let capacity;
  switch (pool.capacity?.mode) {
    case POOL_CAPACITY_MODE.OFFSET_CAP:     capacity = offsetCap; break;
    case POOL_CAPACITY_MODE.AMOUNT:         capacity = pool.capacity.value; break;
    case POOL_CAPACITY_MODE.YEARS_OF_SPEND: capacity = pool.capacity.value * spendForSpec(pool.capacity, ctx, poolState); break;
    default:                                capacity = balance; break;   // BALANCE: no ceiling of its own
  }

  // BALANCE mode means "this pool has no ceiling of its own", NOT "its ceiling is what it
  // currently holds". Conflating the two makes `headroom` identically zero and no refill can
  // ever fire — the failure is silent, because a pool at its stated capacity looks correct.
  const capped = pool.capacity?.mode != null && pool.capacity.mode !== POOL_CAPACITY_MODE.BALANCE;

  return {
    id:        pool.id,
    balance,
    capacity,
    // What the pool is actually doing, as distinct from what it could hold. For an offset
    // this is `min(parked, owed)` — design 97 §12.1's figure, in the field that means it —
    // and for every other capacity mode it is the balance, clamped at the ceiling.
    utilised:  capped ? Math.min(balance, capacity) : balance,
    // Whether `capacity` is a REAL ceiling or just the balance restated. §12.2b's remainder
    // clamp needs the distinction, and re-deriving it from the pool spec at the read site is
    // how the two come to disagree.
    capped,
    capped,
    target,
    floor,
    // What may still be ADDED (never past a real ceiling) and what is still WANTED.
    headroom:  capped ? Math.max(0, capacity - balance) : Infinity,
    shortfall: target != null ? Math.max(0, target - balance) : 0,
    // What may be TAKEN OUT without breaching the pool's own floor.
    available: Math.max(0, balance - floor),
    marketReturn: poolMarketReturn(state, pool),
    yearsOfCover: ctx.annualSpend > 0 ? balance / ctx.annualSpend : null,
  };
}

/** Metrics for every pool, keyed by id. */
export function allPoolMetrics(state, graph, ctx) {
  const out = {};
  const pools = graph?.pools ?? [];
  for (const pool of pools) out[pool.id] = poolMetrics(state, pool, ctx);
  // §12.2b — remainder targets read the pass above, so they resolve after all of it.
  resolveRemainderTargets(out, pools, ctx);
  return out;
}

/**
 * The context the metrics read. Built once per period by the flow reducer and reused, so a
 * period's gates, triggers and telemetry all see ONE spend line and ONE book.
 */
export function poolContext(state, { expensesCurrency = 'RESIDENCE', baseCurrency = 'USD', bookBase = 0 } = {}) {
  return {
    baseCurrency,
    expensesCurrency,
    bookBase,
    annualSpend: annualSpendBase(state, { expensesCurrency, baseCurrency }),
  };
}

/**
 * The ALLOCATION classes a spending reserve is made of. GOLD and EQUITY are deliberately
 * out: the question this answers is "how long could I spend without selling equity", and a
 * volatile sleeve cannot answer it however liquid it is.
 */
export const RESERVE_CLASSES = Object.freeze(['CASH', 'BOND']);

/** Account types whose whole balance IS cash — the only ones counted without lots. */
const RESERVE_CASH_TYPES = new Set([ACCOUNT_TYPE.CHECKING, ACCOUNT_TYPE.SAVINGS, ACCOUNT_TYPE.OFFSET]);

/**
 * What one account contributes to the household reserve, in its OWN currency.
 *
 * Mirrors `claimValueNative`'s holdings-first rule and adds the class filter, with one
 * deliberate asymmetry: an account with no lots counts only when it is CASH-LIKE. A wrapper
 * carrying a balance and no holdings has no allocation to read, and counting it whole would
 * report a 401(k) as a bond reserve.
 */
function reserveValueNative(account) {
  const fromHoldings = holdingsValue(account, RESERVE_CLASSES);
  if (fromHoldings != null) return fromHoldings;
  return RESERVE_CASH_TYPES.has(account?.type) ? Math.max(0, account?.balance ?? 0) : 0;
}

/**
 * DESIGN 97 §22.3 (extended) — the household's spending reserve, across the WHOLE book.
 *
 * The pool cube answers "what is in the pools". On a plan whose taxable accounts drain, that
 * stops being the same question as "how long can I spend without selling equity": the graph's
 * bond target is a portfolio-wide MIX weight, so the located planner puts the reserve wherever
 * there is room — and once that is a wrapper, no pool claims it and every pool reports zero.
 * Measured on the reference plan: the cube fell 4.8 -> 0.0 years between 2040 and 2055 while
 * the real accessible reserve never left the 4.9-5.4 year band.
 *
 * That gap is not closable by authoring. `liquidity-graph.js` refuses a sleeve narrowing on
 * any non-BROKERAGE account (§22.6) and `isPortfolioPool` requires every claim to be a
 * brokerage, so a pool cannot be both "the bond sleeve of my super" and an endpoint of a
 * REBALANCE edge. Hence a household-level figure alongside the per-pool ones, rather than a
 * pool that cannot exist.
 *
 * `isDrawdownAccessible` is the authority for the age gate — the same one `computeNetLiquidity`
 * uses (design 88 §5), so the reserve line and the control metric cannot drift apart. It
 * carries that authority's known coarseness: accessibility there is a per-ACCOUNT boolean, so
 * an under-age Roth counts WHOLE on the strength of `allowsEarlyWithdrawal`, where a draw
 * would really find only its `contributionBasis` (§22.3's trap). That overstates in the one
 * direction this metric should not, so read `accessible` before the age gates open as an upper
 * bound. Fixing it means returning an AMOUNT from the shared authority, which is §22.3's own
 * remaining work and belongs there rather than in a second copy of the rule here.
 *
 * @param {object}    state
 * @param {object}    ctx    `poolContext` output — supplies `annualSpend` and `baseCurrency`
 * @param {Date|null} date   the period instant, for the age gates
 * @returns {{accessible: number, locked: number, yearsOfCover: number|null}}
 */
export function householdReserve(state, ctx, date = null) {
  let accessible = 0;
  let locked     = 0;
  for (const account of Object.values(state ?? {})) {
    if (!account || typeof account !== 'object') continue;
    if (typeof account.balance !== 'number') continue;      // not an account-shaped entry
    const native = reserveValueNative(account);
    if (!(native > 0)) continue;
    const base = toBaseCurrency(native, currencyOf(account, ctx.baseCurrency), ctx.baseCurrency, state);
    // `isDrawdownAccessible` also excludes anything opted OUT of drawdown
    // (`drawdownPriority: null`), which is correct here for the same reason: money the
    // drawdown chain will not touch cannot fund a year of spending.
    if (isDrawdownAccessible(account, state, date)) accessible += base;
    else locked += base;
  }
  return {
    accessible,
    locked,
    yearsOfCover: ctx.annualSpend > 0 ? accessible / ctx.annualSpend : null,
  };
}
