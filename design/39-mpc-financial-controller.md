# 39 — MPC Financial Controller (closed-loop advisor cockpit)

**Status**: Proposed (draft 2026-06-26)
**Related**: `design/38-optimization-solver-framework.md` (**hard dependency** — the controller's inner solve *is* an `OptimizationProblem` + solver), `design/40-after-tax-net-worth.md` (**prerequisite for the Roth flagship** — the objective re-pricing that gives the conversion lever a gradient; see §12.5), `design/30-decision-graph-analysis.md` (the implemented scenario-comparison surface the "futures fan" rides on), `design/17-scenario-as-graph-node.md` (`DERIVES_FROM` parent edges — how a candidate future is recorded as a scenario derived from "now"), `design/33-age-banded-spending.md` / `EXPLICIT_BANDS` (the spending control lever), `design/18-performance-enhancements.md` (rollout cost).

> **Reading note**: design 38 is the *engine* (search over a horizon, offline). This is the *driver* — a closed-loop, receding-horizon controller that calls that engine repeatedly as life unfolds, and a cockpit UI to drive it. They share one `evaluate`/objective core; nothing here re-implements search.

---

## 1. Purpose

The OPT panel (design 38) answers *"what's the single best fixed plan over the whole horizon?"* — **open-loop**. That's the right question once, at the start. It is the wrong question every year after, because the future keeps revealing itself: markets move, you move countries, a house sells, a parameter you guessed turns out wrong.

This design adds a **closed-loop, receding-horizon controller** — Model Predictive Control — layered over the *steppable* simulation. The experience: **play your financial life up to "now," and let the controller advise the next move out into the future**, re-solving as "now" advances. Instead of guessing a parameter and re-running, you stand at the present, see the realized past and a fan of possible futures, and the algorithm tells you what you *could / should* do next — a **financial flight director**, with you as the human in the loop.

The load-bearing decision: the MPC **inner solve reuses design 38 wholesale** (an `OptimizationProblem` over a look-ahead horizon, solved by a budgeted solver), and the **rollout substrate reuses the optimizer's proven isolated-registry simulation** (`_runOne`) — extended to start from a **now-snapshot** rather than t₀ (the snapshot provider is owned by design 38 §3.1). No new simulation primitive, no autonomous control of the user's money; it advises, you decide.

**Flagship use-cases.** The first is **optimal Roth conversion** — re-decide each year's bracket ceiling from realized state (market level, current taxable income, balances), generalizing the existing fixed-window policy and the state-reactive `DOWNTURN_ROTH_CONVERSION` behavioral strategy. Its payoff is *purely* an intertemporal tax/wealth quantity, so it's the truest test of the closed-loop value proposition. The second is **age-banded spending** — adjust the spending level as life and markets unfold toward a "die-with-target" terminal. They are optimized **jointly** (spending → drawdown → taxable income → optimal conversion).

---

## 2. Substrate — what already exists (and what doesn't)

Grounded against the live code (2026-06-26):

- **The sim is steppable/playable.** `Simulation.stepTo(date)`, pause/resume via `sim.control`, and `SimulationHistory` (`restoreSnapshot`, `rewind`, `rewindToDate`, `replayTo`). This is the "play up to now" substrate.
- **Mid-run event-stream branching is *not* implemented.** Design 3 (forkable timelines) was **superseded** by design 17 (scenarios as `SimGraphNode`s with `DERIVES_FROM` edges) and design 30 (decision-graph analysis). **So the controller must not assume a live `branch()` primitive.** Instead, a candidate future is a **rollout in an isolated `ServiceRegistry`** (the optimizer's `_runOne` pattern) seeded from the now-snapshot — cheap, side-effect-free, already battle-tested by the grid search. This rollout primitive is **owned by design 38** as the `OptimizationProblem` `initialState: { kind: 'snapshot' }` provider (38 §3.1), so the controller does not re-implement evaluation — it constructs a horizon `OptimizationProblem` seeded from the snapshot and hands it to a solver.
- **The snapshot already carries the event queue.** `SimulationHistory.takeSnapshot()` stores `state` (deep-cloned), `rngState`, **and** `queue` (a copy of the pending-event list from the heap's backing array). So seeding-from-now needs **no new re-derivation** — the future events are already captured. The one delta for the *cross-registry* hop is fidelity: today's snapshot shallow-spreads each event (`{ ...e }`), flattening `EventSeries`/`OneOffEvent` class instances into plain objects — fine for same-sim rewind, lossy across registries. So injection serializes the queue with the existing **`ScenarioSerializer._serializeEvent`** and re-hydrates via the **`TypeRegistry`** (the same round-trip saved scenarios use). "Carry the heap" means *this serialized event list*, not process-memory transport.
- **Shared invariant — deterministic compile across registries.** Snapshot injection assumes a fresh compile of the same cfg yields identical wiring + `stateKey` slots, so injected state lines up with freshly-built handlers/reducers (38 §3.1). Proving this is Step 1.
- **Live actuation already has a path.** A param edit flows `service.update → SERVICE_ACTION → SimulationSync` which re-wires the *active* sim. The controller applies a chosen move as a **forward-effective** edit at "now" — **not** a full Rebuild (which would re-run from t₀ and is subject to the rebuild/revert and harvest traps noted in the project's known-issues). §5 specifies apply-forward semantics.
- **A comparison surface exists.** Design 30 already renders "scenario A vs B side by side" over design-17 `DERIVES_FROM` scenarios. The futures fan is N derived candidate-scenarios compared through that surface, not a bespoke diff engine.
- **Terminal metrics are ready; running ones partly.** `computeNetWorth` / `computeNetLiquidity` exist; `cumulativeDeficit` accumulates; lifetime taxes do not yet (design 38 §5.3 adds `cumulativeTaxesPaid`). The MPC objective decomposition (§4) consumes these.

---

## 3. Control formulation

| Control concept | This system |
|---|---|
| **State** `x_t` | The full `sim.state` at time `t` (accounts, holdings, periods, residency, …). |
| **Control** `u_t` | The **`controllable ⊆ opt`** params (38 §6.0) effective forward from `t` — e.g. monthly expense per `EXPLICIT_BANDS` band, Roth-conversion bracket ceiling, drawdown order, move/sale timing. A **heterogeneous, fixed-dimension** vector: continuous amounts *and* ordinal bracket ceilings coexist. Structure (band boundaries, band count) is fixed; only levels are controlled. |
| **Plant** | The simulation stepping forward: **nonlinear, event-driven, non-smooth** (tax brackets, RMD thresholds, account exhaustion, FX, super preservation age), and partly **mixed-integer**. A deterministic black box. |
| **Objective** `J` | Reuses design 38's objective registry. Running quantities are **cumulative state accumulators** (`cumulativeTaxesPaid`, consumption), not a per-step callback; the **window cost** is `accumulator(t+H) − accumulator(t)`, and the snapshot at `t` already carries `accumulator(t)` (38 §5). "Die with target" is the terminal cost; "minimize lifetime taxes" is the accumulator delta. |
| **Receding horizon** | At decision epoch `t`, solve for `u` over `[t, t+H]` (or to death), **apply only the first segment** (freeze the controls whose epoch has passed), advance, **re-solve**. Epochs are **per-control** (§6). |
| **Warm start** | Seed each replan with the previous epoch's optimal sequence, shifted one step — the standard MPC trick; keeps each solve cheap. |

The reuse is exact: *one MPC solve* = construct an `OptimizationProblem` whose `baseParams` are the now-snapshot's effective params, whose `variables` are the control vector over the horizon, whose `cfgTemplate` rolls **from the snapshot**, and hand it to a design-38 solver.

---

## 4. Control strategy — where QP fits, honestly

The plant fights classical QP/LQR: it is non-smooth (kinks at every threshold), partly mixed-integer (categorical controls), and the project forbids runtime dependencies (no OSQP/quadprog — any QP must be a small hand-rolled solver). So:

1. **Backbone — sampling-based MPC** (random shooting → CEM → MPPI). No solver library, no gradients; it just rolls out candidate control sequences and ranks them by `J`. It eats the non-smoothness and the categorical controls natively, and it **is literally a design-38 solver run over the horizon** (`RANDOM`/`SIMULATED_ANNEALING`/`PATTERN_SEARCH` seeding the elite set). This is the recommended default.
2. **Optional local polish — SQP / real-time-iteration MPC.** Around the nominal trajectory, finite-difference the **sensitivities** of `J` and the constraints (terminal wealth ≥ bequest, contribution limits, bracket ceilings) to the *continuous* controls, form a small **QP** (quadratic CRRA-utility cost + linear constraints), solve with a hand-rolled active-set / projected-gradient routine, re-linearize next epoch. This is where the QP instinct lives — but it governs only continuous knobs in locally-smooth regions, so it's a *refinement* on the sampling elite, not the primary search.
3. **iLQR / DDP** — elegant, derivative-hungry, brittle on this non-smooth plant. Documented, deferred.

**Recommended:** sampling-based MPC as the backbone; QP/line-search polish on the continuous sub-vector as an opt-in second stage. CRRA running utility makes the per-step cost concave (well-posed QP) and makes **consumption smoothing fall out for free** rather than being imposed.

---

## 5. Actuation — apply-forward, not rebuild

Applying a recommended (or user-overridden) move must affect only `t > now`:

1. Snapshot state at "now" (`SimulationHistory`).
2. Set the chosen control params on the live services so `SimulationSync` re-wires schedules/reducers **going forward** (re-schedule future events, re-register reducers) without replaying the realized past.
3. Record the resulting forward path as a scenario **`DERIVES_FROM`** the now-snapshot (design 17), so it is inspectable/comparable and the decision is auditable (design 30).

This deliberately avoids `ScenarioLoader`'s full compile-from-t₀ path. Validating that a forward-effective param edit produces the same trajectory as a from-scratch run *with that param from `now`* is the key correctness test (§9).

---

## 6. Decision epochs — per-control grids

Different controls are re-decided on **different cadences**, so there is no single global epoch grid. Each control carries its **own epoch grid**:

- **Spending bands** — re-decided on **age-band boundaries** (the natural cadence for the expense use-case).
- **Roth conversion** — re-decided **annually** (the year is the unit of the bracket-filling decision).
- **One-shot timed decisions** (move year, house sale) — a single epoch each, at the candidate date.

The controller's **global epoch set is the union of every control's grid, plus material events** (a move, a house sale, a modeled market shock/regime change — design 21) and **on-demand** ticks (the user scrubs "now" or asks "what next?"). At each global epoch, **only the controls whose own grid fires there are re-optimized**; the rest stay frozen at their last decision. This is what keeps the control vector fixed-dimension (38 §6.0) while letting heterogeneous controls move on their natural cadences — and it's precisely the structure the Roth + expense-band combination forced into the open.

---

## 7. Cockpit UI

A new interactive surface — **not** the OPT panel — living over the timeline/chart:

- **"Now" scrubber** dividing the **realized past (solid)** from the **predicted future (a fan of rollouts)**; the recommended path highlighted.
- **Recommended-next-move card** — human-legible: *"For ages 75–84, drop real monthly spend to $5,800; convert $40k to Roth this year."* With the predicted terminal outcome ("die with ≈ $0 at 92").
- **Apply / Override / Advance** controls — you can accept the recommendation, override any control, and the controller **replans around your choice** (advisor, not autopilot). Advancing steps "now" forward and triggers the next epoch.
- The futures fan reuses design 30's comparison surface (N candidate `DERIVES_FROM` scenarios), not a new renderer.

It's a new plugin (`WorkbenchComponent` + `definePlugin`) added to `FINANCE_PLUGINS`, subscribing to `SCENARIO_READY` and reading services via `ServiceRegistry`.

---

## 8. Cost & performance

Naïve cost is `epochs × candidates × horizon-length`. Mitigations, in order of leverage:

- **Now-snapshot rollouts** — each rollout starts at "now," not t₀, so horizons shrink as the user advances.
- **Warm-start** — shifted previous solution means few evaluations per replan after the first.
- **Budgeted solver** — design 38's evaluation budget caps each solve.
- **Horizon cap + terminal value** — a shorter window with a terminal value function (bequest/wealth target as terminal cost) instead of always rolling to death (§10 Q1).
- **(Later) worker-parallel rollouts** — the harness is already isolated per candidate.

---

## 9. Testing sketch

- `mpc-rollout.test.mjs` — a rollout seeded from a now-snapshot reproduces the tail of a full-horizon run from t₀ that used the same controls from `now` (snapshot-seeding correctness).
- `apply-forward.test.mjs` — forward-effective param edit at `now` ≡ from-scratch run with that param effective from `now`; the realized past is untouched (the §5 correctness gate).
- `mpc-loop.test.mjs` — receding-horizon loop on a toy objective converges to the known optimal policy; warm-start reduces evaluations on later epochs.
- `mpc-objective.test.mjs` — `DIE_WITH_TARGET` terminal cost drives terminal NW onto target across replans; CRRA running utility yields a smoother consumption path than linear utility.
- `mpc-sampling-vs-qp.test.mjs` — on a smooth sub-problem the QP polish improves on the sampling elite; on a non-smooth one it degrades gracefully (no chatter / divergence).

---

## 10. Open questions

- **Q1 — Horizon: full-life or windowed + terminal value?** *Recommended: start full-life* (cheap enough with now-snapshot rollouts, no terminal-value calibration needed); add a windowed mode with a terminal value function once cost demands it.
- **Q2 — Terminal value function calibration** (if windowed). Deferred until Q1 forces it; the natural terminal value is the `DIE_WITH_TARGET` penalty on end-of-window NW.
- **Q3 — Override re-plan UX.** When the user overrides a recommended control, do we replan *immediately* (responsive, more compute) or on the next *Advance* (cheaper)? *Recommended: immediate*, since the whole point is responsiveness.
- **Q4 — Snapshot seeding (resolved + prototype proven).** *Settled:* the snapshot already carries `state` + the event queue (§2), the primitive lives in design 38's `initialState: { kind: 'snapshot' }`. **Prototype result (Step 1, `tests/unit/mpc-rollout.test.mjs`):** with the US→AU **move (2031)** and a **house sale (2033)** both straddling a 2029 snapshot, a rollout seeded from the now-snapshot **compiled in a fresh `ServiceRegistry`** reproduces the full-horizon tail **metric-for-metric** (net worth, liquidity, Roth, cumulative taxes, deficit). So the **deterministic-compile-across-registries** invariant holds, and the queued events re-hydrate faithfully across registries. **Finding that revises the §2 plan:** the heap's queued items are already *plain data records* (the scheduling spread in `Simulation.schedule`, not live `EventSeries`/`OneOffEvent` instances), and re-firing is keyed by event `type` against the freshly-compiled handlers — so the plain `{ ...e }` queue copy is sufficient and the prescribed `ScenarioSerializer._serializeEvent` + `TypeRegistry` round-trip is **unnecessary** for functional fidelity. One real gap was closed: `_rollout` now restores the snapshot's `rngState` (was dropped), so stochastic rollouts (Q5) seed from "now".
- **Q5 — Stochastic MPC?** Replanning under Monte Carlo (maximize expected `J` s.t. success-rate ≥ threshold) is the realistic end state but multiplies cost by the MC sample count. *Recommended: deterministic MPC first*, stochastic as a later layer once the deterministic cockpit is proven.

---

## 11. Step-by-step implementation plan

### Status legend
- [ ] not started · [x] done

**Step 0 — Depends on design 38** — `OptimizationProblem`, solver registry, generalized objectives (`DIE_WITH_TARGET`), and `EXPLICIT_BANDS` must land first.

**Step 1 — Snapshot-seeded rollout primitive** [x] *(the new core — prototype first, §10 Q4; lands in design 38 as `initialState: { kind: 'snapshot' }`)*
- Compile the scenario in an isolated `ServiceRegistry`, inject a `SimulationHistory` snapshot's `state` + event queue, `stepTo` forward. **Prototype proved (§10 Q4)** the deterministic-compile-across-registries invariant + faithful event re-hydration via `tests/unit/mpc-rollout.test.mjs` (move + house sale straddling the snapshot reproduce the full-horizon tail metric-for-metric). The plain-object queue copy is sufficient — the `_serializeEvent`/`TypeRegistry` round-trip is unnecessary (queued items are already plain records re-fired by `type`). Closed one gap: `_rollout` now restores the snapshot `rngState`.

**Step 2 — Apply-forward actuation** [x]
- `src/finance/mpc/apply-forward.js`: `rollForwardWithControls()` is the forward-effective actuation — it reuses the Step 1 snapshot primitive (freeze the realized past in the injected snapshot; bake the NEW control into the fresh forward compile), so the edit is effective strictly from "now" with **no t₀ rebuild** (dodges the §5 rebuild/revert + harvest traps) and full isolation. `recordDerivedScenario()` lays the `DERIVES_FROM` audit trail (design 17).
- **Decision (revises §5 wording):** the rollout-level apply-forward is the snapshot-recompile primitive, **not** a live `SimulationSync` re-wire. The live re-wire mutates the user's running sim and is only needed by the *interactive* cockpit "Apply" — folded into Step 5 (recommended mechanism there: snapshot → recompile-with-new-controls → swap as primary, same primitive). `DERIVES_FROM` had no existing constructor in the code, so the recorder is intentionally minimal; the rich comparison surface is Step 5.
- **§9 gate proved** (`tests/unit/apply-forward.test.mjs`): with a date-keyed `EXPLICIT_BANDS` control (band boundary at age 55 / 2033), a forward-effective edit at a 2030 snapshot reproduces the from-scratch date-keyed tail **metric-for-metric**, the realized state at "now" is byte-identical to the reference, and a no-edit guard diverges (the edit genuinely took effect).

**Step 3 — MPC loop** [x]
- `src/finance/mpc/mpc-controller.js`: `runMpc()` is the receding-horizon driver — per epoch it builds a full-life horizon `OptimizationProblem` seeded from the now-snapshot, solves it with a design-38 solver warm-started from the previous decision, **commits the first segment** by advancing the snapshot to the next epoch (`OptimizationProblem.rollToSnapshot`, the new intermediate-date sibling of `_rollout`, extracted alongside `_seededSim`/`_injectSnapshot`), and re-solves. The loop is a pure orchestrator: `buildProblem`/`advance` are DI hooks (default = real IntlRetirement problem). `makeInitialSnapshot()` rolls t₀→epochs[0] for the "play up to now." Full-life horizon (§10 Q1) means the last epoch's solve already rolled the committed trajectory to simEnd, so its result is the realized terminal.
- **Tested** (`tests/unit/mpc-loop.test.mjs`): on a toy 3-D quadratic the loop converges to the known optimum at every epoch, and warm-starting cuts later-epoch evaluations vs cold. A real end-to-end smoke drives the closed loop over the IntlRetirement scenario (`EXPLICIT_BANDS` band-amount control, GRID solver) and produces a finite terminal + committed forward control. *Note:* warm-start savings are dimension-dependent — negligible in 1-D pattern search (cost is the step-shrink convergence check, not the walk-in), material in higher dimensions.

**Step 4 — Sampling-based MPC backbone** [x]
- `src/finance/optimization/solvers/cem-solver.js`: `CemSolver` (`CEM`) — Cross-Entropy Method as a first-class design-38 solver (same `solve` contract, `EvalLedger` budget/dedup, seed-deterministic). Samples a Gaussian over the encoded vector, keeps an elite set, refits μ/σ with smoothing; integer/enum coordinates snap on `decode` (eats categorical/ordinal controls natively); broad `sigma0` first generation = random shooting; `start` warm-seeds the mean (the MPC replan). Registered in `SOLVER_REGISTRY` with an `optionSchema`. (MPPI = exponential score-weighting on the same machinery, deferred.)
- **CRRA running utility**: `AccumulateConsumptionUtilityReducer` (sibling of `AccumulateConsumptionReducer`) sums per-period CRRA utility `u(c)=(c^{1-γ}-1)/(1-γ)` of real (base-year USD) consumption into `state.cumulativeConsumptionUtility`, wired into US+AU retirement toolsets, gated by a new `crraGamma` param (default 1.5), schema-registered + serializer-registered. Objectives `MAX_CRRA_UTILITY` (running, windowed via snapshot delta) and `CRRA_DIE_WITH_TARGET` (running+terminal) added; `_readResult` surfaces `lifetimeConsumptionUtility`. Concavity makes **consumption smoothing fall out for free** (proved by test: smooth path beats uneven path of equal total).
- **Tested**: `cem-solver.test.mjs` (recovers the analytic optimum, snaps integers, deterministic, budget-respecting, warm-start, in-bounds) and `crra-objective.test.mjs` (utility math, FX/deflation, concavity/smoothing, both objectives). End-to-end smoke confirms the accumulator populates through a real run.
- *Calibration note:* `CRRA_DIE_WITH_TARGET`'s λ trades utils vs dollars, so it needs its own calibration distinct from `DIE_WITH_TARGET`'s (§10 Q2) — left overridable, not tuned here.

**Step 5 — Cockpit UI plugin** [x]
- `src/finance/mpc/cockpit-controller.js`: `CockpitController` — the headless, human-in-the-loop brain (advise / apply / advance) over the shared snapshot primitives, with built-in `COCKPIT_CONTROLS` (SPENDING, ROTH). `advise()` solves at "now" and returns the recommended move + a fan of per-step net-worth trajectories (`OptimizationProblem.rolloutSeries`, added here); `apply()` commits forward via `rollForwardWithControls` + records a `DERIVES_FROM` scenario; `advance()` rolls the committed plan to the next epoch.
- `mpc-cockpit-plugin.js` (`MpcCockpitPlugin`) + `assets/css/plugins/mpc-cockpit.css`: the cockpit surface — lever/goal/search selects, "Advise next move", recommended-move card (move + projected terminal), Apply/Override, "Advance ▶", and an inline-SVG futures fan (realized "now" → diverging candidate futures, recommended highlighted). Registered in `FINANCE_PLUGINS` + the default center layout. Thin DOM view; all rollout/solve logic in the controller.
- **Tested**: `tests/unit/cockpit-controller.test.mjs` (advise payload + fan, apply-commits-and-records, advance) and `tests/viz/mpc-cockpit-plugin.test.mjs` (render, fan SVG, override parsing).
- **Browser-verified** (per CLAUDE.md): reconfigured to `EXPLICIT_BANDS`, stepped to 2034, opened the cockpit, ran CEM advise → recommended-move card + 6-line fan rendered; Apply + Advance re-planned from the new "now". The verification **surfaced and fixed a real bug**: `ExplicitBandsSpendingReducer` re-pinned only at band *transitions* (idempotent on `appliedStartAge`), so a forward edit to an already-entered band's amount was a silent no-op (both goals gave identical terminals). Now it also re-pins when the band *amount* changes (`appliedAmount`), so apply-forward actuates mid-band — confirmed: `MAX_NET_WORTH`→$3k spend→$8.09M vs `DIE_WITH_TARGET`→$12k spend→$7.00M, a visibly diverging fan.
- *Deferred:* the realized-past series and deeper design-30 comparison-surface reuse — the fan currently draws the forward rollouts from "now"; the past is represented by the now-divider.

**Step 5a — Live-sim navigation (cockpit drives the real clock) — Phase A** [x]
- Wired the cockpit's **Advance** through the existing `TimeControls` (new `stepToDate()`), which drives the **live primary sim**; exposed `timeControls` on the runtime (re-assigned each rebuild). The cockpit's "now" is now `sim.currentDate`, tracked off the live sim bus (debounced `EXECUTION_END`), so stepping from the cockpit *or* the header →/slider keeps "now" + every panel (State/Chart/Holdings/Timeline) in lockstep. Advise keeps reading live state and rolling isolated candidates. Fixed a UTC date-format off-by-one in the cockpit. **Browser-verified**: cockpit Advance moves the header clock and the State panel to the advanced date.

**Step 5b — Live-sim actuation (Apply mutates the real plan) — Phase B** [x]
- Added a per-control `actuate()` hook + `liveActuatable` flag. **SPENDING** actuates forward by re-wiring the running `ExplicitBandsSpendingReducer`'s band amount via `reducerService.updateReducer` (→ `SERVICE_ACTION` → `SimulationSync`, the §5 live path) **and** persisting the value to the active scenario param so future Advise rollouts (which recompile from scenario params) and the live sim stay consistent. The realized past (journal/state) is untouched; the change bites at the next period advance via the Step-5 `appliedAmount` re-pin. **ROTH** is flagged `liveActuatable:false` for now (its conversion ceiling re-wire is the remaining follow-up). Apply reports whether it hit the live plan; non-actuatable controls fall back to projection + `DERIVES_FROM` audit.
- **Browser-verified** (the real closed loop): with `EXPLICIT_BANDS`, stepped to 2032 (Monthly Expenses ≈ $5,970 = $5k×inflation), Advise → override-Apply $11,000 → "Applied to the live plan"; Monthly Expenses unchanged *until* Advance, then re-pinned to **$13,934** (= $11k×inflation at 2033) — the accepted decision is baked into the live trajectory and reflected by the State panel. Forward-effective, not retroactive.
- *Remaining Phase B follow-ups:* live actuation for the ROTH ceiling; and note a Rebuild re-applies persisted control values from t₀ (standard Rebuild semantics), whereas live Apply is forward-only.
- **Lever correctness (found in review):** (1) controls gained an `appliesTo(baseParams)` + `requirement` — the cockpit now **disables Advise and explains why** when the lever can't affect the active scenario (e.g. the Spending lever needs `EXPLICIT_BANDS`; a scenario on `AGE_BANDED`/`FIXED` would otherwise advise on an inert `spendingExpenseBands` table and show a flat fan). (2) the Spending lever now targets the **band active at "now"** (matching the reducer's `bandForAge`), not blindly the last band — so at age 50 it tunes the current/near-term band, not the age-85 one.

**Step 5c — MPC save-points are decision records, not scenarios** [x]
- **Problem (found in review).** `recordDerivedScenario` (Apply's audit trail) writes graph nodes with `layer:'scenario'` + `prebuilt:false`, so `ScenarioRegistry.getUserScenarios()` scoops them up: they **render in the scenario picker** as if loadable and get **persisted to `fin-sim-scenarios` storage**; on reload `_init` **re-stamps their `mpc:…` id → `u:N`**, permanently turning decision logs into indistinguishable, un-loadable "user scenarios" (one user's storage held 7 scenarios, 4 of them these records).
- **What they actually are.** A thin MPC **decision record**: `{ asOfDate (the "now"), controlParams (the accepted move), result (projected terminal metrics) }` + a `DERIVES_FROM` edge to the parent. They carry **no** persons/accounts/toolsets/params/initialState, so they are **not** loadable scenarios — selecting + Load would compile nothing.
- **Decision — own graph layer, session-only (chosen).** Treat them as decision records, not scenarios — and store them as such. The root cause is the single `layer:'scenario'` line in `recordDerivedScenario`: a record is *not* a scenario, so it should not live in the scenario layer at all. The graph is already **layer-per-domain** (`scenario` → `ScenarioRegistry`, `execution` → `ExecutionGraph`, `analysis` → `DecisionGraphRegistry`), and each domain registry reads only its own layer. So:
  - **Give decision records their own `layer:'decision'`.** This is a *whitelist*, not Option #1's blacklist: `byLayer('scenario')` (and therefore `getUserScenarios()`, the picker, and `_persistUserScenarios()`) never sees them — no per-reader filtering, no `_init` re-stamp exposure, and no risk from future scenario-layer readers re-introducing the bug. They are **never written to `fin-sim-scenarios` storage** at the root, not patched out after the fact. The `DERIVES_FROM` edge is unaffected (edges are cross-layer).
  - **Session-only.** The `decision` layer lives in the graph but has **no storage backing**, so records last for the cockpit session and vanish on reload. This is the right scope now: Step 5c's whole complaint is that they currently persist *and* corrupt; an inspect-during-this-session log needs neither. Cross-reload persistence is Option #2 territory.
  - Surface them in a **dedicated "MPC Save Points" section** (a small cockpit list) reading `byLayer('decision')` — same pattern as `DecisionGraphRegistry` reads `'analysis'`. **Inspect-only**: *date · move · projected result*; later feed the futures-fan / design-30 comparison. No fake "Load".
  - Rename `recordDerivedScenario` → `recordDecisionRecord` (it stops claiming to make a scenario; ~3 call sites).
  - One-time cleanup: in `ScenarioRegistry._init`, purge already-persisted records from existing `fin-sim-scenarios` storage (drop `mpc:`-id / `derived` entries and re-save). With records no longer entering scenario storage, this is a one-shot migration, not an ongoing filter.
- *Why not Option #1 (flag-in-scenario-layer):* keeping `layer:'scenario'` + a `derived:true` flag means polluting a shared layer and then teaching every reader (`getUserScenarios`, `_init`, the picker, `_persistUserScenarios`, plus any future `byLayer('scenario')` caller) to exclude the pollutant — a fragile blacklist. The separate layer is strictly less code and fixes the bug at the root.
- *Deferred alternative (Option #2):* if load/branch from a save-point is wanted later, capture the **full committed plan** (parent toolsets/persons/accounts + committed params + sim window) so each is a real, loadable, comparable derived scenario, persisted to its own `fin-sim-decisions` key — and switch auto-record to an explicit "Save decision" action to avoid noise.
- **Implemented.** `recordDerivedScenario` → **`recordDecisionRecord`** (`apply-forward.js`), now writing `layer:'decision'` (never `'scenario'`, no `prebuilt`). `CockpitController.apply()` returns `recordId` (was `scenarioId`). New `readDecisionRecords(graph)` reads the `decision` layer as inspect-only summaries (`{ asOfDate, move, result }`, oldest-first), independent of the ephemeral controller. `ScenarioRegistry._init` purges leaked `mpc:`/`derived` entries from `fin-sim-scenarios` and re-saves (one-shot migration). Cockpit plugin renders an inspect-only **"MPC Save Points"** list (date · move · projected terminal), refreshed on mount + after Apply; CSS in `mpc-cockpit.css`. **No scenario-registry filtering needed** — the records simply never enter `byLayer('scenario')`. *Tested:* `apply-forward.test.mjs` (decision layer + excluded from scenario layer), `cockpit-controller.test.mjs` (apply records into `decision`), `scenario-registry.test.mjs` (migration purge + re-save), `mpc-cockpit-plugin.test.mjs` (save-points render + hidden-when-empty). All 788 pass. *Not browser-verified yet — see Step 7.*

**Step 5d — Objective solvency penalty (found in Step 5 browser verification)** [x]
- **Problem.** The `DIE_WITH_TARGET*` family scored `consumption − λ·|terminal − target|` with **no solvency term**, so it *rewarded insolvency*. Because terminal net worth/liquidity floors at 0, a plan that spends the portfolio to zero parks the terminal right next to a low target (tiny penalty) while maximizing the consumption term. Live repro (Spending lever, `DIE_WITH_TARGET_LIQUID`, target $5k, $30k ceiling): the optimizer recommended the **max $30k spend** whose own projected result was `scenarioFailed:true`, **362 deficit months**, **$23.2M cumulative deficit**, `finalNetLiquidity:0` — i.e. it advised bankrupting the user because $0 liquid is "closest to the $5k target." Not controller spin-up; a missing constraint in the objective.
- **Fix.** Added `DEFAULT_DEFICIT_PENALTY = 100` + `_deficitPenalty(result, snapshot)` = `μ · max(0, cumulativeDeficit_T − cumulativeDeficit_snapshot)` (MPC-windowed like the other accumulators), subtracted from `DIE_WITH_TARGET`, `DIE_WITH_TARGET_LIQUID`, and `CRRA_DIE_WITH_TARGET`. It is **zero for any solvent plan** (`cumulativeDeficit = 0`), so it never perturbs the interior "spend-early ⇄ leave-less" optimum — it only ranks failing plans below solvent ones. μ ≫ λ is safe precisely because it's inert unless a path runs dry; overridable per scenario via a new `deficitPenalty` param (wired through `OptimizationProblem._readResult` alongside `terminalWealthTargetPenalty`).
- **Tested** (`objectives.test.mjs`, +6): solvent plan unaffected (exact old formula); a solvent plan now beats the bankrupting plan on all three objectives; a documentation test showing the bankrupt shape *would have won* without the deficit; windowed-penalty math; `deficitPenalty` override.
- **Browser-verified** (same scenario/ceiling/objective): recommendation dropped from **$30,000 (bankrupt)** to **$10,568** with terminal liquidity **$1.07M** and net worth **$5.06M** — solvent, no deficit. *Note:* the single-band lever (it tunes only the band active at "now", §Step 5b) cannot fully draw liquidity down to a $5k terminal by death, so leaving a buffer is the constrained optimum, not a miss.

**Step 5e — Forward edit re-pins from "now," not the next annual boundary** [x]
- **Problem (found in Step 5 verification).** `ExplicitBandsSpendingReducer` only re-pins on the annual `*_PERIOD_ADVANCE`. So a forward-effective Spending edit made mid-year (the original Step 5b semantics, "unchanged until Advance, then re-pinned at the next year boundary") left **the entire current year spending the old amount** — the year you're standing in ignored the decision, and the lever looked weaker than it is. The projection had the same one-year lag (the snapshot carries the old `appliedAmount`), so live and projection were *consistent* but both lagged.
- **Fix — immediate re-pin, shared by live + projection.** Extracted the reducer's pin math into `pinExpensesForBand(state, band, cc)` and added `repinExpensesIfChanged(state, bands, asOfMs)` — both in `explicit-bands-spending-reducer.js`. The latter re-pins the band **active at "now"** off the period-advance grid, returning `null` (no-op) when there's no active EXPLICIT_BANDS pin or the band is unchanged (preserving within-band reactive/inflation drift — mirrors the reducer's own skip). Called from two places so projection == live: `OptimizationProblem._seededSim` (every snapshot-seeded rollout: `_rollout`/`rolloutSeries`/`rollToSnapshot`) and `SPENDING.actuate` (the live sim via `simulationRegistry.getPrimary()`). The reducer now also delegates to `pinExpensesForBand` (behavior-preserving refactor). Realized past untouched.
- **Tested**: `spending-explicit-bands.test.mjs` (+5: `repinExpensesIfChanged` re-pins on amount change, compounds by current price level, no-ops when unchanged / no pin / below first band) and `apply-forward.test.mjs` (+1 integration: rolling to "now" exactly, a $4k→$9k edit re-pins the current period to a 2.25× spend immediately, while a no-edit roll is unchanged). Full suite green.
- **Browser-verified** (live actuation, the part tests can't cover): at "now" = 2030 with band $40k (`monthlyExpenses` $45,020 = $40k×1.1255), override-Apply $10k → live `sim.state.monthlyExpenses` jumped to **$11,255** (= $10k×1.1255) **immediately, with no Advance** (was $45,020 until 2031 before the fix). `appliedAmount` and the scenario param both updated to $10k.
- *Note:* the State panel's "Monthly Expenses" **metric** is the last *debited* amount, so it still trails the live rate until the next monthly debit fires (a separate display-semantics issue, #2a, left open).

**Step 5f — "Auto" cockpit mode (unattended autopilot)** [x]
- **What.** A toggle that runs the cockpit closed loop unattended: per epoch it **advise → apply(recommended) → advance**, year by year, until "now" reaches `simEnd` — the advisor running with no human pause (override is ignored; auto always takes the recommendation). A second click stops it; the loop also stops on solver error, on an unapplicable lever, or a stall guard (the live clock failed to advance). Because the loop only checks the stop flag at its next yield (it may be mid-solve), Stop gives immediate feedback — `_beginStop()` flips the flag and the button reads **"Stopping…"**, disables, and pulses (`mpc-stopping`) until the loop's finally settles it back to "Auto ▶▶".
- **Headless brain.** `CockpitController.autoRun({ solverKey, solverOptions, stepYears, shouldStop, onEpoch })` (`cockpit-controller.js`) — the projection-only loop reusing the existing `advise`/`apply`/`advance` verbs; commits each recommendation into `this.committed` and rolls the committed plan forward exactly as a user clicking Apply+Advance each year would. Returns a per-epoch log; `shouldStop`/`onEpoch` are cancel/observe hooks.
- **Live plugin loop.** `MpcCockpitPlugin._auto()` drives the **live** sim: each epoch advises against the real "now," `_applyCandidate` actuates forward on the live plan (Step 5b path), then `_stepLiveForward` advances the real clock through `TimeControls`, and the loop **yields a frame** (`_nextFrame`) so the recommended-move card, futures fan, and every panel repaint and the user can watch the plan unfold and interrupt. Factored shared helpers out of the manual handlers (`_applyCandidate`, `_stepLiveForward`); manual Advise/Advance/Apply are disabled (and no-op) while the autopilot owns the clock. New "Auto ▶▶ / Stop ⏹" toolbar button.
- **Tested:** `cockpit-controller.test.mjs` (+3: autoRun chains to simEnd and logs every epoch; `onEpoch`/`shouldStop` fire + halt early; throws without a snapshot) and `mpc-cockpit-plugin.test.mjs` (+3: auto button renders; toggle stops a running loop; manual Advance no-ops mid-auto + `_setAutoButton` toggles label/disabled). All 791 viz + 2877 unit green.
- *Not browser-verified yet — see Step 7.*

**Step 6 — QP local polish (opt-in)** [x]
- `src/finance/optimization/solvers/qp-polish.js`: `qpPolish(problem, start, opts)` — the opt-in **second stage** (§4). It refines a sampling **elite** on the **continuous control sub-vector only** (ENUM/INTEGER coords frozen — a QP can't reach them): central-difference **gradient + diagonal Hessian** (the finite-differenced sensitivities), a **projected diagonal-Newton** step (concave coord `H<0` → `-g/H`; else gradient ascent), box bounds as the QP's linear constraints handled by **projection** (active-set on the bounds), and a **backtracking line search** that accepts only strict improvement. The line search makes the iterate **monotone**: smooth region → climbs; non-smooth/noisy point → search fails → **stops at the incumbent** (no chatter, no divergence). Since the incumbent is the elite, the polished result is **never worse** (the §9 graceful-degradation guarantee). `QpPolishSolver` (`QP_POLISH`) is the composite: run an injected base sampler (default `CEM`) → polish its best → merge keeping the global best (so the composite never regresses below the base). Registered in `SOLVER_REGISTRY` (base solver wired via `createSolver` in-module to avoid an import cycle; `base !== 'QP_POLISH'` forced) with an `optionSchema` (`base` / `budget` / `polishBudget` / `seed`); surfaced in the cockpit `SOLVER_OPTIONS` and auto-listed on the OPT panel.
- **Roth flagship:** with the income target continuous (Steps 8–10), the Roth sub-vector is exactly what this polishes; `J(incomeTarget)` is piecewise-smooth with kinks at bracket edges, and the polish operates in the smooth segments between them (real-sim smoke confirms the FD path runs on the live `rothConversionSchedule[i].incomeTarget` control and is graceful).
- **Tested** (`tests/unit/mpc-sampling-vs-qp.test.mjs`, +7, on the shared analytic toy): `qpPolish` improves a coarse elite to the optimum on a smooth concave objective; **degrades gracefully** on a non-smooth staircase (never worse, stays in bounds); leaves a purely INTEGER problem untouched (continuous-only); respects budget. `QpPolishSolver` registered with factory+optionSchema; a coarse `CEM` base reaches the optimum after polish and never regresses below it; `base:'QP_POLISH'` self-recursion is forced to a sampler. All suites green (unit 2903, viz 793).

**Step 7 — Browser verification** [ ]
- Per CLAUDE.md: play a scenario to mid-life, confirm the recommended-move card + futures fan render, apply a move, advance, and confirm the controller replans onto the `DIE_WITH_TARGET` trajectory.

**Step 8 — Wire `rothConversionSchedule` (continuous income-target form)** [x] *(flagship; see §12)*
- `us-roth-conversion-toolset.js` `schedules()`: when `rothConversionSchedule` is non-empty, it emits one `ROTH_CONVERSION_POLICY_EVALUATE` per `(scheduled year, owner)` carrying that year's `targetIncome`; empty ⇒ the existing start/end/`maxBracket` window (back-compat, unchanged). The entry is **`{ year, incomeTarget }`** in **real base-year (2025) USD**, compounded to the year's nominal target by the same inflation path the window uses (`Math.pow(1 + inflationRate, year − 2025)`, matching `usBracketGrossIncomeCeiling`) so the control units stay stationary across years (warm-start friendly). Legacy `{ year, bracketCeiling }` entries are still accepted (resolved through `usBracketGrossIncomeCeiling`). Years absent from the schedule are not converted (skip-years); a non-finite/negative `incomeTarget` is dropped (the `OFF` encoding). The conversion mechanism (`RothConversionPolicyHandler`: `convert = min(IRA, targetIncome − usOrdinaryIncomeYTD)`) is **unchanged** — only the *source* of `targetIncome` becomes the per-year schedule. A shared `emitYear(year, targetIncome)` helper backs both paths.
- **Tested** (`tests/unit/toolset-roth-conversion-schedule.test.mjs`, +7): schedule emits per-year events at the inflation-compounded targets; skip-years honored; `OFF`/non-finite/negative dropped; legacy `bracketCeiling` resolved; empty ⇒ legacy window (per-year, correct ceilings); a non-empty schedule overrides the window; disabled master switch ⇒ no events. Full unit suite green (2884).

**Step 9 — Continuous ROTH cockpit control + opt config** [x] *(flagship; see §12)*
- `cockpit-controller.js` `COCKPIT_CONTROLS.ROTH`: ENUM bracket → **continuous income-target** lever (`numeric:true`, `defaultRange { min:0, max:500k, step:5k }` in real base-year USD). `buildVariables()` emits a single `CONTINUOUS` variable for the year at "now" (`rothConversionSchedule[i].incomeTarget`, the annual epoch §6) — the receding-horizon loop re-decides each subsequent year as "now" advances; `min:0` is the `OFF` encoding (no separate binary, no mixed-integer). `describe()` reads "No Roth conversion this year" for `OFF`, else "Fill ordinary income to $X/yr (real) — N% bracket" (bracket derived from base-year brackets — inflation-free since target and edges deflate together). **Decision (revises §12.2/§3 wording):** the cockpit control is *single-year-per-epoch* (mirrors the SPENDING lever — fast, 1-D), not a simultaneous multi-year forward-tail vector; the per-year schedule emerges across epochs via the receding-horizon loop. A simultaneous multi-year vector (where Step 6's QP polish on a multi-dim continuous Roth sub-vector pays off most, and warm-start §3 matters) is the documented enhancement.
- **Scaffolding:** because `set()` never creates nodes, a `prepareBaseParams({ baseParams, asOf })` control hook ensures `committed.rothConversionSchedule` has an entry (with its `year`) for the year at "now" (append, preserve prior committed years, chronological, idempotent). The controller calls it via `_prepareControl()` at the start of `advise()`/`apply()`. SPENDING has no hook (no-op).
- `intl-retirement-opt-config.js`: added `buildRothScheduleOptConfigs(params)` (sibling of `buildExpenseBandOptConfigs`) emitting one `CONTINUOUS` controllable `rothConversionSchedule[i].incomeTarget` variable per schedule entry (`min:0` = OFF, `enabled:false`); the legacy single `rothConversionMaxBracket` ENUM stays for the batch optimizer. Wired into `buildOptVariables`.
- **Tested**: `cockpit-controller.test.mjs` (+6: numeric/range, `prepareBaseParams` append/preserve/idempotent, `buildVariables` index+type, `describe` OFF/bracket; +1 controller wiring: advise recommends a target → apply commits it into the schedule at the now-year). `opt-roth-schedule-vars.test.mjs` (+4: per-entry continuous controllable vars, none when empty, nested-path `set`, **end-to-end** — a higher income target converts more IRA→Roth / higher terminal Roth balance). One obsolete viz test updated (ROTH now enables the range inputs). All suites green (unit 2894, viz 792).

**Step 10 — Live actuation for ROTH (closes the Step 5b follow-up)** [x]
- `COCKPIT_CONTROLS.ROTH.liveActuatable = true` + `actuate()`: forward-effective live re-wire.
- **Decision (revises §5/Step 10 wording — like Step 2 revised §5):** Roth conversion is driven by scheduled `ROTH_CONVERSION_POLICY_EVALUATE` events, **not** a persistent reducer, and `SimulationSync`'s event-`UPDATE` path unschedules **by `type`** (`Simulation.unschedule(type)` → `removeAllByType`) — which would wipe *every* year's conversion. So `actuate` does **not** go through `SERVICE_ACTION`/`SimulationSync` for the live hop; it re-wires directly and non-destructively: (1) mutate the **future** queued conversion events for the now-year (`item.date` in the year **and** strictly after `sim.currentDate`) to the new **nominal** target (`real × (1+inflationRate)^(year−2025)`), leaving the realized past (already-fired events) and other years untouched; and (2) persist the chosen **real** target into the active scenario's `rothConversionSchedule` param (create/update the now-year entry) for Rebuild + recompiled-rollout consistency (the `SPENDING.actuate` param-persist mirror). The cockpit snapshot carries the mutated queue, so the next Advise stays consistent **without** relying on the param. Returns `true` when a live queued event changed (`false` but still persisted when none is queued — e.g. the year's conversion already fired).
- **Tested** (`cockpit-controller.test.mjs`, +2 and one flip): `liveActuatable` + `actuate` present; actuate re-wires the future now-year event to the inflation-compounded nominal target, leaves a different year and a same-year **past** event untouched (forward-effective), and persists the real target to the scenario param; graceful `false` (still persists) when no live event. All suites green (unit 2896, viz 792).
- *Window→schedule note (documented follow-up):* persisting a now-year entry to a scenario that currently relies on the legacy start/end/`maxBracket` **window** (empty schedule) materializes that year into an explicit schedule; since a non-empty schedule overrides the window on the *next recompile/Rebuild*, other window years would then be dropped from a recompiled run (the live sim keeps its existing window events, so the live trajectory is unaffected). For the intended cockpit usage (schedule-form scenarios, the per-year control the cockpit owns) there is no trap. Full window→schedule materialization on first actuation is the follow-up.
- *Remaining for §9-gate parity:* a `roth-apply-forward.test.mjs` proving a forward-effective schedule edit ≡ a from-scratch run with that schedule from "now" (mirrors the spending `apply-forward` gate) + browser verification (override-Apply a target → live re-wire, consistent advise after) — folded into **Step 7**.

> **Roth ⇄ Step 6.** With the income target continuous (Steps 8–10), the Roth sub-vector joins the continuous controls Step 6's QP polish can refine. `J(incomeTarget)` is piecewise-smooth with kinks at bracket edges, so QP operates in the locally-smooth segments between kinks (exactly the §4 design). Either order works: land Steps 8–10 first so Step 6 has a flagship continuous control to polish, **or** land Step 6 on the spending sub-vector first and fold Roth in afterward.

**Step 11 — Die-With-Target family completed to a 2×2 + grouped goal UI** [x]
- **Two independent axes.** The "die with target" goal has two orthogonal choices: the **running term** (real CONSUMPTION $ vs concave CRRA UTILITY) and the **terminal anchor** (net WORTH vs net LIQUIDITY — the spendable, lever-reachable pool). Three of the four existed; this adds the missing **`CRRA_DIE_WITH_TARGET_LIQUID`** (the right default when you value smooth consumption *and* the levers can't touch illiquid assets — house equity, age-locked super).
- **Factory, not copies.** All four share one formula `running − λ·|terminal − target| − μ·deficit`, so `optimization-objectives.js` generates them via `makeDieWithTarget({ running, terminal, label })` (kills the 4× duplication, keeps them in lockstep) and tags each with `family:'DIE_WITH_TARGET'` + `variant:{ running, terminal }`. Keys are unchanged ⇒ backward compatible (scenarios still serialize a single `objectiveKey`). Helpers: `DIE_WITH_TARGET_AXES` (axis menus), `resolveDieWithTargetKey({running,terminal})`, `groupedObjectiveOptions()` (collapse the family into one entry for selects), `OBJECTIVE_FAMILY_LABELS`.
- **Grouped UI (both surfaces).** The cockpit (`mpc-cockpit-plugin.js`) and OPT panel (`opt-config-panel.js`) render the family as **one "Die With Target" option** plus two sub-selects (**Basis**: Consumption/CRRA · **Terminal**: Net Worth/Net Liquidity), shown only when the family is selected, resolving back to the concrete key. The cockpit keeps its curated goal list (family + `MAX_NET_WORTH`/`MAX_NET_LIQUIDITY`/`MAX_CRRA_UTILITY`/`MIN_LIFETIME_TAXES`); the OPT panel lists every objective grouped. The cockpit recommended-move card annotates the target with its basis ("net-worth target" vs "liquid target").
- **Per-variant default λ (no re-tune on basis switch).** The penalty `λ·|terminal − target|` is in DOLLARS, but the running reward is dollars for CONSUMPTION and UTILS for CRRA (orders of magnitude smaller, scale-dependent on consumption level + γ), so a single fixed λ over-anchors the CRRA variants. `_defaultLambda(running, result)` now scales the CRRA default by the run's **marginal utility of consumption** `u'(c̄) = c̄^{-γ}` — the dollars→utils shadow price — so each dollar of terminal miss costs the same *leverage* as in the consumption variant. The `AccumulateConsumptionUtilityReducer` accumulates `cumulativeConsumptionMarginalUtility` + a count; `_readResult` surfaces the run average as `consumptionMarginalUtility`. Consumption variants keep `DEFAULT_TERMINAL_WEALTH_PENALTY`; an explicit `terminalWealthTargetPenalty` still overrides either. *Verified on a real run:* a fixed λ=10 made the CRRA penalty ~4.7e7 vs a reward of ~190 (terminal dominates ~2.5e5×); the auto-scaled λ gives penalty ~101 vs reward ~190 — balanced, matching the consumption variant.
- **Tested**: `objectives.test.mjs` (+7: complete 2×2 with family/variant tags; `resolveDieWithTargetKey` mapping; the CRRA×Liquid variant rewards utility & anchors on liquidity, ignoring net worth; `groupedObjectiveOptions` collapses the family; CRRA default λ auto-scales by `consumptionMarginalUtility`; consumption basis ignores it; explicit penalty overrides). `crra-objective.test.mjs` (+2: `marginalUtility` math; reducer accumulates sum+count → run-average `u′(c̄)`). `mpc-cockpit-plugin.test.mjs` (+2) and `opt-config-panel.test.mjs` (+2: grouping + `getConfig` resolution). All suites green (unit 2912, viz 796).

### Out of this plan (tracked elsewhere)
- Stochastic / MC-coupled MPC (§10 Q5).
- iLQR/DDP control.
- Worker-parallel rollout fan-out (design 18 territory).
- True mid-run branching event streams (superseded; not revived here).

---

## 12. Flagship deep-dive — optimal Roth conversion as a continuous income-fill control

*Expands the §1 flagship use-case and §11 Steps 8–10. This is the design the controller actuates; the §6 annual epoch grid and §3 control formulation are the frame.*

### 12.1 Problem statement (user)

Given a Traditional IRA, let the optimizer own the **whole conversion policy**:

1. **If at all** — whether to convert any IRA→Roth.
2. **Which years** — an arbitrary subset (skip-years allowed), not one contiguous window.
3. **How much / at what rate** — the per-year amount, with the realized tax rate falling out of where the conversion lands on the bracket ladder.

### 12.2 Decision variable — a per-year income-fill target (Option 1, chosen)

Per year `y`, the control is a **continuous ordinary-income fill target** `Tᵧ ∈ {OFF} ∪ [floor, cap]`, in **real (base-year) USD**. The dollars converted are *derived* by the existing bracket-fill policy:

```
convert(y) = min(IRA_balanceᵧ, Tᵧ_nominal − usOrdinaryIncomeYTDᵧ)
```

- **"Convert at all"** = ∃ `y` with `Tᵧ` active. **"Optimal years"** = the support of the schedule. **"Amount/rate"** = `Tᵧ` (display the marginal bracket it lands in).
- **`OFF`** is encoded as a target at/below the realized-income floor (no room ⇒ no conversion). This folds the per-year on/off decision into the *continuous* variable — **no separate binary, no mixed-integer**, keeping the lever QP-friendly.

**Why income-target, not a statutory bracket (enum) or a raw dollar amount:**

| Form | Control is… | Amount adapts to realized income? | Can stop mid-bracket? | QP-polishable (Step 6)? |
|---|---|---|---|---|
| **Income target (chosen)** | an income line | **yes** (derived) | **yes** | **yes** |
| Statutory bracket ceiling | a rate | yes (to bracket top only) | no | no (categorical) |
| Explicit dollar amount | the dollars | **no** | yes | yes |

The income target **dominates**: it keeps the state-reactive amount-derivation that makes conversion a natural closed-loop control (a low-income/down-market year auto-converts more into the same target), it resolves *between* statutory bracket edges where the optimum usually lives, it is a **superset** of the statutory-ceiling form (set `Tᵧ` to a bracket top), and it is the only continuous form that also hands the optimizer the income axis on which the plant's tax kinks live as clean reference lines. The advisor card can still *display* the derived bracket — legibility without the coarseness.

### 12.3 Mechanism reuse — no new event/reducer

`RothConversionPolicyHandler` already converts `min(IRA, targetIncome − usOrdinaryIncomeYTD)` (`roth-conversion-classes.js:156`); `RothConversionApplyReducer` handles the IRA→Roth move, holdings rescale, dated conversion lots, and the §408A 5-year recapture (`roth-conversion-classes.js:69`). **None of that changes.** The only change is the *source* of `targetIncome`.

**The gap.** `rothConversionSchedule` (`[{ year, bracketCeiling }]`) is declared (`us-roth-conversion-toolset.js:108`) but **inert** — `schedules()` (`:154`) builds events only from the start/end/`maxBracket` window. Step 8 wires the schedule (generalized to `incomeTarget`) into event emission; empty schedule ⇒ the legacy window (back-compat).

**Units decision.** `Tᵧ` is stored as **real base-year USD** and compounded to the year's nominal target by the same inflation path the window uses (`usBracketGrossIncomeCeiling`). This keeps the control vector **stationary** across years — so warm-starting (§3) shifts cleanly — *and* tracks the statutory brackets, which inflate. (`usOrdinaryIncomeYTD` is nominal that-year dollars, so the comparison is nominal-vs-nominal.)

### 12.4 Couplings the objective must see (called out, not re-solved here)

- **Tax funding.** A conversion adds to `usOrdinaryIncomeYTD` (`us-tax-module-2026.js:413`); the year-end tax is paid from the **normal drawdown sources, not the IRA**. So conversions consume the taxable/cash buffer — the objective and the §5d solvency penalty already guard against a plan that converts itself into insolvency.
- **Cross-border (the big lever).** AU does **not** tax the conversion itself (funds move within the US retirement system) — only later Roth *earnings* distributions; the US taxes it as ordinary income at conversion. So optimal conversion years cluster in **low-income, US-resident years before the AU move and before RMDs**. The **move-year and the Roth schedule are jointly optimized** (consistent with §1's "spending + conversion joint"; residency is the same hidden sequencing lever noted across the project).
- **RMDs.** The legacy window defaults to ending at age 72 (before RMD age 73). The schedule form **removes that artificial cap** — `Tᵧ` may be set past 73, where RMDs count toward `usOrdinaryIncomeYTD` and therefore *auto-reduce* remaining conversion room through the same fill formula (falls out, no special case). Conversions also lower the IRA balance and thus future RMDs — an intertemporal payoff the full-life horizon (§10 Q1) captures.

### 12.5 Objective

The user wants "various goals," so the lever stays objective-agnostic and user-selectable in the cockpit: `DIE_WITH_TARGET` / `MAX_NET_WORTH` (wealth/bequest), **minimize lifetime taxes** (the purest test of conversion value — consumes `cumulativeTaxesPaid`, design 38 §5.3), `MAX_CRRA_UTILITY` (smooth lifetime spendable). Roth's payoff is *purely intertemporal tax/wealth*, so it surfaces as higher terminal wealth or lower lifetime tax depending on the chosen objective.

> **⚠️ Objective blindness — see `design/40-after-tax-net-worth.md`.** As implemented through Step 11, **none of the cockpit's wealth/consumption objectives can actually see Roth conversion value**, so the lever is degenerate (browser-confirmed 2026-06-28: on *Die With Target → Consumption → Net Liquidity* it recommends the **max** income-fill target every epoch with an identical terminal across all save points). The root cause: `computeNetWorth`/`computeNetLiquidity` price a pre-tax IRA/401(k) dollar **at par** with a Roth dollar, so a conversion looks like pure tax loss (net-worth objectives → convert nothing) or pure noise (liquidity/consumption → flat → boundary/"max"). **Design 40** adds after-tax re-pricing as a *modifier orthogonal to the worth/liquidity scope* (a 2×2 of terminal measures) plus `MAX_AFTER_TAX_NET_WORTH`, giving the lever a real gradient. **Decision (design 40 D2):** the Roth lever defaults to `MAX_AFTER_TAX_NET_WORTH` (maximize — no targeting-trap), while die-with-target stays on the lever-reachable **liquid** scope. Design 40 is the prerequisite for this flagship lever being non-degenerate.

### 12.6 Testing sketch (detailed in §11 Steps 8–10)

- **Wiring** — non-empty schedule emits per-year events at the right nominal targets; empty ⇒ legacy window byte-identical; income-target reactivity (low-income year converts more); `OFF` ⇒ no conversion.
- **Closed loop** — over a toy tax ladder the loop recovers the known per-year targets, and the **"convert at all" decision genuinely flips** (never-convert wins on a flat ladder, convert wins on a stepped one).
- **Apply-forward** — a forward-effective schedule edit at "now" ≡ a from-scratch run with that schedule from "now"; the realized past is untouched (the §9 gate).
- **QP polish (with Step 6)** — on a locally-smooth segment QP improves the sampling elite's target; across a bracket kink it degrades gracefully (no chatter).
