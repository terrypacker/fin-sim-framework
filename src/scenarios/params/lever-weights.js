/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ACCOUNT_ROLES }            from '../../finance/state/account-roles.js';
import { ALLOCATION, totalizeMix }  from '../../finance/holdings/allocation.js';

/**
 * The searchable LEVER WEIGHT vocabulary — drawdown order (design 58 Lever B) and
 * target allocation mix (design 61 Lever A) — as pure data and pure functions.
 *
 * ─── why this is a LEAF module, and why that is load-bearing ─────────────────────
 *
 * This file imports only `account-roles.js` and `allocation.js`, both leaves. It must
 * stay that way. These constants were extracted from `intl-retirement-scenario.js` by
 * design 81 phase 2 for one measured reason: `intl-retirement-scenario.js` imports every
 * toolset, and `us-retirement-toolset.js` imports `MpcDecisionScheduleReducer` →
 * `lever-schedule.js`. Giving `lever-schedule.js` an import of the scenario module closed
 * that loop, and it does NOT degrade gracefully — four entry points that load today
 * (`us-retirement-toolset.js`, `intl-retirement-scenario.js`,
 * `mpc-decision-schedule-reducer.js`, `cockpit-controller.js`) each died at import with a
 * TDZ `Cannot access 'X' before initialization`. The precedent is already in the tree:
 * design 65's sleeve weight-key helpers live in `holdings-selection.js` "so the toolset
 * projection can import them without a circular scenario↔toolset dependency".
 *
 * `intl-retirement-scenario.js` re-exports everything here, so every existing import site
 * is unchanged; the schema BUILDERS (`buildDrawdownWeightSchema`, `buildAllocWeightSchema`)
 * stay there, because a param schema is scenario surface and nothing in the reducer path
 * needs one.
 */

/**
 * Cash band — savings/checking roles are ranked ahead of every investment role
 * (priority 0) in the built-in strategies, so idle cash is spent before any
 * growth asset is liquidated ("spend non-investment money first"). Two runtime
 * rules in AccountService.replenishSavings give cash its distinct behaviour:
 *   1. a cash source is drawn down only to its `minimumBalance` (keeps a buffer);
 *   2. cash is liquid everywhere — it bypasses the LOCAL_FIRST same-country gate,
 *      so idle cash in the non-residence country is repatriated (FX fee applies)
 *      instead of stranding while growth assets are sold.
 * Because the savings roles live in the maps, a user-authored strategy can rank
 * cash later to model preserving a cash buffer.
 */
const CASH_BAND = {
  [ACCOUNT_ROLES.US_SAVINGS]: 0, [ACCOUNT_ROLES.AU_SAVINGS]: 0,
};

/**
 * Named drawdown strategies — the order accounts are liquidated to cover a
 * spending shortfall. Values are per-role *base* priorities (lower = drawn
 * first). Every built-in strategy spreads in CASH_BAND so cash drains first;
 * investment roles follow. Within investments the per-country strategies use
 * overlapping US/AU ranks (sorted per-country under LOCAL_FIRST); TAX_EFFICIENT
 * uses a single distinct global rank per role.
 *
 * Applied by the `accountPriority` node cascade in ScenarioLoader: each
 * account's drawdownPriority becomes base + ownerRank * ownerStride, so the
 * primary's buckets drain before the spouse's same-role buckets.
 *
 * PROPORTIONAL reuses the TAXABLE_FIRST eligibility map only to keep accounts
 * non-null (eligible); its actual pro-rata behavior is driven at runtime by
 * state.drawdownMode (see us-retirement-toolset + AccountService.replenishSavings).
 */
export const DRAWDOWN_STRATEGIES = {
  TAXABLE_FIRST: {            // cash, then taxable brokerage/fixed-income, then tax-deferred, Roth last
    ...CASH_BAND,
    [ACCOUNT_ROLES.FIXED_INCOME]: 1, [ACCOUNT_ROLES.US_STOCK]: 2,
    [ACCOUNT_ROLES.IRA]: 3, [ACCOUNT_ROLES.K401]: 4, [ACCOUNT_ROLES.ROTH]: 5,
    [ACCOUNT_ROLES.AU_FIXED_INCOME]: 1, [ACCOUNT_ROLES.AU_STOCK]: 2, [ACCOUNT_ROLES.SUPER]: 3,
  },
  TAX_DEFERRED_FIRST: {       // cash, then drain IRA/401k/Super early (bracket-fill, lower future RMDs)
    ...CASH_BAND,
    [ACCOUNT_ROLES.IRA]: 1, [ACCOUNT_ROLES.K401]: 2,
    [ACCOUNT_ROLES.FIXED_INCOME]: 3, [ACCOUNT_ROLES.US_STOCK]: 4, [ACCOUNT_ROLES.ROTH]: 5,
    [ACCOUNT_ROLES.SUPER]: 1, [ACCOUNT_ROLES.AU_FIXED_INCOME]: 2, [ACCOUNT_ROLES.AU_STOCK]: 3,
  },
  ROTH_FIRST: {               // cash, then Roth/tax-free first (comparison baseline); AU mirrors taxable
    ...CASH_BAND,
    [ACCOUNT_ROLES.ROTH]: 1, [ACCOUNT_ROLES.FIXED_INCOME]: 2, [ACCOUNT_ROLES.US_STOCK]: 3,
    [ACCOUNT_ROLES.IRA]: 4, [ACCOUNT_ROLES.K401]: 5,
    [ACCOUNT_ROLES.AU_FIXED_INCOME]: 1, [ACCOUNT_ROLES.AU_STOCK]: 2, [ACCOUNT_ROLES.SUPER]: 3,
  },
  PROPORTIONAL: {             // pro-rata across eligible buckets (runtime mode; see above)
    ...CASH_BAND,
    [ACCOUNT_ROLES.FIXED_INCOME]: 1, [ACCOUNT_ROLES.US_STOCK]: 2,
    [ACCOUNT_ROLES.IRA]: 3, [ACCOUNT_ROLES.K401]: 4, [ACCOUNT_ROLES.ROTH]: 5,
    [ACCOUNT_ROLES.AU_FIXED_INCOME]: 1, [ACCOUNT_ROLES.AU_STOCK]: 2, [ACCOUNT_ROLES.SUPER]: 3,
  },
  TAX_EFFICIENT: {            // GLOBAL order across BOTH countries by tax treatment.
    // Cash first (CASH_BAND), then a single distinct rank per investment role so
    // US and AU accounts interleave into one global drawdown order. Unlike the
    // per-country strategies above (whose US/AU ranks deliberately overlap because
    // replenishSavings sorts each country separately), this pairs with
    // crossBorderDrawdown=GLOBAL (set by the us-retirement toolset when selected),
    // letting replenishSavings cross the currency border in priority order
    // instead of draining the residency country first.
    ...CASH_BAND,
    [ACCOUNT_ROLES.FIXED_INCOME]: 1, [ACCOUNT_ROLES.US_STOCK]: 2,        // taxable: only gains taxed
    [ACCOUNT_ROLES.AU_FIXED_INCOME]: 3, [ACCOUNT_ROLES.AU_STOCK]: 4,     //   (basis already taxed) → drain first
    [ACCOUNT_ROLES.IRA]: 5, [ACCOUNT_ROLES.K401]: 6,                     // tax-deferred: ordinary income on withdrawal
    [ACCOUNT_ROLES.SUPER]: 7, [ACCOUNT_ROLES.ROTH]: 8,                   // tax-free: preserve longest (super tax-free 60+, Roth)
  },
  // Lever B (design 58 §4-B): the cascade *synthesizes* the role→rank map from the
  // per-role `drawdownWeight.<role>` params (ascending sort = draw order) rather
  // than a fixed table here — see DRAWDOWN_WEIGHT_ROLES / drawdownWeightsFromStrategy
  // and the accountPriority cascade's `weightMode` branch. Null here because the map
  // is computed at cascade time from the live weights, not stored. This is the
  // optimizer's "search the order" mode: each named strategy above is one setting
  // of the weights, so they serve as warm-starts. Key kept in sync with
  // DRAWDOWN_WEIGHT_MODE below.
  WEIGHTED: null,
  // No mapping → the cascade is a no-op, so per-account drawdownPriority values
  // authored in buildDefaultConfig (or hand-edited via the account editor) remain
  // authoritative. Select this to hand-tune individual account ordering.
  CUSTOM: null,
};

/**
 * Drawdown-eligible account roles — the union of roles that appear across the
 * built-in DRAWDOWN_STRATEGIES maps. Includes the cash/savings roles (CASH_BAND),
 * which are now first-class members of the drawdown order (spent first by default,
 * but rankable like any other role). Used to seed the DrawdownStrategyList editor's
 * role rows. The active savings *target* account is still never drained below its
 * minimum — that's enforced at runtime in replenishSavings, not by omission here.
 */
export const DRAWDOWN_ROLES = [...new Set(
  Object.values(DRAWDOWN_STRATEGIES)
    .filter(Boolean)
    .flatMap(map => Object.keys(map)),
)];

// ─── Lever B — optimizable role-weight order (design 58 §4-B) ─────────────────

/**
 * The `drawdownStrategy` sentinel that activates the Lever-B weight vector. When
 * selected, the accountPriority cascade synthesizes a role→rank map from the
 * per-role `drawdownWeight.<role>` params instead of reading a fixed strategy
 * table (see scenario-loader's `weightMode` branch). Kept in sync with the
 * `WEIGHTED` key in DRAWDOWN_STRATEGIES above.
 */
export const DRAWDOWN_WEIGHT_MODE = 'WEIGHTED';

/** Param-key prefix for the per-role Lever-B weights. */
export const DRAWDOWN_WEIGHT_PREFIX = 'drawdownWeight';

/**
 * Separator between the prefix and the role in a weight key, giving
 * `drawdownWeight::roth-ira`. A `::` (not a `.`) is REQUIRED: the MC/Opt/MPC
 * candidate path applies params through `set()`, which splits keys on `.`/`[` and
 * refuses to create intermediate nodes — so a dotted `drawdownWeight.roth-ira`
 * would be silently dropped (its `drawdownWeight` parent never pre-exists) and the
 * Lever-B axis would be inert through the solver and under MPC. `::` keeps the key
 * a single flat token that `set()` writes directly (matches the design-55 generated
 * `<member>::<field>` convention).
 */
export const DRAWDOWN_WEIGHT_SEP = '::';

/** The param key for a role's Lever-B weight, e.g. `drawdownWeight::roth-ira`. */
export function drawdownWeightKey(role) {
  return `${DRAWDOWN_WEIGHT_PREFIX}${DRAWDOWN_WEIGHT_SEP}${role}`;
}

/**
 * The investment roles Lever B weights (design 58 §4-B). Each gets a continuous
 * weight in [0,1]; the drawdown order is the ascending sort of the weights (lowest
 * drawn first). This is a smooth search space the optimizer can tune directly, and
 * it is stable across account edits because it keys on *roles*, not account ids.
 * Same-role siblings (e.g. two Roths) share one weight → one drawdown tier, whose
 * internal split is Lever C's job (design 58 §4-C).
 *
 * The two cash roles are intentionally excluded — they always drain first (the
 * CASH_BAND, rank 0) and are not part of the search.
 */
export const DRAWDOWN_WEIGHT_ROLES = [
  ACCOUNT_ROLES.FIXED_INCOME, ACCOUNT_ROLES.US_STOCK,
  ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.K401, ACCOUNT_ROLES.ROTH,
  ACCOUNT_ROLES.AU_FIXED_INCOME, ACCOUNT_ROLES.AU_STOCK, ACCOUNT_ROLES.SUPER,
];

/** Cash roles that always drain first under Lever B (rank 0, the CASH_BAND). */
export const DRAWDOWN_CASH_ROLES = [ACCOUNT_ROLES.US_SAVINGS, ACCOUNT_ROLES.AU_SAVINGS];

/**
 * Human-readable labels for the weighted roles (UI param labels / "tune order").
 */
export const DRAWDOWN_ROLE_LABELS = {
  [ACCOUNT_ROLES.FIXED_INCOME]:    'US Fixed Income',
  [ACCOUNT_ROLES.US_STOCK]:        'US Stock',
  [ACCOUNT_ROLES.IRA]:             'Traditional IRA',
  [ACCOUNT_ROLES.K401]:            '401(k)',
  [ACCOUNT_ROLES.ROTH]:            'Roth IRA',
  [ACCOUNT_ROLES.AU_FIXED_INCOME]: 'AU Fixed Income',
  [ACCOUNT_ROLES.AU_STOCK]:        'AU Stock',
  [ACCOUNT_ROLES.SUPER]:           'Superannuation',
};

/**
 * Restrict the Lever-B weighted roles to those actually backed by an account
 * (design 58 build-time filter). A weighted role with no account is a *phantom*
 * search dimension: nothing consumes its synthesized rank, so the objective is
 * flat along it. Sweeping it only wastes solver budget, yields a non-identifiable
 * weight, and pollutes the displayed draw order with a role the plan can't hold.
 *
 * `presentRoles` is any iterable (or Set) of the roles present among the
 * scenario's accounts — typically `accounts.map(a => a.role)`. The result is the
 * intersection in canonical DRAWDOWN_WEIGHT_ROLES order. Cash roles are handled
 * separately (they always rank 0) and are not returned here.
 */
export function presentDrawdownWeightRoles(presentRoles) {
  const present = presentRoles instanceof Set ? presentRoles : new Set(presentRoles ?? []);
  return DRAWDOWN_WEIGHT_ROLES.filter(role => present.has(role));
}

/**
 * Convert a named strategy into a Lever-B weight vector (role → weight in (0,1))
 * whose ascending sort reproduces the strategy's investment-role order. Each named
 * strategy is therefore one point in the weight space — this is what lets the
 * solver **warm-start** from a preset (design 58 §4-B / §7). Roles the strategy
 * doesn't rank sort last (Infinity, stable tie-break by declaration order).
 * Returns null for a strategy with no role map (CUSTOM, WEIGHTED, unknown).
 */
export function drawdownWeightsFromStrategy(strategyName, roles = DRAWDOWN_WEIGHT_ROLES) {
  const map = DRAWDOWN_STRATEGIES[strategyName];
  if (!map) return null;
  const ranked = [...roles].sort(
    (a, b) => (map[a] ?? Infinity) - (map[b] ?? Infinity));
  const out = {};
  ranked.forEach((role, i) => { out[role] = +((i + 1) / (ranked.length + 1)).toFixed(4); });
  return out;
}

/**
 * Default per-role drawdown weights — seeded from TAX_EFFICIENT (the existing
 * global-order strategy) so selecting WEIGHTED without tuning reproduces a sensible
 * taxable→tax-deferred→tax-free global order. Only consulted when
 * `drawdownStrategy === 'WEIGHTED'`; the default strategy is TAXABLE_FIRST, so
 * existing scenarios are unaffected (byte-identical).
 */
export const DEFAULT_DRAWDOWN_WEIGHTS = drawdownWeightsFromStrategy('TAX_EFFICIENT');

/**
 * Lever B (design 58 §4-B): synthesize a strategy priority map (role → rank) from
 * the per-role weight params carried on an `accountPriority` node's WEIGHTED mode.
 * The draw order is the ascending sort of the weights (lowest drawn first); cash
 * roles are pinned to rank 0 (drawn first). A missing/NaN weight falls back to the
 * node's `weightDefaults`, then 0.5, so a partially-swept vector still resolves.
 * Ties preserve the node's `weightRoles` declaration order (stable sort) — those
 * siblings land in one tier for Lever C to split.
 *
 * Weight keys use a `::` separator (`drawdownWeight::roth-ira`), NOT a dot, so they
 * are a single flat token everywhere: the UI params→parameters sync writes the
 * literal key, and the MC/Opt/MPC candidate path's `set()` (which splits on `.`/`[`
 * and refuses to create intermediate nodes) also writes it flat. A dotted key would
 * be silently dropped by `set()` — `set(p, 'drawdownWeight.roth-ira', v)` no-ops
 * because `p.drawdownWeight` doesn't pre-exist — leaving the Lever-B axis inert
 * through the solver and under MPC. The node carries `weightKeySep`.
 *
 * Exported for the Lever-B online cockpit control (design 58 §11.3 Phase 3-MPC):
 * its live `actuate` re-stamps the running sim's per-account `drawdownPriority`
 * from the committed weights using this SAME role→rank synthesis, so advise/apply
 * and the live sim cannot drift.
 */
export function synthesizeWeightedPriorities(node, parameters = {}, presentRoles = null) {
  const prefix   = node.weightKeyPrefix ?? 'drawdownWeight';
  const sep      = node.weightKeySep ?? '::';
  const defaults = node.weightDefaults ?? {};
  // Build-time filter (design 58): drop weighted/cash roles that no account backs.
  // A phantom role's rank is inert (nothing consumes it), so removing it leaves the
  // *relative* draw order of real accounts identical while keeping the synthesized
  // map (and any display derived from it) free of roles the scenario can't hold.
  const allow = presentRoles == null
    ? null
    : (presentRoles instanceof Set ? presentRoles : new Set(presentRoles));
  const keep = (role) => allow == null || allow.has(role);
  const roles = (Array.isArray(node.weightRoles) ? node.weightRoles : []).filter(keep);
  const weighted = roles.map(role => {
    const raw = Number(parameters?.[`${prefix}${sep}${role}`]);
    const w   = Number.isFinite(raw) ? raw
              : (Number.isFinite(defaults[role]) ? defaults[role] : 0.5);
    return { role, w };
  });
  weighted.sort((a, b) => a.w - b.w);   // ascending = draw order; stable tie-break
  const priorities = {};
  for (const role of (node.cashRoles ?? [])) if (keep(role)) priorities[role] = 0;   // cash first
  weighted.forEach(({ role }, i) => { priorities[role] = i + 1; });
  return priorities;
}

// ─── Lever A — optimizable holding-allocation mix (design 61 §4-A) ─────────────

/**
 * The sentinel `allocationStrategy` value that activates the Lever-A continuous
 * weight vector. When selected, the TARGET_ALLOCATION registry entry synthesizes
 * the rebalance target from the per-class `allocWeight::<CLASS>` params (via
 * stick-breaking) instead of reading the `Object` `rebalanceTargetAllocation`
 * param. The default is `STATIC`, so existing scenarios are unaffected.
 */
export const ALLOCATION_OPTIMIZED_MODE = 'OPTIMIZED';

/**
 * The searchable allocation classes, in a FIXED order — the LAST class is the
 * stick-breaking *residual* (it carries no param; its share is `1 − Σ` of the
 * others). CASH is included as a first-class target, not a leftover (design 61
 * §OQ2): holding cash through a crash is a deliberate, optimizable choice.
 */
export const ALLOC_WEIGHT_CLASSES = [
  ALLOCATION.EQUITY, ALLOCATION.BOND, ALLOCATION.CASH, ALLOCATION.GOLD,
];

/** Param-key prefix for the per-class Lever-A weights. */
export const ALLOC_WEIGHT_PREFIX = 'allocWeight';

/**
 * Separator between the prefix and the class in a weight key, giving
 * `allocWeight::EQUITY`. A `::` (not a `.`) is REQUIRED for the same reason as the
 * design-58 drawdown weights ([[optimizer-param-key-dot-collision]]): the
 * MC/Opt/MPC candidate path applies params through `set()`, which splits on `.`/`[`
 * and refuses to create a missing `allocWeight` parent, so a dotted key would be
 * silently dropped and the axis inert. `::` keeps it a single flat token.
 */
export const ALLOC_WEIGHT_SEP = '::';

/** The param key for a class's Lever-A weight, e.g. `allocWeight::EQUITY`. */
export function allocWeightKey(cls) {
  return `${ALLOC_WEIGHT_PREFIX}${ALLOC_WEIGHT_SEP}${cls}`;
}

/**
 * Human-readable labels for the allocation classes (UI param labels).
 */
export const ALLOC_WEIGHT_CLASS_LABELS = {
  [ALLOCATION.EQUITY]: 'Equity',
  [ALLOCATION.BOND]:   'Bond',
  [ALLOCATION.CASH]:   'Cash',
  [ALLOCATION.GOLD]:   'Gold',
};

/**
 * Named allocation presets → warm-starts. Each is a point in mix space that seeds
 * the solver (the Lever-B `drawdownWeightsFromStrategy` analog). Weights sum to 1.
 */
export const ALLOCATION_PRESETS = {
  SIXTY_FORTY: { EQUITY: 0.60, BOND: 0.40, CASH: 0.00, GOLD: 0.00 },
  ALL_WEATHER: { EQUITY: 0.30, BOND: 0.40, CASH: 0.15, GOLD: 0.15 },
  EQUITY_TILT: { EQUITY: 0.80, BOND: 0.15, CASH: 0.05, GOLD: 0.00 },
};

/**
 * Default target mix — the 60/40 that the legacy `rebalanceTargetAllocation`
 * default (`{EQUITY:0.60, BOND:0.40}`) also expresses, so `OPTIMIZED` with untuned
 * weights reproduces today's opportunistic-rebalance target.
 */
export const DEFAULT_ALLOC_WEIGHTS = ALLOCATION_PRESETS.SIXTY_FORTY;

/** Clamp a value into [0,1] (NaN → 0). */
function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Synthesize a target allocation distribution (summing to 1) from the per-class
 * `allocWeight::<CLASS>` params using **stick-breaking** (design 61 §4-A / OQ1).
 *
 * Stick-breaking is a bijection onto the simplex with NO scale-degenerate ray (the
 * pathology a naive `w_i / Σ w_j` normalization would introduce) and NO `Σ≤1`
 * constraint to project (which a naive `share_K = 1−Σ` residual would need, since
 * CEM samples the box freely). Each of the first `K−1` classes takes a fraction of
 * the *remaining* stick; the last class is the residual.
 *
 * @param {object}  parameters      - flat param map carrying `allocWeight::<CLASS>`
 * @param {Set|null} presentClasses - build-time filter of reachable classes (§ G4);
 *                                     null keeps all four
 * @returns {object} { EQUITY, BOND, CASH, GOLD } fractions summing to 1
 */
export function synthesizeTargetAllocation(parameters, presentClasses = null) {
  const classes = presentClasses
    ? ALLOC_WEIGHT_CLASSES.filter(c => presentClasses.has(c))
    : [...ALLOC_WEIGHT_CLASSES];
  const shares = {};
  if (classes.length === 0) return shares;
  let remaining = 1;
  for (let i = 0; i < classes.length - 1; i++) {
    const cls = classes[i];
    const w = clamp01(parameters?.[allocWeightKey(cls)] ?? DEFAULT_ALLOC_WEIGHTS[cls] ?? 0);
    shares[cls] = +(remaining * w).toFixed(6);
    remaining  = +(remaining - shares[cls]).toFixed(6);
  }
  shares[classes[classes.length - 1]] = +Math.max(0, remaining).toFixed(6);
  // Totalize the OUTPUT while leaving the SEARCH narrowed (design 61 §12.2 Q3).
  // `presentClasses` deliberately restricts stick-breaking to the classes the plan
  // actually holds — searching a dimension the plan cannot use is wasted. But the mix
  // that leaves here is consumed as a target, and a partial target is indistinguishable
  // from a deliberate zero. This is what makes an MPC-harvested glidepath anchor valid
  // and re-runnable: the harvest keeps its narrow search space and still emits every
  // allocation explicitly.
  return totalizeMix(shares);
}

/**
 * Invert a target mix into the stick-breaking `allocWeight::<CLASS>` params that
 * reproduce it (the warm-start; twin of `drawdownWeightsFromStrategy`). For each of
 * the first `K−1` classes, the weight is its share divided by the stick remaining
 * before it; the residual (last) class carries no param. A degenerate stick
 * (remaining ≈ 0) yields weight 0.
 *
 * @param {object} mix - { EQUITY, BOND, CASH, GOLD } fractions (need not sum to 1)
 * @returns {object} flat map of `allocWeight::<CLASS>` → weight in [0,1]
 */
export function allocWeightsFromMix(mix = DEFAULT_ALLOC_WEIGHTS) {
  const out = {};
  let remaining = 1;
  for (let i = 0; i < ALLOC_WEIGHT_CLASSES.length - 1; i++) {
    const cls   = ALLOC_WEIGHT_CLASSES[i];
    const share = Math.max(0, Number(mix?.[cls] ?? 0));
    const w     = remaining > 1e-9 ? clamp01(share / remaining) : 0;
    out[allocWeightKey(cls)] = +w.toFixed(4);
    remaining = Math.max(0, remaining - share);
  }
  return out;
}

/** Warm-start weights for a named preset (design 61 §4-A). */
export function allocWeightsFromPreset(name) {
  const mix = ALLOCATION_PRESETS[name];
  return mix ? allocWeightsFromMix(mix) : null;
}

/**
 * Restrict the searchable allocation classes to those actually reachable given the
 * scenario's accounts/holdings (design 61 §G4 — the design-58 build-time filter
 * analog). A class no account can hold is a *phantom* search dimension: nothing
 * consumes its weight, so the objective is flat along it. Phase 1 has every
 * equity-served account able to hold the four classes, so the default (all present)
 * is correct; the hook exists so later phases can prune (e.g. no GOLD-eligible
 * account).
 *
 * @param {object[]} [accounts] - scenario accounts (unused in Phase 1; reserved)
 * @param {object[]} [holdings] - reserved for a holdings-derived filter
 * @returns {Set<string>} reachable ALLOCATION classes, in canonical order membership
 */
export function presentAllocations(_accounts = null, _holdings = null) {
  return new Set(ALLOC_WEIGHT_CLASSES);
}

// ─── design 35 — per-owner drawdown banding, in ONE place (design 81 phase 7a) ────

/**
 * The owner-banding table the `accountPriority` cascade applies, and the ONE authority for it.
 *
 * `drawdownPriority = roleRank + ownerRank * ownerStride`, so the stride is what decides
 * whether the primary's accounts drain fully before the spouse's (100) or whether same-role
 * accounts across owners share one tier (POOLED, stride 0).
 *
 * ─── why this moved here, and what it was before (design 81 §16.10) ──────────────
 *
 * It was two tables. The compile cascade read this one off the `accountPriority` node; the
 * online commit and the design-81 replay re-derived it from HARD-CODED literals
 * (`mode === 'SPOUSE_FIRST' ? ['spouse','primary'] : ['primary','spouse']`, stride
 * `mode === 'POOLED' ? 0 : 100`). They agreed — by coincidence of two tables saying the same
 * thing, not by construction. Add a fourth mode, or change a stride, and the plan the
 * controller commits stops matching the plan the compile produces, silently, on a field
 * nothing prints.
 *
 * That is D7's drift in its last hiding place: phase 2a collapsed the three copies of the
 * role→rank SYNTHESIS and left the BANDING duplicated behind it.
 */
export const DRAWDOWN_OWNER_MODES = Object.freeze({
  PRIMARY_FIRST: { ownerOrder: ['primary', 'spouse'], ownerStride: 100 },
  SPOUSE_FIRST:  { ownerOrder: ['spouse', 'primary'], ownerStride: 100 },
  POOLED:        { ownerStride: 0 },
});

/** The bare fallback a node carries, and what an unknown/absent mode resolves to. */
export const DRAWDOWN_OWNER_DEFAULT = Object.freeze({ ownerOrder: ['primary', 'spouse'], ownerStride: 100 });

/**
 * Resolve `{ ownerOrder, ownerStride }` for a banding mode.
 *
 * Note `POOLED` names no `ownerOrder`: it only zeroes the stride, so the order falls through
 * to the default and is inert (rank × 0). Reproducing that by hand is exactly the kind of
 * detail two tables drift on, which is why this is a function and not a lookup.
 *
 * @param {string|null} mode   the `drawdownOwnerOrdering` value
 * @param {object} [fallback]  a node's own bare `ownerOrder`/`ownerStride`, when it has them
 */
export function resolveOwnerBanding(mode, fallback = DRAWDOWN_OWNER_DEFAULT) {
  const base = {
    ownerOrder:  fallback?.ownerOrder  ?? DRAWDOWN_OWNER_DEFAULT.ownerOrder,
    ownerStride: fallback?.ownerStride ?? DRAWDOWN_OWNER_DEFAULT.ownerStride,
  };
  const cfg = (mode != null) ? DRAWDOWN_OWNER_MODES[mode] : null;
  if (!cfg) return base;
  return {
    ownerOrder:  cfg.ownerOrder  ?? base.ownerOrder,
    ownerStride: cfg.ownerStride ?? base.ownerStride,
  };
}
