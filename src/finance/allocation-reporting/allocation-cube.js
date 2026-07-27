/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ASSET_CLASS, assetClassForAllocation, exposureCountryForRateKey } from './asset-class.js';
import { resolveDefaultAllocation } from '../holdings/default-allocations.js';
// The SAME valuation FX helper computeNetWorth uses (design 82 §5.1a) — the cube's
// total has to equal net worth (THE INVARIANT below), so the two cannot be allowed to
// hold different conventions. It used to be a private copy guarded by a comment.
import { toBaseCurrency, currencyOf } from '../fx/to-base-currency.js';
import { isSpeculative } from '../assets/asset.js';

/**
 * allocation-cube.js — reduce one simulation state to a flat table of allocation facts.
 *
 * ─── why a cube and not three reports ────────────────────────────────────────
 *
 * The asks are "allocation per account over time", "per country over time" and
 * "total over time". Those are not three features; they are three GROUP-BYs over
 * one fact table. Committing to a grouping here — emitting `{ EQUITY: n, BOND: n }`
 * per country, say — is the only decision in this feature that would force a
 * rewrite later, because every new question ("by wrapper?", "by return series?")
 * would need a new emitter. So this module emits the TUPLE and leaves every
 * grouping, denominator and share calculation to the view.
 *
 * One row per `(stateKey, assetClass, rateKey)` bucket. Buckets, not holdings: a
 * 30-rung bond ladder is one BOND row carrying `holdingCount: 30`, which is what an
 * allocation view wants, and it keeps a 45-year cube in the low thousands of rows.
 *
 * ─── it is a REPORT, so it never refuses to draw ─────────────────────────────
 *
 * Inside the simulation an unrecognised allocation is a load-time error, and that is
 * right: a holding no consumer recognises is silently skipped by the rebalancer and
 * the drawdown sleeve order, so failing loudly is the only way it gets noticed
 * (allocation.js). A report inverts that. Refusing to render leaves the operator
 * with nothing; rendering an honest `UNKNOWN` band leaves them looking straight at
 * the anomaly. So every classification failure here degrades to a visible bucket,
 * and `resolveDefaultAllocation`'s throw is caught rather than propagated.
 *
 * The same instinct drives `reconcileToBalance`. Holdings and the denormalized
 * `account.balance` are known to drift apart (a balance edit does not rescale
 * holdings; `transaction()` only syncs single-holding accounts). Summing holdings
 * alone would quietly produce a mix that does not tie to net worth. Instead the
 * residual is emitted as its own row, so the cube's total ALWAYS equals the account
 * balance and the drift shows up as a labelled band instead of a silent error.
 *
 * ─── THE INVARIANT (now two of them) ─────────────────────────────────────────
 *
 *     Σ rows.marketValue                     === computeNetWorthInclSpeculative   (disclosure)
 *     Σ rows.marketValue where !speculative  === computeNetWorth                  (recognition)
 *
 * with every `include*` option left on. This is not a nice-to-have; it is what
 * makes every share on the chart trustworthy, because a denominator that silently
 * omits an asset misstates EVERY slice, not just the missing one.
 *
 * The single invariant became two when design 88 split RECOGNITION from DISCLOSURE:
 * the cube keeps the row for a speculative asset (dropping it would make the position
 * invisible in the one view whose whole job is showing where the money is — D6) while
 * net worth stops counting it (D5). Together the pair pins strictly more than the
 * original did: not just that the cube and the metrics agree on the total, but that
 * they agree on WHICH ROWS ARE RECOGNISED. A change that drops the flag in one of the
 * two projections fails exactly one of them, which localises the bug immediately.
 *
 * It is therefore load-bearing that inclusion here uses net worth's OWN rule — a
 * numeric `balance`, or a recognised asset `kind` — and never a narrower one. An
 * earlier draft scoped accounts to StateSchemaRegistry#accountBalanceKeys(), which
 * looks more precise and is strictly worse: loan accounts do not register under the
 * `account` display kind, so every loan silently vanished and the cube ran ~$218k
 * above net worth on a real plan, decaying to zero as the mortgages amortized. The
 * synthetic default scenario has no loans and tied perfectly throughout. Anything
 * net worth counts, this counts.
 */

/** Where a row's number came from — the provenance column. */
export const CUBE_SOURCE = Object.freeze({
  /** Summed from `account.holdings[]` — the good case. */
  HOLDING:        'holding',
  /** Synthesized from `account.balance`: the account carries no holdings at all. */
  ACCOUNT_BALANCE: 'account-balance',
  /** A non-account state entry: real property, company equity, a collectible. */
  ASSET:          'asset',
  /** A loan's owed principal, carried negative. */
  LIABILITY:      'liability',
  /** `account.balance` minus Σ holdings — the holdings/balance drift made visible. */
  RECONCILIATION: 'reconciliation',
});

const DEFAULT_BALANCE_TOLERANCE = 1; // currency units; below this, drift is rounding

const _round = n => +(Number(n) || 0).toFixed(2);

/**
 * Is this state entry an account? Duck-typed on a numeric `balance`, matching
 * computeNetWorth exactly — see THE INVARIANT above for why this must not be
 * tightened to the schema registry's `accountBalanceKeys()`, however much more
 * precise that looks.
 */
function _isAccount(entry) {
  return typeof entry?.balance === 'number';
}

/**
 * Build the fact rows for one point in time.
 *
 * @param {object} state                         - a simulation state (live or a history snapshot)
 * @param {object} [opts]
 * @param {Date}   [opts.date]                   - the sample date stamped on every row
 * @param {string} [opts.baseCurrency='USD']     - currency every `*Base` figure is expressed in
 * @param {(stateKey: string) => string|null} [opts.displayNameFor]
 *        - resolver for human account names (StateSchemaRegistry#displayNameFor).
 *          Injected rather than imported so the cube stays pure and usable from a
 *          node script with no registry booted; falls back to the stateKey.
 * @param {boolean} [opts.includeNonHoldingAssets=true]
 *        - emit real property / company equity / collectibles. False gives the
 *          holdings-only ("investable portfolio") view.
 * @param {boolean} [opts.includeLiabilities=true]  - emit loans as negative LIABILITY rows
 * @param {boolean} [opts.reconcileToBalance=true]  - emit the holdings-vs-balance residual
 * @param {number}  [opts.balanceTolerance=1]       - residual below this is treated as rounding
 * @returns {object[]} rows, sorted for stable diffs
 */
export function buildAllocationCube(state, opts = {}) {
  const {
    date                    = null,
    baseCurrency            = 'USD',
    displayNameFor          = null,
    includeNonHoldingAssets = true,
    includeLiabilities      = true,
    reconcileToBalance      = true,
    balanceTolerance        = DEFAULT_BALANCE_TOLERANCE,
  } = opts;

  if (!state || typeof state !== 'object') return [];

  const rows  = [];
  const stamp = date ? new Date(date) : null;

  const nameOf = stateKey => {
    try { return displayNameFor?.(stateKey) || stateKey; }
    catch { return stateKey; }
  };

  /** Assemble one row, doing the FX and rounding in exactly one place. */
  const push = ({
    stateKey, entry, source, assetClass, allocation = null, rateKey = null,
    marketValueLocal, costBasisLocal = null, holdingCount = 0, inferred = false,
  }) => {
    const currency = currencyOf(entry, baseCurrency);
    // The wrapper's jurisdiction and the market it is exposed to are different
    // questions; emit both columns rather than picking one and calling it "country".
    // An unrecognised rateKey (undefined) falls back to the domicile; a deliberately
    // country-agnostic series (null, e.g. GOLD) stays null.
    const domicileCountry = entry?.country ?? null;
    const exposure        = exposureCountryForRateKey(rateKey);
    rows.push({
      date:             stamp,
      stateKey,
      name:             nameOf(stateKey),
      source,
      kind:             entry?.kind ?? 'account',
      role:             entry?.role ?? null,
      type:             entry?.type ?? null,
      domicileCountry,
      exposureCountry:  exposure === undefined ? domicileCountry : exposure,
      currency,
      assetClass,
      allocation,
      rateKey,
      holdingCount,
      // Design 88 D6: the disclosure column. Always a real boolean (never undefined)
      // so a consumer can filter on it without re-deriving the rule, and so a row
      // that lost the field upstream reads as `false` here rather than as absent.
      speculative:      isSpeculative(entry),
      marketValueLocal: _round(marketValueLocal),
      marketValue:      _round(toBaseCurrency(marketValueLocal, currency, baseCurrency, state)),
      costBasisLocal:   costBasisLocal == null ? null : _round(costBasisLocal),
      costBasis:        costBasisLocal == null
        ? null
        : _round(toBaseCurrency(costBasisLocal, currency, baseCurrency, state)),
      inferred,
    });
  };

  for (const [stateKey, entry] of Object.entries(state)) {
    if (entry == null || typeof entry !== 'object') continue;

    // A loan is an account shape with a positive balance that MEANS a negative
    // number (design 54). Carried here as a negative LIABILITY row so that a
    // group-by summing `marketValue` nets automatically, while a mix view gets the
    // conventional gross-asset denominator by filtering the class out. One table
    // serves both; a separate liabilities collection would not.
    //
    // Tested FIRST, on `type` alone, deliberately: `type === 'loan'` is the same
    // discriminator computeNetWorth uses, and it is the only one that cannot be
    // narrowed out from under us by how a loan happens to be registered elsewhere.
    if (entry.type === 'loan' && typeof entry.balance === 'number') {
      if (includeLiabilities) {
        push({
          stateKey, entry,
          source:           CUBE_SOURCE.LIABILITY,
          assetClass:       ASSET_CLASS.LIABILITY,
          marketValueLocal: -entry.balance,
        });
      }
      continue;
    }

    if (_isAccount(entry)) {
      _pushAccountRows(push, stateKey, entry, { reconcileToBalance, balanceTolerance });
      continue;
    }

    if (!includeNonHoldingAssets) continue;

    // Non-account assets have no holdings and therefore no ALLOCATION at all —
    // this is exactly the gap ASSET_CLASS exists to close.
    if (entry.kind === 'real-property' && typeof entry.value === 'number') {
      // Net of `mortgageBalance` to stay consistent with computeNetWorth. In
      // current scenarios that field is 0 BY DESIGN — the mortgage lives on a
      // LoanAccount, which this cube already emits as its own LIABILITY row — so
      // this subtracts nothing and nothing is double-counted. Mirroring net worth
      // keeps a legacy state that DOES carry the scalar consistent too.
      push({
        stateKey, entry,
        source:           CUBE_SOURCE.ASSET,
        assetClass:       ASSET_CLASS.REAL_ESTATE,
        marketValueLocal: entry.value - (entry.mortgageBalance ?? 0),
        costBasisLocal:   typeof entry.costBasis === 'number' ? entry.costBasis : null,
      });
    } else if (entry.kind === 'company' && typeof entry.value === 'number') {
      push({
        stateKey, entry,
        source:           CUBE_SOURCE.ASSET,
        assetClass:       ASSET_CLASS.PRIVATE_EQUITY,
        marketValueLocal: entry.value,
        costBasisLocal:   typeof entry.costBasis === 'number' ? entry.costBasis : null,
      });
    } else if (entry.kind === 'collectible' && typeof entry.value === 'number') {
      push({
        stateKey, entry,
        source:           CUBE_SOURCE.ASSET,
        assetClass:       ASSET_CLASS.COLLECTIBLE,
        marketValueLocal: entry.value,
        costBasisLocal:   typeof entry.costBasis === 'number' ? entry.costBasis : null,
      });
    }
  }

  // Stable order so cube dumps diff cleanly and tests do not depend on state key
  // insertion order.
  rows.sort((a, b) =>
    a.stateKey.localeCompare(b.stateKey) ||
    a.assetClass.localeCompare(b.assetClass) ||
    String(a.rateKey).localeCompare(String(b.rateKey)));

  return rows;
}

/**
 * Emit the rows for one (non-loan) account: its holding buckets, or a synthesized
 * row when it has none, plus any residual against the denormalized balance.
 * @private
 */
function _pushAccountRows(push, stateKey, entry, { reconcileToBalance, balanceTolerance }) {
  const holdings = Array.isArray(entry.holdings) ? entry.holdings : [];
  const balance  = typeof entry.balance === 'number' ? entry.balance : 0;

  if (holdings.length === 0) {
    // A tier-2 legacy account: a balance, no holdings. Reading only `holdings[]`
    // would drop it from the numerator AND the denominator, so every share on the
    // chart would be wrong with nothing to show for it. Synthesize one bucket at
    // the role/type-implied allocation instead, flagged `inferred` so a view can
    // mark that the mix is being assumed rather than read.
    if (balance === 0) return;
    let allocation = null;
    try { allocation = resolveDefaultAllocation(entry); } catch { /* falls through to UNKNOWN */ }
    push({
      stateKey, entry,
      source:           CUBE_SOURCE.ACCOUNT_BALANCE,
      assetClass:       allocation ? assetClassForAllocation(allocation) : ASSET_CLASS.UNKNOWN,
      allocation,
      marketValueLocal: balance,
      holdingCount:     0,
      inferred:         true,
    });
    return;
  }

  // Fold holdings into (allocation, rateKey) buckets — this is what collapses a
  // bond ladder's rungs into a single BOND row.
  const buckets = new Map();
  let holdingsTotal = 0;
  for (const h of holdings) {
    const allocation = h?.allocation ?? null;
    const rateKey    = h?.rateKey ?? null;
    const key        = `${allocation}\u0000${rateKey}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { allocation, rateKey, marketValue: 0, costBasis: 0, count: 0 };
      buckets.set(key, bucket);
    }
    const mv = Number(h?.marketValue) || 0;
    bucket.marketValue += mv;
    bucket.costBasis   += Number(h?.costBasis) || 0;
    bucket.count       += 1;
    holdingsTotal      += mv;
  }

  for (const bucket of buckets.values()) {
    push({
      stateKey, entry,
      source:           CUBE_SOURCE.HOLDING,
      assetClass:       assetClassForAllocation(bucket.allocation),
      allocation:       bucket.allocation,
      rateKey:          bucket.rateKey,
      marketValueLocal: bucket.marketValue,
      costBasisLocal:   bucket.costBasis,
      holdingCount:     bucket.count,
    });
  }

  // The holdings/balance drift, made visible rather than absorbed. Without this the
  // cube silently disagrees with net worth and the mix is wrong by the drift.
  if (!reconcileToBalance) return;
  const residual = balance - holdingsTotal;
  if (Math.abs(residual) <= balanceTolerance) return;
  push({
    stateKey, entry,
    source:           CUBE_SOURCE.RECONCILIATION,
    assetClass:       ASSET_CLASS.UNKNOWN,
    marketValueLocal: residual,
    inferred:         true,
  });
}
