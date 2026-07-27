/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';
import { resolveRateKey }    from '../holdings/default-allocations.js';

/**
 * RevalueAssetReducer — applies a shock's instantaneous level effect.
 *
 * Two kinds of target, and the distinction is the whole point of this reducer:
 *
 *  · **Accounts** (`holdingsStateKeys`) — revalued PER HOLDING. A holding is hit
 *    only when its own allocation resolves to the shocked `rateKey`, so a −40 %
 *    EQUITY_US crash marks down the equity sleeve of a brokerage/IRA/401k/Roth and
 *    leaves that same account's CASH, BOND and GOLD sleeves alone. The account's
 *    ROLE is deliberately not consulted: it used to select whole accounts, which
 *    meant a glidepath sitting 90 % in cash still took the full equity markdown
 *    because the cash happened to live inside an equity-role wrapper.
 *    Balance is then re-synced from Σ holdings — the §4.4 invariant (shocking
 *    `balance` directly would be erased by the next holdings re-sync).
 *
 *  · **Scalar assets** (`targetStateKeys`) — RealProperty / Collectible, which have
 *    no holdings and carry a single `value` (design 25 §5.3). These are still
 *    selected by rate key upstream, because there is no finer signal available.
 *
 * Action fields:
 *   - rateKey: string              — the shocked series, e.g. 'EQUITY_US'
 *   - holdingsStateKeys: string[]  — accounts to scan sleeve-by-sleeve
 *   - targetStateKeys: string[]    — scalar assets to revalue wholesale
 *   - multiplier: number           — e.g. -0.40 to drop 40%
 *
 * Runs at POSITION_UPDATE (30) so it executes after the regime is pushed and
 * after any cash-flow actions from the same handler batch.
 */
export class RevalueAssetReducer extends Reducer {
  static type        = 'RevalueAssetReducer';
  static description = 'Applies the shock multiplier to every holding\'s marketValue (Account) or to the scalar value (RealProperty/Collectible), and re-syncs account.balance.';

  constructor() {
    super('Revalue Asset', PRIORITY.POSITION_UPDATE);
    this.reducedActionTypes = ['REVALUE_ASSET_APPLY'];
  }

  reduce(state, action) {
    const { rateKey, targetStateKeys, holdingsStateKeys, multiplier } = action;
    if (multiplier == null) return this.newState(state);
    if (!targetStateKeys?.length && !holdingsStateKeys?.length) return this.newState(state);

    const shock = (v) => Math.max(0, (v ?? 0) + +(((v ?? 0) * multiplier).toFixed(2)));
    const updates = {};

    // ── Accounts: per-sleeve, by allocation ──────────────────────────────────
    for (const key of holdingsStateKeys ?? []) {
      const entry = state[key];
      if (!entry || !Array.isArray(entry.holdings) || entry.holdings.length === 0) continue;

      let hit = false;
      const nextHoldings = entry.holdings.map(h => {
        if (!h) return h;
        // Resolve the holding's CLASS key from its own allocation, with no role —
        // the sleeve's asset class, independent of the wrapper it happens to sit in.
        // null (account has no country) never matches, so a jurisdiction-less
        // account is untouched by a jurisdiction shock.
        if (resolveRateKey(entry.country, h.allocation, null) !== rateKey) return h;
        hit = true;
        return { ...h, marketValue: shock(h.marketValue) };
      });
      if (!hit) continue;

      const nextBalance = +nextHoldings.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);
      updates[key] = { ...entry, holdings: nextHoldings, balance: nextBalance };
    }

    // ── Scalar assets (RealProperty / Collectible): whole `value` ────────────
    for (const key of targetStateKeys ?? []) {
      const entry = state[key];
      if (!entry || updates[key]) continue;
      if (entry.value != null) updates[key] = { ...entry, value: shock(entry.value) };
    }

    return this.newState(state, updates);
  }
}
