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
import { ACCOUNT_ROLES }    from '../state/account-roles.js';
import { ALLOCATION }       from '../holdings/allocation.js';

/**
 * Tax-advantaged account roles (never taxable).
 * Moves between any pair of these is free of capital-gains tax.
 */
const TAX_ADVANTAGED_ROLES = new Set([
  ACCOUNT_ROLES.K401,
  ACCOUNT_ROLES.IRA,
  ACCOUNT_ROLES.ROTH,
  ACCOUNT_ROLES.SUPER,
]);

/**
 * Default location policy: bonds prefer tax-deferred (IRA, K401) where growth
 * is sheltered from annual taxes on interest; equity prefers Roth (growth
 * tax-free) or taxable (lower LTCG rates).
 */
const DEFAULT_ASSET_LOCATION_POLICY = {
  [ALLOCATION.BOND]:   [ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.K401],
  [ALLOCATION.EQUITY]: [ACCOUNT_ROLES.ROTH],
};

/**
 * StrategicAssetLocationReducer — lever 2 of design/29 §3.4 (Increment 4).
 *
 * Runs annually on period advance. Identifies holdings in tax-advantaged accounts
 * whose allocation is mislocated per `assetLocationPolicy`, then proposes swaps
 * between tax-advantaged accounts only (no taxable account is ever on either side).
 *
 * Emits `ASSET_LOCATION_REBALANCE_APPLY` actions consumed by
 * `AssetLocationRebalanceApplyReducer` which applies mirrored HOLDING_TRANSACT
 * pairs (subtract from source, add to target holding).
 *
 * Lever 1 (contribution routing) is deferred to a later increment.
 */
export class StrategicAssetLocationReducer extends Reducer {
  static type        = 'StrategicAssetLocationReducer';
  static description = 'Annual tax-advantaged swap: moves mislocated holdings between IRA/K401/Roth per assetLocationPolicy. Never touches taxable accounts.';

  /**
   * @param {object}     opts
   * @param {object[]}   opts.taxAdvantaged      - [{stateKey, role}] of tax-advantaged accounts
   * @param {object}     [opts.assetLocationPolicy] - allocation → preferredRoles[] map
   */
  constructor({ taxAdvantaged = [], assetLocationPolicy = DEFAULT_ASSET_LOCATION_POLICY } = {}) {
    super('Strategic Asset Location', PRIORITY.PRE_PROCESS + 5);
    this.reducedActionTypes   = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
    this.generatedActionTypes = ['ASSET_LOCATION_REBALANCE_APPLY'];
    this.taxAdvantaged        = taxAdvantaged;
    this.assetLocationPolicy  = assetLocationPolicy;
  }

  reduce(state, _action) {
    // Only fire once per year (on US_PERIOD_ADVANCE — AU scenarios may use AU_PERIOD_ADVANCE)
    const moves = this._computeMoves(state);
    if (moves.length === 0) return this.newState(state);

    return this.newState(state, {}, moves.map(m => ({ type: 'ASSET_LOCATION_REBALANCE_APPLY', ...m })));
  }

  _computeMoves(state) {
    const policy = this.assetLocationPolicy;
    const moves  = [];

    // Build a map: stateKey → { role, mislocatedHoldings: [{holding, allocation, preferredRoles}] }
    const accountInfo = [];
    for (const { stateKey, role } of this.taxAdvantaged) {
      const account = state[stateKey];
      if (!account || !Array.isArray(account.holdings)) continue;
      const mislocated = account.holdings.filter(h => {
        const preferred = policy[h.allocation];
        if (!preferred) return false;
        return !preferred.includes(role);
      });
      accountInfo.push({ stateKey, role, holdings: account.holdings, mislocated });
    }

    // For each mislocated holding, try to find a complementary mislocated holding
    // in another account where a swap would improve both.
    for (const src of accountInfo) {
      for (const mis of src.mislocated) {
        const preferredRoles = policy[mis.allocation];
        if (!preferredRoles) continue;

        // Find a target account that is a preferred location for this allocation
        const target = accountInfo.find(a =>
          a !== src &&
          preferredRoles.includes(a.role) &&
          a.holdings.length > 0,
        );
        if (!target) continue;

        // Find a holding in the target that would benefit from moving to src
        // (i.e., it's mislocated there too, ideally complementary)
        const targetMislocated = target.mislocated.find(h2 =>
          (policy[h2.allocation] ?? []).includes(src.role),
        );

        // Swap amounts: min of the two holding values
        const srcHolding    = mis;
        const targetHolding = targetMislocated ?? target.holdings[0]; // best available
        const swapAmount    = +Math.min(srcHolding.marketValue, targetHolding.marketValue).toFixed(2);

        if (swapAmount <= 0) continue;

        // Avoid duplicate swaps (if we already added a move for this pair)
        const alreadySwapped = moves.some(m =>
          (m.fromStateKey === src.stateKey && m.toStateKey === target.stateKey) ||
          (m.fromStateKey === target.stateKey && m.toStateKey === src.stateKey),
        );
        if (alreadySwapped) continue;

        // Each "move" is a swap: both sides move
        moves.push({
          fromStateKey:    src.stateKey,
          fromHoldingId:   srcHolding.id,
          toStateKey:      target.stateKey,
          toHoldingId:     targetHolding.id,
          swapAmount,
        });
        break; // one swap per source account per period
      }
    }

    return moves;
  }
}
