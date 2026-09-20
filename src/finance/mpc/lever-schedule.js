/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  DRAWDOWN_WEIGHT_ROLES, DRAWDOWN_CASH_ROLES, DEFAULT_DRAWDOWN_WEIGHTS,
  DRAWDOWN_WEIGHT_PREFIX, DRAWDOWN_WEIGHT_SEP, DRAWDOWN_WEIGHT_MODE, drawdownWeightKey,
  synthesizeWeightedPriorities,
  ALLOC_WEIGHT_CLASSES, ALLOCATION_OPTIMIZED_MODE, allocWeightKey, synthesizeTargetAllocation,
} from '../../scenarios/params/lever-weights.js';
import {
  DRAWDOWN_SLEEVE_CLASSES, SLEEVE_WEIGHT_MODE, SLEEVE_WEIGHT_PREFIX, SLEEVE_WEIGHT_SEP,
  sleeveWeightKey,
} from '../holdings/holdings-selection.js';

/**
 * DESIGN 81 §4.4 / §4.5 — the two hooks that turn a recorded decision into a run.
 *
 *   `scheduleKey(variable)`  the STABLE decision key a recorded row is addressed by
 *   `applyAt({ … })`         the state patch the rows in force produce
 *
 * ─── why they live here and not inline in `COCKPIT_CONTROLS` ─────────────────────
 *
 * They are *spread into* the control specs by `cockpit-controller.js`, so the spec surface
 * is the one design 81 §4.5 describes — `scheduleKey` / `applyAt` beside `buildVariables` /
 * `describe` / `harvest` / `actuate`. They are DEFINED here because the two consumers that
 * need them earliest are the reducer and the toolset that registers it, and importing
 * `cockpit-controller.js` (which pulls the solver registry, the optimization problem and two
 * other toolsets) from inside `US_RETIREMENT.reducers` would be a large import cycle bought
 * for two pure functions.
 *
 * ─── the import rule this module lives under (measured, design 81 §16.5) ─────────
 *
 * `us-retirement-toolset.js` imports `MpcDecisionScheduleReducer`, which imports this file.
 * So ANY import added here that reaches a toolset or `intl-retirement-scenario.js` closes a
 * cycle — and it does not degrade gracefully. Phase 2 measured it: importing the weight
 * constants from `intl-retirement-scenario.js` made four entry points that load today
 * (`us-retirement-toolset.js`, `intl-retirement-scenario.js`, `mpc-decision-schedule-reducer.js`,
 * `cockpit-controller.js`) each die at import with a TDZ `Cannot access 'X' before
 * initialization`. The fix was to move the constants DOWN into leaf modules
 * (`scenarios/params/lever-weights.js`), not to inline copies of them here. Every import in
 * this file must be a leaf; if a hook needs something that is not, move it, do not copy it.
 *
 * ─── why no index is ever stored (§4.5, D5) ──────────────────────────────────────
 *
 * `buildVariables` emits `spendingExpenseBands[19].monthlyAmount`. An index is a position
 * into a table AS IT STOOD DURING THAT RUN: edit the table and every recorded decision
 * silently points somewhere else. `scheduleKey` returns `band@69` instead — the anchor the
 * lever already stamps (`_startAge`) — and `applyAt` writes state keyed by that anchor, so
 * nothing ever writes back into the authored table and there is no index to re-key.
 */

/** `band@<startAge>` ⇄ the age anchor, in one place so the two halves cannot drift. */
export const BAND_KEY_PREFIX = 'band@';

/** @returns {string} the stable key for a SPENDING decision on the band starting at `age`. */
export function bandKey(age) { return `${BAND_KEY_PREFIX}${age}`; }

/** @returns {number|null} the startAge a `band@<age>` key names, or null when it is not one. */
export function bandKeyAge(key) {
  if (typeof key !== 'string' || !key.startsWith(BAND_KEY_PREFIX)) return null;
  const age = Number(key.slice(BAND_KEY_PREFIX.length));
  return Number.isFinite(age) ? age : null;
}

/**
 * SPENDING — `state.mpcSpendingBands`, a FULL REPLACEMENT band table (D12).
 *
 * Not a merge map. A replacement is the shape `ExplicitBandsSpendingReducer.bands` already
 * is, so `bandForAge` and the re-pin logic work unchanged and there is one vocabulary rather
 * than two; the size objection is ~1 KB of table against the ~280 KB a snapshot of a real
 * plan already carries.
 *
 * The table is rebuilt from the AUTHORED base every period, not from the previously stamped
 * one, because `rows` is already the whole history in force (the latest row per key at or
 * before "now"). That makes the patch a pure function of (base table, rows, now) — idempotent,
 * order-independent, and unable to accumulate drift across a rewind.
 *
 * Bands the run never decided are preserved from the base, which is what keeps the pre-MPC
 * plan for the realized past intact (design 39 §13.6.1's last rule, arriving for free).
 */
export const SPENDING_SCHEDULE = {
  scheduleKey: (variable) => {
    const age = variable?._startAge;
    return Number.isFinite(age) ? bandKey(age) : (variable?.paramKey ?? null);
  },

  applyAt: ({ rows, baseParams }) => {
    const base = baseParams?.spendingExpenseBands;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const bands = (Array.isArray(base) ? base : []).map(b => ({ ...b }));
    let touched = false;
    for (const row of rows) {
      const age    = bandKeyAge(row?.key);
      const amount = Number(row?.value);
      if (age == null || !Number.isFinite(amount)) continue;
      const i = bands.findIndex(b => Number(b?.startAge) === age);
      if (i >= 0) bands[i] = { ...bands[i], monthlyAmount: amount };
      else        bands.push({ startAge: age, monthlyAmount: amount });
      touched = true;
    }
    if (!touched) return null;
    // `bandForAge` walks the table in order and breaks at the first band that has not
    // started, so an out-of-order insert would make every later band unreachable.
    bands.sort((a, b) => Number(a.startAge) - Number(b.startAge));
    return { mpcSpendingBands: bands };
  },
};


// ─────────────────────────────────────────────────────────────────────────────────
// Phase 2a — the four drawdown levers (§14, revised by §16.2)
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * `scheduleKey` for every lever whose decision variable IS its state key — the categorical
 * modes and the `<prefix>::<member>` weight vectors. There is no index to strip (D5 is
 * already satisfied by the `::` convention, which exists so `set()` writes the key flat) and
 * no anchor to invent, so the param key is the stable key.
 */
const paramKeySchedule = { scheduleKey: (variable) => variable?.paramKey ?? null };

/** The single row a scalar lever's `rows` carries, or null. */
function _soleValue(rows) {
  const row = Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null;
  return row ? row.value : null;
}

/** One-field state patch for a categorical lever, or null when the row is not a legal mode. */
function _modePatch(field, rows, legal) {
  const mode = _soleValue(rows);
  return legal.includes(mode) ? { [field]: mode } : null;
}

/**
 * DRAWDOWN_XBORDER / DRAWDOWN_WITHINTIER — one state field each, exactly what `actuate`
 * writes. `AccountService.replenishSavings` reads both fresh on every draw, so stamping the
 * field IS the decision taking effect; nothing is compiled from it and there is no
 * per-account re-stamp to keep in step.
 *
 * An illegal value yields null rather than a stamp. A recorded run is data on disk and can be
 * hand-edited, and a typo'd mode written into state would not fail — `replenishSavings` would
 * silently fall through to its default branch and the run would play back as a plan nobody
 * chose.
 */
export const DRAWDOWN_XBORDER_SCHEDULE = {
  ...paramKeySchedule,
  applyAt: ({ rows }) => _modePatch('crossBorderDrawdown', rows, ['LOCAL_FIRST', 'GLOBAL']),
};

export const DRAWDOWN_WITHINTIER_SCHEDULE = {
  ...paramKeySchedule,
  applyAt: ({ rows }) => _modePatch('withinTierDraw', rows, ['SEQUENTIAL', 'EQUAL', 'PROPORTIONAL']),
};

/** `sleeveWeight::EQUITY` → `EQUITY`, or null when the key is not one. */
function _sleeveWeightClass(key) {
  const prefix = `${SLEEVE_WEIGHT_PREFIX}${SLEEVE_WEIGHT_SEP}`;
  if (typeof key !== 'string' || !key.startsWith(prefix)) return null;
  const cls = key.slice(prefix.length);
  return DRAWDOWN_SLEEVE_CLASSES.includes(cls) ? cls : null;
}

/**
 * DRAWDOWN_SLEEVE — the state-resident sell-order policy (design 65 Lever A).
 *
 * The weight map is rebuilt from the AUTHORED base every period, for the reason SPENDING's
 * band table is (§4.5): `rows` is already the whole history in force, so a rebuild is a pure
 * function of (base, rows) and cannot accumulate drift across a rewind. That is the one
 * behavioural difference from `actuate`, which merges into whatever the live state happens to
 * hold — correct for a single forward commit, wrong for a replay that may be re-entered.
 *
 * `drawdownSleeveOrder` is stamped to WEIGHTED alongside the weights, because weights the
 * selector never consults are not a decision. The lever's `appliesTo` gate already required
 * WEIGHTED at record time; stamping it makes the recorded run self-contained rather than
 * dependent on the base scenario still being set that way (the §16.3 failure mode, which the
 * ROTH / EARLY_WITHDRAWAL gates cannot fix this cheaply).
 */
export const DRAWDOWN_SLEEVE_SCHEDULE = {
  ...paramKeySchedule,

  applyAt: ({ rows, baseParams }) => {
    const weights = {};
    for (const cls of DRAWDOWN_SLEEVE_CLASSES) {
      const w = Number(baseParams?.[sleeveWeightKey(cls)]);
      if (Number.isFinite(w)) weights[cls] = w;
    }
    let touched = false;
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const cls = _sleeveWeightClass(row?.key);
      const w   = Number(row?.value);
      if (cls == null || !Number.isFinite(w)) continue;
      weights[cls] = w;
      touched = true;
    }
    if (!touched) return null;
    return { drawdownSleeveOrder: SLEEVE_WEIGHT_MODE, drawdownSleeveWeights: weights };
  },
};

/**
 * The set of account roles actually present in a live sim state — every entry that looks
 * like an account (an object carrying a `role`).
 *
 * Moved here from `cockpit-controller.js` by design 81 §16.2: it is the design-58 build-time
 * filter, `DRAWDOWN_WEIGHTS.applyAt` needs it, and `actuate` now reaches it through this
 * module rather than keeping a private copy that could drift from the one the replay uses.
 */
export function presentRolesFromState(state) {
  const roles = new Set();
  for (const v of Object.values(state ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v.role) roles.add(v.role);
  }
  return roles;
}

/** The `accountPriority` node shape `synthesizeWeightedPriorities` reads, in one place. */
const DRAWDOWN_WEIGHT_NODE = {
  weightKeyPrefix: DRAWDOWN_WEIGHT_PREFIX,
  weightKeySep:    DRAWDOWN_WEIGHT_SEP,
  weightRoles:     DRAWDOWN_WEIGHT_ROLES,
  cashRoles:       DRAWDOWN_CASH_ROLES,
  weightDefaults:  DEFAULT_DRAWDOWN_WEIGHTS,
};

/**
 * DRAWDOWN_WEIGHTS — **the D7 authority**, pulled forward from phase 7a (§16.2).
 *
 * This lever is not the "no reducer refactor" case the plan assumed. Committing a weight
 * vector runs a three-step cascade — `synthesizeWeightedPriorities` over the roles an account
 * backs, then owner banding read from the `drawdownOwnerOrdering` PARAM, then a per-account
 * `drawdownPriority` re-stamp — and that cascade already existed twice (`actuate` here, and
 * `_seededSim`'s re-stamp in `optimization-problem.js`). Writing a third copy for the replay
 * and deleting it in 7a is the wrong order, so this IS the copy: `actuate` now calls it
 * (`cockpit-controller.js`), and 7a has one call site left to move.
 *
 * The owner-banding read is the third vindication of `applyAt` taking `baseParams` — a
 * reducer cannot reach `drawdownOwnerOrdering` any other way.
 *
 * The patch is a map of ACCOUNT KEYS, which is what makes this a legal reducer patch at all:
 * accounts are top-level state entries, so re-stamping them is a shallow merge like any other
 * field. Accounts whose priority is already right are left out, so a period that re-decides
 * nothing puts nothing in the journal.
 */
export const DRAWDOWN_WEIGHTS_SCHEDULE = {
  ...paramKeySchedule,

  applyAt: ({ state, rows, baseParams }) => {
    // The candidate the cascade reads: the authored weights, overridden by the rows in
    // force. Built from the base for the same reason SPENDING's table is — `rows` is the
    // whole history, so the result is a pure function of (base, rows).
    const candidate = {};
    for (const role of DRAWDOWN_WEIGHT_ROLES) {
      const w = Number(baseParams?.[drawdownWeightKey(role)]);
      if (Number.isFinite(w)) candidate[drawdownWeightKey(role)] = w;
    }
    let touched = false;
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const w = Number(row?.value);
      if (typeof row?.key !== 'string' || !Number.isFinite(w)) continue;
      if (!row.key.startsWith(`${DRAWDOWN_WEIGHT_PREFIX}${DRAWDOWN_WEIGHT_SEP}`)) continue;
      candidate[row.key] = w;
      touched = true;
    }
    if (!touched) return null;

    return drawdownPriorityPatch({ state, candidate, baseParams });
  },
};

/**
 * The cascade itself: committed weights → per-account `drawdownPriority`, exactly as the
 * compile-time `accountPriority` node does it. Exported because `actuate` calls it, which is
 * the whole point of D7 — one implementation, two callers, no drift.
 *
 * @param {object}  state       the live sim state (accounts are its top-level entries)
 * @param {object}  candidate   flat `drawdownWeight::<role>` → weight map
 * @param {object} [baseParams] carries `drawdownOwnerOrdering`; POOLED ⇒ no owner banding
 * @returns {object|null} a patch of changed accounts, or null when nothing moved
 */
export function drawdownPriorityPatch({ state, candidate, baseParams }) {
  const roleRank = synthesizeWeightedPriorities(
    DRAWDOWN_WEIGHT_NODE, candidate ?? {}, presentRolesFromState(state));

  const mode        = baseParams?.drawdownOwnerOrdering;
  const ownerOrder  = mode === 'SPOUSE_FIRST' ? ['spouse', 'primary'] : ['primary', 'spouse'];
  const ownerStride = mode === 'POOLED' ? 0 : 100;

  let patch = null;
  for (const [k, acct] of Object.entries(state ?? {})) {
    if (!acct || typeof acct !== 'object' || Array.isArray(acct)) continue;
    if (!('drawdownPriority' in acct) || roleRank[acct.role] == null) continue;
    const pr = roleRank[acct.role] + Math.max(0, ownerOrder.indexOf(acct.ownerId)) * ownerStride;
    if (acct.drawdownPriority === pr) continue;
    patch = { ...(patch ?? {}), [k]: { ...acct, drawdownPriority: pr } };
  }
  return patch;
}

// ─────────────────────────────────────────────────────────────────────────────────
// Phase 2b — the two reducer-resident levers (§14, revised by §16.1)
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * ALLOCATION_MIX — `state.mpcTargetAllocation`, read by
 * `RebalanceToTargetReducer._targetAllocationOf(state)`.
 *
 * `actuate` re-wires the live reducer's `targetAllocation` field; a replay cannot, because
 * the reducer is compiled before the run plays and a reducer must not reach into another's
 * instance fields. So the decision is stamped in state and the reducer reads state-or-self,
 * the same shape `ExplicitBandsSpendingReducer._bandsOf` already uses.
 *
 * ─── what this DOES NOT change, deliberately (§16.1) ─────────────────────────────
 *
 * There are five reads of `targetAllocation`, and four are inside `_scheduledMix`, where
 * under GLIDEPATH or REGIME_CONDITIONED the target is the fallback ANCHOR and the schedule
 * still governs. Routing every read through the accessor reproduces today's behaviour
 * exactly — a committed mix has ALWAYS been an anchor under those modes, because
 * `ALLOCATION_MIX.actuate` has only ever written `targetAllocation`. Inheriting that
 * ambiguity is the right default here; whether the lever should be gated on
 * `scheduleMode === NONE` the way DRAWDOWN_WEIGHTS is gated on WEIGHTED is a question for
 * design 39, not a behaviour change smuggled in under a replay feature.
 *
 * The mix is synthesized from base-plus-rows, not from the row values directly: the rows
 * carry stick-breaking WEIGHTS, which are not a mix and do not interpolate.
 */
export const ALLOCATION_MIX_SCHEDULE = {
  ...paramKeySchedule,

  applyAt: ({ rows, baseParams }) => {
    const candidate = {};
    for (const cls of ALLOC_WEIGHT_CLASSES) {
      const w = Number(baseParams?.[allocWeightKey(cls)]);
      if (Number.isFinite(w)) candidate[allocWeightKey(cls)] = w;
    }
    const present = new Set();
    let touched = false;
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const w = Number(row?.value);
      if (typeof row?.key !== 'string' || !Number.isFinite(w)) continue;
      const cls = ALLOC_WEIGHT_CLASSES.find(c => allocWeightKey(c) === row.key);
      if (cls == null) continue;
      candidate[row.key] = w;
      present.add(cls);
      touched = true;
    }
    if (!touched) return null;

    // The synthesis set is the classes the ROWS name, which is exactly what `actuate` and
    // `describe` pass (`new Set(vars.map(v => v._class))`). It is narrower than it looks and
    // that is deliberate fidelity, not an oversight to fix here: `buildVariables` emits one
    // variable per NON-residual class, so the set is {EQUITY, BOND, CASH} and GOLD — the
    // residual — is absent, making CASH the residual of the narrowed stick. Passing all four
    // instead would reproduce a DIFFERENT mix from the one the run held.
    const mix = synthesizeTargetAllocation(candidate, present);
    return (mix && Object.keys(mix).length) ? { mpcTargetAllocation: mix } : null;
  },
};

/**
 * BOND_LADDER — `state.mpcBondLadderRungs`, read by `BondLadderReducer._targetRungsOf(state)`
 * (one read site, `bond-ladder-reducer.js:91`). Same shape as ALLOCATION_MIX and for the same
 * reason: `actuate` re-wires the live reducer, a replay stamps state instead.
 *
 * The clamp stays in the reducer, where it already is — this hook's job is to carry the
 * decision, not to re-interpret it.
 */
export const BOND_LADDER_SCHEDULE = {
  ...paramKeySchedule,

  applyAt: ({ rows }) => {
    // `Number(null)` is 0 and `Number('')` is 0, and 0 rungs is a legal-looking decision that
    // the reducer's clamp would silently turn into 2. Test the raw value, not the coercion.
    const raw = _soleValue(rows);
    if (raw == null || raw === '' || !Number.isFinite(Number(raw))) return null;
    return { mpcBondLadderRungs: Math.round(Number(raw)) };
  },
};


// ─────────────────────────────────────────────────────────────────────────────────
// Phase 3 — the two QUEUE levers (§6.3): they fold at COMPILE, not at an advance
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * `year@<year>` ⇄ the schedule year, and `year@<year>::<field>` for a lever that decides more
 * than one number per year.
 *
 * Both queue levers' `buildVariables` emit an INDEX — `rothConversionSchedule[7].incomeTarget`,
 * `earlyWithdrawalSchedule[7].taxDeferredAmount` — computed by searching the schedule for the
 * year at "now". That index is a position in the table AS IT STOOD DURING THAT RUN, and both
 * levers' `prepareBaseParams` APPEND a row and re-sort, so it moves as the run proceeds. D5's
 * trap in its purest form; the year is the anchor those very functions searched by.
 */
export const YEAR_KEY_PREFIX = 'year@';
export const YEAR_FIELD_SEP  = '::';

/** @returns {string} `year@2031`, or `year@2031::rothAmount` when a field is named. */
export function yearKey(year, field = null) {
  return `${YEAR_KEY_PREFIX}${year}${field ? YEAR_FIELD_SEP + field : ''}`;
}

/** @returns {{year:number, field:string|null}|null} the parts of a `year@…` key. */
export function yearKeyParts(key) {
  if (typeof key !== 'string' || !key.startsWith(YEAR_KEY_PREFIX)) return null;
  const [y, field = null] = key.slice(YEAR_KEY_PREFIX.length).split(YEAR_FIELD_SEP);
  const year = Number(y);
  return Number.isFinite(year) ? { year, field } : null;
}

/** The trailing `.field` of an indexed param path, e.g. `…[7].rothAmount` → `rothAmount`. */
function _pathField(paramKey) {
  const i = typeof paramKey === 'string' ? paramKey.lastIndexOf('.') : -1;
  return i >= 0 ? paramKey.slice(i + 1) : null;
}

/**
 * Fold year-keyed rows into a year-keyed schedule param, preserving every entry the run never
 * decided and every field of an entry it decided only part of.
 *
 * Sorted by year for the same reason the band table is sorted by age: both toolsets iterate
 * the array to emit events, and `prepareBaseParams` re-sorts after every append, so an
 * unsorted fold would not be the table the run actually ran against.
 */
function _foldYearSchedule(base, rows, fields) {
  const out = (Array.isArray(base) ? base : []).map(e => ({ ...e }));
  let touched = false;
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const parts = yearKeyParts(row?.key);
    const value = Number(row?.value);
    if (parts == null || !Number.isFinite(value)) continue;
    const field = parts.field ?? fields[0];
    if (!fields.includes(field)) continue;
    const i = out.findIndex(e => Number(e?.year) === parts.year);
    if (i >= 0) out[i] = { ...out[i], [field]: value };
    else        out.push({ year: parts.year, [field]: value });
    touched = true;
  }
  if (!touched) return null;
  out.sort((a, b) => Number(a.year) - Number(b.year));
  return out;
}

/**
 * ROTH and EARLY_WITHDRAWAL act on QUEUED EVENTS, and a reducer cannot touch the queue.
 *
 * They need no mid-run mechanism anyway, and that is the point of §6.3: their params are
 * ALREADY year-keyed schedules, consumed at compile to seed those events. So a recorded row
 * folds into `rothConversionSchedule` / `earlyWithdrawalSchedule` before the toolsets build
 * anything, and from there the run is indistinguishable from a hand-authored schedule.
 *
 * `foldsAtCompile: true` is what tells `MpcDecisionScheduleReducer` these rows are SOMEONE
 * ELSE'S JOB rather than an unimplemented lever. Without it the reducer's missing-hook warning
 * — correct and loud for a lever that genuinely cannot be applied — would fire on every run
 * that converts, and a warning that is always wrong is a warning nobody reads.
 *
 * `retargetRothConversionEvents` / `retargetEarlyWithdrawalEvents` are NOT this path. They
 * exist because `_seededSim` injects a stale snapshot queue into a fresh compile, which is a
 * rollout problem that does not arise when the clock starts at t₀.
 */
export const ROTH_SCHEDULE = {
  foldsAtCompile: true,
  paramKey:  'rothConversionSchedule',
  appliesTo: (bp) => bp?.rothConversionEnabled === true,
  requirement: 'Enable Roth conversions (Scenario panel) to use this lever.',
  scheduleKey: (variable) =>
    (Number.isFinite(variable?._year) ? yearKey(variable._year) : (variable?.paramKey ?? null)),
  foldAt: ({ rows, baseParams }) =>
    _foldYearSchedule(baseParams?.rothConversionSchedule, rows, ['incomeTarget', 'bracketCeiling']),
};

export const EARLY_WITHDRAWAL_SCHEDULE = {
  foldsAtCompile: true,
  paramKey:  'earlyWithdrawalSchedule',
  // Enabling is necessary but not sufficient: the toolset seeds tunable events only when a
  // schedule or a valid window exists, so the lever would otherwise advise moves it cannot
  // execute. The recorded run carries its own schedule rows, so the fold satisfies the first
  // clause by construction — but the gate is asserted against the BASE, before the fold.
  appliesTo: (bp) => bp?.earlyWithdrawalEnabled === true && (
    (Array.isArray(bp?.earlyWithdrawalSchedule) && bp.earlyWithdrawalSchedule.length > 0) ||
    (Number.isFinite(bp?.earlyWithdrawalStartYear) &&
     Number.isFinite(bp?.earlyWithdrawalEndYear) &&
     bp.earlyWithdrawalEndYear >= bp.earlyWithdrawalStartYear)
  ),
  requirement: 'Enable early withdrawals and set an optimization window (Scenario panel) to use this lever.',
  // Two variables per year, so the field rides in the key: `year@2031::rothAmount`.
  scheduleKey: (variable) => (Number.isFinite(variable?._year)
    ? yearKey(variable._year, _pathField(variable?.paramKey))
    : (variable?.paramKey ?? null)),
  foldAt: ({ rows, baseParams }) =>
    _foldYearSchedule(baseParams?.earlyWithdrawalSchedule, rows, ['taxDeferredAmount', 'rothAmount']),
};

// ─────────────────────────────────────────────────────────────────────────────────
// The gates — D11's first half (§16.3, and the case that settles Q5)
// ─────────────────────────────────────────────────────────────────────────────────

/** `strategy` may be a scalar or a list of selected strategies. */
function _hasStrategy(strategy, key) {
  return Array.isArray(strategy) ? strategy.includes(key) : strategy === key;
}

/**
 * Every lever's `appliesTo` gate + the sentence that says how to satisfy it.
 *
 * These MOVED here from `COCKPIT_CONTROLS` (they are spread back in) for the reason §16.3
 * found: the gate is not a cockpit concern, it is a fact about the lever that two very
 * different consumers need. The cockpit asks it to decide whether a lever is worth SEARCHING;
 * the loader asks it to decide whether a recorded run can be PLAYED at all. A run recorded
 * with conversions on, selected against a base where they have since been switched off, has
 * every ROTH row dropped by the toolset's opening `if (!p.rothConversionEnabled) return []`
 * and plays back as a different plan in silence. Two copies of that predicate is two places
 * the two answers can diverge.
 */
const LEVER_GATES = {
  SPENDING: {
    appliesTo: (bp) => _hasStrategy(bp?.spendingStrategy, 'EXPLICIT_BANDS'),
    requirement: 'Switch Spending Strategy to include EXPLICIT_BANDS (Scenario panel) to use this lever.',
  },
  // Always applicable: which country's accounts compete for a draw, and how accounts sharing
  // a tier split one, are valid decisions whenever the plan spans both / a tier has ≥2
  // members. Inert only under a DATA condition, which is not something a gate can see.
  DRAWDOWN_XBORDER:    { appliesTo: () => true },
  DRAWDOWN_WITHINTIER: { appliesTo: () => true },
  DRAWDOWN_WEIGHTS: {
    appliesTo: (bp) => bp?.drawdownStrategy === DRAWDOWN_WEIGHT_MODE,
    requirement: 'Set Drawdown Strategy to WEIGHTED (Scenario panel) to tune the drawdown order online.',
  },
  DRAWDOWN_SLEEVE: {
    appliesTo: (bp) => bp?.drawdownSleeveOrder === SLEEVE_WEIGHT_MODE,
    requirement: 'Set Drawdown Sleeve Order to WEIGHTED (Scenario panel) to tune the sleeve sell order online.',
  },
  ALLOCATION_MIX: {
    appliesTo: (bp) => bp?.allocationStrategy === ALLOCATION_OPTIMIZED_MODE
                    && _hasStrategy(bp?.behavioralStrategies, 'TARGET_ALLOCATION'),
    requirement: 'Select the TARGET_ALLOCATION behavioral strategy and set Allocation Strategy to OPTIMIZED (Scenario panel) to tune the mix online.',
  },
  BOND_LADDER: {
    appliesTo: (bp) => _hasStrategy(bp?.behavioralStrategies, 'BOND_LADDER'),
    requirement: 'Select the BOND_LADDER behavioral strategy (Scenario panel) to tune the ladder length online.',
  },
};

/**
 * The hooks, by `COCKPIT_CONTROLS` key. Levers absent from this map have no `applyAt` yet and
 * are skipped by the reducer with a warning rather than silently ignored — a recorded row for
 * a lever that cannot be applied is a run playing back as something other than what it was.
 */
export const LEVER_SCHEDULE = {
  SPENDING:            { ...LEVER_GATES.SPENDING, ...SPENDING_SCHEDULE },
  ROTH:                ROTH_SCHEDULE,
  EARLY_WITHDRAWAL:    EARLY_WITHDRAWAL_SCHEDULE,
  DRAWDOWN_XBORDER:    { ...LEVER_GATES.DRAWDOWN_XBORDER, ...DRAWDOWN_XBORDER_SCHEDULE },
  DRAWDOWN_WITHINTIER: { ...LEVER_GATES.DRAWDOWN_WITHINTIER, ...DRAWDOWN_WITHINTIER_SCHEDULE },
  DRAWDOWN_SLEEVE:     { ...LEVER_GATES.DRAWDOWN_SLEEVE, ...DRAWDOWN_SLEEVE_SCHEDULE },
  DRAWDOWN_WEIGHTS:    { ...LEVER_GATES.DRAWDOWN_WEIGHTS, ...DRAWDOWN_WEIGHTS_SCHEDULE },
  ALLOCATION_MIX:      { ...LEVER_GATES.ALLOCATION_MIX, ...ALLOCATION_MIX_SCHEDULE },
  BOND_LADDER:         { ...LEVER_GATES.BOND_LADDER, ...BOND_LADDER_SCHEDULE },
};
