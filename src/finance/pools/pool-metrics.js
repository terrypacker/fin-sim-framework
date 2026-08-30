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
    default:                              return null;
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
      // min(what is parked, what is owed): cash above the debt suppresses no interest and
      // earns nothing, so it is not capacity — it is money sitting in the wrong place.
      const loan = loanForOffset(state, account);
      offsetCap += fx(Math.min(native, Math.max(0, loan?.balance ?? 0)));
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
  for (const pool of graph?.pools ?? []) out[pool.id] = poolMetrics(state, pool, ctx);
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
