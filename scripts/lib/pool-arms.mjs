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
 * pool-arms.mjs — a pool SEARCH as Monte Carlo arms (design 97 §18.3, step 3).
 *
 * Step 2 (`pool-graph.mjs`) makes one graph from a spec. This makes the SPACE: the cross
 * product of shape × size × refill, as arms `mc-run.mjs` can run, plus the hygiene that
 * makes those arms comparable and the preflight that proves they landed.
 *
 * ── The three things that make this more than a nested loop ─────────────────────────
 *
 * **1. The hygiene is the `base` of the spec, so it applies to the CONTROL too.**
 * Every one of these is a setting the pooled arms need and the control does not — which is
 * exactly why it must be applied to both. An arm and a control that differ in two ways
 * measure neither of them (design 97 §16.3 says this about deleting flows; it is the same
 * mistake one level up).
 *
 *   · the glidepath comes OFF. Under §12.2's one-authority rule a pool target governs the
 *     classes it claims, so a glidepath left on governs only the residual — the pooled arms
 *     would run a different allocation policy from the control by accident, and the anchors
 *     the author wrote would be neither arm's mix.
 *   · `poolCashYears` / `poolBondYears` come OFF. They are the graph target's predecessor
 *     and authoring both throws (§12.2); left on in the control alone they would size its
 *     book differently from every pooled arm.
 *   · any hand-authored `drawdownSequence` comes OFF: the graph compiles to that field, so
 *     both is two authorities on one thing.
 *   · `shocks` comes OFF. §18.4 — with `--paths` a manufactured crash double-counts the
 *     downside, and a DATED crash is foreseen, which biases exactly this class of timing
 *     lever.
 *   · `LIQUIDITY_POOLS` stays SELECTED in every arm, control included. With no graph the
 *     strategy contributes no reducers at all, so it is inert by construction — and keeping
 *     the strategy list identical means the only thing that differs across arms is the graph.
 *
 * **2. Refill on/off is the FLAG, not the absence of flows** (§16.3). The flows are generated
 * for every pooled arm; `poolFlowsEnabled: false` is what turns the behaviour off while
 * leaving the pools, their targets and the compiled spend order live. The GATE is the other
 * axis, and that one IS a difference in the graph (CASCADE vs CASCADE_HARVEST).
 *
 * **3. Arms are only comparable if they start from the same wealth.** Nothing here moves
 * money, so wealth-matching should be automatic — which is precisely why it is asserted
 * rather than assumed (`offset-arms-not-wealth-matched`: a study once credited an uplift to
 * one arm only). `assertArmsWealthMatched` is cheap and runs before the grid.
 */

import { buildPoolGraph, SHAPES, REFILL } from './pool-graph.mjs';
import { allocWeightsFromMix } from '../../src/scenarios/intl-retirement-scenario.js';

/** Short, shell-safe codes — an arm key becomes a filename in `mc-run.mjs`'s output dir. */
const SHAPE_CODE = Object.freeze({
  POOL_LESS:           'none',
  CASH_ONLY:           'cash',
  CASH_BOND:           'cb',
  OFFSET_AFTER_BONDS:  'oab',
  OFFSET_BEFORE_BONDS: 'obb',
  DRY_POWDER:          'dry',
});

/** How a pooled arm refills. The flag and the gate are two different axes (see header). */
export const REFILL_MODE = Object.freeze({
  /** Pools, sizes and spend order live; no flow fires. The §16.3 control for the refill rule. */
  OFF:     'off',
  /** The cascade, ungated: growth is sold to refill the reserve whenever it is under target. */
  ON:      'on',
  /** The cascade with the market-state gate: harvest in up markets, pause in a falling one. */
  HARVEST: 'harvest',
});

const REFILL_CODE = { [REFILL_MODE.OFF]: 'noref', [REFILL_MODE.ON]: 'ref', [REFILL_MODE.HARVEST]: 'harv' };

/** `1` → `1`, `0.5` → `0p5` — a key that survives a filename and still reads as a number. */
const numCode = (n) => String(n).replace('.', 'p');

/**
 * The search space, as arm descriptors.
 *
 * The pool-less control is emitted ONCE regardless of the size and refill axes — it has no
 * pools, so a "pool-less, 4 bond years" arm is the control run a second time under a name
 * that claims it measured something. That is how a grid comes to report a size effect on a
 * plan with no pools.
 *
 * @param {object} o
 * @param {string[]} [o.shapes]      keys of SHAPES
 * @param {number[]} [o.cashYears]
 * @param {number[]} [o.bondYears]
 * @param {string[]} [o.refills]     values of REFILL_MODE
 * @param {string[]} [o.exclude]     account stateKeys to keep out of the pools
 * @returns {Array<{key:string, label:string, shape:string, cashYears:?number, bondYears:?number, refill:?string, exclude:string[]}>}
 */
export function poolArmGrid({
  shapes    = ['POOL_LESS', 'CASH_BOND', 'OFFSET_AFTER_BONDS', 'OFFSET_BEFORE_BONDS', 'DRY_POWDER'],
  cashYears = [1],
  bondYears = [0, 2, 4, 6],
  refills   = [REFILL_MODE.HARVEST],
  exclude   = [],
} = {}) {
  const arms = [];
  for (const shape of shapes) {
    if (!(shape in SHAPES)) throw new Error(`poolArmGrid: unknown shape '${shape}'`);

    if (shape === 'POOL_LESS') {
      arms.push({ key: SHAPE_CODE.POOL_LESS, label: 'pool-less (drawdownPriority)',
                  shape, cashYears: null, bondYears: null, refill: null, exclude });
      continue;
    }
    // A shape with no bond pool cannot express a bond SIZE — sweeping one would run the same
    // arm under N names and report the duplicates as a flat size response.
    const hasBuffer = SHAPES[shape].includes('buffer');
    const bonds = hasBuffer ? bondYears : [null];

    for (const c of cashYears) {
      for (const b of bonds) {
        for (const refill of refills) {
          if (!Object.values(REFILL_MODE).includes(refill)) {
            throw new Error(`poolArmGrid: unknown refill '${refill}'`);
          }
          const key = [SHAPE_CODE[shape], `c${numCode(c)}`,
                       b != null ? `b${numCode(b)}` : null, REFILL_CODE[refill]]
            .filter(Boolean).join('-');
          const label = `${shape} · cash ${c}y${b != null ? ` · bonds ${b}y` : ''} · refill ${refill}`;
          arms.push({ key, label, shape, cashYears: c, bondYears: b, refill, exclude });
        }
      }
    }
  }

  const dupes = arms.map(a => a.key).filter((k, i, xs) => xs.indexOf(k) !== i);
  if (dupes.length) throw new Error(`poolArmGrid: duplicate arm keys ${[...new Set(dupes)].join(', ')} — `
    + 'two arms writing one filename would silently overwrite each other');
  return arms;
}

/**
 * The ALLOCATION-matched controls: pool-less arms pinned to a pooled arm's realized mix.
 *
 * **Why the ordinary control is not enough.** A years-of-spend pool target sizes the MIX and
 * lets equity take the residual (design 97 §9.2), so the size axis is also an equity-share
 * axis — measured on a real plan, 0 years of reserve against 6 was a twenty-point swing in
 * equity. A pool-less control holding its own authored weights therefore differs from every
 * pooled arm by BOTH a drawdown order and a portfolio, and the comparison measures the
 * portfolio. `assertArmsWealthMatched` was watching the wrong invariant: the arms were
 * wealth-matched and were never allocation-matched.
 *
 * With one of these per distinct mix the study asks two clean questions instead of one
 * confounded one:
 *
 *   pooled  vs  matched control   →  the POOL effect, at constant allocation
 *   matched vs  authored control  →  the ALLOCATION effect the pool sizing implies
 *
 * **Deduplicated by the mix itself**, not by arm: shape and refill barely move the mix, so
 * every 4-year arm shares one matched control and the grid grows by the number of distinct
 * mixes rather than by the number of arms. Rounding to `precision` decides what "the same
 * mix" means, and it is reported rather than hidden — two arms that round together are being
 * compared against one control on purpose.
 *
 * **What it does NOT promise.** The control is authored at the pooled arm's realized mix; what
 * it REALIZES is then decided by the located planner and the drift band, exactly as the pooled
 * arm's was. The residual gap is small but real, and the caller should measure it rather than
 * assume it away — `mixGap` exists for that.
 *
 * @param {Array<{key:string, mix:object}>} pooledMixes  realized mix per pooled arm
 * @param {object} [o]
 * @param {number} [o.precision=2]  decimals the mix is rounded to before dedup
 * @returns {{arms:Array, controlFor:Map<string,string>}}
 */
export function matchedControlArms(pooledMixes, { precision = 2 } = {}) {
  // RENORMALISE over the four rebalanceable classes before anything else. A measured mix comes
  // from the allocation cube, which spans the whole balance sheet — property, company equity,
  // collectibles — so the four sleeve classes sum to well under 1. Fed to the stick-breaking
  // inverse unnormalised, the shortfall lands entirely on the RESIDUAL class: a plan measured
  // at 78/0/1/1 would be authored with 21 % GOLD. The rebalancer's target is a mix of the
  // rebalanceable book, so that is the book the match has to be taken over.
  const norm = (m) => {
    const cls = ['EQUITY', 'BOND', 'CASH', 'GOLD'];
    const tot = cls.reduce((t, c) => t + Math.max(0, Number(m?.[c] ?? 0)), 0);
    if (!(tot > 0)) {
      throw new Error('matchedControlArms: a measured mix holds none of EQUITY/BOND/CASH/GOLD — '
        + 'there is nothing to match, and authoring it would produce an all-residual portfolio.');
    }
    return Object.fromEntries(cls.map(c => [c, Math.max(0, Number(m?.[c] ?? 0)) / tot]));
  };
  const round = (m) => {
    const n = norm(m);
    const cls = ['EQUITY', 'BOND', 'CASH', 'GOLD'];
    const out = Object.fromEntries(cls.map(c => [c, +n[c].toFixed(precision)]));
    // Rounding four numbers rarely leaves them summing to 1; the residual class absorbs the
    // slack, which is what the stick-breaking inverse will do with it anyway.
    const slack = 1 - cls.reduce((t, c) => t + out[c], 0);
    out.GOLD = +Math.max(0, out.GOLD + slack).toFixed(6);
    return out;
  };

  const byMix = new Map();
  const controlFor = new Map();
  for (const { key, mix } of pooledMixes) {
    const r  = round(mix);
    const id = `mx-e${String(Math.round(r.EQUITY * 100)).padStart(2, '0')}`
             + `-b${String(Math.round(r.BOND * 100)).padStart(2, '0')}`;
    if (!byMix.has(id)) {
      byMix.set(id, {
        key: id,
        label: `pool-less, matched to EQ ${(r.EQUITY * 100).toFixed(0)}% / BOND ${(r.BOND * 100).toFixed(0)}%`,
        shape: 'POOL_LESS', cashYears: null, bondYears: null, refill: null, exclude: [],
        matchMix: r, matchedTo: [],
      });
    }
    byMix.get(id).matchedTo.push(key);
    controlFor.set(key, id);
  }
  return { arms: [...byMix.values()], controlFor };
}

/** L1 distance between two mixes, in allocation POINTS — the residual a match leaves behind. */
export function mixGap(a, b) {
  return ['EQUITY', 'BOND', 'CASH', 'GOLD']
    .reduce((t, c) => t + Math.abs((a?.[c] ?? 0) - (b?.[c] ?? 0)), 0) * 100;
}

/**
 * The levers for ONE arm. Only the graph and the refill flag vary; everything else is
 * hygiene, and hygiene lives in `poolArmBase` so it applies to the control too.
 *
 * @param {object} cfg   the base scenario config — read for `accounts` only
 * @param {object} arm   one descriptor from `poolArmGrid`
 */
export function poolArmLevers(cfg, arm) {
  const graph = buildPoolGraph(cfg, {
    // An explicit `order` on the descriptor wins over the named shape, so a study can sweep a
    // position WITHIN a shape (where the wrappers pool sits, say) without inventing a SHAPES
    // entry per point. Reading only `arm.shape` here made every point of such an axis compile
    // to the same graph — an inert axis that looks exactly like a null result.
    order:      arm.order ?? SHAPES[arm.shape],
    cashYears:  arm.cashYears,
    bondYears:  arm.bondYears,
    exclude:    arm.exclude ?? [],
    // The flows are always generated for a pooled arm; REFILL_MODE.OFF disables them with the
    // FLAG (§16.3), so the pools, targets and spend order stay identical across the pair.
    refill:     arm.refill === REFILL_MODE.HARVEST ? REFILL.CASCADE_HARVEST : REFILL.CASCADE,
    harvestGate: 0,
  });

  return {
    params: {
      liquidityGraph:   graph,
      poolFlowsEnabled: arm.refill !== REFILL_MODE.OFF,
      // An allocation-matched control is pool-less AND pinned to a mix. The weights go
      // through the stick-breaking inverse the scenario itself uses, so the authored target
      // is the one the plan would have written by hand — not a second parameterisation of
      // the same thing that drifts from it.
      ...(arm.matchMix ? allocWeightsFromMix(arm.matchMix) : {}),
    },
  };
}

/**
 * The `base` levers of the arms spec — the hygiene every arm shares. See the header for why
 * each one is here rather than on the pooled arms only.
 *
 * `allocationSchedule: 'STATIC'` rather than deleting the glidepath: the anchors stay in the
 * scenario (so the file still says what the plan believes) and simply stop being the target
 * source. A study that silently edits the plan's own data is a study nobody can reproduce.
 */
export function poolArmBase(extra = {}) {
  return {
    params: {
      allocationSchedule: 'STATIC',
      poolCashYears:      null,
      poolBondYears:      null,
      drawdownSequence:   null,
      shocks:             [],
      ...(extra.params ?? {}),
    },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'params')),
  };
}

/**
 * `{ base, arms }` in the shape `mc-run.mjs --arms` reads.
 *
 * `extraBase` is a LEVER SET — `{ params: {...} }`, the same shape every other lever argument
 * in this codebase takes — merged into the standard hygiene by `poolArmBase`.
 *
 * It used to be destructured as `{ base = {} }`, i.e. it wanted `{ base: { params } }`. Every
 * caller passed the bare lever set, so every caller's extra params were **silently dropped**:
 * the study restated its location policy and drift band "so the spec is self-describing" and
 * the restatement reached nothing. It happened to be harmless — the scenario authored the same
 * two values itself — but it is the exact shape of the bug this whole design keeps re-finding,
 * and it was caught only because a driver asserted its own treatment had landed. Take the
 * lever set directly, so the obvious call is the correct one.
 */
export function poolArmSpec(cfg, arms, extraBase = {}) {
  if (extraBase.base) {
    throw new Error('poolArmSpec: pass the lever set directly ({ params: {...} }), not '
      + '{ base: { params: {...} } } — the wrapper form silently dropped every extra param.');
  }
  const base = extraBase;
  return {
    _comment: 'GENERATED by scripts/lib/pool-arms.mjs (design 97 §18). Edit the generator, '
      + 'not this file — a hand-edited arm drifts from the rest of the grid in exactly the '
      + 'ways nobody notices.',
    base: poolArmBase(base),
    arms: Object.fromEntries(arms.map(a => [a.key, poolArmLevers(cfg, a)])),
  };
}

/**
 * Did this arm's graph actually REACH state? (§18.4, and §7.2's two lost sessions.)
 *
 * `cfg.params` rows are keyed by `name`, so a lever written the wrong way reads back fine in
 * the driver and is dropped on the way to the compiler. Every arm then runs the SAME plan and
 * the grid reports "the pool shape does not matter" — a finding-shaped non-result that
 * nobody re-checks.
 *
 * Read on state AFTER a build, never off the cfg.
 *
 * @param {object} state  `sim.state` at t0
 * @param {object} arm    the descriptor
 * @throws when the arm is inert
 */
export function assertPoolArmLanded(state, arm) {
  const seq   = state?.drawdownSequence;
  const graph = state?.liquidityGraph;
  const what  = `arm '${arm.key}'`;

  if (arm.shape === 'POOL_LESS') {
    // The control must be genuinely control: §3.1's identity property is "no sequence ⇒ the
    // drawdownPriority walk runs untouched", and a leaked graph would make it a fifth arm.
    if (graph || (Array.isArray(seq) && seq.length)) {
      throw new Error(`${what} is the CONTROL but carries a compiled pool sequence — it is not `
        + 'pool-less, so every comparison against it is against the wrong baseline.');
    }
    return;
  }

  if (!graph || !Array.isArray(graph.pools) || !graph.pools.length) {
    throw new Error(`${what}: no \`liquidityGraph\` reached state. The axis is INERT and every `
      + 'arm is running the same plan (design 97 §7.2 — `cfg.params` rows key on `name`).');
  }
  if (!Array.isArray(seq) || !seq.length) {
    throw new Error(`${what}: a graph landed but compiled to no \`drawdownSequence\`. The pools `
      + 'have no `spendOrder`, so the draw order is unchanged and only the SIZING differs.');
  }
  // The descriptor's own `order` wins, exactly as it does in `poolArmLevers` — otherwise a
  // sweep of a position WITHIN a shape fails this gate for having the pool it was given.
  const expected = (arm.order ?? SHAPES[arm.shape]).length;
  if (graph.pools.length !== expected) {
    throw new Error(`${what}: expected ${expected} pools for ${arm.order ? 'its authored order' : `shape ${arm.shape}`}, found `
      + `${graph.pools.length} (${graph.pools.map(p => p.id).join(', ')}).`);
  }
}

/**
 * Every arm starts from the same wealth — asserted, not assumed.
 *
 * `offset-arms-not-wealth-matched`: a study once credited an offset's uplift to one arm only
 * and the difference read as the lever working. Nothing in `poolArmLevers` moves money, so a
 * failure here means a lever had a side effect nobody intended — which is worth knowing
 * before spending an afternoon of compute.
 *
 * @param {Array<{key:string, netWorth:number}>} armWealth
 * @param {number} [tolerance=1]  base-currency units
 */
export function assertArmsWealthMatched(armWealth, tolerance = 1) {
  if (armWealth.length < 2) return;
  const ref = armWealth[0];
  for (const a of armWealth.slice(1)) {
    if (Math.abs(a.netWorth - ref.netWorth) > tolerance) {
      throw new Error(`arms are NOT wealth-matched at t0: '${ref.key}' holds ${Math.round(ref.netWorth)} `
        + `and '${a.key}' holds ${Math.round(a.netWorth)}. A lever moved money, so the difference `
        + 'between these arms is not the pool shape.');
    }
  }
}
