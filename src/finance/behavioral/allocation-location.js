/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ALLOCATION }    from '../holdings/allocation.js';
import { ACCOUNT_ROLES } from '../state/account-roles.js';
import { roleCanHoldGold } from './rebalance-to-target-reducer.js';

/**
 * Lever D — jurisdiction-aware asset location (design 61 §4-D / Phase 4).
 *
 * The Lever-A target is a WHOLE-PORTFOLIO ratio. This planner maps it onto the
 * individual accounts so the aggregate book hits the target mix while each class
 * sits in its tax-favored account: bonds → tax-deferred (interest sheltered),
 * equity → Roth/taxable (tax-free growth / LTCG + step-up), gold → a shelter that
 * may legally hold it. The rebalance then drives each account toward the composition
 * this planner assigns it — no inter-account transfer is needed, because the
 * assignment fills every account to exactly its own total, so each account's legs
 * still sum to zero and value is conserved per account (Phase-2 invariant).
 *
 * Gold eligibility (§OQ4a): US IRA/401k/Roth cannot hold bullion; AU super can. Gold
 * is therefore capped at the gold-eligible capacity and any excess weight is
 * redistributed across the other classes, so a gold target larger than the eligible
 * shelter is honored as far as legally possible (and never lands in a US IRA).
 *
 * Lazy post-move relocation (§OQ4b): the planner is re-run every period from the
 * CURRENT residency + accounts, so a US→AU move simply re-targets the new optimum and
 * the normal drift-band cadence walks holdings there over the following periods —
 * there is no move-date-specific forced trade here.
 */

/** Processing order: most-eligibility-constrained first (GOLD), then by tax-sensitivity. */
const LOCATION_FILL_ORDER = [ALLOCATION.GOLD, ALLOCATION.BOND, ALLOCATION.EQUITY, ALLOCATION.CASH];
/** The non-gold classes the redistributed gold excess spreads across. */
const NON_GOLD_CLASSES = [ALLOCATION.EQUITY, ALLOCATION.BOND, ALLOCATION.CASH];

/**
 * Default location policy — per class, the account roles that should hold it, in
 * preference order (earlier = better). Preference is SOFT (spills to any remaining
 * capacity when the preferred accounts are full); gold eligibility is HARD (enforced
 * separately by `roleCanHoldGold`). Restricted to the rebalanceable role set
 * (tax-advantaged ∪ taxable brokerage).
 */
export const DEFAULT_LOCATION_POLICY = Object.freeze({
  // Interest is taxed annually at ordinary rates → shelter bonds in tax-deferred first.
  [ALLOCATION.BOND]:   [ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.K401, ACCOUNT_ROLES.SUPER,
                        ACCOUNT_ROLES.US_STOCK, ACCOUNT_ROLES.AU_STOCK],
  // Equity: Roth (tax-free growth) and taxable (preferential LTCG + step-up) first;
  // keep it OUT of tax-deferred where growth would convert to ordinary income.
  [ALLOCATION.EQUITY]: [ACCOUNT_ROLES.ROTH, ACCOUNT_ROLES.US_STOCK, ACCOUNT_ROLES.AU_STOCK,
                        ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.K401, ACCOUNT_ROLES.SUPER],
  // Cash: a low-tax filler — taxable/Roth first, then wherever capacity remains.
  [ALLOCATION.CASH]:   [ACCOUNT_ROLES.US_STOCK, ACCOUNT_ROLES.AU_STOCK, ACCOUNT_ROLES.ROTH,
                        ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.K401, ACCOUNT_ROLES.SUPER],
  // Gold: shelter in AU super (the only gold-eligible tax-advantaged account) first,
  // then a taxable brokerage. US IRA/401k/Roth are excluded by the eligibility guard,
  // not merely deprioritized. Optimal for both residencies (super shelters; the
  // US-28% vs AU-indexed tax difference is realized in the CGT path, design 57).
  [ALLOCATION.GOLD]:   [ACCOUNT_ROLES.SUPER, ACCOUNT_ROLES.AU_STOCK, ACCOUNT_ROLES.US_STOCK],
});

const R2 = (x) => +(+x).toFixed(2);

/**
 * Order eligible accounts for a class: those whose role appears in the class's
 * preference list first (in that order), then any remaining accounts by descending
 * remaining capacity (stable) so the spillover fills the biggest homes first.
 */
function _orderedForClass(accounts, remaining, preferred) {
  const pref = Array.isArray(preferred) ? preferred : [];
  const rank = (role) => { const i = pref.indexOf(role); return i === -1 ? pref.length : i; };
  return [...accounts].sort((a, b) => {
    const ra = rank(a.role), rb = rank(b.role);
    if (ra !== rb) return ra - rb;
    return (remaining[b.stateKey] ?? 0) - (remaining[a.stateKey] ?? 0);
  });
}

/**
 * Plan the per-account target composition that realizes `portfolioTarget` across
 * `accounts`, honoring the location policy and the gold eligibility guard.
 *
 * @param {object}   opts
 * @param {object[]} opts.accounts        - [{ stateKey, role, total }] (total = Σ marketValue)
 * @param {object}   opts.portfolioTarget - { EQUITY, BOND, CASH, GOLD } fractions (need not be exact)
 * @param {object}   [opts.policy]        - class → preferred-roles map (defaults to DEFAULT_LOCATION_POLICY)
 * @param {string}   [opts.residency]     - 'US' | 'AU' (reserved for finer gold policy; see header)
 * @returns {Map<string, object>} stateKey → { <ALLOCATION>: dollars } summing to that account's total
 */
export function planLocatedTargets({ accounts = [], portfolioTarget = {}, policy = DEFAULT_LOCATION_POLICY, residency = 'US' } = {}) {
  const active = accounts.filter(a => (a?.total ?? 0) > 0);
  const totalPortfolio = active.reduce((s, a) => s + a.total, 0);
  const out = new Map(active.map(a => [a.stateKey, {}]));
  if (totalPortfolio <= 0) return out;

  // Class dollar targets from the portfolio fractions.
  const classTargets = {};
  for (const cls of LOCATION_FILL_ORDER) classTargets[cls] = Math.max(0, (portfolioTarget[cls] ?? 0)) * totalPortfolio;

  // Gold eligibility cap: gold cannot exceed the capacity of gold-eligible accounts.
  const goldCap = active.filter(a => roleCanHoldGold(a.role)).reduce((s, a) => s + a.total, 0);
  if (classTargets[ALLOCATION.GOLD] > goldCap) {
    let excess = classTargets[ALLOCATION.GOLD] - goldCap;
    classTargets[ALLOCATION.GOLD] = goldCap;
    // Redistribute the un-placeable gold weight across the other classes, pro-rata to
    // their current targets (fallback: all to EQUITY) so Σ class$ still equals the book.
    const base = NON_GOLD_CLASSES.reduce((s, c) => s + classTargets[c], 0);
    if (base > 0) {
      for (const c of NON_GOLD_CLASSES) classTargets[c] += excess * (classTargets[c] / base);
    } else {
      classTargets[ALLOCATION.EQUITY] += excess;
    }
    excess = 0;
  }

  const remaining = Object.fromEntries(active.map(a => [a.stateKey, a.total]));
  const assign = (stateKey, cls, amt) => {
    const comp = out.get(stateKey);
    comp[cls] = (comp[cls] ?? 0) + amt;
    remaining[stateKey] -= amt;
  };

  // Preference pass: place each class into its preferred eligible accounts, spilling.
  for (const cls of LOCATION_FILL_ORDER) {
    let need = classTargets[cls];
    if (need <= 0) continue;
    const eligible = active.filter(a => cls !== ALLOCATION.GOLD || roleCanHoldGold(a.role));
    for (const a of _orderedForClass(eligible, remaining, policy[cls])) {
      if (need <= 1e-6) break;
      const amt = Math.min(need, remaining[a.stateKey]);
      if (amt <= 1e-6) continue;
      assign(a.stateKey, cls, amt);
      need -= amt;
    }
    classTargets[cls] = need;   // any un-placeable remainder (only possible for GOLD post-cap ≈ 0)
  }

  // Reconcile: fill any account still carrying capacity with the leftover class dollars
  // (respecting gold eligibility). With Σ class$ == Σ capacity and gold capped feasible,
  // this drives every `remaining` to ~0 so each account's composition sums to its total.
  for (const cls of [ALLOCATION.EQUITY, ALLOCATION.BOND, ALLOCATION.CASH, ALLOCATION.GOLD]) {
    let need = classTargets[cls];
    if (need <= 1e-6) continue;
    for (const a of active) {
      if (need <= 1e-6) break;
      if (cls === ALLOCATION.GOLD && !roleCanHoldGold(a.role)) continue;
      const amt = Math.min(need, remaining[a.stateKey]);
      if (amt <= 1e-6) continue;
      assign(a.stateKey, cls, amt);
      need -= amt;
    }
    classTargets[cls] = need;
  }

  // Round and absorb sub-cent drift into each account's largest class so the
  // composition sums to exactly the account total (value-conservation invariant).
  for (const a of active) {
    const comp = out.get(a.stateKey);
    let sum = 0; let largest = null;
    for (const cls of Object.keys(comp)) {
      comp[cls] = R2(comp[cls]);
      sum += comp[cls];
      if (comp[cls] > 0 && (largest === null || comp[cls] > comp[largest])) largest = cls;
    }
    const drift = R2(a.total - sum);
    if (drift !== 0 && largest !== null) comp[largest] = R2(comp[largest] + drift);
    else if (drift !== 0) comp[ALLOCATION.EQUITY] = R2((comp[ALLOCATION.EQUITY] ?? 0) + drift);
  }

  return out;
}
