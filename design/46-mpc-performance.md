# 46 — MPC Performance (structured online surrogate over the black-box sim)

**Status**: Open / living doc (started 2026-06-29; re-framed 2026-07-04 around a **structured online surrogate**). Design direction settled; implementation guide drafted (§10). No code yet.
**Related**: `design/39-mpc-financial-controller.md` (the cockpit/controller this profiles), `design/38` (the solver framework), `design/41` (sliding prediction window `horizonYears`), `design/45-early-withdrawal-decant-lever.md` (the lever work that grows the decision vector and motivates this). Code: `src/finance/optimization/solvers/cem-solver.js`, `.../solvers/qp-polish.js` (the surrogate's embryo — see §9), `.../solvers/solver-registry.js`, `.../solvers/solver-support.js` (`EvalLedger` — the sample store), `src/finance/optimization/optimization-problem.js` (`_compile`, `_rollout`, `evaluate`, `_readResult`), `src/finance/optimization/optimization-objectives.js` (the objective algebra we compose exactly), `src/finance/mpc/cockpit-controller.js` (`advise`, `autoRun`).

> **Driving direction (owner, 2026-07-04).** In a web environment on today's hardware, prefer **one computationally heavy solve per generation** over **many short black-box estimation loops**. Design 45 grows the joint decision vector (Spending, Roth ceiling, tax-deferred early-withdrawal, Roth early-withdrawal), which makes sampling cost worse. The approach below reaches "one heavy solve" **without** hand-transcribing the simulator into equations: it treats the sim as an unknowable black box, **fits a cheap model to its input/output samples online, optimizes that model (a QP), and always verifies the result on the real sim.** The model is a search accelerator, never an authority — so it cannot drift.

> **Nothing here blocks design 45 Phases 1–3** (manual params, no solver in the loop); it bites at Phase 4 (multi-lever MPC).

---

## 1. The current cost model (measured/derived 2026-06-29)

One `advise()` (or one `autoRun` epoch) = one CEM `solve()` over the snapshot-seeded `OptimizationProblem`:

- **CEM defaults** (`solver-registry.js`): `budget = 256`, `population = 32`, `eliteFrac = 0.25` ⇒ ~`256/32 = 8` generations.
- **Each evaluation is one full rollout** (`OptimizationProblem._rollout`): it **compiles the scenario fresh** (`_compile`), injects the snapshot's state + event queue, then steps to the score date.
- **Evaluations run sequentially** — `cem-solver.js` awaits each `ledger.evaluate()` in a `for` loop; no within-generation parallelism.
- **`EvalLedger` dedups** identical candidates, but there is **no memoization of `_compile`** across evaluations.

So ≈ **budget sequential full-horizon simulations per solve**. *Auto* mode pays this every epoch, across the whole horizon. Each new active lever nudges the required budget (and wall-clock) up.

**Measured baseline (Phase 0, 2026-07-04) — this corrects the estimates above.** Live cockpit Advise on a realistic scenario (US–AU cross-border couple, 14 balance-bearing accounts, horizon 2026→2070 = 44 y, snapshot "now" = 2026; 8-core machine). The cockpit calls CEM at **`budget: 64`** (not the registry default 256; `mpc-cockpit-plugin.js:412`), yielding **64 distinct rollouts** (no dedup savings):

| Bucket | Per rollout | Share |
|---|---|---|
| **Forward step** (`stepTo`) | ~387 ms | **97.6 %** |
| Compile/setup (`_seededSim`) | ~9.4 ms | 2.4 % |
| Objective/metrics (`_readResult`) | <0.1 ms | ~0 % |
| **Total** | **~396 ms** | — |

Solve compute ≈ **25.4 s**; wall (incl. the 6-candidate fan + render) ≈ **28.6 s** (fan+render ≈ 3.2 s / 11 %). Reproducible across two warm runs to the decimal. At the registry-default `budget: 256` this would be ~4× (~100 s); autopilot pays it every epoch across ~44 epochs.

**What this changes.** The forward simulation *is* the cost. **Objective evaluation is free (~0 %)** — so the surrogate's value is **purely rollout-count reduction**, not cheaper scoring. **Compile is negligible (2.4 %)** — so "reuse the compiled sim" (§12) is nearly worthless here (kills ~0.6 s of 25 s), contradicting the pre-measurement guess. The high-value levers are all about the forward step: **fewer rollouts** (the surrogate), **cheaper rollouts** (shorter scoring horizon, design 41), and **parallelism** (8 cores, embarrassingly parallel population). Instrumentation lives in `src/finance/optimization/rollout-profiler.js` (disabled by default; `__rolloutProfiler.enable()` → run Advise → `.report()`).

---

## 2. The idea: model the black box, don't re-model the world

The simulator is already a model of reality. Hand-writing a *second* algebraic model of the retirement dynamics (an LP/MILP transcription of the tax code, drawdown ordering, etc.) to feed a convex solver would be a model **of a model** — and it would **drift**: any rule the algebraic model omits or approximates makes the optimizer recommend something the real sim then scores differently. That only pays off if we intend to swap the simulator for the real world, which is far from where we are (§11).

Invert it instead. Pretend the simulator is **unknowable beyond its inputs and outputs.** Sample it, fit a cheap surrogate to those samples, optimize the surrogate to propose a step, and **score every proposed/committed step on the real sim.** Because the black box is always the final judge:

> **Drift becomes impossible by construction.** A wrong surrogate costs a *suboptimal search step* — which the next real sample corrects — never a wrong recommendation. Track A's drift was fatal only because the algebraic model *was* the authority. Here it is a search accelerator; the worst case degrades to plain sampling, not to a wrong answer.

The surrogate is **structured, not black-box**: we know the general shape of every run (§3–§5), so we seed a correct-by-construction default model and let sampling refine it "in real time" — within a solve, and across receding-horizon epochs (§8).

---

## 3. What we model: intermediates, not the score

The key unlock is that **we do not model the score.** Every objective's `evaluate` (`optimization-objectives.js`) is a composition of three kinds of thing:

1. **simulator-reported quantities that vary smoothly with the levers** — fit a surface for each,
2. **known constants/params** (`λ`, `μ`, `target`, `priceLevel`, `γ`) — read from the incumbent, don't fit,
3. **known non-smooth operators** (`|·|`, `max(0,·)`, and the CRRA transform) — apply exactly.

So the intermediate set is generated mechanically: **fit a surface for each smooth simulator-reported term inside the active objective's `evaluate`; read every constant; apply the operators exactly on top.** The set is **objective-driven, not hardcoded** — the objective already declares its terminal metric (`objectivePrimaryMetric` → `{key,label}`) and, for the family, its `variant.running`.

At most **two smooth surfaces + one feasibility boundary** are live per objective:

| Active objective | Smooth surface(s) to fit | Applied on top (exact / constants) |
|---|---|---|
| `MAX_*_NET_WORTH/LIQUIDITY`, `MAX_ROTH_BALANCE` | the declared terminal metric `T(x)` | — |
| `MIN_LIFETIME_TAXES` | `Tax(x)` (windowed) | — |
| `MAX_CRRA_UTILITY` | `U(x)` = CRRA utility accumulator (windowed) | — |
| `DIE_WITH_TARGET` (consumption) | `R(x)` = lifetime consumption, `T(x)` | `λ·\|T/P − target\|`, `μ·hinge(D)` |
| `CRRA_DIE_WITH_TARGET` | `U(x)` = utility accumulator, `T(x)` | same; `λ` scaled by `u'(c̄)` from incumbent |

Everything else is read as a constant (§6), and the deficit `D` is a boundary, not a surface (§6).

---

## 4. The two composition decisions

### 4.1 The `|·|` die-with-target penalty → **exact-on-top**

Model `T(x)` smooth and apply `λ·|T(x)/P − target|` exactly, rather than absorbing the kink into a quadratic fit of the composed score. Three compounding reasons:

1. **The kink is where the optimum lives.** Die-with-target puts the optimum at the interior point where `T(x) = target` (the `DEFAULT_TERMINAL_WEALTH_PENALTY` comment: target "binding," "interior point"). A quadratic fit to the composed V rounds off that vertex and systematically mislocates the optimum — at exactly the point we care about.
2. **The kink is fully known** (`P`, `target` are constants), so there is nothing to learn by absorbing it.
3. **Objective-agnostic reuse.** One fitted `T(x)` serves the pure maximizer, every target value, both worth/liquid bases, and it **survives the user editing the target, retuning `λ`, or `λ` auto-rescaling per run** — none of those touch `T`. Absorbing forces an expensive re-fit on every such edit and kills cross-epoch transfer. (Bonus: objective-agnostic surfaces give the spend-vs-bequest efficient frontier for free — plot predicted `R`/`U` against predicted `T`.)

### 4.2 CRRA → **model the utility accumulator directly** (neither on-top nor absorbed)

`Σₜ u(cₜ) ≠ u(Σₜ cₜ)` — CRRA is a sum of concave *per-period* utilities, so the consumption **path** matters (the code comment: CRRA "rewards a SMOOTH real-spending path over the same total spent unevenly"). The sim computes it per-period into a **separate accumulator** (`cumulativeConsumptionUtility`) from the dollar accumulator (`cumulativeConsumption`). Therefore:

- **On-top is wrong** — applying `u()` to a total-consumption surface gives `u(Σc)`, discarding the smoothing information that is CRRA's entire purpose.
- **Absorbed-into-consumption is wrong** — the dollar surface simply doesn't carry the path information.
- **So fit `U(x)` = the utility accumulator as its own first-class intermediate.** The CRRA transform is already "absorbed" — by the *simulator*, per-period, where it belongs.

Bonus: `U(x)` is **globally concave** in the spending lever, so a negative-definite quadratic is the structurally correct shape — it fits *better* than the raw dollar surface, and the analytic prior (§5) can seed `H ≺ 0` with confidence.

---

## 5. The default model — analytic first-order sensitivities

"We know the general structure of every run" has a concrete form: the **first-order sensitivities are analytic** from horizon length, the assumed return, and the objective weights — so run zero starts correct-to-first-order before any sampling:

- **Spending lever `s`:** `∂R/∂s ≈ +years_remaining`; `∂T/∂s ≈ −Σ compounding_factor` (a dollar/yr not spent compounds to the horizon). `∂U/∂s` from the CRRA marginal utility at the current consumption level.
- **Roth conversion `c`:** ≈ 0 on nominal net worth; `+c·Δrate` on **after-tax** net worth (the lever's whole point).
- **Early withdrawal:** shifts liquidity forward; sign known; magnitude ≈ penalty + rate differential.

That seeds the surrogate's **linear term** (`g`) analytically and the CRRA **curvature sign** (`H ≺ 0`). What sampling then learns is only the *second-order* correction — tax-bracket bends and interaction terms. So the model is correct-to-first-order out of the box and refines to second order online.

---

## 6. Special handling (the pivot seams)

- **Deficit `D` → one-sided hinge, not a surface.** `cumulativeDeficit` is **0 across the entire solvent region** and only turns positive past a feasibility cliff (`DEFAULT_DEFICIT_PENALTY` never perturbs the interior optimum; it only fences off insolvency). Fitting a quadratic would smear flat-zero-then-cliff into a bowl. Model it as `μ·max(0, D̂(x))` with a hinge/boundary. **Pivot seam:** start with the hinge; escalate to a learned feasibility boundary (classifier in lever space) only if it chatters at the cliff.
- **Integer early-withdrawal levers → relax-and-round-and-verify.** Design 45 §5 makes these **dollars per class, `{min:0, max: class drawable balance, step}`** — high-cardinality *quantized-continuous*, not combinatorial (`$80k` vs `$81k` is not a regime change). So: fit surfaces over the continuous coordinate (the fit ignores integrality), optimize the QP continuously, **round the committed value to the legal step, and verify on the real sim.** Round error ≤ half a step — tiny next to bracket widths, and the always-verify invariant catches any worse landing (costs optimality, never correctness). The design-45 runtime *clamp* on shared IRA/bracket headroom (conversion-first, then withdrawal) is already baked into the sampled realized response, so the surface learns the clamped outcome. **Pivot seam:** an `integerStrategy` interface with `relaxAndRound` (default) and `enumerate` (fit/solve per level, pick best) — the latter for any *future* genuinely combinatorial lever ("which year to start SS").
- **`terminalPriceLevel` (P), `λ`, `μ`, `target`, `u'(c̄)` → constants.** `P` is `inflationAccumulator.US`, driven by the inflation assumption, ~independent of the levers; `λ`/`μ`/`target` are params; `u'(c̄)` is a slowly-varying run aggregate. Read all from the incumbent real sample, hold fixed within a solve, refresh each epoch. This de-nonlinearizes the `/P` scale in the penalty.

---

## 7. The per-step solve (a QP)

Composing §3–§6, the per-epoch surrogate optimization is:

```
maximize_x   [ R(x) or U(x) ]   −   λ·|T(x)/P − target|   −   μ·max(0, D̂(x))
             \_ reward: keep _/      \_ penalty: linearize _/   \_ hinge _/
                curvature (quadratic)   T locally → L1
```

- an intermediate entering as a **reward** (`U`, or `T` for a pure maximizer) keeps its **quadratic curvature** — the source of the interior/concave optimum;
- an intermediate inside a **`|·|` penalty** is **linearized locally** (`T ≈ T₀ + gᵀΔx`) so `|·|` becomes a clean L1/epigraph term;
- the hinge is a one-sided linear penalty/constraint;
- all over a **box trust region**.

That is a **QP** (L1 via epigraph + quadratic reward + linear constraints) — the "one heavy solve" the whole thread circled, now over surfaces *fit to the black box* with every known operator applied exactly. The asymmetry (curvature in the reward, location in the penalty) is principled: curvature makes the reward's optimum interior; the kink's *location* is what the penalty needs, its curvature is spurious.

Trust-region ratio test (actual-vs-predicted on the verify rollout) accepts/shrinks the region — the standard graceful degradation: on a non-smooth probe the region shrinks and it stops at the incumbent, never chatters (the property `qp-polish.js` already has).

---

## 8. Cross-epoch persistence — "refine in real time"

Receding-horizon epochs barely move year-to-year, so the surrogate **persists and ages** rather than restarting each solve:

- last epoch's fitted surfaces are this epoch's **prior** (warm start), so most epochs need only a few fresh samples to re-center;
- the sample store (`EvalLedger`, §9) carries forward; stale samples decay by recency/trust-region distance;
- a **periodic cold restart** (or a regime-change trigger — e.g. a move year) guards against a stale prior after a discontinuity.

This is the "fine-tune as we go" the owner described: the model is correct-by-construction on epoch 0 (§5) and continuously refit to ground truth thereafter.

---

## 9. Relationship to existing code (an incremental path, not a rewrite)

- **`qp-polish.js` is the surrogate's embryo.** It already finite-differences a local gradient + **diagonal** Hessian and takes a projected-Newton step — then **throws the model away** after one step. The surrogate generalizes it: keep the model, make it **full** (pairwise interactions — Roth×withdrawal share bracket headroom), **fit it from all samples** (not just FD probes), **seed it analytically** (§5), model **intermediates** (not the composed score), and **persist it across epochs** (§8).
- **`EvalLedger` (`solver-support.js`) is the sample store** — dedup/caching already exists; the surrogate fits on it.
- **The CEM population is free training data** — 32 samples/generation today only refit the sampling distribution; they would *also* feed the surrogate. Natural division of labor: **CEM/LHS for coverage on the cold epoch-0 solve, structured surrogate for exploitation thereafter** (not either/or — the surrogate needs a placed trust region).
- **`OptimizationProblem` is untouched** — it stays the black box `f(x)`; the surrogate is a new solver in the registry that calls `evaluate` like every other solver.

---

## 10. Implementation guide (phased)

*(Summary below; the detailed build plan — modules, interfaces, per-phase tests/exit gates, open decisions D1–D3 — is in `design/46-mpc-performance-implementation.md`. Each phase is independently landable and leaves the cockpit working.)*

- **Phase 0 — Profile & instrument.** Confirm the ~10 s figure (machine + scenario). Split one rollout into compile / forward-step / objective. Decide whether compile-reuse (§12 orthogonal wins) is worth doing first since it speeds *every* rollout the surrogate verifies with. *Exit: a cost breakdown + a per-epoch solve-time target for auto mode.*
- **Phase 1 — Intermediate plumbing (no solver change).** Have `evaluate`/`_readResult` return the decomposed intermediates alongside the score, and a helper that maps an objective → its live intermediate set (from `objectivePrimaryMetric` + `variant`) and recomposes the score from intermediates + constants. *Exit: `recompose(intermediates, constants) === evaluate().score` to tolerance, as a test — proves the decomposition is faithful before anything depends on it.*
- **Phase 2 — Surface fitter + analytic prior.** A quadratic-response fitter over the enabled continuous levers with the §5 analytic seed; fit on `EvalLedger` samples. Validated offline against a CEM run's samples (predicted vs actual intermediate). *Exit: fit quality metric on a real scenario's sample cloud.*
- **Phase 3 — QP step + trust region.** Wire a real WASM QP solver (candidate list §12); build the §7 composed QP (reward curvature + linearized-`T` L1 penalty + deficit hinge + box trust region); ratio-test accept/shrink; verify each step on the real sim. Integer levers via `relaxAndRound`. *Exit: a `SURROGATE` solver in the registry that, single-lever, matches CEM's optimum in far fewer rollouts.*
- **Phase 4 — Multi-lever + persistence.** Full pairwise-interaction surfaces; cross-epoch warm start + sample carry-forward + cold-restart trigger (§8); the deficit hinge and `integerStrategy` seams exposed for pivot. Benchmark against CEM on the design-45 4-lever vector. *Exit: measured rollout-count + wall-clock win at equal solution quality on the multi-lever problem.*
- **Phase 5 — Cockpit wiring + fallback.** Default auto mode to the surrogate with CEM as the cold-start coverage pass and the guaranteed fallback (if the trust region collapses without improvement, hand back CEM's incumbent). Diagnostics: predicted efficient frontier (§4.1 bonus), actual-vs-predicted trace. *Exit: auto mode hits the Phase-0 solve-time target with no quality regression vs today's CEM.*

---

## 11. Track A note — the algebraic model (deferred)

A hand-written LP/MILP transcription of the plant (balance-flow constraints, tax brackets as piecewise-linear, integer levers, epigraph `|·|`, PWL/QP CRRA) remains the theoretically-cleanest "one heavy solve" — **but only makes sense if we intend to swap the simulator for the real world**, since its whole liability is drift against the sim. Until then the online surrogate dominates it (same QP payoff, zero drift). Kept here as the escape hatch, not the plan.

---

## 12. Orthogonal wins & action items

**Loop-cost wins that help *any* approach** (they speed the rollouts the surrogate verifies/samples with). **Reordered by the Phase-0 measurement (§1): the forward step is 97.6 %, so wins that cut step cost or run steps in parallel dominate; compile-reuse is now known to be marginal.**

- **Parallelize the population/sample batch** across Web Workers (members independent). **✅ IMPLEMENTED (Phase 0.5, `design/46-mpc-performance-implementation.md`).** `EvalLedger.evaluateBatch` + `RolloutWorkerPool`, plugin-owned + reused across epochs, **bit-identical to sequential** (proven in Node worker_threads and confirmed byte-for-byte in the browser). **Measured ~3.1× end-to-end** (27.9 → 8.9 s; solve alone ~3.6×) on the §1 scenario in Vite dev, after also parallelizing the futures fan (P-d). Below the hoped ~6–8× because dev-mode workers load unbundled code and the parallel solve (~7 s) is now the floor. A prod-build re-measure is the open lever; beyond that, further speedup is the surrogate's *rollout-count* play, not more parallelism. *Bit-identical to sequential (confirmed byte-for-byte in the browser); shipped default-on.*
- **Shrink the scoring horizon** (design 41 `horizonYears`) — **co-equal top win now**: the rollout steps 44 y (2026→2070); a 10–15 y scoring window cuts step cost ~3–4× linearly. *Risk: too short a window blinds the objective to the long-horizon step-up payoff (design 45) — bounded by only windowing *windowable* objectives (design 41 §4).*
- **Reuse the compiled sim across evaluations** — **DEMOTED: measured at 2.4 % (§1), so this saves ~0.6 s of 25 s.** Not worth the cross-eval state-bleed risk on this scenario. Reconsider only if a lighter scenario shifts the split. *(Was pre-measurement's "biggest single loop win" — the measurement overturned that.)*

**Third-party WASM solver candidates for Phase 3** (verify maintenance/license/bundle before committing — not vetted): **OSQP** or **Clarabel** (Rust→WASM) for the inner **QP**; **HiGHS** if we ever want MILP for the `enumerate` integer strategy; **jsLPSolver** (pure-JS) only for a throwaway spike.

**Open action items:**
- [x] ~~Phase 0 profiling~~ — done 2026-07-04 (§1); forward-step 97.6 %, compile 2.4 %, objective ~0 %.
- [x] ~~Confirm the figure; capture machine + scenario~~ — real is ~28.6 s wall / ~396 ms per rollout at `budget 64` on a 44-y cross-border scenario (§1).
- [ ] **Set a per-epoch solve-time target for auto mode** (owner — defines "interactive" vs today's ~28 s).
- [ ] **Decide sequencing** — parallelism/windowing mini-phase before/alongside the surrogate? (guide D4).
- [ ] Pick the WASM QP library (Phase 3 gate; guide D3).
- [ ] Re-measure with design 45's 4-lever vector once Phase 4 lands.

---

## 13. Log

- **2026-06-29** — Doc opened alongside design 45 §9. Recorded the cost model (§1) and a black-box improvement catalog. Trigger: design 45 → 4-lever joint vector; CEM default budget tuned for single-lever; auto mode ~10 s/epoch.
- **2026-06-29 (later)** — Added a solver-widening note (QP_POLISH, mixed-integer, warm-start, Bayesian, CMA-ES candidates).
- **2026-07-04** — Re-framed around **one heavy solve over many short loops**. Established that a convex/integer solver consumes the objective's *algebra*, not `f(x)`; that today's `evaluate` is a full black box; and that the registered `QP_POLISH` is a finite-difference local polish over that black box, **not** a real QP.
- **2026-07-04 (Phase 0)** — Profiled the live cockpit solve against a realistic loaded scenario (rollout-profiler + Chrome session). **Forward step = 97.6 %** of rollout cost, compile 2.4 %, objective ~0 % (§1). Overturned the pre-measurement guess that compile-reuse was the biggest loop win (§12 demoted it) and confirmed the surrogate's payoff is *purely* rollout-count reduction (scoring is free). Promoted parallelism (~6–8×) + horizon-windowing (~3–4×) as the top orthogonal, algorithm-agnostic wins; raised sequencing decision D4. Real numbers: `budget 64`, ~396 ms/rollout, ~28.6 s wall, 44-y horizon — the old ~10 s/~40 ms estimates were low.
- **2026-07-04 (later)** — Settled the direction: a **structured online surrogate** (this rewrite). Model **intermediates, not the score** (§3), driven by the objective's declared metric. Two composition decisions locked: **`|·|` exact-on-top** (kink is the optimum; objective-agnostic reusable surface, §4.1) and **CRRA as the utility accumulator directly** (Σu(c) is path-dependent, sim-side; §4.2). **Analytic first-order default model** (§5). Pivot seams: **deficit hinge** and **`integerStrategy` = relax-and-round** (levers are quantized-continuous per design 45 §5, not combinatorial; §6). Per-step **QP** with curvature-in-reward / linearize-in-penalty (§7); cross-epoch persistence (§8); `qp-polish` → persistent surrogate incremental path (§9). Drafted the phased implementation guide (§10). **Next: expand/challenge the implementation guide.**
