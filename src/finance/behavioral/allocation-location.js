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
 * Gold eligibility: **every account may hold gold** (design 61 §12 OQ4a, reversed
 * 2026-07-29 — a gold ETF is holdable in a US IRA/401k/Roth and carries the same
 * collectibles rate). `roleCanHoldGold` is therefore total and the gold capacity cap
 * below is unreachable; both are retained as the seam for a future eligibility rule.
 * What decides gold's home now is purely the tax arithmetic, via
 * GOLD_PREFERENCE_BY_RESIDENCY (§12.2 Q4).
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
  // Gold: RESIDENCY-DEPENDENT, so the real list comes from GOLD_PREFERENCE_BY_RESIDENCY
  // via resolveLocationPolicy() (design 61 §12.2 Q4). This entry is the residency-agnostic
  // fallback, used only when a caller supplies its own policy object without a GOLD key.
  [ALLOCATION.GOLD]:   [ACCOUNT_ROLES.SUPER, ACCOUNT_ROLES.AU_STOCK, ACCOUNT_ROLES.US_STOCK],
});

/**
 * Gold's preferred homes, by the holder's CURRENT residency (design 61 §4-D / §12.2 Q4).
 *
 * ⚠ **These lists were set by MEASUREMENT, and the measurement inverted the original
 * reasoning.** §12.2 Q4 originally specified "shelter gold ahead of taxable for a US
 * resident, because a taxable gold sale pays the 28% collectibles rate". That is true
 * about the *rate* and still wrong as a policy, because it optimises the wrong quantity.
 *
 * Asset location depends on **growth × tax treatment**, not the tax rate alone. A shelter
 * is a finite resource, so it should hold the asset that benefits from it most. Gold grows
 * far slower than equity (5% vs 10% in the reference plan), so parking gold in a shelter
 * evicts a 10% asset from it and buys a rate saving on a 5% one. Over a 44-year horizon
 * the displaced compounding dominates the rate.
 *
 * Measured on the reference plan (terminal net worth, identical in every other respect):
 *
 *   | gold preference order                        | terminal NW | vs best  |
 *   |----------------------------------------------|-------------|----------|
 *   | IRA, K401, US_STOCK, AU_STOCK, SUPER, ROTH   | $30.45m     |  best    |
 *   | US_STOCK, AU_STOCK, SUPER, IRA, K401, ROTH   | $28.42m     | −$2.03m  |
 *   | SUPER, AU_STOCK, US_STOCK  (the pre-Q4 list) | $28.21m     | −$2.24m  |
 *   | IRA, K401, ROTH, SUPER, …   (Q4 as specified)| $25.20m     | −$5.25m  |
 *
 * So the ordering below, and the two rules that generate it:
 *
 * 1. **Tax-DEFERRED first (IRA/401k).** Deferred growth converts to ordinary income on
 *    withdrawal, which is the worst possible treatment for a high-growth asset — so a
 *    deferred account is exactly where a low-growth, badly-taxed sleeve belongs. This is
 *    the same logic that already puts BOND at the head of the deferred list; gold is
 *    bonds-like here (low growth, unfavourable rate), so its policy mirrors bonds'.
 * 2. **Roth LAST, always.** The Roth is the most valuable shelter (tax-free forever) and
 *    must hold the highest-growth asset. Q4-as-specified ranked it third, which is most
 *    of that −$5.25m.
 *
 * Residency then decides where the AU wrappers sit: an AU resident's bullion is an
 * ordinary, CPI-indexed AU CGT asset (`isGold:true`, design 57 §6.4/§7.2) and super taxes
 * earnings at 15%, so super leads for AU; a US resident has no reason to route gold across
 * the border. Both lists name EVERY rebalanceable role, so gold always has a defined
 * preference and never falls through to the capacity-ordered spillover.
 *
 * The switch is **lazy**, not move-pinned (§OQ4b): the planner re-runs each period from
 * the current residency, so a US→AU move re-targets and the drift band walks holdings over
 * the following periods rather than forcing a taxable event on the move date. That matters
 * most here — relocating gold out of a taxable account realizes 28% NOW to save later.
 *
 * ⚠ The AU arm is less thoroughly measured than the US arm (the reference plan starts US
 * and moves in 2031, so the US years dominate the terminal figure). Revisit with an
 * AU-resident-from-start plan before treating the AU ordering as settled.
 */
export const GOLD_PREFERENCE_BY_RESIDENCY = Object.freeze({
  // Deferred first, taxable next, super/AU after, Roth last.
  US: Object.freeze([ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.K401,
                     ACCOUNT_ROLES.US_STOCK, ACCOUNT_ROLES.AU_STOCK,
                     ACCOUNT_ROLES.SUPER, ACCOUNT_ROLES.ROTH]),
  // Super leads (15% earnings tax, and bullion is ordinary indexed CGT outside it);
  // then the US deferred wrappers, then taxable. Roth last, same reason as above.
  AU: Object.freeze([ACCOUNT_ROLES.SUPER, ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.K401,
                     ACCOUNT_ROLES.AU_STOCK, ACCOUNT_ROLES.US_STOCK,
                     ACCOUNT_ROLES.ROTH]),
});

/**
 * The location policy in force for a residency.
 *
 * `override` (the `allocationLocationPolicy` param) wins per class, so a scenario can
 * pin any single class's preference without losing the residency-aware gold default.
 *
 * @param {string}      [residency='US'] - 'US' | 'AU'
 * @param {object|null} [override=null]  - partial policy, per class
 */
export function resolveLocationPolicy(residency = 'US', override = null) {
  const gold = GOLD_PREFERENCE_BY_RESIDENCY[residency] ?? GOLD_PREFERENCE_BY_RESIDENCY.US;
  return { ...DEFAULT_LOCATION_POLICY, [ALLOCATION.GOLD]: gold, ...(override ?? {}) };
}

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
 * @param {object}   [opts.policy]        - partial class → preferred-roles map, merged over the
 *                                        residency-resolved default (see resolveLocationPolicy)
 * @param {string}   [opts.residency]     - 'US' | 'AU'; selects gold's preference order (§12.2 Q4)
 * @returns {Map<string, object>} stateKey → { <ALLOCATION>: dollars } summing to that account's total
 */
export function planLocatedTargets({ accounts = [], portfolioTarget = {}, policy = null, residency = 'US' } = {}) {
  // Gold's preferred home depends on residency (§12.2 Q4); everything else does not.
  // A caller-supplied `policy` is merged over the residency default, per class.
  policy = resolveLocationPolicy(residency, policy);
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
