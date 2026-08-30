/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * pool-graph.mjs — a `liquidityGraph` from a small spec (design 97 §18.3, step 2).
 *
 * A pool study sweeps POOL SHAPES, and design 97 §16.2 says how: `liquidityGraph` is an
 * ordinary object param, so a whole graph is an arm value the way `allocationGlidepath`
 * takes whole anchor arrays. What §16.2 does not supply is a way to WRITE thirty of them.
 * Hand-authored, a size grid is thirty near-identical JSON documents that drift from each
 * other in exactly the ways nobody notices — a sleeve dropped from one arm, a flow left
 * behind in another — and the study then measures the drift.
 *
 * So the shape is a FUNCTION of the plan's own accounts plus four or five numbers, and the
 * arms are points in that function's domain. Any hand-authored graph must be reproducible
 * from a spec; if it is not, either the spec vocabulary is missing something or the authored
 * graph says something it did not mean to.
 *
 * ── The rule this file exists to enforce ────────────────────────────────────────────
 *
 * **Every drawdown sleeve of every account the graph touches is claimed by exactly one
 * pool.** Design 97 §3.1 states the consequence of not doing it: what a sequence does not
 * claim keeps its ordinary `drawdownPriority`, so an unlisted equity sleeve can be reached
 * AHEAD of a lower-priority pool — "the arm would still run, and would quietly not be the
 * arm". A generator can make that structural instead of a warning in a comment, and this one
 * does: unclaimed classes fall to the last pool in the spend order, and a shape where that
 * would be wrong throws here rather than producing a plausible graph.
 *
 * ── What it deliberately does not generate ──────────────────────────────────────────
 *
 * **The reverse "buy the dip" edge.** It is not on the study's axis (§18.3), and §16.1(2)
 * makes it a genuinely different object: a dip edge must be IN-PORTFOLIO with exactly one
 * allocation class at each end, so it cannot be added to a `growth` pool that holds EQUITY
 * and GOLD together. Generating it would mean reshaping the pools around an edge the study
 * is not sweeping.
 *
 * **Anything that reads the study's own scenario.** The generator takes a cfg and knows only
 * about account TYPES, so it lives here, in source control, with tests — while the arms that
 * use it live with the study.
 */

/** The pool kinds a spec's `order` is written in. The order IS the spend order. */
export const POOL_KIND = Object.freeze({
  /** Bucket 1 — every cash-like account, plus the settled CASH sleeve of each brokerage. */
  CASH:   'cash',
  /** Bucket 2 — the BOND sleeves. The reserve. */
  BUFFER: 'buffer',
  /** The offset facility, as its own node (its capacity is not its balance — §12.1). */
  OFFSET: 'offset',
  /** Bucket 3 — growth. Takes every class no earlier pool claimed. */
  GROWTH: 'growth',
  /**
   * The age-gated wrappers (IRA / 401k / Roth / super), claimed whole.
   *
   * Exists so a study can put them somewhere ON PURPOSE. Omitted from the order they are not
   * merely last — §3.1 rule 3 draws unclaimed accounts after every pool, and a plan whose
   * pools never run dry never reaches them at all, so a partial graph silently authors "never
   * touch the retirement accounts" (design 97 §18.6 rule 4).
   *
   * Claimed WHOLE, never sleeve-narrowed: sleeves only mean something where the draw runs
   * through `consumeHoldings`, which is a BROKERAGE-only path (§3.1). Placing this pool
   * therefore changes the draw ORDER and nothing else — no target, no capacity rule, no effect
   * on the rebalancer's mix — which is what makes it a clean axis.
   *
   * Placing it FIRST does not force early withdrawals: the sequence governs the penalty-free
   * Phase 1 walk only (§3.1 rule 5), so before the age gate the pool is simply skipped. "First"
   * means "spend them as soon as they are accessible".
   */
  WRAPPERS: 'wrappers',
});

/** Refill topologies. `NONE` authors the pools without the cascade. */
export const REFILL = Object.freeze({
  /** No flows at all. The graph is then a spend ORDER plus sizing. */
  NONE: 'NONE',
  /** buffer → cash, offset → cash (tried second), growth → buffer, ungated. */
  CASCADE: 'CASCADE',
  /** The cascade, with the harvest gate on growth → buffer: sell growth only in an up market. */
  CASCADE_HARVEST: 'CASCADE_HARVEST',
});

const CASH_LIKE   = new Set(['checking', 'savings']);
const WRAPPER_TYPES = new Set(['ira', '401k', 'roth', 'super']);

/**
 * A cfg's accounts come in two shapes and only one of them carries `type`.
 *
 * `ScenarioSerializer` writes both a `__type` class discriminator and a `type` string, so a
 * workbench export has both; `IntlRetirementScenario.buildDefaultConfig()` builds plain
 * objects with `__type` alone. Reading only `type` — which is what the first hand-written
 * study helper did — silently classifies EVERY account as "none of the above" against a
 * synthetic base, and the generator then reports a plan with no accounts.
 */
const CLASS_TO_TYPE = Object.freeze({
  CheckingAccount: 'checking',
  SavingsAccount:  'savings',
  BrokerageAccount: 'brokerage',
  OffsetAccount:   'offset',
  FourOhOneKAccount: '401k',
  RothAccount:     'roth',
  TraditionalIRAAccount: 'ira',
  SuperannuationAccount: 'super',
  LoanAccount:     'loan',
});

/** The account's type, from either shape. Null when the cfg says nothing. */
export function accountType(a) {
  return a?.type ?? CLASS_TO_TYPE[a?.__type] ?? null;
}
const ALL_SLEEVES = ['CASH', 'BOND', 'EQUITY', 'GOLD'];

/** The classes each kind claims BEFORE the residual rule runs. */
const KIND_SLEEVES = {
  [POOL_KIND.CASH]:   ['CASH'],
  [POOL_KIND.BUFFER]: ['BOND'],
  [POOL_KIND.GROWTH]: ['EQUITY', 'GOLD'],
  [POOL_KIND.OFFSET]: [],
  [POOL_KIND.WRAPPERS]: [],
};

/** Kinds whose claims run through `consumeHoldings`, and so can carry a sleeve narrowing. */
const SLEEVE_CAPABLE = new Set([POOL_KIND.CASH, POOL_KIND.BUFFER, POOL_KIND.GROWTH]);

const LABELS = {
  [POOL_KIND.CASH]:   'Bucket 1 — cash',
  [POOL_KIND.BUFFER]: 'Bucket 2 — the reserve',
  [POOL_KIND.OFFSET]: 'The backstop — offset facility',
  [POOL_KIND.GROWTH]: 'Bucket 3 — growth',
  [POOL_KIND.WRAPPERS]: 'The age-gated wrappers',
};

const fail = (msg) => { throw new Error(`buildPoolGraph: ${msg}`); };

/**
 * The accounts of the plan, split by the role a pool spec cares about.
 *
 * `exclude` drops accounts from the pools entirely — for a book the household does not fund
 * spending from (an inherited account being run down on its own schedule, a spouse's separate
 * book). Excluding is not the same as omitting: an excluded account keeps its own
 * `drawdownPriority` and is therefore drawn AFTER every pool (§3.1 rule 3), which is the
 * meaning of "not part of the plan's liquidity" — but it IS still spendable, so a study
 * excluding an account must say so, not assume it was ring-fenced.
 */
export function classifyAccounts(cfg, exclude = []) {
  const skip = new Set(exclude);
  const cash = [], brokerage = [], offset = [], wrappers = [];
  const all = cfg?.accounts ?? [];
  // An untyped account list is a cfg-shape problem, not a plan with no accounts, and the two
  // produce the same downstream symptom (every pool empty). Say which it is.
  if (all.length && !all.some(a => accountType(a))) {
    fail(`none of the ${all.length} accounts carry a \`type\` or a known \`__type\` — this cfg `
      + 'is not in a shape the generator can classify.');
  }
  for (const a of all) {
    if (!a?.stateKey || skip.has(a.stateKey)) continue;
    const type = accountType(a);
    if (type === 'offset')            offset.push(a);
    else if (type === 'brokerage')    brokerage.push(a);
    else if (CASH_LIKE.has(type))     cash.push(a);
    else if (WRAPPER_TYPES.has(type)) wrappers.push(a);
    // Loans and anything else stay unclaimed. Note that "unclaimed" is NOT a mild statement:
    // §3.1 rule 3 draws such an account after every pool, and a plan whose pools never run dry
    // never reaches it. That is why the wrappers get a kind of their own rather than being
    // left to the remainder — see POOL_KIND.WRAPPERS.
  }
  return { cash, brokerage, offset, wrappers };
}

/**
 * Build a `liquidityGraph` for one arm.
 *
 * @param {object} cfg   the scenario config — read for `accounts` only
 * @param {object} spec
 * @param {string[]} spec.order   pool kinds in SPEND order. `[]` ⇒ null (the pool-less arm)
 * @param {?number} [spec.cashYears]  YEARS_OF_SPEND target for the cash pool; null ⇒ no target
 * @param {?number} [spec.bondYears]  YEARS_OF_SPEND target for the buffer; null ⇒ no target
 * @param {string} [spec.refill=NONE] one of REFILL
 * @param {number} [spec.refillTriggerYears=0.5]  the `s` of the (s, S) band: cash is refilled
 *        once it falls below this many years of spending, and filled back to its target (`S`).
 *        Two numbers on purpose — conflating them is what makes a drift band churn (§12.3).
 * @param {string[]} [spec.exclude]  account stateKeys to leave out of the pools entirely.
 *        They keep their `drawdownPriority` and are drawn AFTER every pool — see
 *        `classifyAccounts`. Use for a book the household does not fund spending from.
 * @param {number} [spec.harvestGate=0]  `gate.sourceReturnOver` on growth → buffer under
 *        CASCADE_HARVEST. 0 is the bucket literature's rule exactly: harvest in up markets,
 *        pause equity sales in a falling one. Note §16.1b: this is the RETURN gate, not the
 *        trailing-high one, which latches shut forever in a decumulation plan.
 * @returns {?object} `{ pools, flows }`, or null for the pool-less arm
 */
export function buildPoolGraph(cfg, spec = {}) {
  const order = spec.order ?? [];
  if (!Array.isArray(order)) fail('`order` must be an array of pool kinds');
  // The pool-less arm is a POINT IN THE SAME SPACE, not a different code path: `null` leaves
  // `drawdownPriority` running untouched, which is §3.1's non-negotiable identity property.
  if (order.length === 0) return null;

  for (const kind of order) {
    if (!Object.values(POOL_KIND).includes(kind)) {
      fail(`unknown pool kind '${kind}'. Valid: ${Object.values(POOL_KIND).join(', ')}`);
    }
  }
  if (new Set(order).size !== order.length) fail(`\`order\` repeats a kind: ${order.join(', ')}`);

  const { cash, brokerage, offset, wrappers } = classifyAccounts(cfg, spec.exclude ?? []);

  // A graph that names no cash pool leaves the savings accounts unclaimed — and unclaimed
  // means AFTER the whole sequence (§3.1 rule 3), so the plan would sell the brokerage while
  // holding cash. That is never the intended reading of "no cash bucket", so it throws.
  if (!order.includes(POOL_KIND.CASH) && cash.length) {
    fail(`the plan has ${cash.length} cash-like account(s) but \`order\` names no '${POOL_KIND.CASH}' pool. `
      + 'Unclaimed accounts are drawn AFTER every pool, so the plan would sell investments while '
      + 'holding cash. Include the cash pool, or remove the accounts from the plan.');
  }

  // ── the residual rule ────────────────────────────────────────────────────────────
  // Classes no named kind claims fall to the LAST pool in the spend order. This is §3.1's
  // "list every sleeve" made structural: a sleeve that reaches no pool keeps its own
  // drawdownPriority and can be spent ahead of a pool that was supposed to come first.
  const claimedClasses = new Set(order.flatMap(k => KIND_SLEEVES[k]));
  const residual = ALL_SLEEVES.filter(c => !claimedClasses.has(c));
  // The residual lands on the last SLEEVE-CAPABLE pool, not simply the last one: sleeves only
  // mean something on a brokerage draw (§3.1), so handing them to an offset or wrapper pool
  // would be rejected by the normalizer — and rejected with a message about a claim the author
  // never wrote.
  const residualKind = [...order].reverse().find(k => SLEEVE_CAPABLE.has(k)) ?? null;
  if (residual.length && !residualKind) {
    fail(`\`order\` names no pool that can hold ${residual.join(', ')} — a sleeve narrowing only `
      + 'means something on a brokerage draw, so at least one of cash / buffer / growth must be present.');
  }
  const sleevesFor = (kind) => (kind === residualKind ? [...KIND_SLEEVES[kind], ...residual] : KIND_SLEEVES[kind]);

  const targetYears = {
    [POOL_KIND.CASH]:   spec.cashYears,
    [POOL_KIND.BUFFER]: spec.bondYears,
  };

  const pools = [];
  for (const [i, kind] of order.entries()) {
    const sleeves = sleevesFor(kind);
    const years   = targetYears[kind];
    const target  = years != null ? { mode: 'YEARS_OF_SPEND', value: years } : null;

    // A size target has no unique split across two allocation classes (§12.2), so the
    // normalizer rejects it. Catch it HERE, where the message can name the spec field the
    // author actually wrote instead of the generated pool it turned into.
    if (target && sleeves.length > 1) {
      fail(`pool '${kind}' has a target (${years} years) but would claim ${sleeves.join(', ')} — `
        + `a size target has no unique split across classes. It is the LAST pool in \`order\` that `
        + `can hold sleeves, so it absorbed the unclaimed ${residual.join(', ')}; put an untargeted `
        + 'pool (growth) after it, or drop the target.');
    }

    const claims = [];
    if (kind === POOL_KIND.CASH)     for (const a of cash)     claims.push({ key: a.stateKey });
    if (kind === POOL_KIND.OFFSET)   for (const a of offset)   claims.push({ key: a.stateKey });
    if (kind === POOL_KIND.WRAPPERS) for (const a of wrappers) claims.push({ key: a.stateKey });
    if (sleeves.length) for (const a of brokerage) claims.push({ key: a.stateKey, sleeves: [...sleeves] });

    // A pool with no claims is legal in the engine (§15 Q5 — it reports zero and is skipped),
    // but from a GENERATOR it means the spec asked for something the plan cannot express, and
    // a silently empty reserve is the failure this whole design keeps re-finding.
    if (!claims.length) {
      fail(`pool '${kind}' would claim nothing — the plan has no account it can draw on `
        + `(cash ${cash.length}, brokerage ${brokerage.length}, offset ${offset.length}, `
        + `wrappers ${wrappers.length}).`);
    }

    const pool = { id: kind, label: LABELS[kind], spendOrder: (i + 1) * 10, claims };
    if (target) pool.target = target;
    // OFFSET_CAP only where the join it needs exists: min(balance, LINKED LOAN balance).
    // Without a linked property the normalizer throws, and rightly — an offset that reports
    // its balance as its capacity is the exact illusion §12.1 removes.
    if (kind === POOL_KIND.OFFSET && offset.every(a => a.offsetsPropertyKey)) {
      pool.capacity = { mode: 'OFFSET_CAP' };
    }
    pools.push(pool);
  }

  return { pools, flows: buildFlows(order, spec) };
}

/**
 * The cascade. Three edges, and the middle one is the whole reason a pool is a NODE:
 * `offset → cash` is a SECOND source into one destination, tried after the first
 * (§11) — the thing §1 says a list cannot express.
 */
function buildFlows(order, spec) {
  const refill = spec.refill ?? REFILL.NONE;
  if (!Object.values(REFILL).includes(refill)) {
    fail(`unknown refill '${refill}'. Valid: ${Object.values(REFILL).join(', ')}`);
  }
  if (refill === REFILL.NONE) return [];

  const has = (k) => order.includes(k);
  // `toTarget` on a destination with no target moves nothing, every period — the normalizer
  // rejects it, and it would read in the journal as a broken refill rather than an unsized
  // pool. So an edge is emitted only when its destination has a size to fill to.
  const cashTargeted   = has(POOL_KIND.CASH)   && spec.cashYears != null;
  const bufferTargeted = has(POOL_KIND.BUFFER) && spec.bondYears != null;

  const trigger = { below: { mode: 'YEARS_OF_SPEND', value: spec.refillTriggerYears ?? 0.5 } };
  const flows = [];

  if (cashTargeted && has(POOL_KIND.BUFFER)) {
    flows.push({ id: 'buffer-to-cash', from: POOL_KIND.BUFFER, to: POOL_KIND.CASH, priority: 10, trigger });
  }
  if (cashTargeted && has(POOL_KIND.OFFSET)) {
    // Priority 20: the backstop is tried only after the reserve could not fill the pool.
    flows.push({ id: 'offset-to-cash', from: POOL_KIND.OFFSET, to: POOL_KIND.CASH, priority: 20, trigger });
  }
  if (bufferTargeted && has(POOL_KIND.GROWTH)) {
    flows.push({
      id: 'growth-to-buffer', from: POOL_KIND.GROWTH, to: POOL_KIND.BUFFER, priority: 10,
      ...(refill === REFILL.CASCADE_HARVEST
        ? { gate: { sourceReturnOver: spec.harvestGate ?? 0 } }
        : {}),
    });
  }
  return flows;
}

/**
 * The shapes §18.3 sweeps, as specs. Sizes are supplied per arm; this is the SHAPE axis only.
 *
 * `POOL_LESS` is `order: []` rather than a missing entry, so the control is generated by the
 * same call as every arm and cannot drift from them.
 */
/**
 * Insert the wrappers pool at a named position in an order (design 97 §18.6 rule 4).
 *
 * `null` returns the order untouched — which is NOT "the wrappers go last" but "the wrappers
 * are never claimed", and on a plan whose pools do not run dry that means never spent. It is a
 * point on the axis, not the absence of one, so it is spelled out here rather than left to the
 * caller to omit.
 *
 * @param {string[]} order
 * @param {?string} at  'first' | 'after-cash' | 'before-growth' | 'last' | null
 */
export function withWrappersAt(order, at) {
  if (at == null) return [...order];
  const rest = order.filter(k => k !== POOL_KIND.WRAPPERS);
  const W = POOL_KIND.WRAPPERS;
  switch (at) {
    case 'first': return [W, ...rest];
    case 'last':  return [...rest, W];
    case 'after-cash': {
      const i = rest.indexOf(POOL_KIND.CASH);
      if (i < 0) fail("withWrappersAt('after-cash') needs a cash pool in the order");
      return [...rest.slice(0, i + 1), W, ...rest.slice(i + 1)];
    }
    case 'before-growth': {
      const i = rest.indexOf(POOL_KIND.GROWTH);
      if (i < 0) fail("withWrappersAt('before-growth') needs a growth pool in the order");
      return [...rest.slice(0, i), W, ...rest.slice(i)];
    }
    default:
      fail(`withWrappersAt: unknown position '${at}'. `
        + "Valid: first, after-cash, before-growth, last, or null for 'never claimed'.");
  }
}

/** The wrapper-placement axis, including the do-nothing point. */
export const WRAPPER_PLACEMENTS = Object.freeze([null, 'first', 'after-cash', 'before-growth', 'last']);

export const SHAPES = Object.freeze({
  /** Today's behaviour: no graph, `drawdownPriority` untouched. */
  POOL_LESS:      [],
  /** One bucket of cash in front of everything. */
  CASH_ONLY:      [POOL_KIND.CASH, POOL_KIND.GROWTH],
  /** Cash, then a bond reserve, then growth. No offset in the sequence. */
  CASH_BOND:      [POOL_KIND.CASH, POOL_KIND.BUFFER, POOL_KIND.GROWTH],
  /** Arm A — "the offset as an overflow PAST bonds" (§4). The study's central policy. */
  OFFSET_AFTER_BONDS:  [POOL_KIND.CASH, POOL_KIND.BUFFER, POOL_KIND.OFFSET, POOL_KIND.GROWTH],
  /** The other reading: spend the facility first, keep the reserve behind it. */
  OFFSET_BEFORE_BONDS: [POOL_KIND.CASH, POOL_KIND.OFFSET, POOL_KIND.BUFFER, POOL_KIND.GROWTH],
  /** Arm B — bonds as dry powder: spent only after growth is gone (§7.0's `--b-tail equity`). */
  DRY_POWDER:     [POOL_KIND.CASH, POOL_KIND.OFFSET, POOL_KIND.GROWTH, POOL_KIND.BUFFER],
});
