/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ASSET_CLASS, assetClassForAllocation } from './asset-class.js';
import { toBaseCurrency, currencyOf }           from '../fx/to-base-currency.js';

/**
 * target-cube.js — the mix the plan INTENDED, in the same shape as the mix it got.
 *
 * Design 82 §7. The realized cube says what the portfolio is; this says what it was
 * aiming at, so the two can be charted together and the answer stops being descriptive:
 * drift, band breaches, and — given design 58/65's sleeve-ordered drawdown — whether
 * thirty years of withdrawals are quietly de-risking the plan or un-de-risking it.
 *
 * ─── target rows carry DOLLARS, not weights ──────────────────────────────────
 *
 * `RebalanceToTargetReducer` stamps `account.targetComposition` as fractions **of that
 * account's own holdings total** (design 65 §OQ1a). Fractions of different denominators
 * cannot be summed, so emitting them raw would make every aggregate wrong in a way that
 * still looks plausible. Each row therefore carries `marketValue = weight × the
 * account's holdings total`, converted to the base currency — a target expressed in
 * dollars. Dollars add up, so the ordinary group-by in `allocation-grouping.js` produces
 * a correct aggregate target, and normalizing it yields the target SHARE. One pivot
 * serves the realized table and this one.
 *
 * ─── the comparison set is the trap ──────────────────────────────────────────
 *
 * A target exists only for accounts the rebalancer manages. The house, the company
 * stake, the collectibles and any untargeted account have none — so comparing a target
 * against the realized mix of EVERYTHING would put a 60/40 target next to a book that is
 * 45% private equity and call the difference drift. It isn't drift; it is two different
 * questions. `targetedStateKeys()` exists so a view can hold both sides to the same set
 * of accounts, and it is the caller's job to use it.
 *
 * ─── under LOCATED, per-account targets look extreme, and that is correct ─────
 *
 * With design 61's Lever D in LOCATED mode the plan deliberately concentrates: a 401k
 * targeted 100% GOLD, an IRA 98% BOND. Read one account at a time that looks alarming;
 * read the AGGREGATE and it is the portfolio target the user actually set. So the
 * aggregate is the headline comparison and per-account is the location diagnostic —
 * "is the class where the plan wants it?" — not a second opinion on the mix.
 */

/** A stale stamp on a drained account contributes nothing; see `_holdingsTotal`. */
const MIN_TOTAL = 0;

/**
 * Build the target rows for one point in time.
 *
 * @param {object} state
 * @param {object} [opts]
 * @param {Date}   [opts.date]
 * @param {string} [opts.baseCurrency='USD']
 * @param {(stateKey: string) => string|null} [opts.displayNameFor]
 * @returns {object[]} rows shaped like the realized cube's, `source: 'target'`
 */
export function buildTargetCube(state, opts = {}) {
  const { date = null, baseCurrency = 'USD', displayNameFor = null } = opts;
  if (!state || typeof state !== 'object') return [];

  const rows  = [];
  const stamp = date ? new Date(date) : null;
  const nameOf = (stateKey) => {
    try { return displayNameFor?.(stateKey) || stateKey; }
    catch { return stateKey; }
  };

  for (const [stateKey, entry] of Object.entries(state)) {
    const target = entry?.targetComposition;
    if (!target || typeof target !== 'object') continue;

    const total = _holdingsTotal(entry);
    // The reducer only stamps accounts whose holdings total is positive, and it never
    // CLEARS a stamp — so a fully drawn-down account keeps its last target forever.
    // Skipping zero-total accounts uses the reducer's own rule and makes that stale
    // stamp harmless instead of drawing a target for an account that no longer holds
    // anything.
    if (total <= MIN_TOTAL) continue;

    const currency = currencyOf(entry, baseCurrency);
    const band     = typeof entry.targetBand === 'number' ? entry.targetBand : null;

    for (const [allocation, weight] of Object.entries(target)) {
      if (!Number.isFinite(weight)) continue;
      const local = weight * total;
      rows.push({
        date:             stamp,
        stateKey,
        name:             nameOf(stateKey),
        source:           'target',
        kind:             entry?.kind ?? 'account',
        role:             entry?.role ?? null,
        type:             entry?.type ?? null,
        domicileCountry:  entry?.country ?? null,
        exposureCountry:  entry?.country ?? null,
        currency,
        assetClass:       assetClassForAllocation(allocation),
        allocation,
        rateKey:          null,
        holdingCount:     0,
        targetWeight:     weight,
        // The band the reducer drift-checked this account against, so a view can mark a
        // breach with the number that was actually used (stamped since design 82 §7).
        band,
        marketValueLocal: _round(local),
        marketValue:      _round(toBaseCurrency(local, currency, baseCurrency, state)),
        costBasisLocal:   null,
        costBasis:        null,
        inferred:         false,
      });
    }
  }

  rows.sort((a, b) =>
    a.stateKey.localeCompare(b.stateKey) || a.assetClass.localeCompare(b.assetClass));
  return rows;
}

/**
 * The accounts a target applies to — the ONLY set over which realized and target may be
 * compared. See the header: holding the two sides to different sets is the mistake this
 * function exists to prevent.
 *
 * @param {object[]} targetRows
 * @returns {Set<string>}
 */
export function targetedStateKeys(targetRows) {
  const keys = new Set();
  for (const row of targetRows ?? []) {
    if (row?.stateKey) keys.add(row.stateKey);
  }
  return keys;
}

/**
 * Per-class drift, realized minus target, as shares of the same denominator.
 *
 * Positive = over-weight that class. `band` is the tightest band in play across the
 * accounts being compared: an aggregate spans accounts whose bands differ (taxable vs
 * sheltered), and reporting the loosest would understate how far out of policy the book
 * is. Null when nothing stamped a band.
 *
 * @param {Object<string, number>} realizedMix - class → share, summing to 1
 * @param {Object<string, number>} targetMix   - class → share, summing to 1
 * @param {object[]} [targetRows]              - rows the target came from, for the band
 * @returns {{rows: Array<{key, realized, target, drift, breach}>, band: number|null}}
 */
export function driftAgainstTarget(realizedMix, targetMix, targetRows = null) {
  let band = null;
  for (const row of targetRows ?? []) {
    if (typeof row?.band !== 'number') continue;
    band = band == null ? row.band : Math.min(band, row.band);
  }

  const keys = new Set([...Object.keys(realizedMix ?? {}), ...Object.keys(targetMix ?? {})]);
  const rows = [...keys].map((key) => {
    const realized = realizedMix?.[key] ?? 0;
    const target   = targetMix?.[key]   ?? 0;
    const drift    = realized - target;
    return {
      key, realized, target, drift,
      // A class the plan does not target at all (GOLD at weight 0) is still a breach when
      // held above the band — that is exactly the case design 61 §12.1 D2 found the drift
      // check blind to, so it must not be special-cased away here.
      breach: band != null && Math.abs(drift) > band,
    };
  });
  rows.sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
  return { rows, band };
}

/** Σ holdings marketValue, matching the reducer's own basis for the fractions. */
function _holdingsTotal(entry) {
  if (!Array.isArray(entry?.holdings)) return 0;
  return entry.holdings.reduce((sum, h) => sum + (Number(h?.marketValue) || 0), 0);
}

const _round = n => +(Number(n) || 0).toFixed(2);

export { ASSET_CLASS };
