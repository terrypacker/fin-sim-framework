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

const VALID_SLEEVES  = new Set(DRAWDOWN_SLEEVE_CLASSES);
const TARGET_MODES   = new Set(Object.values(POOL_TARGET_MODE));
const CAPACITY_MODES = new Set(Object.values(POOL_CAPACITY_MODE));
const SPEND_BASES    = new Set(Object.values(POOL_SPEND_BASIS));

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
  if (mode === POOL_TARGET_MODE.YEARS_OF_SPEND || mode === POOL_CAPACITY_MODE.YEARS_OF_SPEND) {
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

/** Normalize a flow's `gate` (design 97 §12.3). Absent ⇒ null ⇒ always open. */
function normalizeGate(raw, flowId) {
  if (raw == null) return null;
  if (typeof raw !== 'object') err(`flow '${flowId}' gate must be an object`);
  const out = {};
  if (raw.sourceDrawdownUnder != null) out.sourceDrawdownUnder = num(raw.sourceDrawdownUnder, `flow '${flowId}' gate.sourceDrawdownUnder`, { min: 0, max: 1 });
  if (raw.targetDrawdownOver  != null) out.targetDrawdownOver  = num(raw.targetDrawdownOver,  `flow '${flowId}' gate.targetDrawdownOver`,  { min: 0, max: 1 });
  // The market-state pair. Prefer these to the drawdown pair in a DECUMULATION plan: a
  // trailing-high gate cannot tell a falling market from a pool being spent down, and latches
  // shut after the first crash (see `poolMarketReturn`).
  if (raw.sourceReturnOver  != null) out.sourceReturnOver  = num(raw.sourceReturnOver,  `flow '${flowId}' gate.sourceReturnOver`,  { min: -1, max: 1 });
  if (raw.targetReturnUnder != null) out.targetReturnUnder = num(raw.targetReturnUnder, `flow '${flowId}' gate.targetReturnUnder`, { min: -1, max: 1 });
  if (raw.notInRegime != null) {
    const tags = Array.isArray(raw.notInRegime) ? raw.notInRegime : [raw.notInRegime];
    if (!tags.length) err(`flow '${flowId}' gate.notInRegime is empty; omit it`);
    out.notInRegime = tags.map(String);
  }
  for (const k of ['notBefore', 'notAfter']) {
    if (raw[k] == null) continue;
    const t = new Date(raw[k]).getTime();
    if (Number.isNaN(t)) err(`flow '${flowId}' gate.${k} is not a date: ${JSON.stringify(raw[k])}`);
    out[k] = new Date(t).toISOString().slice(0, 10);
  }
  if (raw.ageOver  != null) out.ageOver  = num(raw.ageOver,  `flow '${flowId}' gate.ageOver`,  { min: 0, max: 120 });
  if (raw.ageUnder != null) out.ageUnder = num(raw.ageUnder, `flow '${flowId}' gate.ageUnder`, { min: 0, max: 120 });
  return Object.keys(out).length ? out : null;
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
    if (f.executor === FLOW_EXECUTOR.TRANSFER && !depositKeyFor(to, byKey)) {
      err(`flow '${f.id}' has to move CASH into '${f.to}', but that pool claims no cash-like `
        + '(checking / savings / offset) account. Moving value into a holdings sleeve is a '
        + 'PURCHASE, which only the rebalancer can do — and it can only do it when BOTH ends '
        + 'of the flow are brokerage accounts.');
    }
  }
}

/**
 * Validate and normalize an authored liquidity graph.
 *
 * @param {{pools?: Array, flows?: Array}|null} graph
 * @param {Array<{stateKey:string, type?:string, offsetsPropertyKey?:string}>} accounts
 * @param {{ drawdownMode?: string, hasDrawdownSequence?: boolean, hasLegacyPoolYears?: boolean }} [opts]
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
  let anyTarget = false;

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
      anyTarget = true;
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

  if (anyTarget && opts.hasLegacyPoolYears) {
    err('a pool `target` cannot be combined with `poolCashYears`/`poolBondYears`: both size the '
      + 'rebalancer\'s target and one would silently win (design 97 §12.2). The graph target is '
      + 'the successor — drop the legacy params.');
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
export function resolveLiquidityGraph(params, accounts = []) {
  const p = params ?? {};
  return normalizeLiquidityGraph(p.liquidityGraph, accounts, {
    drawdownMode:        p.drawdownMode,
    hasDrawdownSequence: Array.isArray(p.drawdownSequence) && p.drawdownSequence.length > 0,
    hasLegacyPoolYears:  Number.isFinite(p.poolCashYears) || Number.isFinite(p.poolBondYears),
  });
}
