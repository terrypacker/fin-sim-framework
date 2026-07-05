# 46 — Implementation Guide: Structured Online Surrogate

Companion to `design/46-mpc-performance.md` (the design). This is the build plan: modules, interfaces, tests, and per-phase exit criteria. Each phase is independently landable and leaves the cockpit working. Signatures are illustrative, not final.

**Read the design first** — this assumes §3 (intermediates), §4 (composition decisions), §5 (analytic prior), §6 (pivot seams), §7 (the QP), §8 (persistence), §9 (qp-polish embryo).

---

## 0. Architecture at a glance

The surrogate is a **new solver** in the existing registry. It does not touch `OptimizationProblem` — that stays the black box `f(x)`; the solver calls `evaluate()` like every other solver. New modules (proposed under `src/finance/optimization/surrogate/`):

| Module | Responsibility |
|---|---|
| `objective-decomposition.js` | objective → live intermediate keys; `recompose(result, constants, objective)` → score |
| `analytic-prior.js` | §5 first-order sensitivities from horizon / return / weights → seed `g`, `H` sign |
| `response-surface.js` | quadratic fitter over continuous levers: `fit(samples, prior)`, `predict(x)`, `gradient(x)`, `hessian()` |
| `qp-step.js` | build the §7 composed QP (reward curvature + linearized-`T` L1 + deficit hinge + box trust region), solve via the WASM adapter, ratio-test |
| `integer-strategy.js` | `relaxAndRound` (default) / `enumerate` seam (§6) |
| `qp-solver-adapter.js` | thin wrapper over the chosen WASM QP lib (OSQP / Clarabel) — isolates the dependency |
| `surrogate-state.js` | persistent carry across epochs: sample store handle, fitted surfaces, trust-region center/radius (§8) |
| `../solvers/surrogate-solver.js` | registry-facing orchestrator: fit → QP → **verify on real sim** → accept/shrink → repeat |

Reused as-is: `EvalLedger` (`solvers/solver-support.js`) as the sample store; the CEM population as free training samples; `_readResult` fields as the intermediates.

**The invariant that keeps it honest:** every proposed step and every committed epoch decision is scored by `problem.evaluate()` (a real rollout). The surrogate never reports a number the sim didn't produce.

---

## Phase 0 — Profile & instrument ✅ DONE (2026-07-04)

**Goal.** Ground every later decision in measured cost, and decide whether compile-reuse (guessed to be a big loop win) comes first.

**Done.** Added `src/finance/optimization/rollout-profiler.js` (toggle-able, disabled by default, near-zero overhead) timing `_rollout` into compile / forward-step / objective. Measured live cockpit Advise against a realistic loaded scenario via the Chrome debug session.

**Result (see design §1 for the full table).** Scenario: US–AU cross-border couple, 14 accounts, horizon 2026→2070 (44 y), 8 cores. CEM `budget: 64` (the live cockpit value — **not** the registry default 256), 64 distinct rollouts. Per rollout **~396 ms**, split **forward-step 97.6 % / compile 2.4 % / objective ~0 %**. Solve ≈ 25.4 s, wall ≈ 28.6 s. Reproducible to the decimal across warm runs.

**What it changed (feeds the whole plan):**
- **Objective evaluation is free (~0 %)** → the surrogate's value is **purely rollout-count reduction**, never cheaper scoring. Confirms the approach's premise and its *only* payoff mechanism.
- **Compile is 2.4 %, not dominant** → compile-reuse is **deferred/dropped** (was the guessed "do first" — overturned). It saves ~0.6 s of 25 s.
- **The forward step is 97.6 %** → the two biggest *orthogonal* wins are **parallelism** (8 cores, embarrassingly-parallel population → ~6–8×, no fidelity loss) and **horizon-windowing** (design 41; 44 y → ~10–15 y cuts step cost ~3–4×). Both are algorithm-agnostic and land faster than the surrogate.

**Roadmap implication (Decision D4 below).** Parallelism + windowing may deserve to land **before or alongside** the surrogate — they don't depend on it proving out, and parallelism alone might get autopilot to interactive speed. The surrogate is still the *quality-per-rollout* play; these are the *cost-per-rollout* and *rollouts-in-parallel* plays. They stack.

**Exit (met).** Cost breakdown captured (design §1). **Still open:** a chosen per-epoch solve-time target for auto mode (owner call — what "interactive" means here, given ~28 s today).

---

## Phase 0.5 — Parallelize the population (Web Worker pool)

**Goal.** Run a CEM generation's independent ~390 ms rollouts concurrently across cores. Algorithm-agnostic, **bit-identical to sequential**, no fidelity trade. Target ~5–7× (≈25 s → ≈4–5 s) on the 8-core baseline. Resolves **D4 toward (a)** — parallelism before the surrogate, because it's low-risk, high-impact, and speeds the surrogate's own dev/benchmark loop.

**Why parallelizing is safe (the determinism guarantee).** A rollout is a pure deterministic function of `(candidate, snapshot)`: the snapshot carries `rngState`, every candidate in a generation starts from the same snapshot, and rollouts consume **no RNG in-loop** (`sim.rng` has zero in-loop consumers — design memo). So *where/when* a rollout runs never changes *what* it returns. If the batch evaluator folds results back into `EvalLedger` **in the original candidate order**, the ledger state (dedup, budget truncation, best/ties, `_sinceBest`) is identical to the sequential loop — so CEM's elite selection and final output are **exactly** the same. The test is therefore *exact equality*, not "no regression."

**The seam.** All batchable solvers route evaluations through `EvalLedger`. CEM builds a whole generation (`popVecs`) then loops `await ledger.evaluate(...)`. Replace that inner loop with one `await ledger.evaluateBatch(candidates)`; the ledger dispatches novel candidates to a worker pool (or falls back to sequential in-process), then folds results in order. Inherently-sequential solvers (pattern search, annealing) keep `evaluate()` and get no speedup — fine, the cockpit default is CEM.

**Sub-steps (staged so P-a is a pure refactor, fully testable in Node with no workers):**

- **P-a — Seam refactor + batch API (no workers yet). ✅ DONE (2026-07-04).**
  - Split `OptimizationProblem.evaluate` into `_rolloutResult(candidate) → result` (the expensive, worker-runnable rollout — wraps `_seededSim`/`stepTo`/`_readResult`) and `_scoreResult(result) → score` (cheap, main-thread objective application). `evaluate` composes them — signature/behavior unchanged. (This split also serves the surrogate later, which wants `result` intermediates without re-scoring.)
  - Added `EvalLedger.evaluateBatch(candidates)`: plan (dedup within batch + against cache, cap novels at remaining budget headroom) → compute → fold in candidate order through the shared `_record`, stopping at `exhausted`. Extracted `_record` so `evaluate` and `evaluateBatch` accrue budget/best/`_sinceBest`/`onProgress` identically.
  - Switched CEM's per-generation loop to `evaluateBatch`.
  - **Design lesson (shapes P-b):** the in-process path must route through **`problem.evaluate`**, NOT the `_rolloutResult`/`_scoreResult` split. Reason: callers can override `evaluate` (the analytic test mocks do), and the split bypassed the override → ran the real sim → 11 s + wrong answers. So `_computeEntries` uses `problem.evaluate` in-process; the split is **worker-only** (the worker runs `_rolloutResult`, the main thread applies `_scoreResult`).
  - *Exit met: 98 existing solver/cockpit/MPC tests green + 7 new `evaluateBatch === sequential` equivalence tests (`tests/unit/eval-ledger-batch.test.mjs`) covering duplicates, budget truncation, exhaustion, pre-warmed cache, and `onProgress`.*

- **P-b — Worker + pool. ✅ DONE (2026-07-04).**
  - `optimization/parallel/rollout-worker-core.js` — shared worker logic: `initProblem(ctx)` rebuilds a resident `OptimizationProblem` (pre-serialized cfg template assigned to `_serializedTemplate`; objective reduced to a `{ windowable }` stub — the only thing the rollout path reads via `_scoreEnd`), `runTask(candidate)` returns `_rolloutResult`.
  - `optimization/parallel/rollout-worker.js` — browser module-worker entry (`self` messaging shim), referenced via `new Worker(new URL(...), { type:'module' })` so Vite bundles it and it never enters the main-thread graph.
  - `optimization/parallel/rollout-worker-pool.js` — `RolloutWorkerPool` (env-agnostic; `spawn` DI so `node:worker_threads` stays out of the prod bundle), `browserRolloutSpawn`, and `rolloutContext(problem)`. `setContext` broadcasts once; `map` dispatches next-free with a promise per `taskId`; a worker error poisons the pool (fast reject). N = min(`hardwareConcurrency`, 8).
  - `EvalLedger._computeEntries`: on first batch, `setContext(rolloutContext(problem))` then `map`; scores on the main thread via `_scoreResult`.
  - CEM threads `workerPool` from runOpts → `EvalLedger`.
  - *Exit met (real cross-thread via Node worker_threads = same structured-clone as the browser): `tests/unit/rollout-worker-pool.test.mjs` — (1) worker rollout `===` main-thread `_rolloutResult`; (2) `map` returns input-order; (3) CEM pool ON `===` pool OFF (bit-identical best/scores/evaluations). 141 total solver/cockpit/MPC tests green.*
  - *Deferred to P-c: real **browser** Worker + Vite worker-chunk bundling (verified when the controller wiring loads it in the Chrome session).*

- **P-c — Wire through the controller + measure. ✅ DONE (2026-07-04).**
  - Ownership landed **plugin-side, not controller-side**: the `MpcCockpitPlugin` owns one lazy `RolloutWorkerPool` (browser-only via `typeof Worker`), reused across epochs **and** across the frequent `this._controller = null` resets, terminated in `destroy()`. It's injected into every `advise`/`autoRun` call (`workerPool: this._pool()`); the controller stays a pure consumer, so Node cockpit tests are unaffected (default `workerPool: null`). *(This refines D1: surrogate STATE is controller-owned; the worker pool is a shared resource, better owned by the plugin and injected.)* A `_parallel` flag (default on) allows A/B toggling.
  - `advise`/`autoRun` gained a `workerPool` option → `solve(problem, { …, workerPool })` → `EvalLedger`.
  - **Measured on the loaded scenario (Terry Jeanne 2031 AU Move, 14 accounts, 2026→2070, 8 cores), same-session A/B, Vite dev:** sequential (pool off) **27.9 s**; parallel warm, 8 workers **~10.0 s**; parallel cold (first solve, spawns workers) 12.6 s. All three returned the identical score `−3729383.5554004`.
  - **Result: ~2.8× end-to-end (27.9 → 10.0 s), ~3.6× on the solve alone.** Score **bit-identical** across sequential and parallel in the real browser — the P-a guarantee holds through actual Worker serialization. Real browser `Worker` + Vite worker-chunk bundling verified (8 workers spawned, worker-safe results).
  - *Exit partially met:* bit-identical ✅, browser workers ✅, but the **~3.6× solve speedup is below the 4× target**. Understood causes: (1) the ~3 s futures fan (`rolloutSeries`) still runs on the main thread — now ~30 % of wall → **P-d**; (2) Vite **dev** mode loads unbundled modules + runs less-optimized worker code (a production build bundles the worker → faster); (3) the snapshot is broadcast (structured-cloned) to all 8 workers each solve. Net: a clear, safe win shipped default-on; P-d + a prod-build re-measure should push it past 4×.

- **P-d — Fan parallelization. ✅ DONE (2026-07-04).** Added a `series` task kind (`runSeriesTask` → `rolloutSeries`) to the worker + `RolloutWorkerPool.mapSeries`; `advise` runs the 6-candidate fan through the same pool when present. Introduced `pool.setProblem(problem)` (ref-deduped) as the single config entry point — the solve and the fan within one advise broadcast context once; the ledger uses it too (dropped its `_poolReady` flag + `rolloutContext` import). Test: `mapSeries` in a worker `===` main-thread `rolloutSeries` (142 tests green). **Measured (same scenario, warm): ~8.9 s vs P-c's ~10.0 s → ~3.1× end-to-end (from 27.9 s), identical score.** The fan gain is real but modest — the ~7 s parallel *solve* now dominates the remaining wall.

**Serialization boundary.** Broadcast once per epoch via `setContext`: the **pre-serialized** cfg template (`problem._cfgTemplate()` — the *raw* cfg carries registry factories and is NOT structured-clone-safe; only the serialized form is), baseParams, variables, snapshot `{date,state,queue,rngState}` (structured clone preserves Dates + plain data). Per task: just `{taskId, candidate}` (a few numbers). Return: the small metrics `result`. Objectives never cross (functions — scored on the main thread, ~0 % cost per §1).

**Risks & mitigations.**
- *Worker-safety (a DOM ref at module import would throw in a worker).* Low — the same compile+step path runs headless in `scripts/run-scenario.mjs` and the unit tests, so the import graph is DOM-free; the P-b smoke test verifies before the pool is trusted; any offender gets a `typeof window` guard or lazy import.
- *Determinism.* Eliminated by order-preserving fold + RNG-free rollouts; enforced by the P-b equality test.
- *Memory.* N resident compiled sims + snapshots (N× a 14-account state) — modest; cap N at `hardwareConcurrency`.

**Size.** Medium. P-a is a small pure refactor; P-b is the real work (worker + pool + Vite wiring); P-c is plumbing + measurement.

---

## Phase 1 — Intermediate decomposition (no solver change)

**Goal.** Prove we can reconstruct any objective's score from `_readResult` intermediates + constants, *before* anything depends on it. This is the foundation; if the decomposition isn't faithful, nothing above it can be.

**Do.**
- `objective-decomposition.js`:
  - `liveIntermediates(objective)` → the intermediate keys this objective reads (from `objectivePrimaryMetric(objective)` + `objective.variant`). Returns e.g. `{ terminalKey:'finalAfterTaxNetWorth', runningKey:'lifetimeConsumptionUtility', usesDeficit:true }`.
  - `constantsFrom(result, params, objective)` → `{ P, lambda, mu, target, uBar }` read from the incumbent `result`/params (mirrors the exact reads in `makeDieWithTarget` / `_defaultLambda`).
  - `recompose(result, constants, objective)` → score, applying `|·|`, hinge, CRRA-as-accumulator **exactly as `evaluate` does**.
- No change to `OptimizationProblem.evaluate` beyond (optionally) exposing the `result` it already computes.

**Test (the exit gate).** For every objective in `OPTIMIZATION_OBJECTIVES`, over a spread of candidates and a snapshot: `recompose(result, constantsFrom(...), objective)` **equals** `evaluate(candidate).score` to floating tolerance. This is a pure unit test — no solver, no surrogate. **If this doesn't pass, the design's §3 premise is wrong and we stop and reconsider.**

**Risk/size.** Small. The only subtlety is windowing (subtract the snapshot accumulator) and the CRRA `_defaultLambda` scaling — both are already localized in `optimization-objectives.js` and just need mirroring. **Decision seam:** `recompose` is the single place the objective algebra is duplicated; keep it a thin, tested mirror so it can't drift from `evaluate`.

---

## Phase 2 — Surface fitter + analytic prior

**Goal.** Fit a quadratic response surface per live intermediate, seeded correct-to-first-order, validated offline.

**Do.**
- `analytic-prior.js`: `prior(problem, objective)` → per-intermediate `{ g0, Hsign }` from horizon length (`_scoreEnd − now`), assumed return, and objective weights (§5). Spending, Roth-conversion, early-withdrawal sensitivities as derived in the design.
- `response-surface.js`: weighted least-squares fit of `y ≈ a + gᵀx + ½xᵀHx` over the **continuous** lever coordinates, with:
  - the analytic prior as a Tikhonov/ridge center (so a thin sample set falls back to the prior, not to garbage),
  - recency / trust-region-distance sample weighting,
  - full pairwise interaction terms (Roth×withdrawal share bracket headroom — §9).
  - `predict(x)`, `gradient(x)`, `hessian()`.
- Fit consumes `EvalLedger` samples directly.

**Test/exit.** On a real scenario's CEM sample cloud, report predicted-vs-actual per intermediate (R², residual at the incumbent). Gate: the fitted `T`/`U` surfaces predict held-out samples within a stated tolerance; the CRRA `U` surface fits as concave (`H ≺ 0`), confirming §4.2.

**Risk/size.** Medium. Main risk is ill-conditioning with few samples in high dimension — the ridge-to-prior mitigates it. **Pivot seam:** the fitter is behind `predict/gradient/hessian`, so a richer model (e.g. GP mean = analytic prior) can replace the quadratic without touching the QP.

---

## Phase 3 — QP step + trust region (single-lever proof)

**Goal.** Close the loop: fit → build QP → solve → **verify on real sim** → accept/shrink. Prove it matches CEM's single-lever optimum in far fewer rollouts. This is the "does a QP over the surrogate actually help" gate.

**Do.**
- `qp-solver-adapter.js`: wrap the chosen WASM QP lib (pick in the §12 action item — OSQP or Clarabel). One narrow interface: `solveQP({ Q, c, A, lb, ub })`. Keep the dependency isolated here.
- `qp-step.js`: assemble the §7 program —
  - reward intermediate (`U`, or `T` for a maximizer) contributes quadratic curvature;
  - penalty intermediate `T` **linearized locally** → L1 via epigraph (`z ≥ ±(T₀+gᵀΔx)/P − target`);
  - deficit as `μ·max(0, D̂)` hinge;
  - box **trust region** as `lb/ub` on `Δx`;
  - then the **ratio test**: verify the proposed `x+Δx` on `problem.evaluate()`, compare actual-vs-predicted improvement, accept + grow or reject + shrink (standard TR update). Graceful stop at incumbent on repeated rejection (the `qp-polish` property).
- `integer-strategy.js`: `relaxAndRound` — solve continuous, round the committed lever to its legal step, verify. (`enumerate` stubbed for Phase 4.)
- `surrogate-solver.js` + registry entry `SURROGATE`: orchestrate `fit → step* → return best verified`. Same `solve(problem, runOpts)` contract as every other solver.

**Test/exit.** On a single-lever scenario (Spending only), `SURROGATE` reaches CEM's optimum (within tolerance on the objective) using **materially fewer `evaluate` calls** than CEM's 256. Report the rollout-count ratio — that number is the whole justification for the approach.

**Risk/size.** Large — this is the crux phase. Risks: (a) the WASM lib integration (bundle, worker, numerical edge cases) — isolated in the adapter; (b) non-smoothness inside the trust region defeating the QP — mitigated by the ratio test + shrink; (c) the linearize-`T`-in-penalty approximation being too loose — measured directly by the ratio test. **If the rollout-count win isn't there even single-lever, that's the signal to stop and fall back to the §12 orthogonal loop-cost wins instead.**

---

## Phase 4 — Multi-lever + cross-epoch persistence

**Goal.** Scale to the design-45 4-lever joint vector and make the surrogate persist/age across receding-horizon epochs (§8).

**Do.**
- Full pairwise-interaction surfaces active (from Phase 2) across all enabled levers.
- `surrogate-state.js`: the carry object — sample store handle, fitted surfaces, trust-region center/radius — threaded through epochs by the cockpit controller (**see Decision D1**).
- Warm start: seed each epoch's fit from the prior epoch's surfaces + carried samples; decay stale samples by recency / TR distance.
- **Cold-restart trigger:** regime-change detector (e.g. a `moveYear` crossing, or a large incumbent shift) forces a fresh CEM/LHS coverage pass to re-place the trust region (§8).
- `integer-strategy.js`: `enumerate` implemented for the case a future lever is genuinely low-cardinality (not needed for the design-45 dollar levers, but the seam is exercised by a test).

**Test/exit.** On the 4-lever vector: measured **rollout-count and wall-clock win at equal solution quality** vs CEM. Multi-epoch auto run shows each epoch converging in fewer samples than the last (persistence paying off), and a forced regime change triggers the cold restart.

**Risk/size.** Large. Risks: interaction-term conditioning (more coefficients, needs enough spread in samples); persistence bugs (stale surface after a discontinuity — the cold-restart trigger is the guard). **Pivot seams live here:** deficit hinge (→ learned boundary if it chatters) and `integerStrategy` both swappable without touching the QP or fitter.

---

## Phase 5 — Cockpit wiring + guaranteed fallback

**Goal.** Make auto mode use the surrogate by default, with CEM as both cold-start coverage and the safety net, and expose diagnostics.

**Do.**
- Auto mode: CEM/LHS coverage pass on the cold epoch-0 solve to place the trust region → surrogate for exploitation → **if the trust region collapses without improvement, hand back CEM's incumbent** (never worse than CEM).
- Diagnostics for the cockpit: predicted **efficient frontier** (predicted `R`/`U` vs predicted `T` — free from the objective-agnostic surfaces, design §4.1), and an actual-vs-predicted trace per epoch for trust.
- Solver `<select>` exposes `SURROGATE` with its option schema (trust-region params, coverage-pass budget, QP lib knobs).

**Test/exit.** Auto mode hits the Phase-0 solve-time target with **no quality regression** vs today's CEM on a suite of scenarios (single-lever, multi-lever, with/without a move, each objective family). The fallback path is tested by forcing a surrogate failure and asserting CEM's incumbent is returned.

**Risk/size.** Medium. Mostly integration + UX. Risk is auto-mode regressions — the CEM fallback bounds the downside to "no worse than today."

---

## Decisions

- **D1 — Persistent surrogate state → controller-owned carry. ✅ SETTLED (2026-07-04).** The cockpit controller holds a **serializable `SurrogateState`** and threads it into `solve()` each epoch (`solve(problem, { surrogateState }) → { …, surrogateState }`). Solvers stay **stateless**; the carry is serializable so it snapshots with the run. Phase 4/5 wire to this shape — the `solve()` contract gains one optional `surrogateState` in / out; other solvers ignore it.
- **D2 — Auto-mode posture → opt-in flag, flip in Phase 5. ✅ SETTLED (2026-07-04).** Through Phase 4, CEM stays the auto-mode default and `SURROGATE` is opt-in via the solver `<select>`. Phase 5 flips the default to surrogate-primary (CEM cold-start + fallback) **only once the benchmark suite is green** across all objective families, single/multi-lever, with/without a move.
- **D3 — WASM QP library (OPEN).** OSQP vs Clarabel (both Rust/C→WASM). Gate for Phase 3; needs a bundle-size + maintenance + license (Apache-compat) check. Isolated behind `qp-solver-adapter.js` so the choice is reversible. *Research item, not a preference — resolve before Phase 3 starts.*
- **D4 — Sequence the cost-per-rollout wins before the surrogate → (a) parallelism first. ✅ SETTLED (2026-07-04).** Land **Phase 0.5 (Web Worker pool)** before Phase 1. It's low-risk (bit-identical to sequential), high-impact (~5–7×), independent of the surrogate proving out, and its speedup accelerates the surrogate's own dev/benchmark loop. Horizon-windowing (design 41) stays available as a further cost-per-rollout lever but is deferred (fidelity trade-off; not needed if parallelism hits the target).

---

## Log

- **2026-07-04** — Guide drafted alongside the design rewrite. Phases 0–5, module map, per-phase exit gates. Key framing: `_readResult` already returns the intermediates, so Phase 1 is a tested recompose-helper (not a contract change); Phase 3 is the make-or-break "does the QP beat CEM's rollout count" gate; CEM stays as cold-start coverage + guaranteed fallback throughout. D1 (controller-owned carry) and D2 (opt-in flag, flip in Phase 5) settled; D3 (QP lib) open.
- **2026-07-04 (later)** — **Phase 0 done** (rollout-profiler + live measurement). Forward step is **97.6 %** of rollout cost; compile 2.4 %; objective ~0 %. Corrected design §1 (real numbers: `budget 64`, ~396 ms/rollout, ~28.6 s wall on a 44-y cross-border scenario) and §12 (compile-reuse demoted; parallelism + windowing promoted). Raised **D4**.
- **2026-07-04 (Phase 0.5 spec)** — **D4 settled → parallelism first.** Specced **Phase 0.5 (Web Worker pool)**: the `EvalLedger.evaluateBatch` seam, `_rolloutResult`/`_scoreResult` split, worker + `RolloutWorkerPool`, controller-owned pool reused across epochs. Staged P-a → P-b → P-c → P-d. Key property: **bit-identical to sequential**.
- **2026-07-04 (P-a done)** — Landed the seam: `evaluate` split, `EvalLedger._record`/`evaluateBatch`, CEM on the batch. Verified bit-identical (98 existing + 7 new equivalence tests). **Lesson:** in-process batch routes through `problem.evaluate` (not the split) so `evaluate` overrides (test mocks) are honored — the split is worker-only.
- **2026-07-04 (P-b done)** — Built the real workers: `rollout-worker-core.js` (shared) + `rollout-worker.js` (browser entry) + `RolloutWorkerPool` (DI `spawn`, so `node:worker_threads` stays out of the prod bundle); `EvalLedger` broadcasts `rolloutContext` once then `map`s; CEM threads `workerPool`. Tested via Node worker_threads (same structured clone as the browser): worker rollout `===` main-thread, input-order preserved, **CEM pool ON `===` pool OFF**. 141 tests green. **Gotcha fixed:** the ledger must `setContext` before the first `map`.
- **2026-07-04 (P-c done)** — Wired the **plugin-owned** pool into `advise`/`autoRun` (reused across epochs + controller resets, terminated in `destroy()`, default-on). Browser-verified: 8 real Workers, Vite worker chunk builds, **bit-identical score** (−3729383.5554004) sequential vs parallel. **~2.8× end-to-end / ~3.6× solve (27.9 → 10.0 s, dev).**
- **2026-07-04 (P-d done → Phase 0.5 complete)** — Parallelized the fan (`mapSeries` + `series` task; `pool.setProblem` as the deduped config entry). **~8.9 s warm → ~3.1× end-to-end**, identical score, 142 tests green. **Phase 0.5 outcome: a shippable, default-on, bit-identical ~3.1× speedup on the reference scenario in dev.** The remaining wall is dominated by the ~7 s parallel solve; closing the gap to 4×+ is now a **production-build re-measure** (dev-mode workers load unbundled code) and/or the surrogate track's *rollout-count* reduction — not more parallelism. **Next options: prod-build re-measure, or return to the surrogate (Phase 1 — intermediate decomposition).**
