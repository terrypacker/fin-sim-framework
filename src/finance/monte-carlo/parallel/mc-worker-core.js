/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ScenarioRunner }        from '../../../simulation-framework/scenario.js';
import { createDistribution }    from '../../../simulation-framework/distributions.js';
import { ServiceRegistry }       from '../../../services/service-registry.js';
import { IntlRetirementScenario } from '../../../scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }        from '../../../scenarios/scenario-loader.js';
import { applyParamBagToConfig } from '../../../scenarios/scenario-param-apply.js';
import { computeNetWorth, computeNetWorthInclSpeculative }
  from '../../derived-metrics/net-worth.js';
import { computeAfterTaxNetWorth, afterTaxOptionsFromParams } from '../../derived-metrics/after-tax.js';
import { computeNetLiquidity }   from '../../derived-metrics/net-liquidity.js';
import { buildSpendingCube }     from '../../spending-reporting/spending-cube.js';
import { summarizeSpendingForRun } from '../../spending-reporting/spending-distribution.js';
import { createMcSampler, extractYearlyTimeSeries, MC_SAMPLER_CADENCE, computeNetWorthUsd, makeMcSeededRng }
  from '../mc-sampling.js';
import { get, set }              from '../mc-param-paths.js';
import { computePathShape }      from '../mc-sampling.js';
import { runsToRows }            from '../mc-analysis.js';

/**
 * The per-iteration Monte Carlo world, in one place, so the SERIAL loop and a WORKER
 * run the identical code (design 89 §21.7).
 *
 * This module holds nothing that decides WHICH world is run — the base params, the
 * variable list and the provenance are resolved once on the main thread by
 * `IntlRetirementMcRunner`, then travel here as a plain `ctx`. What lives here is
 * only "given that world, run iteration i", which is exactly the unit that
 * parallelizes: iterations are independent and index-seeded (`seed = i + 1` for the
 * in-loop stochastic path, `makeSeededRng(i + 1)` for the scalar draws), so sharding
 * by index is BIT-IDENTICAL to running them in order, not merely equivalent in
 * distribution. `tests/unit/mc-worker-pool.test.mjs` asserts exactly that.
 *
 * The context is structured-clone-safe by construction:
 *   cfgTemplate — already piped through `ScenarioSerializer.serializeScenario` (the
 *                 raw record carries registry `factory`/`scenarioClass` refs that
 *                 `structuredClone` rejects);
 *   base        — a flat param bag, plain values + Dates;
 *   variables   — resolved sweep entries: plain distribution metadata plus the
 *                 schema's `label`/`options`/`visibleWhen`, all plain data.
 *
 * @typedef {object} McIterationContext
 * @property {object}  cfgTemplate  serialized scenario template
 * @property {object}  base         the resolved base param bag (incl. `endDate`)
 * @property {Array}   variables    resolved MC variables
 * @property {Date}    simStart
 * @property {Date}    simEnd
 * @property {boolean} [mix]
 * @property {boolean} [spending]
 */

/**
 * Produce a perturbed parameter object for iteration i.
 *
 * Deep-clones baseParams so nested writes (e.g. shocks[N].severity) never
 * leak back into the live scenario or adjacent iterations.
 *
 * For every variable in the resolved list:
 *   - Enabled: sample from its distribution and write via set(). A row carrying
 *     `integer: true` (a year axis) is rounded first — consumers build dates with
 *     `Date.UTC(year, …)`, which truncates, so an unrounded draw around 2031 runs
 *     ~half a year early (design 98 F10). Rounding here means r.params records
 *     the year the sim actually ran, and replay applies the same integer.
 *   - Disabled: if the path is absent from baseParams, fill the reference
 *     value (cfg.value ?? cfg.mean) so r.params is self-contained.
 */
export function perturbParams(baseParams, i, variables) {
  const rng       = makeMcSeededRng(i + 1);
  const perturbed = structuredClone(baseParams);

  for (const cfg of variables) {
    if (cfg.enabled) {
      const sample = createDistribution(cfg).sample(rng);
      set(perturbed, cfg.paramKey, cfg.integer && typeof sample === 'number' ? Math.round(sample) : sample);
    } else if (get(baseParams, cfg.paramKey) === undefined) {
      set(perturbed, cfg.paramKey, cfg.value ?? cfg.mean);
    }
  }

  // Design 98 M3 — Monte Carlo runs the stochastic return path (sequence risk and design
  // 90 §7.4's market dispersion) whatever a single run does, so the anchor's sd can mean
  // estimation uncertainty alone. Opt out with `mcSequenceRisk: false`. Written into the
  // iteration's params, so `r.params` records it and a replay runs the same path.
  if (perturbed.mcSequenceRisk !== false) perturbed.equityReturnStochastic = true;

  return perturbed;
}

/**
 * The shape of the random stream `perturbParams` consumes: each ENABLED variable, in
 * draw order, with how many random numbers its distribution takes per sample.
 *
 * Every variable draws from ONE shared stream, so this — not merely the set of sampled
 * keys — is what decides whether path i is the same world in two batches (design 100
 * §6). The count is not fixed by the key: a Normal takes two numbers, a Uniform one, and
 * a Normal with a zero spread takes NONE. Setting one lever's sd to 0 therefore shifts
 * every variable drawn after it, which a key comparison cannot see.
 *
 * Counted by sampling once with a counting stream rather than by a per-type table, so a
 * distribution added later is covered without anyone remembering to update one.
 *
 * @param {Array} variables  the resolved variable list the batch ran with
 * @returns {Array<{key: string, draws: number}>}
 */
export function samplingSignature(variables) {
  return (variables ?? []).filter(v => v.enabled).map(v => {
    let draws = 0;
    createDistribution(v).sample(() => { draws++; return 0.5; });
    return { key: v.paramKey, draws };
  });
}

/**
 * Build the `ScenarioRunner` that runs one MC iteration of `ctx`'s world.
 *
 * Called once per thread — once on the main thread for the serial path, once per
 * worker on `init` — and then reused for every iteration that thread is given.
 *
 * @param {McIterationContext} ctx
 * @returns {{ runIteration: (i: number, params?: object) => object, perturb: (i: number) => object }}
 */
export function buildIterationRunner(ctx) {
  const simStart    = ctx.simStart;
  const simEnd      = ctx.simEnd;
  const cfgTemplate = ctx.cfgTemplate;
  const sampler     = createMcSampler({ mix: !!ctx.mix });
  // Metric (not economic) params, so one provider is correct for the whole run —
  // see the note at the runner's call site.
  const afterTaxOpts = afterTaxOptionsFromParams(ctx.base);

  const runner = new ScenarioRunner({
    createSimulation: (params, seed) => {
      // Isolated per-iteration registry: never touches the singleton, so the
      // user's active config graph + UI bindings stay intact across MC runs.
      const registry = new ServiceRegistry();
      const scenario = new IntlRetirementScenario({
        context: registry.simulationContext,
        params,
        simStart,
        simEnd,
      });
      // Per-iteration seed so each path draws its OWN in-loop stochastic sequence
      // (design 74 §5.2). Previously the seed was dropped here and every iteration
      // ran at the default seed 1 — so with a stochastic path ON, all iterations
      // drew the IDENTICAL return sequence and sequence-of-returns risk collapsed to
      // a single ordering. The seed is the ScenarioRunner iteration index (i + 1),
      // so a run is reproducible and the scalar-param sampling rng (makeSeededRng,
      // same index) and the in-loop path share the iteration.
      // telemetry 'off' + a sampler: MC needs no bus, journal or full-state
      // history snapshots — only the yearly series, which the sampler collects
      // directly (design 78 §4.5).
      //
      // The cadence is 'year-boundary' (design 82 §4/§8.3), NOT the event cadence
      // design 78 shipped with. Design 78 picked the event cadence for cheapness, and
      // it lands the "yearly" point at whatever event happened to be last in the year
      // — mid-something, and drifting with event volume. A MIX is precisely sensitive
      // to whether the year-end rebalance has fired, so an arbitrary instant is not an
      // option here; and having MC sample somewhere the lab page and the workbench
      // panel do not would defeat the shared-modules argument entirely.
      //
      // This RE-BASELINES the RECORDED series, and nothing else. The sampler cannot
      // affect the run, so `scenarioFailed`, `outOfFundsDate`, `cumulativeDeficit` and
      // `finalNetWorthUsd` are unchanged EXACTLY. What moves is `timeSeries`, and
      // therefore `pathShape` (CAGR, worst-5yr, max drawdown, the decade split).
      //
      // Direction, measured rather than assumed — and the opposite of the intuition:
      // on the reference plan the year-boundary series is LOWER in 25 of 45 years and
      // higher in 2 (mean −0.10%, worst −1.17%). A retired plan spends faster than it
      // compounds within a year, so a mid-year reading sits ABOVE the year-end one.
      // See design 82 §8.3; an arm JSON from before this change is not comparable.
      // `spending` needs a NON-silent run: the spending cube reads `stateDiff`, which
      // `silent` mode skips entirely (simulation.js records the journal regardless of
      // silent, but with a null diff). A 'journal'-level run therefore yields a
      // well-formed journal whose cube totals zero — the quiet kind of wrong.
      //
      // 'diffs', NOT 'full'. 'full' also keeps ~2,000 whole-state history snapshots,
      // an ~85k-node execution graph and a state clone per event day — ~470 MB of a
      // ~540 MB iteration on the reference plan, none of it read here. With eight pool
      // workers each holding one iteration, that crashed the tab. 'diffs' is ~70 MB and
      // the result is bit-identical. Still ~7x an 'off' run (design 89 §20), which is
      // why this stays opt-in.
      scenario.buildSim({
        seed, telemetry: ctx.spending ? 'diffs' : 'off', sampler,
        samplerCadence: MC_SAMPLER_CADENCE,
      });

      const cfg = structuredClone(cfgTemplate);
      // Both param stores, alias-aware — shared with the workbench's Replay button so a
      // replayed run applies the SAME bag the same way. See applyParamBagToConfig.
      applyParamBagToConfig(cfg, params);
      new ScenarioLoader().load(cfg, registry);

      return scenario.sim;
    },
    evaluate: (sim) => ({
      // Design 84 §6.4a — MC used to record NOMINAL net worth only, which prices a
      // Roth dollar at par with a pre-tax one. On any question about WHERE wealth
      // sits (a decant, a conversion, a wrapper swap) that is the wrong scoreboard
      // and it favours holding by construction; G1 fixed it on the grid path and the
      // MC path was never followed. Built from the shared factory so a grid cell, an
      // optimizer score and an MC path are one number.
      afterTaxNetWorthUsd: computeAfterTaxNetWorth(sim.state, simEnd, afterTaxOpts),
      cumulativeTaxesPaid: sim.state.cumulativeTaxesPaid ?? 0,
      finalNetWorthUsd:  computeNetWorthUsd(sim.state),
      finalNetWorthInclSpeculative: computeNetWorthInclSpeculative(sim.state, 'USD'),  // design 88 D7
      finalNetLiquidity: computeNetLiquidity(sim.state, simEnd),
      scenarioFailed:    sim.state.scenarioFailed    ?? false,
      outOfFundsDate:    sim.state.outOfFundsDate    ?? null,
      cumulativeDeficit: sim.state.cumulativeDeficit ?? 0,
      deficitMonths:     sim.state.deficitMonths     ?? 0,
      timeSeries:        extractYearlyTimeSeries(sim),
      // Lifetime stochastic house-repair spend (design 75 §6.4 C), native property currency
      // summed across properties. Already accumulated in state by HouseRepairApplyReducer.
      lifetimeRepairSpend: sim.state.houseRepairSpendingTotal ?? 0,
      // Design 89 phase 6. Reduced to ~20 numbers HERE rather than kept as a cube:
      // ~3,900 rows x n paths is hundreds of megabytes, and the whole reason an MC
      // iteration records metrics instead of state (design 78 §4.5).
      ...(ctx.spending
        // `services: null` deliberately. The per-iteration registry is scoped to
        // createSimulation and, on the compiler path, registers no accounts anyway — so
        // the cube resolves each balance's unit from the account's own `currency.code`
        // in live state, the fallback phase 2 added when the loan balances turned out to
        // declare a currency KIND with a null CODE. Verified to give identical totals.
        ? { spending: summarizeSpendingForRun(buildSpendingCube({
            journal: sim.journal, state: sim.state, services: null, currency: 'USD',
          })) }
        : {}),
    }),
  });

  return {
    perturb: (i) => perturbParams(ctx.base, i, ctx.variables),
    /**
     * Run iteration `i`. `params` is passed in by the main thread so a subclass
     * `_perturb` override still governs the serial path; a worker perturbs locally
     * from the same shared function, which is why the two agree exactly.
     */
    runIteration(i, params = perturbParams(ctx.base, i, ctx.variables)) {
      // One path that throws — a strict-mode invariant, a model defect — must not take the
      // other n − 1 down with it. The path comes back as `error` with its seed and params so
      // it can be replayed; callers drop it from the statistics and report it.
      try {
        return { seed: i + 1, params, result: runner.runScenario(params, i + 1) };
      } catch (err) {
        return { seed: i + 1, params, result: null,
                 error: { message: String(err?.message ?? err), stack: err?.stack ?? null } };
      }
    },
  };
}

// ── Worker-side entry points ───────────────────────────────────────────────────
// A worker holds ONE resident iteration runner for the whole MC batch: `initMcContext`
// builds it from the context the pool broadcasts once, then each `runMcIteration(i)`
// returns that path's record. Mirrors `optimization/parallel/rollout-worker-core.js`.

let _iter = null;
let _ctx  = null;

/** Rebuild the resident iteration runner from the pool's broadcast context. */
export function initMcContext(ctx) { _ctx = ctx; _iter = buildIterationRunner(ctx); }

/**
 * Run one task. A number is a batch iteration and returns `{ seed, params, result }`;
 * a `{ cell, i }` pair is a grid task and returns that path's analysis row (design 100
 * §7). One entry for both, so the browser and Node worker shells need no change.
 */
export function runMcIteration(payload) {
  if (!_iter) throw new Error('mc worker: initMcContext must run before runMcIteration');
  return typeof payload === 'number' ? _iter.runIteration(payload) : runGridTask(_iter, _ctx, payload);
}

// ── Grid cells (design 100 §7) ──────────────────────────────────────────────────

/**
 * The params for path `i` of grid cell `cell`: the cell's lever values written onto the
 * base world, then the batch's usual perturbation.
 *
 * The overrides go on BEFORE `perturbParams`, and the grid runner has already disabled
 * every sampled variable that is also an axis, so a draw can never overwrite the lever
 * the cell exists to set. They are written with the same path-aware `set` the
 * optimizer's `_applyCandidate` uses, so a lever means the same thing in a grid cell as
 * in an Opt candidate.
 */
export function gridCellParams(ctx, cell, i) {
  const base = structuredClone(ctx.base);
  for (const [k, v] of Object.entries(ctx.cells[cell].overrides)) set(base, k, v);
  return perturbParams(base, i, ctx.variables);
}

/**
 * Run one grid task and reduce it to an analysis row (`runsToRows` shape plus `cell`).
 *
 * Reduced here, in the worker, not on the main thread. A grid is cells × paths, and
 * shipping every path's yearly series and param bag back only to drop them is the
 * memory problem design 100 §4 hit with spending. A row is everything the heatmap and
 * the paired readout use (§7.2).
 */
export function runGridTask(iter, ctx, { cell, i }) {
  const { seed, result, error } = iter.runIteration(i, gridCellParams(ctx, cell, i));
  if (error) return { cell, seed, error: error.message };
  const [row] = runsToRows([{
    seed,
    scenarioFailed:      result.scenarioFailed,
    outOfFundsDate:      result.outOfFundsDate,
    finalNetWorthUsd:    result.finalNetWorthUsd,
    afterTaxNetWorthUsd: result.afterTaxNetWorthUsd,
    lifetimeRepairSpend: result.lifetimeRepairSpend ?? 0,
    pathShape:           computePathShape(result.timeSeries),
  }]);
  return { cell, ...row };
}
