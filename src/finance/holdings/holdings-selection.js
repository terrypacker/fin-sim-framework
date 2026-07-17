/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ALLOCATION } from './allocation.js';

/**
 * ALLOCATION-AWARE HOLDING SELECTION (design 65).
 *
 * The single shared liquidation primitive (`consumeHoldings` in holdings-fifo.js)
 * consumes an account's lots to satisfy a sale. Historically it walked the lots in
 * strict FIFO purchase-date order — blind to *what kind* of holding it sold. This
 * module builds the **comparator** the primitive sorts by, so a caller can steer the
 * liquidation along two orthogonal axes:
 *
 *  - **Lever A — sleeve order:** which ALLOCATION class (CASH / BOND / EQUITY / GOLD)
 *    to sell first. Ascending rank = sold first. Either a fixed class order
 *    (`sleeveOrder`) or an optimizable per-class weight (`sleeveWeights`, the design-58
 *    Lever-B analog: ascending weight = sold first).
 *  - **Lever B — lot strategy:** which lots *within* the chosen sleeve to consume —
 *    FIFO (oldest), HIFO / MIN_GAIN (least gain per dollar), or LOSS_FIRST (banks
 *    losses first). Finally implements the dormant `costBasisStrategy` hook.
 *
 * The comparator is total: sleeve rank, then lot rank, then a `purchaseDate` tie-break
 * so the result is deterministic and — when `selection` is null — byte-identical to the
 * old FIFO sort. The primitive's downstream tallies (realized basis, collectible split,
 * per-country / indexed / discount-eligible slices) are computed from *whichever* lots
 * are consumed, so they are unaffected by the ordering; only *which* lots get sold
 * changes.
 */

/** Sleeve sell-order strategies (Lever A). Ascending index ⇒ sold first. */
export const SLEEVE_ORDER = Object.freeze({
  // Tax-cost ascending: CASH (no gain) → BOND (small gains) → EQUITY (LTCG) →
  // GOLD (US 28% collectible). Raises cash from the least-taxed sleeve first.
  TAX_COST:        Object.freeze([ALLOCATION.CASH, ALLOCATION.BOND, ALLOCATION.EQUITY, ALLOCATION.GOLD]),
  // Spend the "safe" sleeves first and let the highest-growth sleeve (EQUITY)
  // compound longest — the classic retirement heuristic. Differs from TAX_COST only
  // in that GOLD is sold before EQUITY (risk framing, not tax framing).
  PRESERVE_GROWTH: Object.freeze([ALLOCATION.CASH, ALLOCATION.BOND, ALLOCATION.GOLD, ALLOCATION.EQUITY]),
});

/** The lot-selection strategies (Lever B) — widens the dormant `costBasisStrategy`. */
export const LOT_STRATEGY = Object.freeze({
  FIFO:       'FIFO',        // oldest first (today). Maximizes AU ≥12-month discount eligibility.
  HIFO:       'HIFO',        // highest cost basis first ⇒ least realized gain per dollar.
  MIN_GAIN:   'MIN_GAIN',    // synonym for HIFO — least realized gain per dollar.
  LOSS_FIRST: 'LOSS_FIRST',  // realize lots at a loss first (banks losses; coordinates with TLH).
  // SPECIFIC — a bracket-aware pick (design 61 §OQ3). Not yet implemented; the
  // primitive is intentionally tax-agnostic (it tallies, the caller taxes), so a
  // bracket-aware SPECIFIC needs caller-side rate context. Until then it behaves as
  // MIN_GAIN, the closest gain-minimizing proxy. See design 65 OQ3.
  SPECIFIC:   'SPECIFIC',
  // LADDER — ladder-aware drawdown (design 66 §G8, sell side / §10.9): raise cash the
  // way a ladder investor does — spend already-liquid CASH (a redeemed/matured rung)
  // first, then the NEAREST-maturity individual bond (its price has pulled to ≈ par so
  // selling it early realizes the least mark-to-market deviation), sparing the growth
  // sleeves and perpetual bond funds. See `ladderKey`.
  LADDER:     'LADDER',
});

/** Milliseconds → the epoch time of a lot's purchase; null/invalid ⇒ 0 (oldest). */
export function purchaseTs(h) {
  if (!h?.purchaseDate) return 0;
  const t = h.purchaseDate instanceof Date
    ? h.purchaseDate.getTime()
    : new Date(h.purchaseDate).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Lever-A sleeve-order MODES — the scenario/opt enum a user selects (distinct from
 * the concrete `SLEEVE_ORDER` arrays, which are what a mode resolves to):
 *  - `FIFO`            : no sleeve bias (walk lots by purchaseDate) — the default.
 *  - `TAX_COST`        : SLEEVE_ORDER.TAX_COST (CASH→BOND→EQUITY→GOLD).
 *  - `PRESERVE_GROWTH` : SLEEVE_ORDER.PRESERVE_GROWTH (CASH→BOND→GOLD→EQUITY).
 *  - `WEIGHTED`        : an optimizable per-class weight vector (ascending ⇒ first).
 */
export const SLEEVE_ORDER_MODES = Object.freeze(['FIFO', 'TAX_COST', 'PRESERVE_GROWTH', 'WEIGHTED']);

/** Lever-B lot strategies exposed as the scenario/opt enum for `drawdownLotStrategy`. */
export const LOT_STRATEGIES = Object.freeze(['FIFO', 'HIFO', 'LOSS_FIRST', 'SPECIFIC', 'LADDER']);

/**
 * The ALLOCATION classes carrying a Lever-A `WEIGHTED` search weight. Mirrors the
 * design-58 per-role weight surface: one continuous weight per sleeve, ascending
 * sort = sold first. (OTHER is excluded — it is not a disposable investment sleeve.)
 */
export const DRAWDOWN_SLEEVE_CLASSES = Object.freeze([
  ALLOCATION.CASH, ALLOCATION.BOND, ALLOCATION.EQUITY, ALLOCATION.GOLD,
]);

/**
 * Param-key prefix + separator for the Lever-A per-class sleeve weights, e.g.
 * `sleeveWeight::EQUITY`. A `::` (not a `.`) is REQUIRED — the MC/Opt/MPC candidate
 * path applies params through `set()`, which silently drops dotted keys whose parent
 * node doesn't pre-exist (see `optimizer-param-key-dot-collision`). Kept a flat token.
 * Lives here (not the scenario) so the toolset projection can import it without a
 * circular scenario↔toolset dependency.
 */
export const SLEEVE_WEIGHT_PREFIX = 'sleeveWeight';
export const SLEEVE_WEIGHT_SEP    = '::';
/** The `drawdownSleeveOrder` sentinel that activates the Lever-A weight vector. */
export const SLEEVE_WEIGHT_MODE   = 'WEIGHTED';

/** The param key for a sleeve's Lever-A weight, e.g. `sleeveWeight::EQUITY`. */
export function sleeveWeightKey(cls) {
  return `${SLEEVE_WEIGHT_PREFIX}${SLEEVE_WEIGHT_SEP}${cls}`;
}

/**
 * Read the flat `sleeveWeight::<CLASS>` params off a params object into a
 * { CLASS: weight } map for state projection. Returns null when none are present
 * (so a scenario with no sleeve weights carries no map).
 */
export function sleeveWeightsFromParams(p) {
  if (!p) return null;
  const out = {};
  for (const cls of DRAWDOWN_SLEEVE_CLASSES) {
    const v = p[sleeveWeightKey(cls)];
    if (v != null) out[cls] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Resolve the runtime `state` drawdown fields into a `selection` object for
 * `consumeHoldings` — or **null** when the policy is plain FIFO with no sleeve bias,
 * so the default scenario stays byte-identical to the pre-design-65 behavior.
 *
 * @param {{ sleeveOrderMode?: string, lotStrategy?: string,
 *           sleeveWeights?: Object<string,number>|null }} [fields={}]
 * @returns {{ sleeveOrder?: string[], sleeveWeights?: Object<string,number>, lotStrategy: string }|null}
 */
export function resolveDrawdownSelection({ sleeveOrderMode = 'FIFO', lotStrategy = 'FIFO', sleeveWeights = null, rebalanceWeight = 0 } = {}) {
  const lot  = LOT_STRATEGIES.includes(lotStrategy) ? lotStrategy : 'FIFO';
  const wMix = Number.isFinite(rebalanceWeight) && rebalanceWeight > 0 ? rebalanceWeight : 0;
  let sleeveOrder = null;
  let weights     = null;
  switch (sleeveOrderMode) {
    case 'TAX_COST':        sleeveOrder = SLEEVE_ORDER.TAX_COST; break;
    case 'PRESERVE_GROWTH': sleeveOrder = SLEEVE_ORDER.PRESERVE_GROWTH; break;
    case 'WEIGHTED':        weights = (sleeveWeights && Object.keys(sleeveWeights).length) ? sleeveWeights : null; break;
    case 'FIFO':
    default:                break;
  }
  // No sleeve bias, plain FIFO lots, and no rebalance coupling ⇒ null (identical to
  // the historic FIFO path). Lever C (wMix > 0) forces a non-null policy so the
  // per-account coupling can engage in withRebalanceCoupling.
  if (!sleeveOrder && !weights && lot === 'FIFO' && wMix === 0) return null;
  const selection = { lotStrategy: lot };
  if (sleeveOrder) selection.sleeveOrder     = sleeveOrder;
  if (weights)     selection.sleeveWeights   = weights;
  if (wMix > 0)    selection.rebalanceWeight = wMix;
  return selection;
}

/**
 * Lever C — rebalance coupling (design 65 §4-C). Bias the sleeve order toward the
 * **over-weight** class (per the account's design-61 `targetComposition`, stamped
 * into state each period by RebalanceToTargetReducer) so a spending debit *doubles
 * as* a rebalance — one CGT event instead of a separate drawdown + rebalance.
 *
 * Returns `selection` unchanged when coupling is off (`rebalanceWeight` absent/≤0),
 * the account has no stamped target, or the account is empty — so a design-61-off
 * account transparently falls back to the Lever-A order.
 *
 * The blended per-class score sorts **ascending** (sold first), so the mix term is
 * SUBTRACTED — an over-weight sleeve (actualFrac − targetFrac > 0) gets a lower score
 * and is sold first; an under-weight sleeve is pushed later:
 *
 *   score(class) = taxRankNorm(class) − wMix · (actualFrac − targetFrac)
 *
 * `taxRankNorm` is the base Lever-A sleeve-order index normalized to [0,1] (0 when no
 * base order, i.e. a FIFO base coupled purely by mix). A class held but not in the
 * target (targetFrac 0) reads as fully over-weight ⇒ sold first (drops legacy sleeves).
 *
 * @param {object|null} selection - a resolveDrawdownSelection result (may be null)
 * @param {object}      account   - the account being liquidated (reads holdings + targetComposition)
 */
export function withRebalanceCoupling(selection, account) {
  if (!selection || !(selection.rebalanceWeight > 0)) return selection;
  const target = account?.targetComposition;
  if (!target || typeof target !== 'object' || !Object.keys(target).length) return selection;
  const holdings = account?.holdings ?? [];
  const total = holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
  if (total <= 0) return selection;

  const actual = {};
  for (const h of holdings) {
    const a = h?.allocation;
    if (a) actual[a] = (actual[a] ?? 0) + (h?.marketValue ?? 0);
  }
  const order = selection.sleeveOrder;
  const n     = order?.length ?? 0;
  const taxRankNorm = (cls) => {
    if (!order || n === 0) return 0;
    const i = order.indexOf(cls);
    if (i === -1) return 1;            // unlisted classes are the most-taxed ⇒ sold last (before mix bias)
    return n > 1 ? i / (n - 1) : 0;
  };
  const wMix = selection.rebalanceWeight;
  const sleeveScore = (cls) => {
    const actualFrac = (actual[cls] ?? 0) / total;
    const targetFrac = target[cls] ?? 0;
    return taxRankNorm(cls) - wMix * (actualFrac - targetFrac);
  };
  return { ...selection, sleeveScore };
}

/** A lot's basis-to-value ratio (0 = pure gain, ≥1 = at/under water). Guards mv≤0. */
function basisRatio(h) {
  const mv = h?.marketValue ?? 0;
  if (mv <= 0) return Number.POSITIVE_INFINITY; // empty lots sort last within a sleeve
  return (h?.costBasis ?? 0) / mv;
}

/** A lot's absolute unrealized gain (marketValue − costBasis). */
function unrealizedGain(h) {
  return (h?.marketValue ?? 0) - (h?.costBasis ?? 0);
}

/** Milliseconds → a bond's maturity epoch; null when it is not an individual bond. */
function maturityTs(h) {
  if (h?.maturityDate == null) return null;
  const t = h.maturityDate instanceof Date ? h.maturityDate.getTime() : new Date(h.maturityDate).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Lever-B `LADDER` sort key (design 66 §G8 ladder-aware drawdown). A single
 * per-element key — like `basisRatio` for HIFO — so `(a,b) => key(a) − key(b)` is a
 * valid TOTAL order (transitive, deterministic, replay-safe). Ascending ⇒ sold first,
 * encoding "matured-cash → nearest rung → … → far rung, sparing the growth engine":
 *   - CASH             → −∞          : already-liquid proceeds (a redeemed/matured rung) first;
 *   - individual BOND  → maturityTs  : nearest-maturity rung first (price ≈ par ⇒ least
 *                                      realized mark-to-market deviation);
 *   - everything else  → +∞          : perpetual bond funds (no rung liquidity) + EQUITY/
 *                                      GOLD/OTHER last, preserving the growth sleeves.
 * Ties (same tier / equal maturity) fall through to the purchaseDate tie-break. When a
 * sleeveOrder / weights / score bias is ALSO active the ±∞ tiers are inert — sleeveRank
 * has already grouped the allocations, so within the BOND sleeve this reduces to purely
 * nearest-maturity-first with funds last (the intended ladder ordering).
 */
function ladderKey(h) {
  if (h?.allocation === ALLOCATION.CASH) return Number.NEGATIVE_INFINITY;
  const m = (h?.allocation === ALLOCATION.BOND) ? maturityTs(h) : null;
  return m == null ? Number.POSITIVE_INFINITY : m;
}

/** Infinity-safe ascending numeric compare (−∞/+∞ ties ⇒ 0, not NaN). */
function cmpNum(x, y) {
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Build a (holding) → rank function for Lever A. Lower rank ⇒ sold first.
 *  - `sleeveOrder`  : an array of ALLOCATION classes; rank = index (unlisted ⇒ after).
 *  - `sleeveWeights`: a { CLASS: weight } map; rank = weight (ascending ⇒ sold first),
 *    the design-58 Lever-B `WEIGHTED` analog so the solver/MPC can search the order.
 *  - `sleeveScore`  : an explicit (class) → number scorer (Lever C rebalance coupling).
 * When none is supplied every lot ranks equal (0) and the lot comparator alone decides.
 */
function buildSleeveRanker(selection) {
  if (typeof selection.sleeveScore === 'function') {
    return (h) => selection.sleeveScore(h?.allocation) ?? 0;
  }
  if (Array.isArray(selection.sleeveOrder) && selection.sleeveOrder.length) {
    const order = selection.sleeveOrder;
    return (h) => {
      const i = order.indexOf(h?.allocation);
      return i === -1 ? order.length : i; // unlisted classes sold after listed ones
    };
  }
  if (selection.sleeveWeights && typeof selection.sleeveWeights === 'object') {
    const w = selection.sleeveWeights;
    return (h) => w[h?.allocation] ?? Number.POSITIVE_INFINITY; // unweighted ⇒ sold last
  }
  return () => 0;
}

/** Build a (a, b) lot comparator for Lever B (within a sleeve). */
function buildLotComparator(lotStrategy) {
  switch (lotStrategy) {
    case LOT_STRATEGY.HIFO:
    case LOT_STRATEGY.MIN_GAIN:
    case LOT_STRATEGY.SPECIFIC:   // MIN_GAIN proxy until bracket-awareness lands (OQ3)
      // Highest basis ratio first ⇒ least gain (or a loss) realized per dollar raised.
      return (a, b) => basisRatio(b) - basisRatio(a);
    case LOT_STRATEGY.LOSS_FIRST:
      // Smallest gain first ⇒ losses (negative gain) are realized before gains.
      return (a, b) => unrealizedGain(a) - unrealizedGain(b);
    case LOT_STRATEGY.LADDER:
      // design 66 §G8: cash → nearest-maturity rung → funds/growth. Infinity-safe.
      return (a, b) => cmpNum(ladderKey(a), ladderKey(b));
    case LOT_STRATEGY.FIFO:
    default:
      return (a, b) => purchaseTs(a) - purchaseTs(b);
  }
}

/**
 * Build the total comparator the liquidation primitive sorts holdings by.
 *
 * `selection === null` ⇒ pure FIFO (purchaseDate ascending), identical to the historic
 * behavior, so every caller that omits `selection` (and the golden) is byte-identical.
 *
 * Otherwise: primary key = sleeve rank (Lever A / C), secondary = lot rank (Lever B),
 * tie-break = purchaseDate (stable, deterministic).
 *
 * @param {{ sleeveOrder?: string[], sleeveWeights?: Object<string,number>,
 *           sleeveScore?: (allocation: string) => number,
 *           lotStrategy?: string }|null} [selection=null]
 * @returns {(a: object, b: object) => number}
 */
export function buildHoldingsComparator(selection = null) {
  if (!selection) return (a, b) => purchaseTs(a) - purchaseTs(b);
  const sleeveRank = buildSleeveRanker(selection);
  const lotCmp     = buildLotComparator(selection.lotStrategy);
  return (a, b) => {
    const sr = sleeveRank(a) - sleeveRank(b);
    if (sr !== 0) return sr;
    const lr = lotCmp(a, b);
    if (lr !== 0) return lr;
    return purchaseTs(a) - purchaseTs(b);
  };
}
