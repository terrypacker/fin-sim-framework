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

  return perturbed;
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
      // `spending` forces FULL telemetry, and nothing less will do: the spending cube
      // reads `stateDiff`, which `silent` mode skips entirely (simulation.js records the
      // journal regardless of silent, but with a null diff). A 'journal'-level run
      // therefore yields a well-formed journal whose cube totals zero — the quiet kind
      // of wrong. Measured 7.5x, which is why this is opt-in (design 89 §20).
      scenario.buildSim({
        seed, telemetry: ctx.spending ? 'full' : 'off', sampler,
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
      return { seed: i + 1, params, result: runner.runScenario(params, i + 1) };
    },
  };
}

// ── Worker-side entry points ───────────────────────────────────────────────────
// A worker holds ONE resident iteration runner for the whole MC batch: `initMcContext`
// builds it from the context the pool broadcasts once, then each `runMcIteration(i)`
// returns that path's record. Mirrors `optimization/parallel/rollout-worker-core.js`.

let _iter = null;

/** Rebuild the resident iteration runner from the pool's broadcast context. */
export function initMcContext(ctx) { _iter = buildIterationRunner(ctx); }

/** Run one iteration by index; returns `{ seed, params, result }`. */
export function runMcIteration(i) {
  if (!_iter) throw new Error('mc worker: initMcContext must run before runMcIteration');
  return _iter.runIteration(i);
}
