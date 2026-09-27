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

/**
 * Lever D — jurisdiction-aware asset location (design 61 §4-D / Phase 4).
 *
 * The Lever-A target is a WHOLE-PORTFOLIO ratio. This planner maps it onto the
 * individual accounts so the aggregate book hits the target mix while each class
 * sits in its tax-favored account: bonds → tax-deferred (interest sheltered),
 * equity → Roth/taxable (tax-free growth / LTCG + step-up), gold → wherever its
 * residency-aware preference sends it (GOLD_PREFERENCE_BY_RESIDENCY). The rebalance then drives each account toward the composition
 * this planner assigns it — no inter-account transfer is needed, because the
 * assignment fills every account to exactly its own total, so each account's legs
 * still sum to zero and value is conserved per account (Phase-2 invariant).
 *
 * Class restrictions: **by default every account may hold every class** (design 61 §12
 * OQ4a, reversed 2026-07-29 — a gold ETF is holdable in a US IRA/401k/Roth). The author
 * may opt in to HARD per-role bans through `restrictions` (design 115 — e.g.
 * `{ GOLD: ['super'] }` for a US citizen, whose super could only hold gold as a
 * self-managed fund). Unlike the soft preference lists, a restriction is never relaxed:
 * a class weight the permitted accounts cannot hold is capped and redistributed.
 *
 * Lazy post-move relocation (§OQ4b): the planner is re-run every period from the
 * CURRENT residency + accounts, so a US→AU move simply re-targets the new optimum and
 * the normal drift-band cadence walks holdings there over the following periods —
 * there is no move-date-specific forced trade here.
 */

/** Processing order: most-eligibility-constrained first (GOLD), then by tax-sensitivity. */
const LOCATION_FILL_ORDER = [ALLOCATION.GOLD, ALLOCATION.BOND, ALLOCATION.EQUITY, ALLOCATION.CASH];
/** Where a capped class's excess goes when no uncapped class has a target to spread it by. */
const EXCESS_FALLBACK_ORDER = [ALLOCATION.EQUITY, ALLOCATION.BOND, ALLOCATION.CASH, ALLOCATION.GOLD];

/**
 * True when an account of `role` may hold `allocation` under `restrictions` (design 115).
 *
 * `restrictions` is the `allocationClassRestrictions` map, class → roles that class may
 * NEVER occupy. Null, a class the map does not name, or a non-array entry ⇒ permitted, so
 * a plan without restrictions behaves exactly as before. An empty array is the author
 * saying "considered, allowed everywhere" — also permitted.
 */
export function roleCanHold(allocation, role, restrictions = null) {
  const forbidden = restrictions?.[allocation];
  return !(Array.isArray(forbidden) && forbidden.includes(role));
}

/**
 * Default location policy — per class, the account roles that should hold it, in
 * preference order (earlier = better). Preference is SOFT (spills to any remaining
 * capacity when the preferred accounts are full); class restrictions are HARD (enforced
 * separately by `roleCanHold`). Restricted to the rebalanceable role set
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
 * Design 97 §23 — the MEASUREMENT SEAM for joining pool claims to placement.
 *
 * `eligibility` is `Map<stateKey, Set<ALLOCATION>>`: the classes an account is permitted
 * to hold. It is HARD where the role policy is soft — the whole point, since the policy's
 * preference lists spill into any account with capacity left and so cannot say "never
 * bonds here" (the failure this exists to price).
 *
 * Three rules, and the second and third are the ones with teeth:
 *
 * 1. **Absent ⇒ unconstrained.** A null map, or an account the map does not name, keeps
 *    today's behaviour exactly. That is what makes this inert: no caller wires it yet.
 * 2. **An account named for no class holds nothing.** An empty Set is a real statement.
 * 3. **Value conservation outranks eligibility.** If the constraint leaves an account with
 *    capacity no permitted class can fill, the final pass RELAXES it rather than stranding
 *    the money — an account whose composition does not sum to its own total breaks the
 *    Phase-2 invariant and would silently destroy value. The relaxed dollars are counted
 *    into `stats.relaxed` instead, because that number IS the measurement: it is how much
 *    of the author's placement the book cannot afford to honour.
 *
 * Unwired on purpose. Nothing reads a param into this yet; the probe sets it directly on
 * the reducer so the join can be priced BEFORE it is designed into the authoring surface.
 */
function _canHold(eligibility, stateKey, cls) {
  if (!eligibility) return true;
  const set = eligibility.get?.(stateKey);
  return set === undefined ? true : set.has(cls);
}

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
 * Design 115 — close the gaps the greedy passes leave when several classes are restricted.
 *
 * A breadth-first search over accounts from one with unfilled capacity G: an edge A → B
 * via class X means "B holds X, and A may hold X", so X can move from B into A. Reaching an
 * account that may hold a still-unplaced class Y completes a path; shifting X along it and
 * placing Y at the end fills G without breaking any restriction or changing any class
 * total. Each augment exhausts a gap, a class's unplaced dollars or an edge's holding, so
 * the loop is bounded; the iteration cap only guards against float dust.
 *
 * Mutates `out`, `remaining` and `classTargets` in place.
 */
function _repairRestrictedGaps(active, out, remaining, classTargets, mayHold) {
  const EPS = 1e-6;
  const classes = LOCATION_FILL_ORDER;
  for (let iter = 0; iter < 64 * (active.length + 1); iter++) {
    const gap = active.find(a => remaining[a.stateKey] > EPS);
    const pending = classes.filter(c => classTargets[c] > EPS);
    if (!gap || pending.length === 0) return;

    // BFS: parent.get(B) = { from: A, cls: X } ⇒ X moves B → A.
    const parent = new Map([[gap.stateKey, null]]);
    const queue = [gap];
    let end = null; let endCls = null;
    while (queue.length && !end) {
      const a = queue.shift();
      for (const x of classes) {
        if (!mayHold(x, a)) continue;
        for (const b of active) {
          if (parent.has(b.stateKey) || (out.get(b.stateKey)[x] ?? 0) <= EPS) continue;
          parent.set(b.stateKey, { from: a, cls: x });
          const y = pending.find(c => mayHold(c, b));
          if (y) { end = b; endCls = y; break; }
          queue.push(b);
        }
        if (end) break;
      }
    }
    if (!end) return;   // no path from this gap: genuinely infeasible for it

    let amt = Math.min(remaining[gap.stateKey], classTargets[endCls]);
    for (let b = end; parent.get(b.stateKey); b = parent.get(b.stateKey).from) {
      amt = Math.min(amt, out.get(b.stateKey)[parent.get(b.stateKey).cls]);
    }
    if (amt <= EPS) return;
    for (let b = end; parent.get(b.stateKey); b = parent.get(b.stateKey).from) {
      const { from, cls } = parent.get(b.stateKey);
      out.get(b.stateKey)[cls] -= amt;
      out.get(from.stateKey)[cls] = (out.get(from.stateKey)[cls] ?? 0) + amt;
    }
    out.get(end.stateKey)[endCls] = (out.get(end.stateKey)[endCls] ?? 0) + amt;
    remaining[gap.stateKey] -= amt;
    classTargets[endCls]    -= amt;
  }
}

/**
 * Plan the per-account target composition that realizes `portfolioTarget` across
 * `accounts`, honoring the location policy and the class restrictions.
 *
 * @param {object}   opts
 * @param {object[]} opts.accounts        - [{ stateKey, role, total }] (total = Σ marketValue)
 * @param {object}   opts.portfolioTarget - { EQUITY, BOND, CASH, GOLD } fractions (need not be exact)
 * @param {object}   [opts.policy]        - partial class → preferred-roles map, merged over the
 *                                        residency-resolved default (see resolveLocationPolicy)
 * @param {string}   [opts.residency]     - 'US' | 'AU'; selects gold's preference order (§12.2 Q4)
 * @param {?Map}     [opts.eligibility]   - design 97 §23 measurement seam: stateKey → Set<ALLOCATION>
 *                                        of the classes that account may hold. Null (the default)
 *                                        and unnamed accounts are unconstrained. See `_canHold`.
 * @param {?object}  [opts.restrictions]  - design 115: class → account roles that class may NEVER
 *                                        occupy (`allocationClassRestrictions`). HARD — never relaxed.
 *                                        Null (the default) restricts nothing. See `roleCanHold`.
 * @param {?object}  [opts.stats]         - optional out-param; `stats.relaxed` accumulates the
 *                                        dollars placed in violation of `eligibility` to keep each
 *                                        account's composition summing to its total;
 *                                        `stats.restricted` the class-target dollars `restrictions`
 *                                        left no account to hold (redistributed to other classes);
 *                                        `stats.overPlaced` the dollars placed beyond a class's
 *                                        target to fill an account no remaining class may enter.
 * @returns {Map<string, object>} stateKey → { <ALLOCATION>: dollars } summing to that account's total
 */
export function planLocatedTargets({ accounts = [], portfolioTarget = {}, policy = null, residency = 'US',
                                     eligibility = null, restrictions = null, stats = null } = {}) {
  // Gold's preferred home depends on residency (§12.2 Q4); everything else does not.
  // A caller-supplied `policy` is merged over the residency default, per class.
  policy = resolveLocationPolicy(residency, policy);
  const active = accounts.filter(a => (a?.total ?? 0) > 0);
  // A role barred from EVERY class cannot hold its own money, so the restriction is
  // unsatisfiable for it. The loader refuses that shape; defensively, such an account is
  // planned as if unrestricted rather than breaking value conservation.
  const canHold = (cls, role) => roleCanHold(cls, role, restrictions)
    || LOCATION_FILL_ORDER.every(c => !roleCanHold(c, role, restrictions));
  const totalPortfolio = active.reduce((s, a) => s + a.total, 0);
  const out = new Map(active.map(a => [a.stateKey, {}]));
  if (totalPortfolio <= 0) return out;

  // Class dollar targets from the portfolio fractions.
  const classTargets = {};
  for (const cls of LOCATION_FILL_ORDER) classTargets[cls] = Math.max(0, (portfolioTarget[cls] ?? 0)) * totalPortfolio;

  // Restriction cap (design 115): no class may exceed the capacity of the accounts allowed
  // to hold it. The excess is redistributed across the classes still under their own caps,
  // pro-rata to their targets, and the loop repeats because the redistribution can push
  // another class over. Unrestricted ⇒ every cap is the whole book and nothing moves.
  const caps = Object.fromEntries(LOCATION_FILL_ORDER.map(cls =>
    [cls, active.filter(a => canHold(cls, a.role)).reduce((s, a) => s + a.total, 0)]));
  const capped = new Set();
  for (let pass = 0; pass < LOCATION_FILL_ORDER.length; pass++) {
    const over = LOCATION_FILL_ORDER.filter(c => !capped.has(c) && classTargets[c] > caps[c] + 1e-6);
    if (over.length === 0) break;
    let excess = 0;
    for (const c of over) { excess += classTargets[c] - caps[c]; classTargets[c] = caps[c]; capped.add(c); }
    if (stats) stats.restricted = (stats.restricted ?? 0) + excess;
    const open = LOCATION_FILL_ORDER.filter(c => !capped.has(c));
    const base = open.reduce((s, c) => s + classTargets[c], 0);
    if (base > 0) {
      for (const c of open) classTargets[c] += excess * (classTargets[c] / base);
    } else {
      const sink = EXCESS_FALLBACK_ORDER.find(c => !capped.has(c) && caps[c] > 0);
      if (sink) classTargets[sink] += excess;
    }
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
    const eligible = active.filter(a => canHold(cls, a.role) && _canHold(eligibility, a.stateKey, cls));
    for (const a of _orderedForClass(eligible, remaining, policy[cls])) {
      if (need <= 1e-6) break;
      const amt = Math.min(need, remaining[a.stateKey]);
      if (amt <= 1e-6) continue;
      assign(a.stateKey, cls, amt);
      need -= amt;
    }
    classTargets[cls] = need;   // any un-placeable remainder (≈ 0 once capped)
  }

  // Reconcile: fill any account still carrying capacity with the leftover class dollars
  // (respecting the restrictions). With Σ class$ == Σ capacity and each class capped to what
  // its permitted accounts can hold, this drives every `remaining` to ~0 so each account's
  // composition sums to its total — exactly when at most one class is restricted.
  const RECONCILE_ORDER = [ALLOCATION.EQUITY, ALLOCATION.BOND, ALLOCATION.CASH, ALLOCATION.GOLD];
  for (const cls of RECONCILE_ORDER) {
    let need = classTargets[cls];
    if (need <= 1e-6) continue;
    for (const a of active) {
      if (need <= 1e-6) break;
      if (!canHold(cls, a.role)) continue;
      if (!_canHold(eligibility, a.stateKey, cls)) continue;
      const amt = Math.min(need, remaining[a.stateKey]);
      if (amt <= 1e-6) continue;
      assign(a.stateKey, cls, amt);
      need -= amt;
    }
    classTargets[cls] = need;
  }

  // Design 97 §23 rule 3 — value conservation outranks eligibility. Whatever the constrained
  // passes could not place goes back into the accounts that have room, ignoring `eligibility`
  // but never the class restrictions (a claim about what an account may hold, not a
  // preference). Reached only when the author's placement is infeasible against this book;
  // `stats.relaxed` is how much of it the book could not honour.
  if (eligibility) {
    for (const cls of RECONCILE_ORDER) {
      let need = classTargets[cls];
      if (need <= 1e-6) continue;
      for (const a of active) {
        if (need <= 1e-6) break;
        if (!canHold(cls, a.role)) continue;
        const amt = Math.min(need, remaining[a.stateKey]);
        if (amt <= 1e-6) continue;
        assign(a.stateKey, cls, amt);
        need -= amt;
        // Only a placement `eligibility` actually FORBIDS is a violation. This pass also
        // mops up dollars headed for unconstrained accounts — capacity the constrained
        // reconcile left behind for ordinary reasons — and counting those would report a
        // constraint as broken in runs where it was honoured exactly.
        if (stats && !_canHold(eligibility, a.stateKey, cls)) stats.relaxed = (stats.relaxed ?? 0) + amt;
      }
      classTargets[cls] = need;
    }
  }

  // Design 115 — with SEVERAL classes restricted, the greedy passes can box themselves in:
  // an account is left with capacity that only classes already spent elsewhere may enter,
  // while some class's dollars have no permitted room left. Often a valid placement exists
  // and is one or more MOVES away (put X from account B into the gap, then the stranded Y
  // into B). `_repairRestrictedGaps` finds those moves; whatever it cannot fix is genuinely
  // infeasible and falls to the over-place fill below.
  if (restrictions) {
    _repairRestrictedGaps(active, out, remaining, classTargets,
      (cls, a) => canHold(cls, a.role) && _canHold(eligibility, a.stateKey, cls));
  }

  // Value conservation still wins, but never over a restriction: a gap nothing can fix is
  // filled with a class the account IS allowed to hold, beyond that class's target, and
  // counted into `stats.overPlaced`. Unreachable with zero or one restricted class.
  if (restrictions) {
    for (const a of active) {
      const gap = remaining[a.stateKey];
      if (gap <= 1e-6) continue;
      const cls = EXCESS_FALLBACK_ORDER.find(c => canHold(c, a.role));
      if (!cls) continue;
      assign(a.stateKey, cls, gap);
      if (stats) stats.overPlaced = (stats.overPlaced ?? 0) + gap;
    }
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
    else if (drift !== 0) {
      const cls = EXCESS_FALLBACK_ORDER.find(c => canHold(c, a.role)) ?? ALLOCATION.EQUITY;
      comp[cls] = R2((comp[cls] ?? 0) + drift);
    }
  }

  return out;
}
