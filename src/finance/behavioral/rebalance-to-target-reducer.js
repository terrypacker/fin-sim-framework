/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY }   from '../../simulation-framework/reducers.js';
import { REGIME_TAG }          from '../economic-regimes/regime-tag.js';
import { ALLOCATION, totalizeMix, assertTotalMix } from '../holdings/allocation.js';
import { ACCOUNT_ROLES }       from '../state/account-roles.js';
import { planLocatedTargets } from './allocation-location.js';
import { toBaseCurrency, currencyOf } from '../fx/to-base-currency.js';

const ACTION_KEY = 'rebalance_to_target';

/**
 * How the portfolio target maps onto accounts (design 61 Lever D / Phase 4).
 * LOCATED (default) places each class in its tax-favored account so the aggregate
 * book hits the target while accounts concentrate; PER_ACCOUNT drives every account
 * to the uniform mix (the Phase 1–3 behavior; a manual escape hatch).
 */
export const ALLOCATION_LOCATION = Object.freeze({
  LOCATED:     'LOCATED',
  PER_ACCOUNT: 'PER_ACCOUNT',
});

/**
 * Roles that are sheltered (no CGT on a rebalance): a sell inside them is free.
 * (design 61 §0 TAX_ADVANTAGED_ROLES.)
 */
export const TAX_ADVANTAGED_ROLES = new Set([
  ACCOUNT_ROLES.K401, ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.ROTH, ACCOUNT_ROLES.SUPER,
]);

/**
 * Taxable brokerage roles a design-61 rebalance may churn — a sell here realizes
 * capital gains (design 61 §0 TAXABLE_ROLES). Matches the `_taxableStateKeys` set
 * the harvest strategies already use.
 */
export const TAXABLE_ROLES = new Set([
  ACCOUNT_ROLES.US_STOCK, ACCOUNT_ROLES.AU_STOCK,
]);

/**
 * The US tax-advantaged roles (IRA/401k/Roth); AU SUPER is deliberately excluded.
 *
 * This no longer gates gold — the bullion guard was reversed (design 61 §12 OQ4a,
 * 2026-07-29) because a gold ETF is holdable in all three. Retained because it is
 * exported and names a genuinely useful jurisdiction/shelter set.
 */
export const US_TAX_ADVANTAGED_ROLES = new Set([
  ACCOUNT_ROLES.K401, ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.ROTH,
]);

/** Roles that live under US tax/currency; everything else is AU. */
const US_ROLES = new Set([
  ACCOUNT_ROLES.US_SAVINGS, ACCOUNT_ROLES.FIXED_INCOME, ACCOUNT_ROLES.US_STOCK,
  ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.K401, ACCOUNT_ROLES.ROTH,
  ACCOUNT_ROLES.US_LOAN, ACCOUNT_ROLES.US_OFFSET,
]);

/** Country ('US' | 'AU') an account role belongs to. */
export function countryForRole(role) {
  return US_ROLES.has(role) ? 'US' : 'AU';
}

/**
 * True when a role's account may hold a GOLD sleeve.
 *
 * **Every role may (design 61 §12 OQ4a, reversed 2026-07-29).** This used to exclude
 * US tax-advantaged roles on the strength of the §408(m) bullion restriction. That was
 * modelling the wrong instrument: §408(m) restricts holding *physical* bullion directly
 * in an IRA, and says nothing about a **gold ETF** (GLD/IAU), which is how a retirement
 * portfolio actually takes a gold position and is available in every IRA/401k/Roth. The
 * `GOLD` sleeve here is an abstract *exposure*, not a claim about custody, and the ETF
 * carries the same US collectibles rate, so one sleeve models both.
 *
 * Kept as a named predicate rather than deleted because the location code reads better
 * for it and a future eligibility rule (an AU-super in-house-asset test, say) would land
 * here. It is currently total.
 *
 * Consequence worth knowing: the 28% collectibles rate now makes *sheltering* gold in a
 * US tax-advantaged account the tax-efficient placement for a US resident — the
 * placement the old guard forbade — so located plans will migrate gold there.
 */
export function roleCanHoldGold(_role) {
  return true;
}

// ─── Lever B — time variation (design 61 §4-B / Phase 3) ──────────────────────

/** allocationSchedule modes. STATIC is the default (back-compat). */
export const ALLOCATION_SCHEDULE = Object.freeze({
  STATIC:             'STATIC',
  GLIDEPATH:          'GLIDEPATH',
  REGIME_CONDITIONED: 'REGIME_CONDITIONED',
  // Design 97 §9 — the pool target as a number of YEARS OF SPENDING, not a percent.
  YEARS_OF_SPEND:     'YEARS_OF_SPEND',
});

/**
 * The regime tags a REGIME_CONDITIONED target may key on, in resolution PRIORITY
 * order (first active match wins). `NORMAL` is the implicit no-active-stress
 * default, not a tag. Mirrors the tags OpportunisticRebalance/PanicSell consume.
 */
export const REGIME_TARGET_PRIORITY = [
  REGIME_TAG.ECONOMIC_STRESS, REGIME_TAG.PANIC_SELL_TRIGGER,
];

/**
 * Validate every AUTHORED target mix a scenario carries, at compile time.
 *
 * This is the enforcement point for design 61 §12.2 Q3. It deliberately sits at the
 * boundary where scenario *parameters* become reducer configuration — not inside the
 * reducer's own constructor — so that the authored surface is strict while the internal
 * API stays usable from tests and tooling with a narrower mix.
 *
 * Throws on the first problem, naming the exact anchor or regime tag, because the error
 * message is the migration guide: there is no back-compat shim for a partial mix.
 *
 * @param {object} p - the resolved scenario parameter bag
 */
export function assertAuthoredMixes(p) {
  const [first] = collectAuthoredMixProblems(p);
  if (first) throw new Error(first.message);
}

/**
 * The same rule as {@link assertAuthoredMixes}, reported instead of thrown.
 *
 * The authoring UI needs every problem at once, keyed to the anchor that carries it,
 * so it can refuse a Rebuild and point at the offending row — and the boot-time
 * recovery path needs to identify the bad param without parsing an error string.
 * Both must agree with the compiler to the letter, so this IS the compiler's check:
 * `assertAuthoredMixes` throws the first entry this returns.
 *
 * @param {object} p - the resolved scenario parameter bag
 * @returns {Array<{param: string, index: number|null, message: string}>} empty when valid
 */
export function collectAuthoredMixProblems(p) {
  const problems = [];
  const check = (param, index, fn) => {
    try { fn(); } catch (e) { problems.push({ param, index, message: e.message }); }
  };

  if (p?.rebalanceTargetAllocation != null) {
    check('rebalanceTargetAllocation', null,
      () => assertTotalMix(p.rebalanceTargetAllocation, 'rebalanceTargetAllocation'));
  }

  if (Array.isArray(p?.allocationGlidepath)) {
    p.allocationGlidepath.forEach((anchor, i) => {
      check('allocationGlidepath', i, () => {
        if (!anchor || typeof anchor !== 'object') {
          throw new Error(`allocationGlidepath[${i}]: expected { age, weights }, got ${JSON.stringify(anchor)}.`);
        }
        if (!Number.isFinite(Number(anchor.age))) {
          throw new Error(`allocationGlidepath[${i}]: "age" must be a number, got ${JSON.stringify(anchor.age)}.`);
        }
        assertTotalMix(anchor.weights, `allocationGlidepath[${i}] (age ${anchor.age})`);
      });
    });
  }

  if (p?.allocationRegimeTargets != null) {
    const map = p.allocationRegimeTargets;
    if (typeof map !== 'object' || Array.isArray(map)) {
      problems.push({
        param: 'allocationRegimeTargets', index: null,
        message: `allocationRegimeTargets: expected a { regimeTag: mix } map, got ${typeof map}.`,
      });
    } else {
      Object.entries(map).forEach(([tag, mix], i) => {
        check('allocationRegimeTargets', i,
          () => assertTotalMix(mix, `allocationRegimeTargets["${tag}"]`));
      });
    }
  }

  return problems;
}

/** Whole years of age as of asOfMs (matches the RMD / spending-band handlers). */
export function ageAsOf(birthDate, asOfMs) {
  if (!birthDate || asOfMs == null) return null;
  const bd = birthDate instanceof Date ? birthDate : new Date(birthDate);
  const as = new Date(asOfMs);
  const years = as.getUTCFullYear() - bd.getUTCFullYear();
  const hadBirthday =
    as.getUTCMonth() > bd.getUTCMonth() ||
    (as.getUTCMonth() === bd.getUTCMonth() && as.getUTCDate() >= bd.getUTCDate());
  return hadBirthday ? years : years - 1;
}

/**
 * Normalize a weight map to sum to 1.
 *
 * Kept as a post-validation guard only. Authored mixes are validated by
 * `assertAuthoredMixes` (called at compile, from the behavioral registry), which REJECTS
 * a non-unit sum rather than rescaling it — a silent rescale is exactly what turned an
 * authored 0.75/0.25/0/0.25 into an executed 0.6/0.2/0/0.2 with no signal (design 61
 * §12.2 Q3). On validated input this is a no-op; it still earns its keep for the
 * *blended* glidepath result, where two valid anchors can leave a 6-dp rounding residue.
 */
function _normalize(weights) {
  const total = Object.values(weights).reduce((s, v) => s + Math.max(0, v ?? 0), 0);
  if (total <= 0) return { ...weights };
  const out = {};
  for (const [k, v] of Object.entries(weights)) out[k] = +(Math.max(0, v ?? 0) / total).toFixed(6);
  return out;
}

/**
 * GLIDEPATH: linearly interpolate the target mix between `{ age, weights }` anchors
 * by the current age (design 61 §4-B). Below the first anchor uses the first's
 * weights; above the last uses the last's; between two anchors interpolates each
 * class independently. Anchors need not be pre-sorted. A linear blend of two
 * simplex points stays on the simplex; the result is normalized defensively.
 */
export function interpolateGlidepath(anchors, age, fallback) {
  const list = (Array.isArray(anchors) ? anchors : [])
    .filter(a => a && a.weights && Number.isFinite(Number(a.age)))
    .map(a => ({ age: Number(a.age), weights: a.weights }))
    .sort((x, y) => x.age - y.age);
  if (list.length === 0 || age == null) return fallback;
  if (age <= list[0].age) return _normalize(list[0].weights);
  if (age >= list[list.length - 1].age) return _normalize(list[list.length - 1].weights);
  let lo = list[0], hi = list[list.length - 1];
  for (let i = 0; i < list.length - 1; i++) {
    if (age >= list[i].age && age <= list[i + 1].age) { lo = list[i]; hi = list[i + 1]; break; }
  }
  const span = hi.age - lo.age;
  const t    = span > 0 ? (age - lo.age) / span : 0;
  const classes = new Set([...Object.keys(lo.weights), ...Object.keys(hi.weights)]);
  const blended = {};
  for (const c of classes) {
    const a = lo.weights[c] ?? 0, b = hi.weights[c] ?? 0;
    blended[c] = a + (b - a) * t;
  }
  return _normalize(blended);
}

/**
 * REGIME_CONDITIONED: pick the target keyed to the highest-priority ACTIVE regime
 * tag, falling back to the map's `NORMAL` entry, then to `fallback` (design 61
 * §4-B). This generalizes the reactive PanicSell (EQUITY→CASH on stress) into a
 * full per-regime mix.
 */
export function resolveRegimeTarget(regimeTargets, activeRegimes, fallback) {
  if (!regimeTargets || typeof regimeTargets !== 'object') return fallback;
  const activeTags = new Set(
    (activeRegimes ?? []).flatMap(r => r?.tags ?? []));
  for (const tag of REGIME_TARGET_PRIORITY) {
    if (activeTags.has(tag) && regimeTargets[tag]) return _normalize(regimeTargets[tag]);
  }
  if (regimeTargets.NORMAL) return _normalize(regimeTargets.NORMAL);
  return fallback;
}

/**
 * RebalanceToTargetReducer — design 61 Lever C (Phase 2). The taxable-aware
 * generalization of OpportunisticRebalanceReducer: rebalances BOTH tax-advantaged
 * (free) AND taxable (CGT-realizing) accounts toward a portfolio target mix,
 * emitting REBALANCE_TO_TARGET_APPLY per drifted account. Each account uses its own
 * tier's drift band (taxable = wide, sheltered = tight, design 61 §OQ3), and a
 * US-tax-advantaged account's target drops GOLD (bullion ban, §OQ4a).
 *
 * Like its Phase-1 predecessor it also fires on PANIC_SELL_TRIGGER / ECONOMIC_STRESS
 * regime entry (idempotent per shockId). Per-account, one portfolio target — true
 * cross-account location is Lever D (Phase 4).
 */
export class RebalanceToTargetReducer extends Reducer {
  static type        = 'RebalanceToTargetReducer';
  static description = 'Rebalances tax-advantaged (free) and taxable (CGT-realizing) holdings toward a portfolio target mix when drift exceeds the per-tier band; emits REBALANCE_TO_TARGET_APPLY.';

  /**
   * @param {object}   opts
   * @param {object[]} opts.accounts               - [{stateKey, role}] rebalanceable accounts
   * @param {object}   [opts.targetAllocation]     - STATIC target / schedule fallback { EQUITY, BOND, CASH, GOLD }
   * @param {number}   [opts.driftBandTaxable]     - drift band for taxable accounts (wide)
   * @param {number}   [opts.driftBandSheltered]   - drift band for sheltered accounts (tight)
   * @param {string}   [opts.scheduleMode]         - ALLOCATION_SCHEDULE mode (design 61 Lever B)
   * @param {Array}    [opts.glidepath]            - GLIDEPATH anchors [{ age, weights }]
   * @param {object}   [opts.poolYears]            - YEARS_OF_SPEND pools { CASH, BOND } in years
   * @param {string}   [opts.expensesCurrency]     - what `state.monthlyExpenses` is a price in
   * @param {string}   [opts.baseCurrency]         - valuation base for the years arithmetic
   * @param {object}   [opts.regimeTargets]        - REGIME_CONDITIONED map { <REGIME_TAG>|NORMAL: weights }
   * @param {string}   [opts.locationMode]         - ALLOCATION_LOCATION mode (design 61 Lever D)
   * @param {object}   [opts.locationPolicy]       - class → preferred-roles map (Lever D placement)
   */
  constructor({ accounts = [], targetAllocation = { EQUITY: 0.60, BOND: 0.40 },
                driftBandTaxable = 0.10, driftBandSheltered = 0.02,
                scheduleMode = ALLOCATION_SCHEDULE.STATIC, glidepath = null, regimeTargets = null,
                poolYears = null, expensesCurrency = 'RESIDENCE', baseCurrency = 'USD',
                locationMode = ALLOCATION_LOCATION.LOCATED, locationPolicy = null,
                poolGraph = null } = {}) {
    super('Rebalance To Target', PRIORITY.PRE_PROCESS + 4);
    this.reducedActionTypes   = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
    this.generatedActionTypes = ['REBALANCE_TO_TARGET_APPLY'];
    this.accounts             = accounts;
    this.targetAllocation     = targetAllocation;
    this.driftBandTaxable     = driftBandTaxable;
    this.driftBandSheltered   = driftBandSheltered;
    this.scheduleMode         = scheduleMode;
    this.glidepath            = glidepath;
    // Design 97 §9 — YEARS_OF_SPEND config. `poolYears` is { CASH: n, BOND: n } in years of
    // current annual spending; `expensesCurrency` says what currency `state.monthlyExpenses`
    // is a price in (see `_annualSpendBase`).
    this.poolYears            = poolYears;
    this.expensesCurrency     = expensesCurrency;
    this.baseCurrency         = baseCurrency;
    this.regimeTargets        = regimeTargets;
    this.locationMode         = locationMode;
    this.locationPolicy       = locationPolicy;
    // Design 97 §12.2/§12.4 — EXECUTOR 1. When a liquidity graph is present it is the ONE
    // authority for the size of the classes its pools claim, and its gates act as a veto on
    // the sale that would otherwise refill them. Null ⇒ every line below is inert and this
    // reducer is byte-identical to the pre-97 one.
    this.poolGraph            = poolGraph;
  }

  /**
   * Design 97 §12.2 — the portfolio mix implied by the graph's pool targets.
   *
   * `PoolFlowReducer` has already resolved each pool's target to a base-currency figure and
   * stamped it on `state.liquidityPools`, so this reads ONE spend line and ONE book — a
   * years-of-spend target and a years-of-cover report that read different lines would
   * silently disagree about what "4 years" means.
   *
   * Fill order is the SPEND order, which is the same principle §9.2 established for
   * CASH → BOND → GOLD → EQUITY: when the book cannot cover the pools, the pool that is
   * spent FIRST wins. A book too small for both buckets should be all cash and no equity,
   * not a proportionally shrunken copy of a mix it cannot afford.
   *
   * Classes no pool targets keep their scheduled weights, renormalised into whatever room
   * is left — so a graph that sizes only the reserve leaves the glidepath governing the rest.
   *
   * **A target of ZERO is a target.** "Hold no reserve" is an authorable policy and the
   * natural bottom row of any pool-size sweep, and it must not fall through to the
   * scheduled weight for that class. This guard used to read `targetBase > 0`, which
   * conflated "the pool resolved no target" with "the pool's target is nothing" — so an arm
   * authored as 0 years of bonds silently held the AUTHORED bond weight, and a size sweep's
   * bottom row was not a member of its own series. Found by a pool search whose 0-year arm
   * held MORE bonds than its 2-year arm (design 97 §18.3e).
   */
  _resolvePoolTarget(state, bookBase, fallbackMix) {
    const cube = state?.liquidityPools;
    if (!cube || !(bookBase > 0)) return null;
    const pools = [...(this.poolGraph.pools ?? [])]
      .filter(p => p.target)
      .sort((a, b) => (a.spendOrder ?? Number.MAX_SAFE_INTEGER) - (b.spendOrder ?? Number.MAX_SAFE_INTEGER));

    const mix    = {};
    const taken  = new Set();
    let room     = 1;
    for (const pool of pools) {
      const cls = (pool.claims.flatMap(c => c.sleeves ?? []))[0];
      if (!cls) continue;                                   // a whole-account pool holds no class
      const targetBase = cube[pool.id]?.target;
      // Finite, not positive: zero is an authored policy (see the note above), while null,
      // undefined and NaN mean the pool resolved no target at all and must fall through.
      if (!Number.isFinite(targetBase)) continue;
      const frac = Math.max(0, Math.min(room, targetBase / bookBase));
      mix[cls] = (mix[cls] ?? 0) + frac;
      room -= frac;
      taken.add(cls);
    }
    if (!taken.size && !Object.keys(state.poolRefillPlan?.adjust ?? {}).length) return null;

    // Design 97 §12.4 — an in-portfolio `fractionOfSource` edge that fired this period,
    // stamped by PoolFlowReducer as a per-pool shift. This is the ONE thing a static target
    // cannot say: "on a 20 % drawdown, rotate a quarter of the reserve into equity". The
    // shift is temporary by construction — when the gate closes the edge stops firing and
    // the mix returns to its targets, which is what a dip-buy is.
    const adjust = state.poolRefillPlan?.adjust;
    if (adjust) {
      for (const pool of this.poolGraph.pools ?? []) {
        const delta = adjust[pool.id];
        if (!delta) continue;
        const cls = (pool.claims.flatMap(c => c.sleeves ?? []))[0];
        if (!cls) continue;
        const base = mix[cls] ?? (fallbackMix?.[cls] ?? 0);
        mix[cls] = Math.max(0, base + delta / bookBase);
        taken.add(cls);
      }
      // Recompute the room from what the mix now actually claims rather than tracking it
      // incrementally: an adjustment can move a class the target loop never touched, and a
      // running subtraction then double-counts the fallback weight it inherited.
      room = Math.max(0, 1 - Object.values(mix).reduce((a, b) => a + b, 0));
    }

    // The residual, split by the scheduled mix's relative weights among the classes the
    // graph did not claim. EQUITY absorbs it when the fallback names none of them, which is
    // the same residual rule §9.2 uses.
    const rest = Object.entries(fallbackMix ?? {}).filter(([c, w]) => !taken.has(c) && w > 0);
    const restTotal = rest.reduce((s, [, w]) => s + w, 0);
    if (room > 1e-9) {
      if (restTotal > 0) for (const [c, w] of rest) mix[c] = (mix[c] ?? 0) + room * (w / restTotal);
      else mix[ALLOCATION.EQUITY] = (mix[ALLOCATION.EQUITY] ?? 0) + room;
    }
    return totalizeMix(mix);
  }

  /**
   * Design 97 §12.4 — the GATE AS A VETO.
   *
   * A closed gate stops the explicit refill edge. If the drift band then sells the same
   * sleeve for the same reason, the gate has changed nothing — which is `FINDINGS.md` §6.4's
   * laundering, arriving from the other direction. So a vetoed pool's classes have their
   * target RAISED to what the portfolio currently holds: the rebalancer cannot sell them,
   * and the other classes renormalise into what is left.
   *
   * Raising the target rather than deleting the sell leg is deliberate — legs must sum to
   * zero for gross value to be conserved, and surgery on one leg breaks that invariant.
   */
  _applyVeto(mix, state, actualFractions) {
    if (!mix) return mix;
    // Floor first, then cap (§12.4c): a graph may mix the two scopes, and the cap has to see
    // the mix the floor left or the two would each renormalise a different denominator.
    const floored = this._applySourceVeto(mix, state, actualFractions);
    return this._applyEdgeVeto(floored, state, actualFractions);
  }

  /**
   * `scope: SOURCE` — "do not SELL this pool while it is down" (§12.4/§12.4c).
   *
   * Raising the target rather than deleting the sell leg is deliberate — legs must sum to
   * zero for gross value to be conserved, and surgery on one leg breaks that invariant.
   *
   * The `floorSum >= 1` branch is the one to read twice. Once the vetoed pool holds nearly
   * the whole book — which is what spending a reserve down produces — the floor reaches 1 and
   * every UNGATED class is zeroed with it, for as long as the gate holds. That is a real
   * measured behaviour (`pool-veto-floor-collapse`: BOND and CASH at 0.0 % for six consecutive
   * years, on a graph whose gates never mentioned cash), and it is the strictness this scope
   * is FOR, not a defect in it — but it is why §12.4c exists and why EDGE is the safer scope.
   */
  _applySourceVeto(mix, state, actualFractions) {
    const vetoed = state?.poolRefillPlan?.vetoed;
    if (!Array.isArray(vetoed) || vetoed.length === 0) return mix;
    const byId = new Map((this.poolGraph?.pools ?? []).map(p => [p.id, p]));
    const held = new Map();
    for (const id of vetoed) {
      for (const cls of (byId.get(id)?.claims ?? []).flatMap(c => c.sleeves ?? [])) {
        held.set(cls, Math.max(held.get(cls) ?? 0, actualFractions?.[cls] ?? 0));
      }
    }
    if (!held.size) return mix;
    const out = { ...mix };
    let floorSum = 0;
    for (const [cls, frac] of held) {
      out[cls] = Math.max(out[cls] ?? 0, frac);
      floorSum += out[cls];
    }
    if (floorSum >= 1) return totalizeMix(Object.fromEntries([...held].map(([c]) => [c, out[c]])));
    const others = Object.entries(out).filter(([c]) => !held.has(c) && out[c] > 0);
    const otherSum = others.reduce((s, [, w]) => s + w, 0);
    if (otherSum > 0) for (const [c, w] of others) out[c] = (1 - floorSum) * (w / otherSum);
    return totalizeMix(out);
  }

  /**
   * `scope: EDGE` — "do not FILL that pool from this one while it is down" (§12.4c).
   *
   * The mirror of the floor: cap every class the gated edge's DESTINATION claims at what the
   * portfolio currently holds, so the drift band cannot grow the pool the gate just refused to
   * fill. It blocks the identical laundering trade from the other end.
   *
   * Two properties follow from capping rather than flooring, and both are the point:
   *
   *  - **an ungated class can only ever GAIN weight**, so this can never collapse a target the
   *    author did not gate — the `floorSum >= 1` failure has no analogue here;
   *  - **it constrains only the routes the author drew.** A pool claiming no ALLOCATION class
   *    (an offset, a cash facility) caps nothing, so gating an edge into one leaves the
   *    rebalancer free. That is the honest cost of the scope and the reason SOURCE stays the
   *    default — see §12.4c before reading EDGE as strictly safer.
   *
   * Driven off `poolRefillPlan.capped`, the EDGE-scoped sibling of `vetoed`, stamped by
   * `PoolFlowReducer` in the same pass. Re-deriving it here from `gated` plus a flow lookup
   * also works and is what the prototype did — but the panel needs the same list, and two
   * derivations of one decision is how they come to disagree. One consequence to keep: it is
   * recorded only for an edge whose `want > 0`, so a shut edge that wanted nothing caps
   * nothing. Correct (no demand, no trade to launder), and it makes an EDGE veto demand-driven
   * where a SOURCE veto is not.
   */
  _applyEdgeVeto(mix, state, actualFractions) {
    const capped = state?.poolRefillPlan?.capped;
    if (!Array.isArray(capped) || capped.length === 0) return mix;
    const byId = new Map((this.poolGraph?.pools ?? []).map(p => [p.id, p]));
    const cap = new Map();
    for (const id of capped) {
      for (const cls of (byId.get(id)?.claims ?? []).flatMap(c => c.sleeves ?? [])) {
        // The TIGHTEST cap wins when two gated edges name one destination class, mirroring
        // the floor's `Math.max` — both mean "the most restrictive statement governs".
        cap.set(cls, Math.min(cap.get(cls) ?? Infinity, actualFractions?.[cls] ?? 0));
      }
    }
    if (!cap.size) return mix;
    const out = { ...mix };
    let freed = 0;
    for (const [cls, c] of cap) {
      const now = out[cls] ?? 0;
      if (now > c) { freed += now - c; out[cls] = c; }
    }
    if (freed <= 0) return mix;      // nothing was above its cap; the mix is already legal
    const others = Object.entries(out).filter(([c]) => !cap.has(c) && out[c] > 0);
    const otherSum = others.reduce((s, [, w]) => s + w, 0);
    // Nowhere to put the freed weight (every other class is zero) ⇒ leave it with the capped
    // classes rather than emit a mix that does not sum to 1. `totalizeMix` then restores the
    // pre-cap proportions, which is the honest "this cap cannot be expressed" outcome.
    if (otherSum <= 0) return mix;
    for (const [c, w] of others) out[c] = w + freed * (w / otherSum);
    return totalizeMix(out);
  }

  /**
   * The household's annual spend, in the valuation base currency (design 97 §9).
   *
   * `state.monthlyExpenses` is the NATIVE figure in `expensesCurrency`, and under the
   * default RESIDENCE mode that native figure is denominated in the BASE currency —
   * `MonthlyExpensesHandler` re-bases it into the residence currency once, at spend time
   * (`rebaseAtAnchor(nativeAmount, baseCurrency, residenceCurrency, state)`). So RESIDENCE
   * needs no conversion here and an explicitly pinned USD/AUD does.
   *
   * It is read live rather than from the authored parameter because
   * `InflationAdjustReducer` inflates it every year — that is the whole point of a target
   * expressed in years: the reserve grows with the spend line instead of with the book.
   */
  _annualSpendBase(state) {
    const monthly = Number(state?.monthlyExpenses);
    if (!Number.isFinite(monthly) || monthly <= 0) return 0;
    const ccy = (this.expensesCurrency === 'RESIDENCE') ? this.baseCurrency : this.expensesCurrency;
    return toBaseCurrency(monthly * 12, ccy, this.baseCurrency, state);
  }

  /**
   * Design 97 §9 — the pool target resolved as N YEARS OF SPENDING.
   *
   * A percentage target and a years target diverge in exactly the wrong direction: a fixed
   * BOND percentage **over-provisions as the book grows and under-provisions after a
   * crash**, which is inverted from what a reserve is for. Measured on the reference plan,
   * accessible bond cover under a fixed percentage ran 3.5 years in 2027 to 13.6 by 2042 with
   * no crash, and fell to 4.5 by 2042 with one — so a plan authored as "4 years of bonds" is
   * not 4 years for most of its own horizon.
   *
   * Here CASH and BOND are dollar figures off the live spend line, converted to fractions of
   * the current book; GOLD keeps its authored weight and EQUITY is the residual. Fill order
   * is CASH → BOND → GOLD → EQUITY, so when the book cannot cover the pools the LOWER pool
   * wins: a book too small for both buckets should be all cash and no equity, not a
   * proportionally shrunken version of a mix it cannot afford.
   *
   * ⚠️ This decides the mix, NOT where it sits. The design-61 LOCATED planner then places
   * bonds in whichever account is tax-favoured, which for a pre-60 household is the
   * age-gated wrappers — where they are not cover for anyone. "N years of ACCESSIBLE cover"
   * additionally needs a location policy that prefers the taxable accounts for CASH/BOND.
   * That is authorable config (`allocationLocationPolicy`); it is deliberately not forced
   * here, because location is a separate lever and silently overriding it would make one
   * mode of one strategy secretly rewrite another.
   *
   * @param {object} state
   * @param {number} bookBase - the rebalanced book, in base currency
   * @returns {object|null} a total mix, or null to fall through to the authored target
   */
  _resolveYearsTarget(state, bookBase) {
    const S = this._annualSpendBase(state);
    if (!(S > 0) || !(bookBase > 0)) return null;   // no spend line / empty book ⇒ fall back

    const years = this.poolYears ?? {};
    let room = 1;
    const take = (y) => {
      const want = Number(y);
      if (!Number.isFinite(want) || want <= 0) return 0;
      const frac = Math.min(room, (want * S) / bookBase);
      room -= frac;
      return frac;
    };

    const CASH   = take(years[ALLOCATION.CASH]);
    const BOND   = take(years[ALLOCATION.BOND]);
    const GOLD   = Math.min(room, Math.max(0, Number(this.targetAllocation?.[ALLOCATION.GOLD]) || 0));
    room -= GOLD;
    const EQUITY = Math.max(0, room);
    return totalizeMix({ CASH, BOND, GOLD, EQUITY });
  }

  /**
   * Resolve the portfolio target mix in effect this period (design 61 Lever B).
   * STATIC ⇒ the fixed target; GLIDEPATH ⇒ interpolate anchors by the primary's
   * age; REGIME_CONDITIONED ⇒ pick the per-regime mix from state.activeRegimes.
   * Both time-varying modes fall back to the static target when unconfigured.
   */
  resolveScheduledTarget(state, action, bookBase = 0, actualFractions = null) {
    // Design 97 §12.2 — ONE authority. A graph target governs the classes its pools claim
    // and `allocationSchedule` governs the rest; authoring both a graph target and
    // poolCashYears/poolBondYears throws at config time, because one would silently win.
    if (this.poolGraph) {
      const base = this._scheduledMix(state, action, bookBase);
      const mix  = this._resolvePoolTarget(state, bookBase, base) ?? base;
      return this._applyVeto(mix, state, actualFractions);
    }
    return this._scheduledMix(state, action, bookBase);
  }

  /** The pre-97 schedule resolution — Lever B alone. */
  _scheduledMix(state, action, bookBase = 0) {
    if (this.scheduleMode === ALLOCATION_SCHEDULE.YEARS_OF_SPEND) {
      return this._resolveYearsTarget(state, bookBase) ?? this.targetAllocation;
    }
    if (this.scheduleMode === ALLOCATION_SCHEDULE.GLIDEPATH) {
      const cc         = action?.type === 'AU_PERIOD_ADVANCE' ? 'AU' : 'US';
      const primaryKey = Object.keys(state.people ?? {})[0];
      const birthDate  = state.people?.[primaryKey]?.birthDate;
      const asOfMs     = action?.date != null ? new Date(action.date).getTime()
                                              : state.currentPeriods?.[cc]?.startMs;
      const age = ageAsOf(birthDate, asOfMs);
      return interpolateGlidepath(this.glidepath, age, this.targetAllocation);
    }
    if (this.scheduleMode === ALLOCATION_SCHEDULE.REGIME_CONDITIONED) {
      return resolveRegimeTarget(this.regimeTargets, state.activeRegimes, this.targetAllocation);
    }
    return this.targetAllocation;
  }

  reduce(state, action) {
    const regimes = state.activeRegimes ?? [];
    const entry   = state.regimeActions?.[ACTION_KEY] ?? { firedForShocks: [] };
    const alreadyFired = new Set(entry.firedForShocks);

    const qualifyingRegimes = regimes.filter(r =>
      (r.tags?.includes(REGIME_TAG.PANIC_SELL_TRIGGER) ||
       r.tags?.includes(REGIME_TAG.ECONOMIC_STRESS)) &&
      !alreadyFired.has(r.shockId),
    );

    // Present accounts with their current totals (skip absent / empty).
    //
    // Built BEFORE the target is resolved because YEARS_OF_SPEND needs the book to turn a
    // dollar figure ("4 years of spending") into the fraction the rest of this reducer
    // works in. Every other mode ignores the extra argument.
    const present = [];
    let bookBase = 0;
    for (const { stateKey, role } of this.accounts) {
      const account = state[stateKey];
      if (!account || !Array.isArray(account.holdings)) continue;
      const total = account.holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
      if (total <= 0) continue;
      present.push({ stateKey, role, total });
      // FX-normalised, unlike `total` itself. The years arithmetic compares a spend figure
      // against a book, so the two have to be in one currency or "4 years" means nothing.
      // Note the located planner downstream still sums raw per-account totals — a
      // pre-existing currency-blindness (design 61 / `planLocatedTargets`) that this mode
      // inherits rather than fixes, and which shifts the REALISED pool by the AUD share of
      // the book. Measure the realised years; do not assume them.
      bookBase += toBaseCurrency(total, currencyOf(account, this.baseCurrency), this.baseCurrency, state);
    }

    // Portfolio-level actual fractions — needed only by the design-97 veto, which has to
    // know what the vetoed classes currently hold in order to pin their target there.
    let actualFractions = null;
    if (this.poolGraph && bookBase > 0) {
      const byClass = {};
      let grossTotal = 0;
      for (const { stateKey } of present) {
        const account = state[stateKey];
        for (const h of account.holdings ?? []) {
          const v = toBaseCurrency(h?.marketValue ?? 0, currencyOf(account, this.baseCurrency), this.baseCurrency, state);
          byClass[h.allocation] = (byClass[h.allocation] ?? 0) + v;
          grossTotal += v;
        }
      }
      actualFractions = grossTotal > 0
        ? Object.fromEntries(Object.entries(byClass).map(([c, v]) => [c, v / grossTotal]))
        : {};
    }

    // The portfolio target in effect this period (Lever B time variation).
    const scheduledTarget = this.resolveScheduledTarget(state, action, bookBase, actualFractions);

    // Lever D — locate the portfolio target across accounts (design 61 §4-D). The
    // plan assigns each account a composition summing to its own total, so each
    // account's rebalance still conserves value; the AGGREGATE book hits the target.
    // Recomputed every period from the current residency ⇒ a residency move re-targets
    // lazily and the drift cadence walks holdings there (§OQ4b).
    const locatedPlan = (this.locationMode === ALLOCATION_LOCATION.LOCATED)
      ? planLocatedTargets({
          accounts: present, portfolioTarget: scheduledTarget,
          // Pass the override through as-is (possibly null): planLocatedTargets merges it
          // over the residency-resolved default, which is what selects gold's preferred
          // home (design 61 §12.2 Q4). Passing DEFAULT_LOCATION_POLICY here instead would
          // pin the residency-agnostic gold list and make the whole lever inert.
          policy: this.locationPolicy ?? null,
          residency: _primaryResidency(state),
        })
      : null;

    const rebalanceActions = [];
    const newFiredShocks   = [];
    // Design 65 §OQ1(a): stamp each account's current target composition into state
    // every period — even when no rebalance fires — so the allocation-aware drawdown
    // (Lever C) can read `actual − target` per sleeve at liquidation time and sell the
    // over-weight sleeve first. Copy-on-write (a fresh account object) keeps the
    // JOURNAL_STRICT purity invariant; the field is inert unless drawdownRebalanceWeight>0.
    const stampPatch = {};

    for (const { stateKey, role, total } of present) {
      const account = state[stateKey];
      const taxable = TAXABLE_ROLES.has(role);
      const band    = taxable ? this.driftBandTaxable : this.driftBandSheltered;
      // LOCATED ⇒ this account's assigned composition (as fractions of its total);
      // PER_ACCOUNT drives every account to the uniform portfolio mix. There is no
      // longer any role-based restriction to apply here — `targetForRole` existed only
      // to strip GOLD from US tax-advantaged accounts and was removed with that guard
      // (design 61 §12 OQ4a, reversed 2026-07-29).
      const target = locatedPlan
        ? _fractionsOf(locatedPlan.get(stateKey), total)
        : scheduledTarget;
      // `targetBand` rides along for design 82 §7's target overlay: it is the band THIS
      // reducer just drift-checked against, so a report can mark a breach exactly rather
      // than re-deriving it from params + a role classification that could drift out of
      // step with `TAXABLE_ROLES` here. One number per account per period, alongside the
      // composition that is already stamped.
      stampPatch[stateKey] = { ...account, targetComposition: target, targetBand: band };

      // Actual allocation fractions.
      const actual = {};
      for (const h of account.holdings) {
        // Every holding carries a valid allocation (enforced in Holding's constructor).
        actual[h.allocation] = (actual[h.allocation] ?? 0) + (h?.marketValue ?? 0);
      }

      const needsRebalance = Object.entries(target).some(([alloc, tgt]) => {
        const actualFrac = (actual[alloc] ?? 0) / total;
        return Math.abs(actualFrac - tgt) > band;
      });
      if (!needsRebalance && qualifyingRegimes.length === 0) continue;

      // Legs: signed delta per allocation. Include a negative leg for any
      // held-but-not-targeted class (e.g. drop a legacy sleeve) so its value is
      // redeployed into the target classes and Σ delta = 0 (gross conservation).
      const classes = new Set([...Object.keys(target), ...Object.keys(actual)]);
      const legs = [...classes].map(alloc => {
        const targetMv = (target[alloc] ?? 0) * total;
        const actualMv = actual[alloc] ?? 0;
        return { allocation: alloc, delta: +(targetMv - actualMv).toFixed(2) };
      }).filter(l => Math.abs(l.delta) > 0.01);
      if (legs.length === 0) continue;

      rebalanceActions.push({
        type: 'REBALANCE_TO_TARGET_APPLY',
        stateKey, role, taxable, country: countryForRole(role), legs,
      });
    }

    for (const r of qualifyingRegimes) newFiredShocks.push(r.shockId);

    // Always return the target stamp (design 65 §OQ1a) even when nothing drifted, so
    // the drawdown sees a fresh target between rebalances. Merge in the fired-shock
    // ledger only when a regime rebalance fired.
    const patch = { ...stampPatch };
    if (newFiredShocks.length > 0) {
      patch.regimeActions = {
        ...state.regimeActions,
        [ACTION_KEY]: { ...entry, firedForShocks: [...entry.firedForShocks, ...newFiredShocks] },
      };
    }

    return this.newState(state, patch, rebalanceActions);
  }
}

/** Convert a located `{ class: dollars }` composition to fractions of `total`. */
function _fractionsOf(composition, total) {
  if (!composition || total <= 0) return {};
  const out = {};
  for (const [cls, dollars] of Object.entries(composition)) out[cls] = dollars / total;
  // Totalize (design 61 §12.2 Q3). A located composition names only the classes placed
  // in THIS account, so a shelter holding pure equity used to yield `{EQUITY: 1}` — and
  // `needsRebalance` iterates the target's own keys, so the classes located elsewhere
  // were never drift-checked here at all. Backfilling explicit zeros is both the correct
  // meaning ("this account should hold none of that") and what makes the check total.
  return totalizeMix(out);
}

/** The primary person's tax residency ('US' | 'AU'), for the Lever-D gold policy. */
function _primaryResidency(state) {
  const people = state.people ?? {};
  for (const p of Object.values(people)) {
    if (p?.residency) return p.residency;
  }
  return 'US';
}
