# 46 — MPC Performance (CEM solve cost, multi-lever scaling)

**Status**: Open / living doc (started 2026-06-29). A running catalog — append findings and ideas as design 45 (and later lever work) lands. No committed plan yet; this is where we accrue the case for a focused performance pass.
**Related**: `design/39-mpc-financial-controller.md` (the cockpit/controller this profiles), `design/38` (the solver framework), `design/41` (sliding prediction window `horizonYears`), `design/45-early-withdrawal-decant-lever.md` (the lever work that grows the decision vector and motivates this). Code: `src/finance/optimization/solvers/cem-solver.js`, `src/finance/optimization/solvers/solver-registry.js`, `src/finance/optimization/optimization-problem.js` (`_compile`, `_rollout`, `evaluate`), `src/finance/mpc/cockpit-controller.js` (`advise`, `autoRun`).

> **Why this doc exists.** The cockpit's CEM solve is **~10s per iteration** in MPC Cockpit *auto* mode today. Design 45 opens additional levers (early-withdrawal tax-deferred + Roth), and each active lever adds a dimension to the joint decision vector — which pushes the sample budget up and the solve slower. Before we let the lever count grow unchecked, capture the cost model and the menu of improvements so a later performance pass has a ready brief. **Nothing here blocks design 45 Phases 1–3** (manual params, no solver in the loop); it bites at Phase 4 (multi-lever MPC).

---

## 1. Current cost model (as measured/derived 2026-06-29)

One `advise()` (or one `autoRun` epoch) = one CEM `solve()` over the snapshot-seeded `OptimizationProblem`:

- **CEM defaults** (`solver-registry.js`): `budget = 256` evaluations, `population = 32`, `eliteFrac = 0.25` ⇒ ~`256/32 = 8` generations.
- **Each evaluation is one full rollout** (`OptimizationProblem._rollout` via `evaluate`): it **compiles the scenario fresh** (`_compile`), injects the now-snapshot's state + event queue, then steps forward to `simEnd`.
- **Evaluations run sequentially** — `cem-solver.js` awaits each `ledger.evaluate()` in a `for` loop; no parallelism within a generation.
- **`EvalLedger` dedups** identical candidates (so the budget isn't wasted on repeats), but there is **no memoization of the expensive `_compile`** across evaluations — every rollout rebuilds the whole handler/reducer wiring.

So ≈ **256 sequential full-horizon simulations per solve**, ≈ 40 ms each ⇒ the observed ~10 s. *Auto* mode does this once per epoch, every epoch, across the whole horizon.

**Scaling with levers (the design-45 concern):** CEM samples the joint vector, so cost is `budget × rollout`, *largely independent of dimension* at a fixed budget — BUT good coverage of a higher-dimensional space needs a larger `population`/`budget`, so in practice each new active lever nudges the budget up and the solve slower. With 4 levers (Spending, Roth, TaxDeferred-early, Roth-early) we should expect to want a bigger budget than the single-lever default tuned for.

## 2. Improvement catalog (unranked; profile before committing)

Each entry: the idea, the expected win, and the risk/cost. **Measure first** — we don't yet know the compile-vs-step-vs-objective split per rollout (§3 action item).

1. **Reuse the compiled sim across evaluations.** `_compile` rebuilds the full wiring every rollout; if compile is a large fraction of the 40 ms, compile **once per solve** and reset/clone just the mutable state + queue per candidate. *Win: potentially large (kills 255 redundant compiles/solve). Risk: must guarantee no cross-eval state bleed — the deterministic-compile invariant that lets snapshots line up (design 39 §10 Q4) is what makes a shared compile plausible.*
2. **Parallelize the population.** Members within a generation are independent; run them across worker threads / Web Workers. *Win: ~Nx on N cores (CEM is embarrassingly parallel within a generation). Risk: sim must be worker-serializable; harness/bus singletons; added complexity.*
3. **Warm-start CEM from the prior epoch's solution.** Receding-horizon epochs have nearly-identical optima year-to-year; seed CEM's `start` (it already accepts one) from last epoch's committed candidate so it converges in fewer generations at a smaller budget. *Win: lower budget for equal quality, especially in auto mode. Risk: bias toward stale optima after a regime change (e.g. a move year) — may need a periodic cold restart.*
4. **Shrink the scoring horizon (design 41 `horizonYears`).** A shorter sliding window = cheaper rollouts. *Win: linear in steps dropped. Risk: fidelity — the design-45 step-up payoff is a long-horizon effect; too short a window blinds the objective to exactly the thing the lever exists for.*
5. **Cross-generation memoization.** Extend `EvalLedger` dedup to cache scores by quantized candidate across generations (CEM revisits nearby points as it contracts). *Win: moderate; depends on revisit rate. Risk: quantization granularity vs. accuracy.*
6. **Budget/population auto-scaling with active-lever count.** Only grow the budget when levers are actually active; keep single-lever solves cheap. *Win: avoids paying multi-lever cost when one lever is selected. Risk: a heuristic to tune.*
7. **Multi-fidelity / coarse-to-fine.** Cheap low-fidelity rollouts (coarse step, short horizon) to prune the population, expensive high-fidelity only on the elite. *Win: large if a cheap proxy correlates with the true score. Risk: proxy mis-ranking.*
8. **QP-polish the continuous sub-vector (`QP_POLISH`, already in the registry).** Fewer base CEM samples + a local polish on the continuous levers (Spending, Roth ceiling, withdrawal dollars are all continuous). *Win: fewer base evals for equal precision. Risk: QP assumptions on a non-smooth objective.*
9. **MPPI weighting** (noted in `cem-solver.js`): exponential score-weighting of the whole population instead of a hard elite cut — better sample efficiency per generation. *Win: smaller budget for equal quality. Risk: a solver change to validate against current results.*

## 2a. Solver selection — widen beyond CEM (owner ask, 2026-06-29)

> Direction: don't treat CEM as the only option. Phase 4's joint vector makes solver choice materially more impactful, and several registered-but-underused solvers (esp. **QP_POLISH**) and un-implemented algorithms may fit our shape better. **To be expanded + refined tomorrow.**

The Phase-4 decision vector is **higher-dimensional and mixed-type**: Spending (continuous), Roth ceiling (continuous), early-withdrawal tax-deferred + Roth (declared **INTEGER**) — and the levers are **coupled** on shared balances/bracket headroom (a dollar of IRA can be converted *or* withdrawn). CEM is a robust black-box sampler but: (a) sample-inefficient in higher dims (needs a bigger population → more rollouts → slower, the §1 cost), and (b) doesn't exploit the partly-smooth, partly-discrete structure.

Candidates to evaluate (expand tomorrow):

- **QP_POLISH (already in the registry, underused).** A sampling backbone (CEM/random) refined by a local QP on the **continuous sub-vector**. Most of our levers are continuous or near-continuous; a cheap local polish after a coarse global sample could cut the base sample budget for equal precision. *First thing to benchmark.*
- **Mixed-integer awareness.** The early-withdrawal vars are INTEGER and step-quantized; a solver (or a CEM variant) that respects the lattice avoids wasting samples on infeasible/duplicate points. Or relax-then-round + polish.
- **Gradient-free local methods with warm starts** (pattern search / Nelder–Mead) seeded from the prior epoch's commit (§2 #3) — receding-horizon optima move little year-to-year, so a *local* refine may beat a *global* re-search most epochs, with a periodic global restart.
- **MPPI / score-weighted CEM (§2 #9)** — better sample efficiency per generation than a hard elite cut.
- **Multi-fidelity / coarse-to-fine (§2 #7)** — cheap low-fidelity rollouts to rank, expensive high-fidelity only on the elite; orthogonal to the solver and stacks with any of the above.
- **Un-implemented options to scope:** Bayesian optimization (expensive-eval friendly, low-dim — fits a ≤6-var vector well), CMA-ES (a more principled cousin of CEM), trust-region derivative-free (e.g. a BOBYQA-style local model).

Open questions for tomorrow's refinement: which solver per *mode* (interactive single-epoch advise vs. headless autoRun)? Auto-select by vector size/type? A per-objective default? How to benchmark fairly (fixed rollout budget, same seed) given optimizer noise?

## 3. Action items / open

- [ ] **Profile one rollout**: compile vs. forward-step vs. objective evaluation. This decides whether #1 (compile reuse) or #4/#7 (horizon/fidelity) is the high-value lever. *(Do this before any optimization work.)*
- [ ] Confirm the ~10 s figure and capture machine + scenario it was measured on (horizon length, account count).
- [ ] Decide a per-epoch solve-time **target** for auto mode (interactive feel vs. quality).
- [ ] Re-measure with design 45's 4-lever joint vector once Phase 4 lands — quantify the real multi-lever slowdown rather than assuming it.

## 4. Log

- **2026-06-29** — Doc opened alongside design 45 §9 resolution. Recorded the current cost model (§1) and seeded the improvement catalog (§2). Trigger: design 45 adds 2 levers (joint vector → 4), and the CEM default budget (256/pop 32) was tuned for single-lever solves; auto mode already ~10 s/epoch.
- **2026-06-29 (later)** — Added §2a (solver selection) on the owner's ask to widen beyond CEM (QP_POLISH first, plus mixed-integer / warm-start / Bayesian / CMA-ES candidates). Prompted by design 45 Phase 4 landing the multi-lever joint vector (mixed INTEGER + continuous, coupled). **Next session:** refine §2a into a ranked plan, then start with the §3 profiling item to ground solver choices in measured rollout cost.
