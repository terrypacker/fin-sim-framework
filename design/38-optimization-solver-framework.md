# 38 — Optimization Solver Framework

**Status**: Implemented (2026-06-26) — Steps 1–8 complete; CMA-ES/GA and worker-parallel rollouts remain as documented follow-ups.
**Related**: `design/33-age-banded-spending.md` (the expense-band parameterization this reuses), `design/25a-mc-nested-param-paths.md` (nested decision-variable paths — already implemented), `design/30-decision-graph-analysis.md` (combinatorial exploration surface), `design/39-mpc-financial-controller.md` (the closed-loop driver that reuses this engine as its inner solve), `design/15-config-as-source-of-truth.md` (round-tripped params).

---

## 1. Purpose

The current optimizer (`IntlRetirementOptimizer`) is an **exact grid search**: it enumerates the Cartesian product of every enabled variable range, runs a deterministic simulation per candidate, and ranks by objective. It is 100% accurate and perfectly adequate for low-dimensional, small-range problems — and it should stay the default for those.

It does **not** survive combinatorial explosion. The motivating problem is *"find the optimal monthly expense amount for each of several age bands until death."* With `K` bands and `M` candidate amounts each, the grid is `M^K` — e.g. 5 bands × 20 amounts = **3.2 million** full simulations. Grid search is the wrong tool the moment the decision space is a vector.

This design **decouples the search strategy from the problem** and introduces a pluggable **solver** abstraction, selected via a new *Solver* `<select>` on the OPT panel (mirroring the existing *Objective* select). The exact grid search becomes one solver among several; new solvers (pattern search, simulated annealing, …) explore large spaces without enumerating them. The same `evaluate(candidate)` simulation harness is shared by every solver, so results stay directly comparable, and the same engine is reused by the MPC controller (design 39) as its inner optimization.

The load-bearing decision: extract the reusable jewel that already exists inside `IntlRetirementOptimizer` — the **isolated-registry per-candidate simulation harness** (`_runOne`) — into a first-class `OptimizationProblem` (the black box `f(x)`), and reduce a "solver" to *the policy that decides which candidates to evaluate next*. `OptimizationProblem` is deliberately built to roll forward from **either** the scenario start (batch) **or** a mid-run snapshot (design 39's MPC), so a single `evaluate` serves both engines (§3.1).

Two concrete problems drive the design and exercise different seams: **optimal monthly expense per age band** (§6.1 — many continuous levels, the explosion case) and **optimal Roth conversion, when + how much** (§6.3 — ordinal bracket-ceiling controls whose payoff is purely a lifetime-tax/wealth quantity). The latter is also the flagship closed-loop use-case for design 39.

---

## 2. Today

Grounded against the live code (2026-06-26):

- **One monolith does three jobs.** `IntlRetirementOptimizer` (`src/finance/optimization/intl-retirement-optimizer.js`) (a) generates candidates as the Cartesian product of enabled configs (`_generateCandidates` / `cartesianProduct`), (b) evaluates each in an **isolated `ServiceRegistry`** so the user's live scenario is untouched (`_runOne`: build scenario → `ScenarioLoader.load` → `stepTo(endDate)` → read `sim.state`), and (c) scores + sorts. Only (b) is intrinsically valuable and reusable; (a) and (c) are strategy-specific.
- **Decision variables are declarative and already support nested paths.** `DEFAULT_OPTIMIZATION_CONFIGS` carries `ENUM | INTEGER | CONTINUOUS` configs; `buildShockOptConfigs` *dynamically generates* per-shock variables with nested keys like `shocks[0].severity`; `_applyCandidate` writes them via `set(params, k, v)` (design 25a). **A per-band variable list reuses this mechanism verbatim.**
- **Objectives are a tiny registry.** `OPTIMIZATION_OBJECTIVES` (`optimization-objectives.js`): `{ label, direction, evaluate(result) }`. The optimizer always maximizes internally and negates for `minimize`. Current entries: `MAX_NET_WORTH`, `MAX_ROTH_BALANCE`, `MIN_DEFICIT`, `MAX_NET_LIQUIDITY`.
- **The UI is one panel.** `OptConfigPanel` renders an Objective `<select>` + a grouped variable table with per-row enable + min/max/step. `candidateCount` is the product of enabled value-set sizes. Adding a **Solver `<select>` beside Objective** is a small, idiomatic change.
- **Terminal metrics exist; running accumulators mostly don't.** `computeNetWorth(state, baseCurrency)` and `computeNetLiquidity(state, date)` are ready. `state.cumulativeDeficit` is accumulated by `AccumulateDeficitReducer`. **There is no lifetime-tax accumulator** — taxes settle per-period (`TAX_SETTLE_APPLY`) but are not summed into a single state field (§5.3).

---

## 3. Architecture — three pieces

Split the monolith into three composable parts. Nothing about the existing default behavior changes; grid search is re-expressed on top of the new seams.

### 3.1 `OptimizationProblem` — the black box `f(x)`

Owns everything that is *not* search strategy:

```
OptimizationProblem {
  variables       // [{ paramKey, type, min/max/step | values, group }]   (the search space)
  baseParams      // scenario params applied to every candidate
  initialState    // HOW each rollout begins — see "Initial-state provider" below
  objective       // entry from OPTIMIZATION_OBJECTIVES (§5)
  simStart, simEnd

  evaluate(candidate) -> { result, score }   // ONE isolated simulation (today's _runOne + objective)
  encode(candidate)   -> number[]            // candidate object  -> numeric vector
  decode(vector)      -> candidate           // numeric vector    -> candidate object (snaps INTEGER/ENUM)
  randomCandidate(rng)                        // seeded sample within bounds
  candidateCount()                            // exhaustive size (∞-safe: returns null when unbounded)
}
```

`evaluate` is the shared, deterministic, side-effect-isolated simulation. Every solver calls it; no solver knows how a candidate becomes a score. `encode`/`decode` exist so vector-oriented solvers (annealing, pattern search, CMA-ES) can operate in ℝⁿ while categorical/integer variables snap back to legal values on `decode`.

#### Initial-state provider — the seam with design 39

`evaluate` must roll forward from **either** the scenario start **or** a mid-run snapshot, so the *same* black box serves the batch optimizer and the MPC controller (design 39) without a second evaluate path. `initialState` is a small strategy:

```js
initialState = { kind: 'compile',  cfgTemplate }            // batch: build + step from t0 (today's _runOne)
initialState = { kind: 'snapshot', snapshot, cfgTemplate }  // MPC:   inject a now-snapshot, step forward
```

- **`compile`** is today's behavior unchanged: build the scenario in an isolated `ServiceRegistry`, `stepTo(simEnd)`.
- **`snapshot`** still *compiles the scenario* in the isolated registry (to rebuild the deterministic wiring — handlers, reducers, schedules), then **injects the snapshot's `state` + event queue** instead of re-simulating the past, and steps forward from the snapshot date. This is the snapshot-seeded rollout primitive; it lives **here in design 38** as an `OptimizationProblem` capability so both engines share it. Mechanics and the event-serialization detail are in design 39 §2/§5; the contract that makes it sound is the shared invariant below.

> **Shared invariant — deterministic compile across registries.** Both `kind`s, and every solver, assume that compiling the same scenario cfg in a fresh `ServiceRegistry` produces **identical wiring and `stateKey` slot assignments** every time. The batch path already trusts this (its isolated-registry `evaluate` would be meaningless otherwise); the snapshot path *depends* on it so an injected snapshot's `stateKey`s line up with the freshly-compiled handlers/reducers. This invariant is the first thing design 39 Step 1 must prove.

### 3.2 `Solver` interface + `SOLVER_REGISTRY`

A solver is *a policy for choosing which candidates to evaluate*:

```
Solver.solve(problem, { onProgress, seed, budget, signal }) ->
  { candidates: [{ candidate, result, score }], best, evaluations, solver }
```

`SOLVER_REGISTRY` is a named-things registry exactly like `OPTIMIZATION_OBJECTIVES` and `SPENDING_STRATEGY_REGISTRY`:

```js
SOLVER_REGISTRY = {
  GRID:               { label: 'Grid Search (exact)',     factory, optionSchema },
  PATTERN_SEARCH:     { label: 'Pattern Search',          factory, optionSchema },
  SIMULATED_ANNEALING:{ label: 'Simulated Annealing',     factory, optionSchema },
  RANDOM:             { label: 'Random / Latin Hypercube',factory, optionSchema },
  // CMA_ES: next step (§4)
}
```

`optionSchema` is a small typed param list (same shape the spending strategies use) so the UI can render solver-specific knobs generically (budget, seed, population size, temperature schedule…).

### 3.3 Backward-compatible refactor

`IntlRetirementOptimizer` becomes a thin shim: it constructs an `OptimizationProblem` from its current args and runs `GridSearchSolver`. `GridSearchSolver.solve` is today's `_generateCandidates` + loop + sort, now calling `problem.evaluate`. Existing tests (`intl-retirement-optimizer.test.mjs`) and the OPT panel keep working with the default solver; the registry just makes other solvers selectable.

---

## 4. Solvers (first cut)

All solvers are **deterministic given a seed** (use the framework's seeded `Distributions` RNG, not `Math.random`) — consistent with the project's reproducibility ethos and required for the MPC controller's warm-started replans (design 39).

| Solver | Strategy | Best for |
|---|---|---|
| **`GRID`** (existing) | Exhaustive Cartesian enumeration. | Low-dim, small ranges. Exact. Default. |
| **`PATTERN_SEARCH`** | Hooke–Jeeves / coordinate descent: line-search one coordinate at a time, then pattern moves; shrink step on stall. | The expense-band problem — adjacent bands are weakly coupled, so coordinate moves are cheap and near-optimal. |
| **`SIMULATED_ANNEALING`** | Seeded stochastic local search over the encoded vector; Metropolis acceptance with a cooling schedule. | Discrete "many amounts" grids; rugged landscapes; escaping local optima. |
| **`RANDOM`** | Seeded uniform / Latin-hypercube sampling within bounds. | Cheap baseline + seeding/benchmarking the smarter solvers. |
| `CMA_ES` / GA *(next step)* | Population-based, continuous, self-adapting covariance. | Higher-dimensional continuous spaces; documented follow-up, not first cut. |

Stopping is **budgeted** (`budget` = max evaluations) with optional convergence tolerance (no improvement over `N` evals). The OPT panel's `candidateCount` becomes an *exhaustive* count for `GRID` and a *budget estimate* for the rest.

---

## 5. Objectives — generalized registry (running + terminal)

The control framing (design 39) wants objectives expressed as a **running cost over time plus a terminal cost** — `J = Σ_t running(x_t, u_t) + terminal(x_T)`. The clean way to express the running part in *this* framework is **not** an objective-side per-step callback (the batch `evaluate` only ever sees final state — it never instruments the sim loop, so such a hook would have nothing to call it). Instead, **running quantities are cumulative accumulators written into `sim.state` by reducers** — exactly how `cumulativeDeficit` already works today — and **objectives are pure functions of the final state** (plus, for windowed horizons, the snapshot state).

### 5.1 Generalized shape

```js
OPTIMIZATION_OBJECTIVES[KEY] = {
  label, direction,                       // existing
  // Pure function of the final sim result. Reads terminal metrics (net worth)
  // AND cumulative running accumulators (lifetime taxes, lifetime consumption)
  // that reducers wrote into state over the run.
  evaluate(result, { snapshot } = {}) -> number,
}
```

This **simplifies** the original sketch: there is no `running(state, step)` callback. Existing entries are unchanged (`evaluate` already had this shape). The running/terminal *decomposition* survives — it's just realized as "terminal metrics + state accumulators," both read at the end.

**Windowed horizons (MPC) get the running delta for free.** When design 39 solves over a window `[t, t+H]` rather than to death, the cost incurred *within the window* is `accumulator(t+H) − accumulator(t)`. The snapshot at `t` already carries `accumulator(t)`, and the rollout ends carrying `accumulator(t+H)` — so `evaluate` subtracts the two via the optional `snapshot` argument. No per-step instrumentation, same accumulators, both engines.

### 5.2 New objectives (the user's set)

- **`DIE_WITH_TARGET`** *(headline — "die with zero, or with \$XX")*. A `terminalWealthTarget` param (default `0`). Maximize lifetime real consumption subject to terminal net worth landing on the target: `score = lifetimeConsumption − λ · |NW_T − target|` (soft two-sided penalty; `λ` large enough to make the target binding). This is what makes the band solution an **interior** point rather than saturating — spend-early ⇄ leave-less is the whole trade-off.
- **`MAX_NET_WORTH`** / **`MAX_NET_LIQUIDITY`** — already present; reclassified as pure terminal objectives.
- **`MIN_LIFETIME_TAXES`** *(running)* — minimize total tax paid over life. Requires the accumulator in §5.3.

### 5.3 `cumulativeTaxesPaid` accumulator (honest prerequisite for min-tax)

There is no single lifetime-tax field today. Add a small `AccumulateTaxesPaidReducer` (mirrors `AccumulateDeficitReducer`) that sums `TAX_SETTLE_APPLY.tax` into `state.cumulativeTaxesPaid`, registered by the tax toolsets, formatted via `StateSchemaRegistry`. Small, additive, independently testable, and useful beyond optimization (chartable KPI).

---

## 6. Decision variables, controls, and concrete use-cases

### 6.0 Two shared contracts (used by both engines)

**The `controllable` param facet.** The batch optimizer searches over every param flagged `opt`. The MPC controller (design 39) can only actuate the **subset that is forward-adjustable at runtime** — you can re-decide next year's spending or this year's Roth conversion, but you cannot re-decide a birth date or un-sell a house already sold at the current "now." So the param schema gains a second facet, `controllable: true`, meaning "actuatable forward mid-run." It is defined **here** (it's a property of the variable) and merely *consumed* by design 39, where the control vector is `controllable ⊆ opt`.

**Fixed structure, variable levels; heterogeneous multi-control.** Decision variables tune **levels**, not **structure**: band *boundaries* (start ages), conversion *windows*, the *number* of bands — these are fixed limits the user sets (your "limits on the bands and amounts"), so the decision vector keeps a fixed dimension. The vector is **heterogeneous and multi-control** — continuous amounts *and* ordinal bracket ceilings coexist (§6.1, §6.3), each just a `paramKey` to the variable list. Keeping structure fixed is what lets design 39 hold a static, fixed-dimension control vector across receding-horizon replans.

### 6.1 Use-case A — the expense-band problem · `EXPLICIT_BANDS` spending strategy

A new design-33 sibling in `SPENDING_STRATEGY_REGISTRY`. Where `AGE_BANDED` applies a *multiplier* table on a base expense, `EXPLICIT_BANDS` carries **absolute monthly amounts** per band and materializes `state.expenses` directly:

```js
spendingExpenseBands: [
  { startAge: 65, monthlyAmount: 7000 },
  { startAge: 75, monthlyAmount: 6000 },
  { startAge: 85, monthlyAmount: 5500 },
]
```

Reducer mirrors `AgeBandedSpendingReducer` (listens on `*_PERIOD_ADVANCE`, residence-gated, idempotent) but *sets* the slice to the band's amount (inflation-compounded from a base year) rather than multiplying. "Optimal monthly expense amount" wants amounts, so this is the natural lever; it composes with inflation and with the portfolio-reactive strategies (guardrail/regime) on top.

### 6.2 Decision variables — generated per band, like shocks

`buildExpenseBandOptConfigs(params)` (sibling of `buildShockOptConfigs`) emits one variable per band:

```
spendingExpenseBands[0].monthlyAmount  INTEGER  min..max step   group 'Spending Bands'
spendingExpenseBands[1].monthlyAmount  ...
```

`_applyCandidate`'s existing `set(params, key, v)` already routes nested paths correctly — **no engine change**. The user's "limits on the bands and amounts" map to: band **count** (how many band rows the strategy has) and per-variable **min/max/step** (the UI row controls). Monotonicity ("spend can only step down") is an optional ordered-constraint flag the solver honors when generating/accepting candidates (§10 Q2).

### 6.3 Use-case B — optimal Roth conversion (when + how much)

The second flagship problem: choose **how much to convert from Traditional → Roth each year**, trading higher tax now against lower RMD-driven tax (and the widow's penalty / IRMAA) later. The interplay with bracket boundaries is the whole point.

The codebase is already shaped for it. `us-roth-conversion-toolset.js` parameterizes the conversion as a **bracket ceiling**, not raw dollars: `rothConversionMaxBracket` → "fill ordinary income to the top of this marginal bracket" via `usBracketGrossIncomeCeiling(maxBracket, year, inflation)`, bounded by `rothConversionStartYear`/`rothConversionEndYear`. That ceiling form is the right control variable — it's kink-aware (auto-adjusts to other income) and **ordinal/discrete** (which bracket, or none), which is exactly why the *sampling* solvers (and design 39's sampling MPC) suit it and a QP cannot touch it directly.

Two parameterizations, one per engine — both just `controllable` param paths:

- **Batch (this design):** the existing low-dimensional triple — `rothConversionStartYear`, `rothConversionEndYear`, `rothConversionMaxBracket` (an `ENUM` over `US_MFJ_BRACKET_RATES`, already in `DEFAULT_OPTIMIZATION_CONFIGS` conceptually). Cheap to grid/pattern-search.
- **Closed-loop (design 39):** a **per-year ceiling schedule** — `rothConversionSchedule: [{ year, bracketCeiling }]` — the `EXPLICIT_BANDS` analog, so the controller can re-decide each year's ceiling from realized state instead of committing to one window up front. This generalizes the existing state-reactive `DOWNTURN_ROTH_CONVERSION` behavioral strategy.

Scoring leans entirely on the **state accumulators** of §5: the value of a conversion schedule shows up only in `cumulativeTaxesPaid` and terminal net worth — there is no terminal-only way to see it, which is precisely why §5's "running = accumulator" decision is load-bearing. This use-case also stresses the multi-control vector: spending bands and conversion ceilings are optimized **jointly**, because spending → drawdown → taxable income → optimal conversion.

---

## 7. UI

`OptConfigPanel` gains, next to the Objective `<select>`:

- a **Solver `<select>`** populated from `SOLVER_REGISTRY`;
- a **solver-options block** rendered from the selected solver's `optionSchema` (budget, seed, and solver-specific knobs);
- the candidate badge reads "*N candidates (exhaustive)*" for `GRID` and "*≤ B evaluations*" for budgeted solvers.

`getConfig()` returns `{ ...existing, solverKey, solverOptions }`; the presenter/controller pass them into the new `OptimizationProblem` + solver. No change to the results/runs panels — they already consume `{ candidates, best, totalRuns }`, which `solve` preserves.

---

## 8. Out of scope (here)

- **Gradient-based / QP / MPC solvers** — they belong to design 39's *inner loop* (local linearization of the plant), not the batch panel.
- **Parallel rollouts / web-worker fan-out** — a performance follow-up; the harness is already isolated per candidate, so it parallelizes cleanly later.
- **Empirical calibration** of default band tables / objective penalty weights.

---

## 9. Testing sketch

- `optimization-problem.test.mjs` — `encode`/`decode` round-trips (INTEGER/ENUM snapping); `evaluate` isolation (active scenario untouched); `randomCandidate` respects bounds + seed determinism.
- `solver-registry.test.mjs` — registry lookup; each solver recovers the known optimum of a cheap analytic toy `OptimizationProblem` (e.g. a quadratic over 2 vars) within tolerance; seed determinism.
- `intl-retirement-optimizer.test.mjs` — **unchanged** expectations under the `GRID` default (backward-compat gate).
- `spending-explicit-bands.test.mjs` — reducer sets the slice to the band amount, inflation-composes, residence-gated, `monthlyExpenses` sum stays consistent.
- `opt-band-vars.test.mjs` — `buildExpenseBandOptConfigs` emits nested-path vars; `set()` routes them; band count + amount limits respected.
- `objectives.test.mjs` — `DIE_WITH_TARGET` penalty is two-sided and binding; `MIN_LIFETIME_TAXES` reads `cumulativeTaxesPaid`.

---

## 10. Open questions

- **Q1 — Stop on budget or convergence?** *Recommended: both* — a hard `budget` cap plus an optional "no improvement in `N` evals" early-out. Budget is the user-legible knob; convergence saves wasted runs.
- **Q2 — Monotone-spending constraint?** *Recommended: optional flag.* Real plans often want non-increasing real bands (the spending "smile" decline). When set, solvers reject candidates violating `amount[i] ≥ amount[i+1]` (or project onto the ordered cone). Off by default so the optimizer can discover non-monotone optima.
- **Q3 — Mixed-integer handling in continuous solvers?** *Recommended: snap-on-decode* (round INTEGER, nearest-legal ENUM) for the first cut; branch-and-bound over categoricals is a later refinement.
- **Q4 — Does `EXPLICIT_BANDS` replace or compose with `AGE_BANDED` (design 33)?** *Recommended: compose.* They are different levers (absolute schedule vs. real-multiplier glide); a plan may pin a base schedule and still let the smile/guardrail bend it.
- **Q5 — Where does `terminalWealthTarget` live?** *Recommended: a first-class scenario param* (round-tripped, design 15), so it's editable outside the optimizer and reusable by the MPC terminal cost (design 39).
- **Q6 — One Roth control form or two?** *Recommended: two, by engine.* Batch keeps the cheap `start/end/maxBracket` triple; the controller uses the per-year `rothConversionSchedule` array (§6.3). They describe the same mechanic at different resolutions — confirm the toolset can consume either without a fork in the conversion reducer.

---

## 11. Step-by-step implementation plan

### Status legend
- [ ] not started · [x] done

**Step 1 — `OptimizationProblem` + initial-state provider** [x]
- `src/finance/optimization/optimization-problem.js`: lift `_runOne` + objective scoring into `evaluate`; add `encode`/`decode`/`randomCandidate`/`candidateCount`. Pure of any search strategy.
- Implement the `initialState` strategy: `kind: 'compile'` (today's t₀ build) and `kind: 'snapshot'` (compile wiring + inject `state`/queue, step forward). Add a **deterministic-compile-across-registries** test (same cfg → identical `stateKey` slots + wiring) — the invariant design 39 stands on.
- Add the `controllable` facet to the param schema (consumed by design 39; inert here).

**Step 2 — Solver interface + registry + `GridSearchSolver`** [x]
- `src/finance/optimization/solvers/` (`grid-search-solver.js`, `solver-registry.js`). `GridSearchSolver` reproduces today's enumeration on top of `problem.evaluate`. Re-point `IntlRetirementOptimizer` at it (shim) — backward-compat gate (Step from §9).

**Step 3 — `PATTERN_SEARCH` + `RANDOM`** [x]
- Coordinate/pattern search and seeded random/LHS. Toy-problem tests.

**Step 4 — `SIMULATED_ANNEALING`** [x]
- Seeded Metropolis + cooling schedule; `optionSchema` (temperature, cooling, budget).

**Step 5 — Objectives (pure-of-final-state) + `cumulativeTaxesPaid`** [x]
- Keep `evaluate(result, { snapshot })` shape; add `DIE_WITH_TARGET`, `MIN_LIFETIME_TAXES` reading cumulative accumulators; windowed delta = terminal − snapshot accumulator. `AccumulateTaxesPaidReducer` (mirrors `AccumulateDeficitReducer`) + schema registration. **No** per-step objective callback.

**Step 6 — Spending + Roth-conversion controls** [x]
- `EXPLICIT_BANDS` spending strategy (design-33 sibling reducer) + `buildExpenseBandOptConfigs`; mark band-amount vars `controllable`.
- Roth: ensure `rothConversionMaxBracket`/`StartYear`/`EndYear` are sweepable batch vars; spec the per-year `rothConversionSchedule` array as the design-39 control form (mark `controllable`). Wire both into `buildOptVariables`.

**Step 7 — UI: Solver select + options block** [x]
- `OptConfigPanel` Solver `<select>` + `optionSchema` renderer; `getConfig()` returns `solverKey`/`solverOptions`; presenter/controller thread them through.

**Step 8 — Browser verification** [x]
- Per CLAUDE.md: run the dev server; on the expense-band problem confirm `PATTERN_SEARCH`/`SIMULATED_ANNEALING` reach near-`GRID` optima at a fraction of the evaluations; confirm `DIE_WITH_TARGET` lands terminal NW on target.

### Out of this plan (tracked elsewhere)
- QP / MPC inner solve → design 39.
- CMA-ES / GA solver → follow-up.
- Worker-parallel rollouts → performance follow-up.
