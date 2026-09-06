/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ACCOUNT_TYPE }            from '../assets/account.js';
import { DRAWDOWN_SLEEVE_CLASSES } from '../holdings/holdings-selection.js';
// The rebalancer's own account set, imported rather than restated: two authorities on
// "which accounts can this reducer trade" is how a warning comes to disagree with the
// thing it warns about. No cycle — `rebalance-to-target-reducer.js` does not import us.
import { TAX_ADVANTAGED_ROLES, TAXABLE_ROLES } from '../behavioral/rebalance-to-target-reducer.js';

/**
 * DESIGN 97 PART II — the LIQUIDITY GRAPH.
 *
 * §3 built the spend side as a LIST (`drawdownSequence`). Three things the pools concept
 * needs cannot be said in a list, and this module is the generalisation that can say them:
 *
 *  1. **a pool spanning several accounts** — "one year of cash" is the AU savings account
 *     AND the US savings account AND the settled CASH sleeve of the brokerage. As a list
 *     that is three adjacent entries tied together by nothing, so nothing can size, report
 *     or refill it as one thing;
 *  2. **a refill with several sources and several destinations** — the cascade
 *     (growth → reserve → cash), the offset as a SECOND source into cash tried after the
 *     reserve, and "buy the dip" as an edge pointing back UP the cascade;
 *  3. **two different orders over the same nodes** — the spend order and the refill order.
 *
 * So: pools are NODES, flows are EDGES, and §3's sequence is the degenerate case.
 *
 * ── The load-bearing decision (design 97 §12) ────────────────────────────────────────
 * **The graph COMPILES.** `compileToDrawdownSequence()` flattens the pools' claims into
 * exactly the `state.drawdownSequence` §3 already consumes, at build time, so effort 1 adds
 * NO second drawdown code path and `AccountService.replenishSavings` is untouched. Every §3
 * semantic — including "what the sequence does not claim follows it in `drawdownPriority`
 * order" — is inherited rather than reimplemented.
 *
 * If a change to the graph would require a change to `replenishSavings`, the change is in
 * the wrong place.
 *
 * ── Validation is the feature (design 97 §12.7) ──────────────────────────────────────
 * Every failure mode here is silent and produces a perfectly believable number, which is why
 * they throw at config time. Two are new relative to §6 and both matter:
 *  - **claims overlapping ACROSS pools** — §3 checked this within one sequence; two pools
 *    claiming the same sleeve would be double-counted by every target, trigger and cover
 *    figure in the feature;
 *  - **an unconditional opposing edge pair** — a laundering loop with no reading under which
 *    it is intended. Conditional cycles are LEGAL (harvest and buy-the-dip are genuinely
 *    both wanted); see `assertNoUnconditionalCycle`.
 */

/** How a pool's size target is expressed (design 97 §12.2). */
export const POOL_TARGET_MODE = Object.freeze({
  /** value × the LIVE annual spend line — §9's arithmetic, the reserve grows with spending. */
  YEARS_OF_SPEND: 'YEARS_OF_SPEND',
  /** value as a fraction of the rebalanced book. */
  PERCENT:        'PERCENT',
  /** a fixed figure in the valuation base currency. */
  AMOUNT:         'AMOUNT',
  /**
   * Design 97 §12.2b — the RESIDUAL of an aggregate cover target held across several pools.
   *
   * `{ mode, value, after: [poolId, …] }` ⇒ `max(0, value × spend − Σ contribution(after))`.
   * The case it exists for: a pool whose CAPACITY falls on a schedule nobody authored — an
   * offset, whose `OFFSET_CAP` is `min(balance, linked loan)` and shrinks as the loan
   * amortises. Nothing refills it, because it is the ceiling that dropped, not the balance;
   * so without this the aggregate reserve silently decays and no per-node target can see it.
   *
   * A referenced pool contributes its TARGET when it has one, and its `utilised` cover when
   * it does not. That asymmetry is the decision, not an accident: a target IS the pool's
   * claim about what it will hold and the refill flows are what keep that claim true, so a
   * cash pool drained between refills must not move this target and start a rebalance. A
   * pool with no target makes no such claim, and only what it actually holds is cover.
   */
  YEARS_OF_SPEND_REMAINDER: 'YEARS_OF_SPEND_REMAINDER',
});

/** Which spend line a YEARS_OF_SPEND target reads (design 97 §12.2). */
export const POOL_SPEND_BASIS = Object.freeze({
  /** the live, inflated `state.monthlyExpenses` — what §9 built and measured. */
  LIVE:     'LIVE',
  /** a trailing average, so a guardrail cut does not shrink the reserve when it is needed. */
  TRAILING: 'TRAILING',
});

/** How a pool's CAPACITY (its ceiling, distinct from its balance) is derived (§12.1). */
export const POOL_CAPACITY_MODE = Object.freeze({
  /** capacity == balance; the pool has no ceiling of its own. The default. */
  BALANCE:        'BALANCE',
  /** min(balance, linked loan balance) — the offset's amortising cap, which falls on a
   *  schedule nobody authored and is the reason `FINDINGS.md` §6.3 exists. */
  OFFSET_CAP:     'OFFSET_CAP',
  /** an authored ceiling in base currency. */
  AMOUNT:         'AMOUNT',
  /** an authored ceiling in years of spending. */
  YEARS_OF_SPEND: 'YEARS_OF_SPEND',
});

/** How often an edge may fire (design 97 §12.6). */
export const FLOW_CADENCE = Object.freeze({ PERIOD: 'PERIOD', ANNUAL: 'ANNUAL' });

/**
 * What series a drawdown gate measures the pool against (design 97 §20.14).
 *
 * `sourceDrawdownUnder` has always meant "within x of the pool's trailing high", and `high`
 * has always meant the peak BALANCE. In a plan being spent down those are two different
 * questions wearing one name, and `poolMarketReturn`'s docstring is the record of it: the
 * reference plan's growth pool sat 9–16 % below its peak balance in years the market had
 * fully recovered, purely because spending had permanently removed capital, so a 5 % gate
 * latched shut forever after the first crash.
 *
 * INDEX answers the question the gate's name asks. It is a unit-value series — the pool's own
 * market return, compounded, starting at 1.0 and never touched by a contribution or a
 * withdrawal — which is the ordinary time-weighted definition of a drawdown. Two pools with
 * the same returns and different flow timing report the same number, which is the property a
 * flow-adjusted balance cannot have.
 *
 * BALANCE remains the default: it is what every existing graph means, and the two answer
 * genuinely different questions ("is the market down?" vs "is this pool smaller than it has
 * ever been?"). The second is the right question for a pool with a spending FLOOR.
 */
export const POOL_DRAWDOWN_BASIS = Object.freeze({
  /** the peak BALANCE — spending counts as drawdown. The default, and what §12.3 shipped. */
  BALANCE: 'BALANCE',
  /** the peak of the pool's compounded RETURN index — flow-neutral (§20.14). */
  INDEX:   'INDEX',
});

/**
 * What a closed gate VETOES (design 97 §12.4c). Two different author intents, not two
 * phrasings of one — see the design section before changing the default.
 */
export const POOL_GATE_SCOPE = Object.freeze({
  /**
   * "Do not SELL this pool while it is down." Floors every class the SOURCE claims at what it
   * currently holds. The default, and byte-identical to everything shipped before §12.4c —
   * including its collateral: once the source holds most of the book the floor sums to 1 and
   * every other target is zeroed (`pool-veto-floor-collapse`).
   */
  SOURCE: 'SOURCE',
  /**
   * "Do not FILL that pool from this one while it is down." Caps every class the gated edge's
   * DESTINATION claims at what it currently holds. Blocks the same laundering trade from the
   * other end, and cannot collapse an ungated class — but only closes the routes the author
   * actually drew (an offset claims no class, so it constrains the rebalancer not at all).
   */
  EDGE:   'EDGE',
});

const GATE_SCOPES    = new Set(Object.values(POOL_GATE_SCOPE));
const VALID_SLEEVES  = new Set(DRAWDOWN_SLEEVE_CLASSES);
const TARGET_MODES   = new Set(Object.values(POOL_TARGET_MODE));
const CAPACITY_MODES = new Set(Object.values(POOL_CAPACITY_MODE));
const SPEND_BASES    = new Set(Object.values(POOL_SPEND_BASIS));
const DRAWDOWN_BASES = new Set(Object.values(POOL_DRAWDOWN_BASIS));
/** A composed gate is a tree; a bound keeps a cyclic or absurd authored one from recursing. */
const MAX_GATE_DEPTH = 6;

const err = (msg) => { throw new Error(`liquidityGraph: ${msg}`); };

/** A finite number, or throw naming the field. */
function num(v, what, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) err(`${what} must be a finite number, got ${JSON.stringify(v)}`);
  if (n < min || n > max)  err(`${what} must be within [${min}, ${max}], got ${n}`);
  return n;
}

/**
 * Normalize a `{ mode, value }` size spec (target / floor / capacity).
 * A bare number is sugar for the caller's default mode.
 */
function sizeSpec(raw, what, allowed, defaultMode) {
  if (raw == null) return null;
  const spec = (typeof raw === 'number') ? { mode: defaultMode, value: raw } : raw;
  if (typeof spec !== 'object') err(`${what} must be a number or { mode, value }`);
  const mode = spec.mode ?? defaultMode;
  if (!allowed.has(mode)) err(`${what} has unknown mode '${mode}'. Valid: ${[...allowed].join(', ')}`);
  const out = { mode };
  // BALANCE and OFFSET_CAP take no value: both ARE derived from live state (the balance
  // itself, and min(balance, linked loan) respectively).
  const derived = mode === POOL_CAPACITY_MODE.BALANCE || mode === POOL_CAPACITY_MODE.OFFSET_CAP;
  if (!derived) out.value = num(spec.value, `${what}.value`, { min: 0 });
  if (mode === POOL_TARGET_MODE.YEARS_OF_SPEND_REMAINDER) {
    const after = spec.after;
    if (!Array.isArray(after) || after.length === 0) {
      err(`${what} needs a non-empty \`after\` naming the pools whose cover it is the remainder of. `
        + 'Without one it is just YEARS_OF_SPEND wearing a longer name.');
    }
    if (after.some(id => typeof id !== 'string' || !id)) err(`${what}.after must be pool ids`);
    if (new Set(after).size !== after.length) {
      err(`${what}.after names the same pool twice, which would double-count its cover`);
    }
    out.after = [...after];
  }
  if (mode === POOL_TARGET_MODE.YEARS_OF_SPEND || mode === POOL_CAPACITY_MODE.YEARS_OF_SPEND
      || mode === POOL_TARGET_MODE.YEARS_OF_SPEND_REMAINDER) {
    const basis = spec.spendBasis ?? POOL_SPEND_BASIS.LIVE;
    if (!SPEND_BASES.has(basis)) err(`${what}.spendBasis must be one of ${[...SPEND_BASES].join(', ')}`);
    out.spendBasis = basis;
    if (basis === POOL_SPEND_BASIS.TRAILING) {
      out.trailingYears = num(spec.trailingYears ?? 3, `${what}.trailingYears`, { min: 1, max: 20 });
    }
  }
  if (mode === POOL_TARGET_MODE.PERCENT && out.value > 1) {
    err(`${what}.value is a FRACTION of the book, not a percentage — got ${out.value}`);
  }
  return out;
}

/** Normalize one pool's claims: [{ key, sleeves|null }]. */
function normalizeClaims(rawClaims, poolId, byKey) {
  const claims = Array.isArray(rawClaims) ? rawClaims : (rawClaims == null ? [] : [rawClaims]);
  if (claims.length === 0) err(`pool '${poolId}' has no claims; a pool is a set of (account, sleeves) claims`);
  const out = [];
  const seen = new Map();   // key → Set<sleeve> | true, WITHIN this pool
  for (const rawClaim of claims) {
    const claim = (typeof rawClaim === 'string') ? { key: rawClaim } : rawClaim;
    const key   = claim?.key;
    if (!key) err(`pool '${poolId}' has a claim with no \`key\``);
    const account = byKey.get(key);
    if (!account) {
      err(`pool '${poolId}' claims '${key}', which is not an account stateKey in this scenario. `
        + `Known keys: ${[...byKey.keys()].join(', ')}`);
    }
    let sleeves = claim.sleeves ?? null;
    if (sleeves != null) {
      if (!Array.isArray(sleeves) || sleeves.length === 0) {
        err(`pool '${poolId}' claim '${key}' has an empty \`sleeves\`; omit it to claim the whole account`);
      }
      for (const cls of sleeves) {
        if (!VALID_SLEEVES.has(cls)) {
          err(`pool '${poolId}' claim '${key}' names unknown sleeve '${cls}'. Valid: ${DRAWDOWN_SLEEVE_CLASSES.join(', ')}`);
        }
      }
      // §3's rule, unchanged: sleeves only MEAN anything on an account whose draw runs
      // through consumeHoldings. Elsewhere the narrowing would read as a pool boundary
      // and enforce nothing.
      if (account.type !== ACCOUNT_TYPE.BROKERAGE) {
        err(`pool '${poolId}' claim '${key}' narrows sleeves, but only a BROKERAGE account draws `
          + 'through consumeHoldings — on any other account the narrowing would enforce nothing.');
      }
      sleeves = [...sleeves];
    }
    const prior = seen.get(key);
    if (prior === true || (sleeves == null && prior)) {
      err(`pool '${poolId}' claims '${key}' twice`);
    }
    if (sleeves == null) seen.set(key, true);
    else {
      const set = prior ?? new Set();
      for (const cls of sleeves) {
        if (set.has(cls)) err(`pool '${poolId}' claims sleeve '${cls}' of '${key}' twice`);
        set.add(cls);
      }
      seen.set(key, set);
    }
    out.push({ key, sleeves });
  }
  return out;
}

/**
 * Normalize a flow's `gate` (design 97 §12.3, composed in §20.15). Absent ⇒ null ⇒ open.
 *
 * ── the grammar ─────────────────────────────────────────────────────────────────────
 * A gate is a TREE of nodes. A node carries clauses of its own, any number of child nodes,
 * and an optional dwell:
 *
 *   { sourceDrawdownUnder: 0.05, sustainedYears: 2 }          one node, two clauses
 *   { anyOf: [ {…}, {…} ] }                                   OR
 *   { allOf: [ {…}, {…} ] }  ·  [ {…}, {…} ]                  AND (an array is sugar for it)
 *   { not: {…} }                                              negation
 *
 * A node is open when its own clauses ALL pass, every `allOf` child is open, at least one
 * `anyOf` child is open, and any `not` child is shut. Clauses on one node are therefore an
 * AND, which is what a flat gate has always meant — every gate authored before this section
 * normalizes to exactly what it did, which is the property that keeps the goldens still.
 *
 * The shape mirrors `visibleWhen`'s DSL deliberately: two composable predicate languages in
 * one codebase that disagree about whether an array is an AND would be a coin flip at every
 * call site.
 *
 * ── why dwell is the interesting half ───────────────────────────────────────────────
 * §20.13 measured the three trailing-high thresholds (1 %, 5 %, 10 %) landing within \$13k of
 * each other on a \$5m plan, while the C-vs-E-vs-D spread — the same gate family differing
 * only in HOW LONG it stays shut — ran to \$460k. The threshold is nearly inert and the
 * DURATION is the lever, so the grammar has to be able to say duration. `sustainedYears: n`
 * is that: the node's condition must have held on the last n consecutive years, this one
 * included, before it counts as open.
 *
 * The unit is the YEAR, and not for convenience. This reducer fires on both US_ and
 * AU_PERIOD_ADVANCE, so a dwell counted in evaluations would mean one year in a US-only plan
 * and half a year in a cross-border one — the same authored number silently meaning two
 * different policies. It is also the grain at which the signal changes at all: the equity
 * tick is annual, so every gate reading is constant within a year (§20.2, and POOL-12d is the
 * regression for it).
 */
function normalizeGate(raw, flowId, depth = 0, where = 'gate') {
  if (raw == null) return null;
  if (Array.isArray(raw)) return normalizeGate({ allOf: raw }, flowId, depth, where);
  if (typeof raw !== 'object') err(`flow '${flowId}' ${where} must be an object`);
  if (depth > MAX_GATE_DEPTH) {
    err(`flow '${flowId}' ${where} nests deeper than ${MAX_GATE_DEPTH}; flatten it`);
  }
  const out = {};
  if (raw.sourceDrawdownUnder != null) out.sourceDrawdownUnder = num(raw.sourceDrawdownUnder, `flow '${flowId}' ${where}.sourceDrawdownUnder`, { min: 0, max: 1 });
  if (raw.targetDrawdownOver  != null) out.targetDrawdownOver  = num(raw.targetDrawdownOver,  `flow '${flowId}' ${where}.targetDrawdownOver`,  { min: 0, max: 1 });
  // Which series those two measure against (§20.14). Normalized only when a drawdown clause
  // is actually present: carrying a basis on a gate with no drawdown term would round-trip a
  // setting that decides nothing, and every saved graph would then differ from itself.
  if (raw.drawdownBasis != null) {
    if (out.sourceDrawdownUnder == null && out.targetDrawdownOver == null) {
      err(`flow '${flowId}' ${where}.drawdownBasis is set but the gate has no drawdown clause for it to govern`);
    }
    const b = String(raw.drawdownBasis).toUpperCase();
    if (!DRAWDOWN_BASES.has(b)) {
      err(`flow '${flowId}' ${where}.drawdownBasis '${raw.drawdownBasis}' is unknown. Valid: ${[...DRAWDOWN_BASES].join(', ')}`);
    }
    if (b !== POOL_DRAWDOWN_BASIS.BALANCE) out.drawdownBasis = b;   // default stays absent
  }
  // The market-state pair. Prefer these to the drawdown pair in a DECUMULATION plan: a
  // trailing-high gate cannot tell a falling market from a pool being spent down, and latches
  // shut after the first crash (see `poolMarketReturn`).
  //
  // Both read the PRIOR period's return off the pool cube, never the current period's — see
  // `PoolFlowReducer#_gateOpen`, where design 97 §20 measured the live reading to be exactly
  // the return of the year the gate is deciding in. So `sourceReturnOver: 0` means "sell the
  // source only after an up year", not "only in an up year"; the two differ by a year of
  // foresight and the second is not implementable.
  if (raw.sourceReturnOver  != null) out.sourceReturnOver  = num(raw.sourceReturnOver,  `flow '${flowId}' ${where}.sourceReturnOver`,  { min: -1, max: 1 });
  if (raw.targetReturnUnder != null) out.targetReturnUnder = num(raw.targetReturnUnder, `flow '${flowId}' ${where}.targetReturnUnder`, { min: -1, max: 1 });
  if (raw.notInRegime != null) {
    const tags = Array.isArray(raw.notInRegime) ? raw.notInRegime : [raw.notInRegime];
    if (!tags.length) err(`flow '${flowId}' ${where}.notInRegime is empty; omit it`);
    out.notInRegime = tags.map(String);
  }
  for (const k of ['notBefore', 'notAfter']) {
    if (raw[k] == null) continue;
    const t = new Date(raw[k]).getTime();
    if (Number.isNaN(t)) err(`flow '${flowId}' ${where}.${k} is not a date: ${JSON.stringify(raw[k])}`);
    out[k] = new Date(t).toISOString().slice(0, 10);
  }
  if (raw.ageOver  != null) out.ageOver  = num(raw.ageOver,  `flow '${flowId}' ${where}.ageOver`,  { min: 0, max: 120 });
  if (raw.ageUnder != null) out.ageUnder = num(raw.ageUnder, `flow '${flowId}' ${where}.ageUnder`, { min: 0, max: 120 });

  // ── the composition, and the dwell ────────────────────────────────────────────────
  for (const key of ['allOf', 'anyOf']) {
    if (raw[key] == null) continue;
    const list = Array.isArray(raw[key]) ? raw[key] : [raw[key]];
    if (!list.length) err(`flow '${flowId}' ${where}.${key} is empty; omit it`);
    const kids = list.map((k, i) => normalizeGate(k, flowId, depth + 1, `${where}.${key}[${i}]`));
    // A child that normalizes away is a branch that decides nothing, and inside an `anyOf`
    // one such branch is always open — which quietly makes the whole gate always open. That
    // is the single most expensive way for this feature to fail, so it is a config error
    // rather than a default.
    kids.forEach((k, i) => {
      if (!k) err(`flow '${flowId}' ${where}.${key}[${i}] has no conditions; ${key === 'anyOf'
        ? 'an always-open branch makes the whole gate always open' : 'omit it'}`);
    });
    out[key] = kids;
  }
  if (raw.not != null) {
    const kid = normalizeGate(raw.not, flowId, depth + 1, `${where}.not`);
    if (!kid) err(`flow '${flowId}' ${where}.not has no conditions; it would never be true`);
    out.not = kid;
  }
  // §12.4c — the veto's target. ROOT ONLY: the run takes ONE veto decision per gate, so a
  // scope on an `anyOf` branch would read as though branches could veto differently, and the
  // author would be owed a behaviour the single decision cannot deliver. Rejected loudly for
  // that reason rather than silently hoisted, which would be a second way to write the root.
  if (raw.scope != null) {
    if (depth > 0) {
      err(`flow '${flowId}' ${where}.scope is nested. A gate takes ONE veto decision, so the `
        + 'scope belongs on the gate root — move it there.');
    }
    const sc = String(raw.scope).toUpperCase();
    if (!GATE_SCOPES.has(sc)) {
      err(`flow '${flowId}' ${where}.scope '${raw.scope}' is unknown. Valid: ${[...GATE_SCOPES].join(', ')}`);
    }
    // SOURCE is the default and is DROPPED, so an authored SOURCE does not make a saved graph
    // differ from itself on the next save — the same rule `sustainedYears: 1` follows below.
    if (sc !== POOL_GATE_SCOPE.SOURCE) out.scope = sc;
  }
  // Dwell. `1` is the default and is dropped, so an authored 1 does not make a saved graph
  // differ from itself on the next save.
  if (raw.sustainedYears != null) {
    const n = num(raw.sustainedYears, `flow '${flowId}' ${where}.sustainedYears`, { min: 1, max: 100 });
    if (!Number.isInteger(n)) err(`flow '${flowId}' ${where}.sustainedYears must be a whole number of years, got ${n}`);
    if (!hasCondition(out)) {
      err(`flow '${flowId}' ${where}.sustainedYears is set but the node has no condition to sustain`);
    }
    if (n > 1) out.sustainedYears = n;
  }
  return Object.keys(out).length ? out : null;
}

/** Does this normalized node say anything at all? (`sustainedYears` alone says nothing.) */
function hasCondition(node) {
  return Object.keys(node).some(k => k !== 'sustainedYears' && k !== 'scope');
}

/**
 * Normalize a flow's `trigger` — WHEN the destination wants money (design 97 §12.3).
 * Absent ⇒ null ⇒ fires whenever the destination is under target at all.
 *
 * `trigger` and `amount.toTarget` are deliberately two numbers: the (s, S) control band of
 * the cash-management literature. Conflating them is what makes a drift band churn.
 */
function normalizeTrigger(raw, flowId) {
  if (raw == null) return null;
  if (typeof raw !== 'object') err(`flow '${flowId}' trigger must be an object`);
  const out = {};
  if (raw.below != null) {
    out.below = sizeSpec(raw.below, `flow '${flowId}' trigger.below`, TARGET_MODES, POOL_TARGET_MODE.AMOUNT);
  }
  if (raw.belowTargetFraction != null) {
    out.belowTargetFraction = num(raw.belowTargetFraction, `flow '${flowId}' trigger.belowTargetFraction`, { min: 0, max: 1 });
  }
  if (out.below && out.belowTargetFraction != null) {
    err(`flow '${flowId}' sets both trigger.below and trigger.belowTargetFraction; they are two ways to say one thing`);
  }
  return Object.keys(out).length ? out : null;
}

/** Normalize a flow's `amount` — HOW MUCH to move. Default: fill the destination to target. */
function normalizeAmount(raw, flowId) {
  const spec = raw ?? {};
  if (typeof spec !== 'object') err(`flow '${flowId}' amount must be an object`);
  const out = {
    toTarget:        spec.toTarget !== false && spec.fractionOfSource == null,
    fractionOfSource: spec.fractionOfSource != null
      ? num(spec.fractionOfSource, `flow '${flowId}' amount.fractionOfSource`, { min: 0, max: 1 })
      : null,
    max: spec.max != null ? num(spec.max, `flow '${flowId}' amount.max`, { min: 0 }) : null,
    min: spec.min != null ? num(spec.min, `flow '${flowId}' amount.min`, { min: 0 }) : null,
  };
  if (!out.toTarget && out.fractionOfSource == null) {
    err(`flow '${flowId}' amount says neither toTarget nor fractionOfSource; it can never move anything`);
  }
  return out;
}

/**
 * Design 97 §12.5 — cycles are LEGAL, an unconditional opposing pair is not.
 *
 * `growth → reserve` (harvest) and `reserve → growth` (buy the dip) are both wanted, so
 * validation must not demand a DAG. What has no intended reading is a pair of edges between
 * the same two pools where NEITHER has a gate or a trigger: that is a laundering loop that
 * fires every period in both directions.
 */
function assertNoUnconditionalCycle(flows) {
  const unconditional = new Map();   // "from>to" → flow id
  for (const f of flows) {
    if (f.gate || f.trigger) continue;
    unconditional.set(`${f.from}>${f.to}`, f.id);
  }
  for (const [pair, id] of unconditional) {
    const [from, to] = pair.split('>');
    const back = unconditional.get(`${to}>${from}`);
    if (back) {
      err(`flows '${id}' and '${back}' move value between '${from}' and '${to}' in both directions with `
        + 'no gate and no trigger on either — an unconditional laundering loop. Gate one of them, '
        + 'or give it a trigger. (A CONDITIONAL cycle is legal and is how harvest + buy-the-dip is said.)');
    }
  }
}


/** How an edge is actually executed (design 97 §12.4). */
export const FLOW_EXECUTOR = Object.freeze({
  /** Both ends sit inside the rebalanceable book ⇒ the design-61 rebalancer moves it,
   *  and the gate acts as a VETO on the leg that would sell the source. No new transfer
   *  machinery, no new disposal path, no new tax path. */
  REBALANCE: 'REBALANCE',
  /** At least one end is a cash-like account ⇒ a real debit/credit, routed through
   *  `AccountService.replenishSavings`'s scoped draw so withdrawal tax, the §988 leg and
   *  `INTL_TRANSFER_RECORD` all fire exactly as they do for spending. */
  TRANSFER:  'TRANSFER',
});

/** Cash-like = holds no lots, so value moves into it as a deposit rather than a purchase. */
const CASH_LIKE_TYPES = new Set([ACCOUNT_TYPE.CHECKING, ACCOUNT_TYPE.SAVINGS, ACCOUNT_TYPE.OFFSET]);

/** Is every claim of this pool inside the rebalanceable (holdings-bearing) book? */
function isPortfolioPool(pool, byKey) {
  return pool.claims.every(c => byKey.get(c.key)?.type === ACCOUNT_TYPE.BROKERAGE);
}

/**
 * The account a TRANSFER executor deposits into: the pool's first cash-like claim.
 *
 * A pool with no cash-like claim cannot receive a transfer — moving value into a BOND
 * sleeve is a PURCHASE, which is the rebalancer's job, not a deposit. Validated at config
 * time (below) rather than discovered at run time as a flow that silently moves nothing.
 */
export function depositKeyFor(pool, byKey) {
  return pool.claims.find(c => CASH_LIKE_TYPES.has(byKey.get(c.key)?.type))?.key ?? null;
}

/**
 * The (account, allocation) a TRANSFER executor BUYS into — design 97 §12.4a.
 *
 * The original §12.4 split had exactly two shapes: value moves INSIDE the book (the
 * rebalancer, a target-mix shift) or it moves into a cash-like account (a deposit). What
 * neither can say is the one the offset makes natural — **cash held OUTSIDE the book buying
 * into the book**: the offset is not rebalanceable, so executor 1 cannot see it, and the
 * destination is a sleeve, so `depositKeyFor` finds nowhere to put the money. "Buy the dip
 * with the offset" therefore failed validation rather than running, which is the reverse of
 * the g→o harvest edge the same graph already expresses.
 *
 * A purchase destination is deliberately the NARROWEST shape that has one unambiguous
 * reading:
 *  - **one claim** — two accounts, or two sleeves, and there is no unique split for the
 *    money, the same reason a pool `target` and a `fractionOfSource` REBALANCE edge each
 *    demand a single class;
 *  - **a BROKERAGE account** — a deposit into a wrapper (IRA / 401k / Roth / super) is a
 *    CONTRIBUTION, which has eligibility and a cap and is not this feature's to invent;
 *  - **exactly one named sleeve** — the allocation the cash becomes. An unnarrowed claim
 *    would mean "buy the account's current mix", which is a second, silently different
 *    policy wearing the same edge.
 *
 * The purchase itself is a real one: `PoolFlowApplyReducer` routes it through the same
 * `replenishSavings` seam as every other flow (so the SOURCE side still books its disposal,
 * its withdrawal tax and its §988 leg) and the credit opens a properly dated vintage lot in
 * the named sleeve — a new cost basis and a new holding period, which is what buying is.
 *
 * @returns {{key: string, allocation: string}|null}
 */
export function purchaseTargetFor(pool, byKey) {
  const claims = pool?.claims ?? [];
  if (claims.length !== 1) return null;
  const [claim] = claims;
  if (byKey.get(claim.key)?.type !== ACCOUNT_TYPE.BROKERAGE) return null;
  if (!Array.isArray(claim.sleeves) || claim.sleeves.length !== 1) return null;
  return { key: claim.key, allocation: claim.sleeves[0] };
}

/** Classify each flow and validate what its executor requires. Mutates `flows` in place. */
function assignExecutors(pools, flows, byKey) {
  const byId = new Map(pools.map(p => [p.id, p]));
  for (const f of flows) {
    const from = byId.get(f.from), to = byId.get(f.to);
    f.executor = (isPortfolioPool(from, byKey) && isPortfolioPool(to, byKey))
      ? FLOW_EXECUTOR.REBALANCE
      : FLOW_EXECUTOR.TRANSFER;
    if (f.executor === FLOW_EXECUTOR.REBALANCE && f.amount.fractionOfSource != null) {
      // An in-portfolio edge is realised as a shift in the rebalancer's TARGET MIX, so both
      // ends must name exactly one ALLOCATION class — the same reason a `target` does.
      for (const [role, pool] of [['source', from], ['destination', to]]) {
        const classes = new Set(pool.claims.flatMap(c => c.sleeves ?? []));
        if (classes.size !== 1) {
          err(`flow '${f.id}' moves a fraction of '${pool.id}' inside the portfolio, but that `
            + `${role} pool claims ${classes.size} allocation classes. An in-portfolio move is a `
            + 'shift in the target mix, and across two classes there is no unique split.');
        }
      }
    }
    if (f.executor === FLOW_EXECUTOR.TRANSFER && !depositKeyFor(to, byKey) && !purchaseTargetFor(to, byKey)) {
      err(`flow '${f.id}' has to move CASH into '${f.to}', and that pool is neither of the two `
        + 'things a transfer can land in: it claims no cash-like (checking / savings / offset) '
        + 'account to DEPOSIT into, and it is not a single BROKERAGE account narrowed to a '
        + 'single sleeve to BUY into. Give it a cash-like claim, or narrow it to one brokerage '
        + 'sleeve — across two accounts or two sleeves there is no unique split for the money.');
    }
  }
}

/**
 * Validate and normalize an authored liquidity graph.
 *
 * @param {{pools?: Array, flows?: Array}|null} graph
 * @param {Array<{stateKey:string, type?:string, offsetsPropertyKey?:string}>} accounts
 * @param {{ drawdownMode?: string, hasDrawdownSequence?: boolean, hasLegacyPoolYears?: boolean,
 *   hasRebalancer?: boolean }} [opts] - `hasRebalancer` false ⇒ no TARGET_ALLOCATION, so nothing
 *   reads a pool target OR the legacy pool years and the §12.2 conflict cannot arise. Defaults
 *   to true: a caller that cannot see the strategy list gets the strict reading.
 * @returns {{pools: Array, flows: Array}|null} null when absent/empty
 */
export function normalizeLiquidityGraph(graph, accounts = [], opts = {}) {
  if (!graph || typeof graph !== 'object') return null;
  const rawPools = Array.isArray(graph.pools) ? graph.pools : [];
  if (rawPools.length === 0) return null;

  // ── The three "two authorities on one policy" errors (design 97 §12.7) ────────────
  if (opts.drawdownMode === 'PROPORTIONAL') {
    err('a graph cannot be combined with drawdownMode PROPORTIONAL: the graph compiles to an '
      + 'ORDERING and a pro-rata split is not one. Choose one.');
  }
  if (opts.hasDrawdownSequence) {
    err('a graph cannot be combined with an authored `drawdownSequence`: the graph COMPILES to '
      + 'that field (design 97 §12), so both is two authorities on one thing. Drop the sequence — '
      + 'give each pool a `spendOrder` instead.');
  }

  const byKey = new Map();
  for (const a of accounts) if (a?.stateKey) byKey.set(a.stateKey, a);

  const pools      = [];
  const ids        = new Set();
  // Global claim ledger: key → Set<sleeve> | true. Overlap ACROSS pools is the new error.
  const claimedAll = new Map();
  const targetedPools = [];
  const targetModeById = new Map();

  for (const raw of rawPools) {
    if (!raw || typeof raw !== 'object') err('every pool must be an object');
    const id = raw.id;
    if (!id || typeof id !== 'string') err('every pool needs a stable string `id` (flows, params and the editor key off it)');
    if (ids.has(id)) err(`duplicate pool id '${id}'`);
    ids.add(id);

    const claims = normalizeClaims(raw.claims, id, byKey);
    for (const { key, sleeves } of claims) {
      const prior = claimedAll.get(key);
      if (prior === true || (sleeves == null && prior)) {
        err(`pool '${id}' claims '${key}', which another pool already claims. Two pools claiming one `
          + 'sleeve would be double-counted by every target, trigger and cover figure in the feature.');
      }
      if (sleeves == null) claimedAll.set(key, true);
      else {
        const set = prior ?? new Set();
        for (const cls of sleeves) {
          if (set.has(cls)) {
            err(`pool '${id}' claims sleeve '${cls}' of '${key}', which another pool already claims`);
          }
          set.add(cls);
        }
        claimedAll.set(key, set);
      }
    }

    const target   = sizeSpec(raw.target,   `pool '${id}' target`,   TARGET_MODES,   POOL_TARGET_MODE.YEARS_OF_SPEND);
    const floor    = sizeSpec(raw.floor,    `pool '${id}' floor`,    TARGET_MODES,   POOL_TARGET_MODE.AMOUNT);
    const capacity = sizeSpec(raw.capacity, `pool '${id}' capacity`, CAPACITY_MODES, POOL_CAPACITY_MODE.BALANCE)
                  ?? { mode: POOL_CAPACITY_MODE.BALANCE };
    if (target) {
      targetedPools.push(id);
      targetModeById.set(id, target.mode);
      // A size target on a pool is realised by the rebalancer as a fraction of the book
      // allocated to that pool's ALLOCATION classes (design 97 §12.2, executor 1). Across
      // two classes there is no unique split, and inventing one (equal? by authored weight?)
      // would make "4 years of reserve" mean something the author never wrote.
      const classes = new Set(claims.flatMap(c => c.sleeves ?? []));
      if (classes.size > 1) {
        err(`pool '${id}' has a \`target\` but claims ${classes.size} allocation classes `
          + `(${[...classes].join(', ')}). A size target has no unique split across classes — `
          + 'give the pool one class, or drop the target and let it take the residual.');
      }
    }

    if (capacity.mode === POOL_CAPACITY_MODE.OFFSET_CAP) {
      // The cap is `min(balance, linked loan balance)` and the join runs offset → property →
      // loan. An account that is not an offset, or an offset linked to no property, would
      // silently fall back to its balance — i.e. the pool would look uncapped, which is the
      // exact illusion §6.3 exists to remove.
      const bad = claims.find(c => byKey.get(c.key)?.type !== ACCOUNT_TYPE.OFFSET);
      if (bad) err(`pool '${id}' uses capacity OFFSET_CAP but claims '${bad.key}', which is not an offset account`);
      const unlinked = claims.find(c => !byKey.get(c.key)?.offsetsPropertyKey);
      if (unlinked) err(`pool '${id}' uses capacity OFFSET_CAP but '${unlinked.key}' links to no property, so no loan can be found to cap it`);
    }

    const spendOrder = raw.spendOrder != null ? num(raw.spendOrder, `pool '${id}' spendOrder`) : null;

    pools.push({
      id,
      label: typeof raw.label === 'string' ? raw.label : id,
      claims,
      spendOrder,
      target,
      floor,
      capacity,
      // Opaque to the engine, preserved by the serializer — the editor (effort 2) needs a
      // place to keep layout and a second store would drift (design 97 §14).
      ...(raw.ui != null ? { ui: raw.ui } : {}),
    });
  }

  // §12.2b — a REMAINDER target's references, checked once every pool id is known. Done as a
  // whole-graph pass rather than inside `sizeSpec` for the same reason the claim-overlap check
  // is: the pool being referenced may not have been read yet when this one is normalized.
  for (const pool of pools) {
    if (pool.target?.mode !== POOL_TARGET_MODE.YEARS_OF_SPEND_REMAINDER) continue;
    for (const ref of pool.target.after) {
      if (ref === pool.id) {
        err(`pool '${pool.id}' names itself in its remainder target's \`after\`: its own size `
          + 'would be an input to itself.');
      }
      if (!ids.has(ref)) {
        err(`pool '${pool.id}' remainder target names '${ref}', which is not a pool in this graph. `
          + `Known pools: ${[...ids].map(x => `'${x}'`).join(', ')}`);
      }
      if (targetModeById.get(ref) === POOL_TARGET_MODE.YEARS_OF_SPEND_REMAINDER) {
        err(`pool '${pool.id}' remainder target names '${ref}', which is itself a remainder. `
          + 'Chaining them makes the resolution order decide the answer, and a graph is not an '
          + 'ordered list — give the referenced pool a target of its own, or reference what it '
          + 'references.');
      }
    }
  }

  // Two authorities on the rebalancer's target (design 97 §12.2) — but only when there IS a
  // rebalancer. Both values are read in exactly one place, TARGET_ALLOCATION's reducers, and
  // this validator runs in the toolset's state projection, which runs whatever strategies are
  // selected. Without that strategy neither value reaches anything, so throwing refused to
  // compile a config over two dead numbers. `hasRebalancer` defaults TRUE so a caller that
  // cannot know (a bare graph passed straight to the normalizer, the authoring UI) keeps the
  // strict reading; only `resolveLiquidityGraph`, which can see the strategy list, relaxes it.
  if (targetedPools.length > 0 && opts.hasLegacyPoolYears && opts.hasRebalancer !== false) {
    err('a pool `target` cannot be combined with `poolCashYears`/`poolBondYears`: both size the '
      + `rebalancer's target and one would silently win (design 97 §12.2). Pools carrying a `
      + `target: ${targetedPools.map(id => `'${id}'`).join(', ')}. The graph target is the `
      + 'successor, so either clear `poolCashYears`/`poolBondYears` and size these pools with '
      + 'their own `target`, or clear the `liquidityGraph` param to use the legacy pair. Note '
      + 'that DESELECTING the LIQUIDITY_POOLS strategy does not clear the graph — that strategy '
      + 'governs only the refill flows, while the graph itself still compiles to the drawdown '
      + 'order and still sizes the rebalancer.');
  }

  // ── flows ────────────────────────────────────────────────────────────────────────
  const rawFlows = Array.isArray(graph.flows) ? graph.flows : [];
  const flows    = [];
  const flowIds  = new Set();
  for (const raw of rawFlows) {
    if (!raw || typeof raw !== 'object') err('every flow must be an object');
    const id = raw.id;
    if (!id || typeof id !== 'string') err('every flow needs a stable string `id`');
    if (flowIds.has(id)) err(`duplicate flow id '${id}'`);
    flowIds.add(id);
    const { from, to } = raw;
    if (!ids.has(from)) err(`flow '${id}' names unknown source pool '${from}'. Known pools: ${[...ids].join(', ')}`);
    if (!ids.has(to))   err(`flow '${id}' names unknown destination pool '${to}'. Known pools: ${[...ids].join(', ')}`);
    if (from === to)    err(`flow '${id}' is a self-edge on '${from}'`);
    const cadence = raw.cadence ?? FLOW_CADENCE.PERIOD;
    if (!Object.values(FLOW_CADENCE).includes(cadence)) {
      err(`flow '${id}' has unknown cadence '${cadence}'. Valid: ${Object.values(FLOW_CADENCE).join(', ')}`);
    }
    flows.push({
      id, from, to,
      priority: raw.priority != null ? num(raw.priority, `flow '${id}' priority`) : 0,
      trigger:  normalizeTrigger(raw.trigger, id),
      gate:     normalizeGate(raw.gate, id),
      amount:   normalizeAmount(raw.amount, id),
      cadence,
      ...(raw.ui != null ? { ui: raw.ui } : {}),
    });
  }
  assertNoUnconditionalCycle(flows);
  assignExecutors(pools, flows, byKey);

  warnMarketClausesWithoutAMarket(pools, flows, byKey);
  warnUntradeableRebalanceFlows(pools, flows, byKey);
  warnDivergentGatesFromOneSource(flows);

  // A destination with no target can never be filled `toTarget` — it would move zero every
  // period, which reads in the journal as "the refill is broken" rather than "the pool has
  // no size". Caught here because it is exactly the believable-wrong-config class.
  const targetById = new Map(pools.map(p => [p.id, p.target]));
  for (const f of flows) {
    if (f.amount.toTarget && !targetById.get(f.to)) {
      err(`flow '${f.id}' fills '${f.to}' to its target, but '${f.to}' has no \`target\` — it would `
        + 'move nothing, every period. Give the pool a target or give the flow an `amount.fractionOfSource`.');
    }
  }

  return { pools, flows };
}

/**
 * Design 97 §20.18 — a market clause on a pool that HAS no market.
 *
 * Four clauses read a market signal: the RETURN pair reads `poolMarketReturn`, and the
 * drawdown pair reads the return INDEX that compounds from it. Both are computed off the
 * lots the pool's claims hold, so on a pool that claims only cash-like accounts there is
 * nothing to read — `poolMarketReturn` returns null, the index never compounds off 1.0, its
 * high stays 1.0, and the drawdown is 0.0 forever.
 *
 * That is not an error: "no signal is not bad signal" is the absent-reading rule the gate
 * vocabulary is built on (POOL-12b), and each clause has a documented default for it. What
 * makes it worth a warning is that the default is a CONSTANT — `sourceDrawdownUnder` on such
 * a pool is always true, and under a `not` it is always FALSE. A permanently shut edge
 * validates, loads, runs, and reports itself as gated in every period of the run, which
 * reads as a gate that is working. Measured on a real plan: an edge whose whole purpose was
 * to fund spending in a crash fired 0 times in 35 years.
 *
 * Warning and not `err`, for §12.2's reason: it is a plausible authoring (the BALANCE basis
 * on the same pool is perfectly meaningful — a balance is a series a cash pool really has),
 * just almost never the intended one.
 */
function warnMarketClausesWithoutAMarket(pools, flows, byKey) {
  // A pool has a market iff some claim can hold LOTS. Cash-like accounts hold none; anything
  // else — brokerage, and every wrapper — does, so an unknown type is left alone.
  const hasMarket = new Map(pools.map(p =>
    [p.id, p.claims.some(c => !CASH_LIKE_TYPES.has(byKey.get(c.key)?.type))]));
  const cashClaims = new Map(pools.map(p => [p.id, p.claims.map(c => c.key).join(', ')]));

  const visit = (node, flow, path, negated) => {
    if (!node) return;
    for (const [clause, role] of [['sourceDrawdownUnder', 'from'], ['targetDrawdownOver', 'to'],
                                 ['sourceReturnOver',     'from'], ['targetReturnUnder',   'to']]) {
      if (node[clause] == null) continue;
      // The BALANCE basis reads the pool's own balance, which a cash pool really has. Only
      // the INDEX basis (and the return pair, which has no basis to choose) needs lots.
      const needsLots = clause.includes('Return') || node.drawdownBasis === POOL_DRAWDOWN_BASIS.INDEX;
      const poolId = flow[role];
      if (!needsLots || hasMarket.get(poolId)) continue;
      // Each clause's own absent-reading default (POOL-12b): the two SOURCE clauses stay
      // open on no signal, the two DESTINATION clauses stay shut. A `not` above flips it.
      const base   = clause.startsWith('source');
      const always = negated ? !base : base;
      console.warn(
        `liquidityGraph: flow '${flow.id}' ${path}.${clause} reads a market signal on pool `
        + `'${poolId}', which claims only cash-like accounts (${cashClaims.get(poolId)}). They hold `
        + 'no lots, so its return is null and its return index never moves off its high — the '
        + `clause is therefore ALWAYS ${always ? 'TRUE' : 'FALSE'} and the gate decides nothing. `
        + 'Measure the pool that has the market, or use `drawdownBasis: BALANCE`, which reads a '
        + 'series a cash pool really has.');
    }
    for (const key of ['allOf', 'anyOf']) {
      (node[key] ?? []).forEach((kid, i) => visit(kid, flow, `${path}.${key}[${i}]`, negated));
    }
    if (node.not) visit(node.not, flow, `${path}.not`, !negated);
  };
  for (const flow of flows) visit(flow.gate, flow, 'gate', false);
}

/**
 * Design 97 §20.19 — an in-portfolio refill whose ends the rebalancer cannot trade.
 *
 * An edge with a brokerage at both ends is realised by `RebalanceToTargetReducer`
 * (`assignExecutors` stamps `executor: REBALANCE`), and that reducer only ever sees accounts
 * whose ROLE is tax-advantaged or taxable. `fixed-income` and `au-fixed-income` are in
 * neither set, so an edge into or out of a pool claiming one of them validates, saves, and
 * moves nothing — for ever, and silently, because a REBALANCE edge emits no action of its own
 * and so cannot even report a firing that did not happen (§12.4).
 *
 * Warned, not thrown, for the same reason as §20.18: claiming such an account is a perfectly
 * good thing to do — the pool is still a spend source and still reports cover — it is only
 * the REFILL that cannot work.
 *
 * Skipped entirely when the caller supplied no roles (several call sites pass
 * `{stateKey, type}` projections): an absent role is not evidence of an untradeable one.
 */
/**
 * Two edges out of ONE source pool carrying DIFFERENT gate thresholds (design 97 §12.4b).
 *
 * A gate reads as a property of its edge. It is not: the veto it produces names the SOURCE
 * POOL, and it has to, or the laundering hole this whole reducer exists to close reopens —
 * with `growth → offset` gated shut, a rebalancer still free to sell EQUITY to hit a BOND
 * target moves the same money out of growth by a second route. So the veto covers every route
 * out of the pool, and **the tightest gate on any edge out of a source is that source's
 * effective gate**. The looser one is unreachable.
 *
 * Warned, not thrown, because it is a legal graph and the behaviour is correct — it is the
 * AUTHORING that is not what it looks like. And the failure is silent and severe: the looser
 * threshold never fires, nothing records that it did not, and when the veto binds
 * `_applyVeto`'s `floorSum` can reach 1, which sends the unvetoed classes to ZERO rather than
 * shrinking them. On the reference plan that turned an authored 4-year bond reserve into no
 * bond target at all, for years, while the pool cube went on reporting the target it wanted.
 *
 * Compared on the SHAPE of the gate, not on a single number: a gate is a composed tree
 * (§20.15) and two edges may differ in clause kind, basis or dwell as easily as in threshold.
 * Any difference has the same consequence, so any difference is worth saying.
 */
function warnDivergentGatesFromOneSource(flows) {
  const bySource = new Map();
  for (const flow of flows) {
    if (!flow.gate) continue;
    if (!bySource.has(flow.from)) bySource.set(flow.from, []);
    bySource.get(flow.from).push(flow);
  }
  for (const [source, edges] of bySource) {
    // §12.4c — only SOURCE-scoped gates can silently govern one another. Two EDGE-scoped
    // gates out of one source are independent by construction, and warning about them would
    // train the author to ignore the message in the case that still matters. A MIXED set is
    // still warned: the SOURCE-scoped one governs the source, which is exactly the surprise.
    // Silent only when NO edge out of this source is SOURCE-scoped. One SOURCE-scoped gate is
    // enough to govern the whole pool, so a MIXED set is the case that most needs saying: the
    // author who sets one edge to EDGE believing it is now independent still has the other
    // edge flooring the source. Measured on the reference plan — buffer EDGE 0.40 beside
    // offset SOURCE 0.10 is byte-identical to both-at-SOURCE-0.10 ($6,930k, buffer $0k).
    const sourceScoped = edges.filter(f => (f.gate?.scope ?? POOL_GATE_SCOPE.SOURCE) === POOL_GATE_SCOPE.SOURCE);
    if (sourceScoped.length === 0 || edges.length < 2) continue;
    const shapes = new Set(edges.map(f => JSON.stringify(f.gate)));
    if (shapes.size < 2) continue;
    console.warn(
      `liquidityGraph: pool '${source}' is the source of ${edges.length} gated edges `
      + `(${edges.map(f => `'${f.id}'`).join(', ')}) whose gates DIFFER. A gate vetoes the sale `
      + `of its SOURCE POOL — it must, or the rebalancer launders the same sale through another `
      + `route — so the TIGHTEST of these governs the VETO and a looser one cannot reach the `
      + `rebalancer. (Each edge still FIRES on its own gate, which is why a cross-account `
      + `transfer edge is not fully suppressed; an in-portfolio one is — §12.4c.) `
      + `Give the edges one gate, set \`gate.scope: 'EDGE'\` so each vetoes its own destination, `
      + `or move them onto separate source pools with disjoint claims.`);
  }
}

function warnUntradeableRebalanceFlows(pools, flows, byKey) {
  const anyRole = [...byKey.values()].some(a => a?.role != null);
  if (!anyRole) return;
  const tradeable = (key) => {
    const role = byKey.get(key)?.role;
    return role == null || TAX_ADVANTAGED_ROLES.has(role) || TAXABLE_ROLES.has(role);
  };
  const byId = new Map(pools.map(p => [p.id, p]));
  for (const flow of flows) {
    if (flow.executor !== FLOW_EXECUTOR.REBALANCE) continue;
    for (const [role, poolId] of [['source', flow.from], ['destination', flow.to]]) {
      const blocked = (byId.get(poolId)?.claims ?? []).filter(c => !tradeable(c.key));
      if (!blocked.length) continue;
      console.warn(
        `liquidityGraph: flow '${flow.id}' is an in-portfolio (REBALANCE) edge, but its `
        + `${role} pool '${poolId}' claims ${blocked.map(c => `'${c.key}'`).join(', ')}, whose `
        + 'role the rebalancer does not trade — only tax-advantaged and taxable-brokerage roles '
        + `are in its account list. The edge will never move anything. Claim a us-stock / `
        + 'au-stock brokerage sleeve instead, or drop the flow and let the pool be a spend '
        + 'source only.');
    }
  }
}

/**
 * Design 97 §12 — flatten the graph's pools into the `state.drawdownSequence` §3 consumes.
 *
 * Pools with a `spendOrder` are emitted in that order (ties by declaration order, so the
 * authored list is the tie-break and the result is stable); a pool without one is NOT a
 * spend source and contributes nothing. A multi-account pool becomes several ADJACENT
 * entries — nothing downstream needs to know they were one pool.
 *
 * Returns null when no pool is a spend source, so the compiled state field stays absent and
 * the drawdownPriority walk runs untouched (the §3.1 non-negotiable).
 */
export function compileToDrawdownSequence(graph) {
  const pools = graph?.pools;
  if (!Array.isArray(pools)) return null;
  const spend = pools
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.spendOrder != null)
    .sort((a, b) => (a.p.spendOrder - b.p.spendOrder) || (a.i - b.i));
  const out = [];
  for (const { p } of spend) {
    for (const { key, sleeves } of p.claims) out.push({ key, sleeves: sleeves ?? null });
  }
  return out.length ? out : null;
}

/** The pool ids a given ALLOCATION class is claimed by, for the rebalancer's one-authority rule. */
export function poolsClaimingClass(graph, cls) {
  return (graph?.pools ?? []).filter(p => p.claims.some(c => c.sleeves?.includes(cls))).map(p => p.id);
}

/**
 * The ONE place a scenario's `liquidityGraph` param becomes a normalized graph.
 *
 * Three sites need it — the toolset's state projection, the flow reducers, and the
 * rebalancer acting as executor 1 — and normalizing it three times with three slightly
 * different option sets is how the same object comes to mean three things. Every caller
 * goes through here.
 *
 * @param {object} params    - the scenario parameter bag
 * @param {Array}  accounts  - context.accounts
 * @returns {{pools:Array, flows:Array}|null}
 */
function hasTargetAllocation(p) {
  const sel = p?.behavioralStrategies;
  // Absent is NOT "no strategies" — a params bag that never mentions the field (a test, a
  // partial config) must keep the strict reading rather than silently lose the guard.
  if (!Array.isArray(sel)) return true;
  return sel.includes('TARGET_ALLOCATION');
}

export function resolveLiquidityGraph(params, accounts = []) {
  const p = params ?? {};
  // §12.5 — the master switch. Checked HERE, in front of the normalizer, because this
  // function is the one thing all three consumers share: the toolset's state projection
  // (which compiles the spend order), TARGET_ALLOCATION's rebalancer (which reads pool
  // targets and gates) and LIQUIDITY_POOLS' flow reducers. A null from here makes every
  // design-97 line inert at once, which is what deselecting the strategy looks like it
  // does and does not. Absent is ON, so an existing scenario is byte-identical.
  if (p.liquidityGraphEnabled === false) return null;
  return _normalizeFromParams(p, accounts);
}

/**
 * The normalizer call with the option set derived from a params bag — the half of
 * {@link resolveLiquidityGraph} that is NOT subject to the master switch.
 *
 * Split out for `collectAuthoredGraphProblems`: the authoring UI has to keep reporting a
 * bad row while the graph is switched off, or the switch becomes a way to hide errors and
 * the editor goes quiet on a graph that will not compile the moment it is switched back on.
 * @private
 */
function _normalizeFromParams(p, accounts) {
  return normalizeLiquidityGraph(p.liquidityGraph, accounts, {
    drawdownMode:        p.drawdownMode,
    hasDrawdownSequence: Array.isArray(p.drawdownSequence) && p.drawdownSequence.length > 0,
    hasLegacyPoolYears:  Number.isFinite(p.poolCashYears) || Number.isFinite(p.poolBondYears),
    // Only TARGET_ALLOCATION's reducers read a pool target or the legacy pool years, so with
    // it deselected the §12.2 "two authorities" conflict has no reader and is not a conflict.
    hasRebalancer:       hasTargetAllocation(p),
  });
}

/**
 * The same rules as {@link normalizeLiquidityGraph}, reported instead of thrown — and
 * localized to the FIELD that carries the problem.
 *
 * `collectAuthoredMixProblems` is the model (design 61 §12.2 Q3): the authoring UI needs
 * every problem at once keyed to the row that carries it, and the boot-time recovery
 * surface needs to identify the bad value without parsing an error string. A pool's
 * `target`/`floor`/`capacity` are each re-validated through the SAME `sizeSpec` the
 * compiler runs, so the two can never drift — a percent authored as 100 is reported here
 * by exactly the sentence `normalizeLiquidityGraph` would have thrown.
 *
 * Field-local problems are reported alone: once a size spec is known bad the whole-graph
 * pass would only re-report it, unlocalized. When there is none, the whole-graph pass runs
 * and its first throw is reported with `field: null` — still nameable ("this graph does not
 * compile"), just not repairable a cell at a time.
 *
 * @param {object} params   - the scenario parameter bag
 * @param {Array}  accounts - the accounts the claims name; the whole-graph pass is SKIPPED
 *        when this is empty, because every claim would then read as naming a dead account
 * @returns {Array<{param: string, index: number|null, field: string|null, pool: string|null,
 *                  message: string}>} empty when valid
 */
export function collectAuthoredGraphProblems(params, accounts = []) {
  const p = params ?? {};
  const graph = p.liquidityGraph;
  if (!graph || typeof graph !== 'object') return [];
  const rawPools = Array.isArray(graph.pools) ? graph.pools : [];
  if (rawPools.length === 0) return [];

  const problems = [];
  const specs = [
    ['target',   TARGET_MODES,   POOL_TARGET_MODE.YEARS_OF_SPEND],
    ['floor',    TARGET_MODES,   POOL_TARGET_MODE.AMOUNT],
    ['capacity', CAPACITY_MODES, POOL_CAPACITY_MODE.BALANCE],
  ];
  rawPools.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : `#${index}`;
    for (const [field, allowed, defaultMode] of specs) {
      try {
        sizeSpec(raw[field], `pool '${id}' ${field}`, allowed, defaultMode);
      } catch (e) {
        problems.push({ param: 'liquidityGraph', index, field, pool: raw.id ?? null, message: e.message });
      }
    }
  });
  if (problems.length) return problems;

  if (!accounts?.length) return problems;
  try {
    // NOT `resolveLiquidityGraph` — see `_normalizeFromParams`. A graph switched off with
    // `liquidityGraphEnabled: false` still has to report its problems, because the switch
    // is a run-time "ignore this", not an authoring-time "this is fine".
    _normalizeFromParams(p, accounts);
  } catch (e) {
    problems.push({ param: 'liquidityGraph', index: null, field: null, pool: null, message: e.message });
  }
  return problems;
}
