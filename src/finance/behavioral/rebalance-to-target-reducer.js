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
import { ALLOCATION }          from '../holdings/allocation.js';
import { ACCOUNT_ROLES }       from '../state/account-roles.js';
import { planLocatedTargets, DEFAULT_LOCATION_POLICY } from './allocation-location.js';

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
 * The US tax-advantaged roles that may NOT hold a GOLD sleeve (IRA/401k/Roth
 * bullion ban, design 61 §OQ4a). AU SUPER is deliberately excluded — bullion is a
 * permitted SMSF asset. Used both to renormalize a guarded account's target (so a
 * gold leg is never generated) and by the apply reducer's establish-new-sleeve buy.
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

/** True when a role's account may hold a GOLD sleeve (design 61 §OQ4a). */
export function roleCanHoldGold(role) {
  return !US_TAX_ADVANTAGED_ROLES.has(role);
}

// ─── Lever B — time variation (design 61 §4-B / Phase 3) ──────────────────────

/** allocationSchedule modes. STATIC is the default (back-compat). */
export const ALLOCATION_SCHEDULE = Object.freeze({
  STATIC:             'STATIC',
  GLIDEPATH:          'GLIDEPATH',
  REGIME_CONDITIONED: 'REGIME_CONDITIONED',
});

/**
 * The regime tags a REGIME_CONDITIONED target may key on, in resolution PRIORITY
 * order (first active match wins). `NORMAL` is the implicit no-active-stress
 * default, not a tag. Mirrors the tags OpportunisticRebalance/PanicSell consume.
 */
export const REGIME_TARGET_PRIORITY = [
  REGIME_TAG.ECONOMIC_STRESS, REGIME_TAG.PANIC_SELL_TRIGGER,
];

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

/** Normalize a weight map to sum to 1 (defensive; a degenerate all-zero map is returned as-is). */
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
 * Restrict a portfolio target mix to the allocation classes a given account role may
 * hold, renormalizing so the eligible shares still sum to 1. Today the only
 * restriction is the US-tax-advantaged gold guard (design 61 §OQ4a): an IRA/401k/Roth
 * drops GOLD and the freed weight spreads pro-rata across EQUITY/BOND/CASH — so a gold
 * leg is never generated for a guarded account and value still conserves. A degenerate
 * target (all-eligible weight 0) falls back to the un-normalized eligible slice.
 */
export function targetForRole(target, role) {
  if (roleCanHoldGold(role)) return target;
  const eligible = {};
  let total = 0;
  for (const [alloc, w] of Object.entries(target)) {
    if (alloc === ALLOCATION.GOLD) continue;
    eligible[alloc] = w;
    total += w;
  }
  if (total <= 0) return eligible;
  for (const alloc of Object.keys(eligible)) {
    eligible[alloc] = +(eligible[alloc] / total).toFixed(6);
  }
  return eligible;
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
   * @param {object}   [opts.regimeTargets]        - REGIME_CONDITIONED map { <REGIME_TAG>|NORMAL: weights }
   * @param {string}   [opts.locationMode]         - ALLOCATION_LOCATION mode (design 61 Lever D)
   * @param {object}   [opts.locationPolicy]       - class → preferred-roles map (Lever D placement)
   */
  constructor({ accounts = [], targetAllocation = { EQUITY: 0.60, BOND: 0.40 },
                driftBandTaxable = 0.10, driftBandSheltered = 0.02,
                scheduleMode = ALLOCATION_SCHEDULE.STATIC, glidepath = null, regimeTargets = null,
                locationMode = ALLOCATION_LOCATION.LOCATED, locationPolicy = null } = {}) {
    super('Rebalance To Target', PRIORITY.PRE_PROCESS + 4);
    this.reducedActionTypes   = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
    this.generatedActionTypes = ['REBALANCE_TO_TARGET_APPLY'];
    this.accounts             = accounts;
    this.targetAllocation     = targetAllocation;
    this.driftBandTaxable     = driftBandTaxable;
    this.driftBandSheltered   = driftBandSheltered;
    this.scheduleMode         = scheduleMode;
    this.glidepath            = glidepath;
    this.regimeTargets        = regimeTargets;
    this.locationMode         = locationMode;
    this.locationPolicy       = locationPolicy;
  }

  /**
   * Resolve the portfolio target mix in effect this period (design 61 Lever B).
   * STATIC ⇒ the fixed target; GLIDEPATH ⇒ interpolate anchors by the primary's
   * age; REGIME_CONDITIONED ⇒ pick the per-regime mix from state.activeRegimes.
   * Both time-varying modes fall back to the static target when unconfigured.
   */
  resolveScheduledTarget(state, action) {
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

    // The portfolio target in effect this period (Lever B time variation).
    const scheduledTarget = this.resolveScheduledTarget(state, action);

    // Present accounts with their current totals (skip absent / empty).
    const present = [];
    for (const { stateKey, role } of this.accounts) {
      const account = state[stateKey];
      if (!account || !Array.isArray(account.holdings)) continue;
      const total = account.holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
      if (total <= 0) continue;
      present.push({ stateKey, role, total });
    }

    // Lever D — locate the portfolio target across accounts (design 61 §4-D). The
    // plan assigns each account a composition summing to its own total, so each
    // account's rebalance still conserves value; the AGGREGATE book hits the target.
    // Recomputed every period from the current residency ⇒ a residency move re-targets
    // lazily and the drift cadence walks holdings there (§OQ4b).
    const locatedPlan = (this.locationMode === ALLOCATION_LOCATION.LOCATED)
      ? planLocatedTargets({
          accounts: present, portfolioTarget: scheduledTarget,
          policy: this.locationPolicy ?? DEFAULT_LOCATION_POLICY,
          residency: _primaryResidency(state),
        })
      : null;

    const rebalanceActions = [];
    const newFiredShocks   = [];

    for (const { stateKey, role, total } of present) {
      const account = state[stateKey];
      const taxable = TAXABLE_ROLES.has(role);
      const band    = taxable ? this.driftBandTaxable : this.driftBandSheltered;
      // LOCATED ⇒ this account's assigned composition (as fractions of its total);
      // PER_ACCOUNT ⇒ the uniform portfolio mix with the per-role gold guard.
      const target = locatedPlan
        ? _fractionsOf(locatedPlan.get(stateKey), total)
        : targetForRole(scheduledTarget, role);

      // Actual allocation fractions.
      const actual = {};
      for (const h of account.holdings) {
        const alloc = h.allocation ?? ALLOCATION.OTHER;
        actual[alloc] = (actual[alloc] ?? 0) + (h?.marketValue ?? 0);
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

    if (rebalanceActions.length === 0 && newFiredShocks.length === 0) {
      return this.newState(state);
    }

    const updatedEntry = newFiredShocks.length > 0
      ? { ...entry, firedForShocks: [...entry.firedForShocks, ...newFiredShocks] }
      : entry;

    return this.newState(
      state,
      newFiredShocks.length > 0
        ? { regimeActions: { ...state.regimeActions, [ACTION_KEY]: updatedEntry } }
        : {},
      rebalanceActions,
    );
  }
}

/** Convert a located `{ class: dollars }` composition to fractions of `total`. */
function _fractionsOf(composition, total) {
  const out = {};
  if (!composition || total <= 0) return out;
  for (const [cls, dollars] of Object.entries(composition)) out[cls] = dollars / total;
  return out;
}

/** The primary person's tax residency ('US' | 'AU'), for the Lever-D gold policy. */
function _primaryResidency(state) {
  const people = state.people ?? {};
  for (const p of Object.values(people)) {
    if (p?.residency) return p.residency;
  }
  return 'US';
}
