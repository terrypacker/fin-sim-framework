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
 * Param type constants for optimization configs.
 *
 * ENUM       — discrete set of explicit values (e.g., bracket rates)
 * INTEGER    — integer range [min, max] stepped by step
 * CONTINUOUS — continuous range [min, max] stepped by step (discretised for grid search)
 */
export const OPT_PARAM_TYPES = {
  ENUM:       'enum',
  INTEGER:    'integer',
  CONTINUOUS: 'continuous',
};

/**
 * Default penalty weight λ for DIE_WITH_TARGET. Large enough that each dollar of
 * terminal-wealth miss outweighs the consumption gained by leaving (or spending)
 * it, so the terminal-wealth target is binding and the band solution is an
 * interior point. Overridable per-scenario via `terminalWealthTargetPenalty`.
 */
export const DEFAULT_TERMINAL_WEALTH_PENALTY = 10;

/**
 * Default penalty weight μ for cumulative deficit in the "die with target"
 * family. Without it these objectives reward INSOLVENCY: terminal net worth /
 * liquidity floors at 0, so a plan that spends the portfolio to zero parks the
 * terminal right next to a low target (tiny |NW − target| penalty) while
 * maximizing the consumption term — i.e. the optimizer recommends going broke
 * (design/39: a $30k-spend rollout scored best despite scenarioFailed=true, 362
 * deficit months, $23M cumulative deficit). The deficit penalty makes solvency
 * binding: it is **zero for any solvent plan** (cumulativeDeficit = 0) and only
 * ranks failing plans below solvent ones, so it never perturbs the interior
 * "spend-early ⇄ leave-less" optimum. μ comfortably exceeds the marginal reward
 * of a deficit dollar (1 from consumption + at most λ from approaching the
 * target), so every dollar of shortfall is net-negative. Overridable per scenario
 * via the `deficitPenalty` param.
 */
export const DEFAULT_DEFICIT_PENALTY = 100;

/**
 * Windowed cumulative deficit incurred over the scored horizon: terminal minus
 * the snapshot accumulator (MPC §47), clamped ≥ 0 since deficit is monotonic.
 * Shared by the `μ · deficit` penalty and by the feasibility-first ranking.
 */
export function windowedDeficit(result, snapshot) {
  return Math.max(0,
    (result.cumulativeDeficit ?? 0) - (snapshot?.state?.cumulativeDeficit ?? 0));
}

/**
 * How infeasible a rollout is, in dollars of shortfall — 0 means feasible.
 *
 * `scenarioFailed` and a non-zero windowed deficit are near-synonyms, but not
 * quite: a plan can be flagged failed on the last step with the shortfall not yet
 * accumulated, and a plan can inherit `scenarioFailed` from a snapshot whose
 * deficit is already subtracted out. Treat EITHER as infeasible, and report the
 * deficit as the magnitude so callers can rank least-bad when nothing is feasible.
 */
export function infeasibilityOf(result, snapshot) {
  const deficit = windowedDeficit(result, snapshot);
  if (deficit > 0) return deficit;
  return result?.scenarioFailed ? Number.MIN_VALUE : 0;
}

/** True when a rollout finished solvent over the scored window. */
export function isFeasibleResult(result, snapshot) {
  return infeasibilityOf(result, snapshot) === 0;
}

/**
 * Score offset that puts every infeasible candidate strictly below every feasible
 * one (design 80 U2). Finite by design — CEM refits a Gaussian over its elite set
 * and a non-finite score poisons the mean/σ update — and far larger than any
 * realistic |score| or deficit on these scenarios, so the two bands never
 * interleave.
 */
export const INFEASIBLE_OFFSET = 1e15;

/**
 * Returns the penalty term `μ · deficit` to SUBTRACT from a maximize score.
 *
 * **Known limit (design 80 §2.7)** — this is the *only* term that grows with the
 * severity of a failure. The λ terminal term cannot help: for the `liquid` scope
 * `computeNetLiquidity` bottoms out at 0 (it "reaches zero at the same moment an
 * OutOfFunds event fires"), so `|terminal − target|` is bounded above by `target`
 * in the whole insolvent region. The terminal penalty for ruin is therefore
 * **capped at `λ · target`** however catastrophic the ruin is, and raising the
 * target raises the cap linearly without ever making it a gradient. Solvency
 * ranking must not rely on it — see `OptimizationProblem.feasibilityFirst`.
 */
function _deficitPenalty(result, snapshot) {
  const mu = result.deficitPenalty ?? DEFAULT_DEFICIT_PENALTY;
  return mu * windowedDeficit(result, snapshot);
}

/**
 * The "Die With Target" family is a 2×2 over two independent axes (design/39):
 *   - running term  : real CONSUMPTION ($) vs concave CRRA UTILITY (smoothing)
 *   - terminal anchor: net WORTH vs net LIQUIDITY (the spendable, lever-reachable
 *     pool — excludes house equity / age-locked super / drawdownPriority=null)
 * All four share one formula — `running − λ·|terminal − target| − μ·deficit` — so
 * they are generated by `makeDieWithTarget` to stay in lockstep, and tagged with
 * `family` + `variant` so the UI can group them and offer the two axes as
 * sub-options. λ (`terminalWealthTargetPenalty`) generally needs its own
 * calibration per variant (utils ≪ dollars; worth vs liquid reachability).
 */
export const DIE_WITH_TARGET_FAMILY = 'DIE_WITH_TARGET';

const _RUNNING_TERMS = {
  consumption: { label: 'Consumption ($)', resultKey: 'lifetimeConsumption',        cumKey: 'cumulativeConsumption' },
  crra:        { label: 'CRRA utility',    resultKey: 'lifetimeConsumptionUtility', cumKey: 'cumulativeConsumptionUtility' },
};
// The terminal anchor is a 2×2 over two orthogonal axes (design/40 §2.0):
//   scope : worth (all assets) vs liquid (lever-reachable pool)
//   basis : nominal (at par) vs afterTax (net of the embedded liquidation tax)
// The UI renders the two axes as separate sub-selects; `resolveTerminalKey`
// maps a (scope, basis) pair back to the concrete measure key here.
const _TERMINAL_MEASURES = {
  worth:          { label: 'Net Worth',               resultKey: 'finalNetWorthUsd',          scope: 'worth',  basis: 'nominal'  },
  liquid:         { label: 'Net Liquidity',           resultKey: 'finalNetLiquidity',         scope: 'liquid', basis: 'nominal'  },
  afterTaxWorth:  { label: 'After-Tax Net Worth',     resultKey: 'finalAfterTaxNetWorth',     scope: 'worth',  basis: 'afterTax' },
  afterTaxLiquid: { label: 'After-Tax Net Liquidity', resultKey: 'finalAfterTaxNetLiquidity', scope: 'liquid', basis: 'afterTax' },
};

/**
 * The axis menus the UI renders as sub-options for the Die-With-Target family.
 * `terminal` is kept (flat list) for back-compat; `scope`/`basis` are the two
 * orthogonal sub-axes the cockpit/OPT panels render (design/40 §4).
 */
export const DIE_WITH_TARGET_AXES = {
  running:  Object.entries(_RUNNING_TERMS).map(([value, m])     => ({ value, label: m.label })),
  terminal: Object.entries(_TERMINAL_MEASURES).map(([value, m]) => ({ value, label: m.label })),
  // LIQUID FIRST, deliberately: the first option is what an untouched select shows,
  // so this ordering IS the default scope for every goal built through the axes
  // (design 88 D10/§5.4). A controller can only steer the lever-reachable pool, so a
  // worth-scoped target asks it to hit a number it cannot move.
  scope: [
    { value: 'liquid', label: 'Net Liquidity' },
    { value: 'worth',  label: 'Net Worth (reporting scope)' },
  ],
  basis: [
    { value: 'nominal',  label: 'Nominal' },
    { value: 'afterTax', label: 'After-tax' },
  ],
};

/**
 * Resolve a (scope, basis) pair to the concrete terminal-measure key.
 *
 * Defaults to the LIQUID scope (design 88 D10). Measured on the reference plan
 * (2026-08-07): 36% of terminal net worth is un-leverable — two houses and a
 * collectible, no speculative asset involved — so under the worth scope every
 * die-with target below \$5.08M real was unreachable and the anchor degenerated into
 * a one-sided push to spend the maximum. Under the liquid scope the same goal at a
 * \$5M target landed on it to within \$13k. The un-leverable component is exactly the
 * width of the extra band of targets the worth scope cannot serve.
 */
export function resolveTerminalKey({ scope = 'liquid', basis = 'nominal' } = {}) {
  const hit = Object.entries(_TERMINAL_MEASURES).find(
    ([, m]) => m.scope === scope && m.basis === basis);
  return hit?.[0] ?? 'liquid';
}

/** The (scope, basis) pair for a terminal-measure key — inverse of resolveTerminalKey. */
export function terminalAxesFor(terminal) {
  const m = _TERMINAL_MEASURES[terminal];
  return { scope: m?.scope ?? 'worth', basis: m?.basis ?? 'nominal' };
}

/**
 * Per-variant default λ so switching basis needs no re-tune (design/39 §11).
 *
 * The terminal penalty `λ·|terminal − target|` is in DOLLARS, but the running
 * reward is dollars for the CONSUMPTION basis and UTILS for CRRA — orders of
 * magnitude smaller, and scale-dependent on the consumption level and γ. A single
 * fixed λ therefore over-anchors the CRRA variants. To hold the same *leverage*
 * (each dollar of terminal miss ≈ λ× a dollar of consumption reward) across both
 * bases, the CRRA default scales λ by the run's marginal utility of consumption
 * u'(c̄) = c̄^{-γ} (`result.consumptionMarginalUtility`), converting the dollar
 * penalty into utils. An explicit `terminalWealthTargetPenalty` still overrides.
 */
function _defaultLambda(running, result) {
  if (running === 'crra') {
    const mu = result.consumptionMarginalUtility;
    if (Number.isFinite(mu) && mu > 0) return DEFAULT_TERMINAL_WEALTH_PENALTY * mu;
  }
  return DEFAULT_TERMINAL_WEALTH_PENALTY;
}

/**
 * Build one Die-With-Target objective: maximize the running reward subject to the
 * terminal anchor hitting `terminalWealthTarget`, with the shared two-sided λ
 * penalty (interior spend-early ⇄ leave-less optimum) and the μ deficit penalty
 * (solvency). Running reward is windowed (snapshot accumulator subtracted). λ
 * defaults per-variant (see `_defaultLambda`) so the CRRA basis is balanced
 * out-of-box; overridable via `terminalWealthTargetPenalty`.
 */
function makeDieWithTarget({ running, terminal, label }) {
  const r = _RUNNING_TERMS[running];
  const t = _TERMINAL_MEASURES[terminal];
  return {
    label,
    direction: 'maximize',
    family:    DIE_WITH_TARGET_FAMILY,
    variant:   { running, terminal },
    // The terminal anchor this goal targets — what the save-points log / card show.
    metric:    { key: t.resultKey, label: t.label },
    evaluate(result, { snapshot } = {}) {
      const reward = (result[r.resultKey] ?? 0) - (snapshot?.state?.[r.cumKey] ?? 0);
      // Deflate the terminal anchor to REAL base-year USD so the |terminal − target|
      // penalty shares units with the real consumption reward. The terminal measures
      // (worth/liquidity, nominal & after-tax) are nominal USD at the score date;
      // dividing by the run's terminal price level (∏(1+inflation) to that date)
      // expresses them in base-year dollars. `terminalWealthTarget` is therefore a
      // REAL base-year ("today's dollars") figure. Without this the objective traded
      // a real consumption dollar against a nominal terminal dollar, so as inflation
      // compounded it progressively starved late-life real spending to defend a fixed
      // nominal target — the unrealistic MPC drop. Defaults to 1 (no deflation) when
      // the result carries no price level, keeping pure-unit callers/tests unchanged.
      const priceLevel   = result.terminalPriceLevel || 1;
      const realTerminal = (result[t.resultKey] ?? 0) / priceLevel;
      const target = result.terminalWealthTarget ?? 0;
      const lambda = result.terminalWealthTargetPenalty ?? _defaultLambda(running, result);
      return reward
        - lambda * Math.abs(realTerminal - target)
        - _deficitPenalty(result, snapshot);
    },
  };
}

/**
 * Named optimization objectives (design/38 §5).
 *
 * Each entry has:
 *   label     — human-readable name for UI
 *   direction — 'maximize' | 'minimize'
 *   evaluate  — (result, { snapshot } = {}) => number
 *
 * Objectives are **pure functions of the final sim state** (the `result` object
 * built by OptimizationProblem._readResult): terminal metrics (net worth,
 * liquidity) AND cumulative running accumulators (lifetime taxes, lifetime
 * consumption) that reducers wrote into state over the run. There is no per-step
 * callback — the running/terminal decomposition is realized as "terminal metrics
 * + state accumulators", both read at the end.
 *
 * **Windowed horizons (MPC).** When design 39 solves over a window [t, t+H], the
 * cost incurred within the window is `accumulator(t+H) − accumulator(t)`. The
 * optional `snapshot` carries `accumulator(t)`, so running objectives subtract
 * it; terminal objectives ignore it.
 *
 * The optimizer always maximises internally; a 'minimize' direction causes
 * scores to be negated before ranking.
 */
export const OPTIMIZATION_OBJECTIVES = {
  // ── Terminal objectives (pure functions of final state) ──────────────────
  MAX_NET_WORTH: {
    label:     'Maximize Final Net Worth (USD)',
    direction: 'maximize',
    metric:    { key: 'finalNetWorthUsd', label: 'Net Worth' },
    windowable: true,                    // terminal stock = continuation value (design 41 §4)
    evaluate:  result => result.finalNetWorthUsd,
  },

  MAX_ROTH_BALANCE: {
    label:     'Maximize Final Roth Balance (USD)',
    direction: 'maximize',
    metric:    { key: 'rothFinalBalance', label: 'Roth Balance' },
    windowable: true,
    evaluate:  result => result.rothFinalBalance,
  },

  MIN_DEFICIT: {
    label:     'Minimize Cumulative Deficit',
    direction: 'minimize',
    metric:    { key: 'cumulativeDeficit', label: 'Cumulative Deficit' },
    evaluate:  result => result.cumulativeDeficit,
  },

  MAX_NET_LIQUIDITY: {
    label:     'Maximize Final Net Liquidity (USD)',
    direction: 'maximize',
    metric:    { key: 'finalNetLiquidity', label: 'Net Liquidity' },
    windowable: true,
    evaluate:  result => result.finalNetLiquidity,
  },

  // ── After-tax maximizers (design/40 §4). The *maximize* form for the Roth
  //    lever — no targeting-trap, and where the conversion signal is strongest
  //    (converting a discounted pre-tax dollar to a par Roth dollar raises this).
  //    MAX_AFTER_TAX_NET_WORTH is the design/40 D2 default for the Roth lever.
  MAX_AFTER_TAX_NET_WORTH: {
    label:     'Maximize After-Tax Net Worth (USD)',
    direction: 'maximize',
    metric:    { key: 'finalAfterTaxNetWorth', label: 'After-Tax Net Worth' },
    windowable: true,                    // the Roth flagship: edge stock sees conversion value
    evaluate:  result => result.finalAfterTaxNetWorth,
  },

  MAX_AFTER_TAX_NET_LIQUIDITY: {
    label:     'Maximize After-Tax Net Liquidity (USD)',
    direction: 'maximize',
    metric:    { key: 'finalAfterTaxNetLiquidity', label: 'After-Tax Net Liquidity' },
    windowable: true,
    evaluate:  result => result.finalAfterTaxNetLiquidity,
  },

  // ── "Die With Target" family (2×2 over running × terminal, design/38 §5.2,
  //    design/39). Generated from makeDieWithTarget; grouped in the UI via the
  //    `family`/`variant` tags.
  //
  //    THE LIQUID TERMINAL IS THE DEFAULT (design 88 D10). This used to be a
  //    preference stated in this comment while every default resolved to `worth`,
  //    which is the combination that does not work: the lever set cannot liquidate
  //    house equity or age-locked super, so a worth-scoped "die with \$X" asks the
  //    controller to hit a number it can only partly move, and when the un-leverable
  //    part alone exceeds the target the |terminal − target| kink becomes unreachable
  //    — the penalty goes one-sided and pushes reachable wealth toward ZERO. The
  //    worth-scoped variants are kept for reporting-style comparisons. ───────────
  DIE_WITH_TARGET:
    makeDieWithTarget({ running: 'consumption', terminal: 'worth',
      label: 'Die With Target (max consumption, hit terminal wealth)' }),

  DIE_WITH_TARGET_LIQUID:
    makeDieWithTarget({ running: 'consumption', terminal: 'liquid',
      label: 'Die With Target — Liquid (max consumption, hit terminal liquidity)' }),

  CRRA_DIE_WITH_TARGET_LIQUID:
    makeDieWithTarget({ running: 'crra', terminal: 'liquid',
      label: 'Die With Target — Liquid (CRRA utility)' }),

  // After-tax terminal variants (design/40 §2.0): the same family with the
  // embedded liquidation tax priced into the terminal anchor. Backward-compatible
  // keys; the UI surfaces these via the Scope × Tax-basis sub-axes.
  DIE_WITH_TARGET_AFTERTAX:
    makeDieWithTarget({ running: 'consumption', terminal: 'afterTaxWorth',
      label: 'Die With Target — After-Tax (max consumption, hit terminal after-tax wealth)' }),

  DIE_WITH_TARGET_AFTERTAX_LIQUID:
    makeDieWithTarget({ running: 'consumption', terminal: 'afterTaxLiquid',
      label: 'Die With Target — After-Tax Liquid (max consumption, hit terminal after-tax liquidity)' }),

  CRRA_DIE_WITH_TARGET_AFTERTAX:
    makeDieWithTarget({ running: 'crra', terminal: 'afterTaxWorth',
      label: 'Die With Target — After-Tax (CRRA utility)' }),

  CRRA_DIE_WITH_TARGET_AFTERTAX_LIQUID:
    makeDieWithTarget({ running: 'crra', terminal: 'afterTaxLiquid',
      label: 'Die With Target — After-Tax Liquid (CRRA utility)' }),

  // ── Lifetime taxes (running accumulator, design/38 §5.3) ─────────────────
  MIN_LIFETIME_TAXES: {
    label:     'Minimize Lifetime Taxes (USD)',
    direction: 'minimize',
    metric:    { key: 'cumulativeTaxesPaid', label: 'Lifetime Taxes' },
    evaluate(result, { snapshot } = {}) {
      return (result.cumulativeTaxesPaid ?? 0) - (snapshot?.state?.cumulativeTaxesPaid ?? 0);
    },
  },

  // ── CRRA consumption utility (running, design/39 §4) ─────────────────────
  // Maximize Σ u(cₜ) of real consumption. Because CRRA u is concave, this
  // rewards a SMOOTH real-spending path over the same total spent unevenly —
  // consumption smoothing falls out of the objective rather than being imposed.
  // Reads the cumulativeConsumptionUtility accumulator; windowed via snapshot.
  MAX_CRRA_UTILITY: {
    label:     'Maximize CRRA Consumption Utility',
    direction: 'maximize',
    metric:    { key: 'lifetimeConsumptionUtility', label: 'CRRA Utility' },
    evaluate(result, { snapshot } = {}) {
      return (result.lifetimeConsumptionUtility ?? 0)
        - (snapshot?.state?.cumulativeConsumptionUtility ?? 0);
    },
  },

  // ── "Die With Target" on CRRA utility (running + terminal, design/39 §4) ──
  // The MPC headline objective: maximize CRRA consumption utility subject to
  // terminal net worth landing on the target. Concave running term (smoothing);
  // its λ trades util vs dollars so it needs its own calibration vs the
  // consumption variants (design/39 §10 Q2) — overridable per scenario.
  CRRA_DIE_WITH_TARGET:
    makeDieWithTarget({ running: 'crra', terminal: 'worth',
      label: 'Die With Target (CRRA utility)' }),
};

// ── Objective-family helpers (UI grouping, design/39) ───────────────────────

/** Human label for a family id, shown as the single grouped option in selects. */
export const OBJECTIVE_FAMILY_LABELS = {
  [DIE_WITH_TARGET_FAMILY]: 'Die With Target',
};

/**
 * The primary terminal/running metric a goal optimizes — `{ key, label }` over the
 * `result` object — used by the cockpit save-points log and move card to show the
 * value the goal actually anchors on (not just net worth). Falls back to net worth
 * for any objective that hasn't tagged a metric.
 */
export function objectivePrimaryMetric(objective) {
  return objective?.metric ?? { key: 'finalNetWorthUsd', label: 'Net Worth' };
}

/**
 * Whether an objective may be scored over a sliding window shorter than the full
 * horizon (design 41 §4). True only for pure terminal-stock MAXIMIZERS, whose
 * value at any end date IS a faithful continuation value (the stock you hold).
 * False (the default) for pure running accumulators (MIN_LIFETIME_TAXES,
 * MAX_CRRA_UTILITY — windowing drops the out-of-window value) and death-anchored
 * goals (the DIE_WITH_TARGET family — its penalty is meaningless off the death
 * date; needs a terminal value, design 41 §7). Non-windowable goals are scored at
 * the full horizon regardless of the requested window.
 */
export function objectiveIsWindowable(objective) {
  return objective?.windowable === true;
}

/** The objective key for a Die-With-Target (running, terminal) variant pair. */
export function resolveDieWithTargetKey({ running = 'consumption', terminal = 'worth' } = {}) {
  const hit = Object.entries(OPTIMIZATION_OBJECTIVES).find(([, o]) =>
    o.family === DIE_WITH_TARGET_FAMILY
    && o.variant?.running === running && o.variant?.terminal === terminal);
  return hit?.[0] ?? 'DIE_WITH_TARGET';
}

/**
 * UI model for an objective <select>: family objectives collapse into ONE grouped
 * entry (`kind:'family'`), every other objective stays standalone (`kind:'single'`),
 * preserving registry order. The selected family then drives the axis sub-selects.
 */
export function groupedObjectiveOptions() {
  const out = [];
  const seenFamily = new Set();
  for (const [key, o] of Object.entries(OPTIMIZATION_OBJECTIVES)) {
    if (o.family) {
      if (seenFamily.has(o.family)) continue;
      seenFamily.add(o.family);
      out.push({ kind: 'family', family: o.family, label: OBJECTIVE_FAMILY_LABELS[o.family] ?? o.family });
    } else {
      out.push({ kind: 'single', key, label: o.label });
    }
  }
  return out;
}
