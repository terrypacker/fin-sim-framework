# 39 — MPC Financial Controller (closed-loop advisor cockpit)

**Status**: Proposed (draft 2026-06-26) · §13's harvest is **superseded** by `design/81` (a run is stored, not baked) · **§14 is the live open problem**: every epoch under-projects its own outcome, and design 81 isolated it as a controller-accuracy question
**Related**: `design/81-run-as-replayable-artifact.md` (**what §13 became** — the run is a scenario param the simulation plays; its §10 lab supplies §14's measurement surface), `design/38-optimization-solver-framework.md` (**hard dependency** — the controller's inner solve *is* an `OptimizationProblem` + solver), `design/40-after-tax-net-worth.md` (**prerequisite for the Roth flagship** — the objective re-pricing that gives the conversion lever a gradient; see §12.5), `design/30-decision-graph-analysis.md` (the implemented scenario-comparison surface the "futures fan" rides on), `design/17-scenario-as-graph-node.md` (`DERIVES_FROM` parent edges — how a candidate future is recorded as a scenario derived from "now"), `design/33-age-banded-spending.md` / `EXPLICIT_BANDS` (the spending control lever), `design/18-performance-enhancements.md` (rollout cost), `design/61-holding-allocation-lever.md` §7/OQ7 + `design/58` / `design/65` / `design/66` (the levers whose **harvest** back into a scenario §13 specifies).

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
- **Recommended-next-move card** — human-legible: *"For ages 75–84, drop real monthly spend to \$5,800; convert \$40k to Roth this year."* With the predicted terminal outcome ("die with ≈ \$0 at 92").
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

- **Q1 — Horizon: full-life or windowed + terminal value?** *Recommended: start full-life* (cheap enough with now-snapshot rollouts, no terminal-value calibration needed); add a windowed mode with a terminal value function once cost demands it. **Update:** the windowed mode is now specified in **`design/41-windowed-prediction-horizon.md`** (a sliding fixed-length `H`, clamped to `simEnd`, so `H = remaining` ≡ full-life). Phase 1 windows only the terminal-stock maximizers (the Roth flagship); the **terminal value function** that would let the die-with-target family be windowed is Q2 below / design 41 Phase 2.
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
- **Browser-verified** (per CLAUDE.md): reconfigured to `EXPLICIT_BANDS`, stepped to 2034, opened the cockpit, ran CEM advise → recommended-move card + 6-line fan rendered; Apply + Advance re-planned from the new "now". The verification **surfaced and fixed a real bug**: `ExplicitBandsSpendingReducer` re-pinned only at band *transitions* (idempotent on `appliedStartAge`), so a forward edit to an already-entered band's amount was a silent no-op (both goals gave identical terminals). Now it also re-pins when the band *amount* changes (`appliedAmount`), so apply-forward actuates mid-band — confirmed: `MAX_NET_WORTH`→\$3k spend→\$8.09M vs `DIE_WITH_TARGET`→\$12k spend→\$7.00M, a visibly diverging fan.
- *Deferred:* the realized-past series and deeper design-30 comparison-surface reuse — the fan currently draws the forward rollouts from "now"; the past is represented by the now-divider.

**Step 5a — Live-sim navigation (cockpit drives the real clock) — Phase A** [x]
- Wired the cockpit's **Advance** through the existing `TimeControls` (new `stepToDate()`), which drives the **live primary sim**; exposed `timeControls` on the runtime (re-assigned each rebuild). The cockpit's "now" is now `sim.currentDate`, tracked off the live sim bus (debounced `EXECUTION_END`), so stepping from the cockpit *or* the header →/slider keeps "now" + every panel (State/Chart/Holdings/Timeline) in lockstep. Advise keeps reading live state and rolling isolated candidates. Fixed a UTC date-format off-by-one in the cockpit. **Browser-verified**: cockpit Advance moves the header clock and the State panel to the advanced date.

**Step 5b — Live-sim actuation (Apply mutates the real plan) — Phase B** [x]
- Added a per-control `actuate()` hook + `liveActuatable` flag. **SPENDING** actuates forward by re-wiring the running `ExplicitBandsSpendingReducer`'s band amount via `reducerService.updateReducer` (→ `SERVICE_ACTION` → `SimulationSync`, the §5 live path) **and** persisting the value to the active scenario param so future Advise rollouts (which recompile from scenario params) and the live sim stay consistent. The realized past (journal/state) is untouched; the change bites at the next period advance via the Step-5 `appliedAmount` re-pin. **ROTH** is flagged `liveActuatable:false` for now (its conversion ceiling re-wire is the remaining follow-up). Apply reports whether it hit the live plan; non-actuatable controls fall back to projection + `DERIVES_FROM` audit.
- **Browser-verified** (the real closed loop): with `EXPLICIT_BANDS`, stepped to 2032 (Monthly Expenses ≈ \$5,970 = \$5k×inflation), Advise → override-Apply \$11,000 → "Applied to the live plan"; Monthly Expenses unchanged *until* Advance, then re-pinned to **\$13,934** (= \$11k×inflation at 2033) — the accepted decision is baked into the live trajectory and reflected by the State panel. Forward-effective, not retroactive.
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
- **Problem.** The `DIE_WITH_TARGET*` family scored `consumption − λ·|terminal − target|` with **no solvency term**, so it *rewarded insolvency*. Because terminal net worth/liquidity floors at 0, a plan that spends the portfolio to zero parks the terminal right next to a low target (tiny penalty) while maximizing the consumption term. Live repro (Spending lever, `DIE_WITH_TARGET_LIQUID`, target \$5k, \$30k ceiling): the optimizer recommended the **max \$30k spend** whose own projected result was `scenarioFailed:true`, **362 deficit months**, **\$23.2M cumulative deficit**, `finalNetLiquidity:0` — i.e. it advised bankrupting the user because \$0 liquid is "closest to the \$5k target." Not controller spin-up; a missing constraint in the objective.
- **Fix.** Added `DEFAULT_DEFICIT_PENALTY = 100` + `_deficitPenalty(result, snapshot)` = `μ · max(0, cumulativeDeficit_T − cumulativeDeficit_snapshot)` (MPC-windowed like the other accumulators), subtracted from `DIE_WITH_TARGET`, `DIE_WITH_TARGET_LIQUID`, and `CRRA_DIE_WITH_TARGET`. It is **zero for any solvent plan** (`cumulativeDeficit = 0`), so it never perturbs the interior "spend-early ⇄ leave-less" optimum — it only ranks failing plans below solvent ones. μ ≫ λ is safe precisely because it's inert unless a path runs dry; overridable per scenario via a new `deficitPenalty` param (wired through `OptimizationProblem._readResult` alongside `terminalWealthTargetPenalty`).
- **Tested** (`objectives.test.mjs`, +6): solvent plan unaffected (exact old formula); a solvent plan now beats the bankrupting plan on all three objectives; a documentation test showing the bankrupt shape *would have won* without the deficit; windowed-penalty math; `deficitPenalty` override.
- **Browser-verified** (same scenario/ceiling/objective): recommendation dropped from **\$30,000 (bankrupt)** to **\$10,568** with terminal liquidity **\$1.07M** and net worth **\$5.06M** — solvent, no deficit. *Note:* the single-band lever (it tunes only the band active at "now", §Step 5b) cannot fully draw liquidity down to a \$5k terminal by death, so leaving a buffer is the constrained optimum, not a miss.

**Step 5e — Forward edit re-pins from "now," not the next annual boundary** [x]
- **Problem (found in Step 5 verification).** `ExplicitBandsSpendingReducer` only re-pins on the annual `*_PERIOD_ADVANCE`. So a forward-effective Spending edit made mid-year (the original Step 5b semantics, "unchanged until Advance, then re-pinned at the next year boundary") left **the entire current year spending the old amount** — the year you're standing in ignored the decision, and the lever looked weaker than it is. The projection had the same one-year lag (the snapshot carries the old `appliedAmount`), so live and projection were *consistent* but both lagged.
- **Fix — immediate re-pin, shared by live + projection.** Extracted the reducer's pin math into `pinExpensesForBand(state, band, cc)` and added `repinExpensesIfChanged(state, bands, asOfMs)` — both in `explicit-bands-spending-reducer.js`. The latter re-pins the band **active at "now"** off the period-advance grid, returning `null` (no-op) when there's no active EXPLICIT_BANDS pin or the band is unchanged (preserving within-band reactive/inflation drift — mirrors the reducer's own skip). Called from two places so projection == live: `OptimizationProblem._seededSim` (every snapshot-seeded rollout: `_rollout`/`rolloutSeries`/`rollToSnapshot`) and `SPENDING.actuate` (the live sim via `simulationRegistry.getPrimary()`). The reducer now also delegates to `pinExpensesForBand` (behavior-preserving refactor). Realized past untouched.
- **Tested**: `spending-explicit-bands.test.mjs` (+5: `repinExpensesIfChanged` re-pins on amount change, compounds by current price level, no-ops when unchanged / no pin / below first band) and `apply-forward.test.mjs` (+1 integration: rolling to "now" exactly, a \$4k→\$9k edit re-pins the current period to a 2.25× spend immediately, while a no-edit roll is unchanged). Full suite green.
- **Browser-verified** (live actuation, the part tests can't cover): at "now" = 2030 with band \$40k (`monthlyExpenses` \$45,020 = \$40k×1.1255), override-Apply \$10k → live `sim.state.monthlyExpenses` jumped to **\$11,255** (= \$10k×1.1255) **immediately, with no Advance** (was \$45,020 until 2031 before the fix). `appliedAmount` and the scenario param both updated to \$10k.
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
- `cockpit-controller.js` `COCKPIT_CONTROLS.ROTH`: ENUM bracket → **continuous income-target** lever (`numeric:true`, `defaultRange { min:0, max:500k, step:5k }` in real base-year USD). `buildVariables()` emits a single `CONTINUOUS` variable for the year at "now" (`rothConversionSchedule[i].incomeTarget`, the annual epoch §6) — the receding-horizon loop re-decides each subsequent year as "now" advances; `min:0` is the `OFF` encoding (no separate binary, no mixed-integer). `describe()` reads "No Roth conversion this year" for `OFF`, else "Fill ordinary income to \$X/yr (real) — N% bracket" (bracket derived from base-year brackets — inflation-free since target and edges deflate together). **Decision (revises §12.2/§3 wording):** the cockpit control is *single-year-per-epoch* (mirrors the SPENDING lever — fast, 1-D), not a simultaneous multi-year forward-tail vector; the per-year schedule emerges across epochs via the receding-horizon loop. A simultaneous multi-year vector (where Step 6's QP polish on a multi-dim continuous Roth sub-vector pays off most, and warm-start §3 matters) is the documented enhancement.
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
- **Two independent axes.** The "die with target" goal has two orthogonal choices: the **running term** (real CONSUMPTION \$ vs concave CRRA UTILITY) and the **terminal anchor** (net WORTH vs net LIQUIDITY — the spendable, lever-reachable pool). Three of the four existed; this adds the missing **`CRRA_DIE_WITH_TARGET_LIQUID`** (the right default when you value smooth consumption *and* the levers can't touch illiquid assets — house equity, age-locked super).
- **Factory, not copies.** All four share one formula `running − λ·|terminal − target| − μ·deficit`, so `optimization-objectives.js` generates them via `makeDieWithTarget({ running, terminal, label })` (kills the 4× duplication, keeps them in lockstep) and tags each with `family:'DIE_WITH_TARGET'` + `variant:{ running, terminal }`. Keys are unchanged ⇒ backward compatible (scenarios still serialize a single `objectiveKey`). Helpers: `DIE_WITH_TARGET_AXES` (axis menus), `resolveDieWithTargetKey({running,terminal})`, `groupedObjectiveOptions()` (collapse the family into one entry for selects), `OBJECTIVE_FAMILY_LABELS`.
- **Grouped UI (both surfaces).** The cockpit (`mpc-cockpit-plugin.js`) and OPT panel (`opt-config-panel.js`) render the family as **one "Die With Target" option** plus two sub-selects (**Basis**: Consumption/CRRA · **Terminal**: Net Worth/Net Liquidity), shown only when the family is selected, resolving back to the concrete key. The cockpit keeps its curated goal list (family + `MAX_NET_WORTH`/`MAX_NET_LIQUIDITY`/`MAX_CRRA_UTILITY`/`MIN_LIFETIME_TAXES`); the OPT panel lists every objective grouped. The cockpit recommended-move card annotates the target with its basis ("net-worth target" vs "liquid target").
- **Per-variant default λ (no re-tune on basis switch).** The penalty `λ·|terminal − target|` is in DOLLARS, but the running reward is dollars for CONSUMPTION and UTILS for CRRA (orders of magnitude smaller, scale-dependent on consumption level + γ), so a single fixed λ over-anchors the CRRA variants. `_defaultLambda(running, result)` now scales the CRRA default by the run's **marginal utility of consumption** `u'(c̄) = c̄^{-γ}` — the dollars→utils shadow price — so each dollar of terminal miss costs the same *leverage* as in the consumption variant. The `AccumulateConsumptionUtilityReducer` accumulates `cumulativeConsumptionMarginalUtility` + a count; `_readResult` surfaces the run average as `consumptionMarginalUtility`. Consumption variants keep `DEFAULT_TERMINAL_WEALTH_PENALTY`; an explicit `terminalWealthTargetPenalty` still overrides either. *Verified on a real run:* a fixed λ=10 made the CRRA penalty ~4.7e7 vs a reward of ~190 (terminal dominates ~2.5e5×); the auto-scaled λ gives penalty ~101 vs reward ~190 — balanced, matching the consumption variant.
- **Tested**: `objectives.test.mjs` (+7: complete 2×2 with family/variant tags; `resolveDieWithTargetKey` mapping; the CRRA×Liquid variant rewards utility & anchors on liquidity, ignoring net worth; `groupedObjectiveOptions` collapses the family; CRRA default λ auto-scales by `consumptionMarginalUtility`; consumption basis ignores it; explicit penalty overrides). `crra-objective.test.mjs` (+2: `marginalUtility` math; reducer accumulates sum+count → run-average `u′(c̄)`). `mpc-cockpit-plugin.test.mjs` (+2) and `opt-config-panel.test.mjs` (+2: grouping + `getConfig` resolution). All suites green (unit 2912, viz 796).

**Step 12 — Harvest: copy a completed run's decisions back into the scenario** [x] *(see §13; 12a–12f done, 12g gated; browser verification outstanding)*
- The cockpit discovers good values; today there is no way to get them **into the loaded scenario** as an inspectable, re-runnable, saveable plan. §13 specifies the harvest: a per-lever `harvest()` hook → a reviewable `HarvestPlan` → an upsert into `scenario.params` (values **plus** the enabling params that make them bite) → Rebuild/Save through the existing flows.
- Sub-steps:
  - **12a — Harvest seam + record enrichment.** Stamp `runId` / `controlKeys` / `controlVars` on the decision record (§13.2) and give the `decision` layer durable storage (`fin-sim-decisions`, H4); `harvestDecisions(records, ctx) → HarvestPlan` in `src/finance/mpc/harvest.js`; `harvest()` hooks on the schedule-shaped levers; POINT default with a varied-across-epochs warning for the rest (§13.3–§13.4).
  - **12b — Safe write into the scenario.** `applyHarvestPlan(scenario, plan)`: schema-driven **upsert** (not `if (p) p.value`), single-store write to `cfg.params`, enabling params applied atomically, `harvestedFrom` provenance stamp (H5), `PARAMS_CHANGED` so the Scenario panel re-renders (§13.5). Re-label the seven `actuate` persist sites as *live-value sync* (H3).
  - **12c — Cockpit UI.** "Copy to scenario…" → diff/preview (param · lever · form · current → harvested · epochs · warnings) → Apply, with the Rebuild prompt (§13.8). Available at any point in a run, with the epoch range shown (H2); one `runId` per harvest, no cross-run merge (H1).
  - **12d — GLIDEPATH bake for `ALLOCATION_MIX`** — closes design 61 §7 / OQ7's deferred schedule-baking (§13.6.4).
  - **12e — `RESOLVE` for the scalar levers** (§13.6.6): a budgeted full-horizon design-38 solve from t₀, jointly over the scalar levers, warm-started from the MPC's committed values and run **after** the schedule bakes are folded into `baseParams`. Opt-in per harvest; falls back to POINT.
  - **12f — Verify the bake + VoTV readout.** Deterministic from-t₀ re-run at the same seed vs the MPC's committed terminal, drift decomposed (§13.7); headless `scripts/lab/verify-harvest.mjs`. Then the free byproduct: `VoTV = B − C`, `VoFB = A − B` per lever (§13.13.3), `scripts/lab/votv.mjs`.
  - **12g — (Phase 3, gated) time-varying param forms** for the levers that have none — drawdown role/sleeve weights, cross-border mode, ladder length (§13.6.5). Plant work in designs 58 / 65 / 66 — and **gated on 12f's VoTV numbers**, not on intuition (D7). If ≥2 levers show real time-variation value, the right move is the factored schedule param type (§13.13.4, a future design 79), not a ninth bespoke `*List`.
- Browser verification per CLAUDE.md: auto-run the cockpit to simEnd, harvest, Rebuild, confirm the re-run trajectory tracks the MPC's and the Scenario panel shows the baked values. Everything below is covered by unit/viz tests plus the headless verifier, but the live Apply→Rebuild→panel loop has now been driven in a browser.

**Step 12 — implementation notes (2026-07-25, `wip/mpc-parameter-values`)**
- **Landed.** `src/finance/mpc/harvest.js` (`harvestDecisions` → `HarvestPlan`, `pointHarvest`, `collapseConsecutive`, `ageAt`, `requiresIncludes`), `harvest-apply.js` (`applyHarvestPlan` schema-driven upsert + enabling params + `harvestedFrom`), `harvest-resolve.js` (`resolveStaticLevers`/`foldScheduleBakes`/`mergeResolved`, with `makeProblem`/`makeSolver` DI seams), `decision-record-storage.js` + `decision-record-registry.js` (durable `fin-sim-decisions`, H4), `harvest`/`harvestRequires` hooks on SPENDING/ROTH/EARLY_WITHDRAWAL/ALLOCATION_MIX, `runId`/`controlKeys`/`controlVars` on the record, `readDecisionRuns`, `WB_EVENTS.PARAMS_CHANGED` → `scenarioTabPresenter.refreshParams()`, the cockpit's "Copy to scenario…" review panel, and `scripts/lab/verify-harvest.mjs` + `scripts/lab/votv.mjs` over `scripts/lib/harvest-lab.mjs` (`npm run verify:harvest` / `npm run votv`).
- **Tests:** `tests/unit/mpc-harvest.test.mjs` (+48) and `tests/viz/mpc-cockpit-plugin.test.mjs` (+9). Suites green: **4078 unit / 934 viz**.
- **§13.7 gate MET on the spending lever.** `npm run verify:harvest -- SPENDING --epochs 3` reports **B ≡ A to the dollar** (\$12,140,961, drift +0.00%) — the baked band table re-runs from t₀ to exactly the terminal the closed-loop run committed. The ~1% goal is comfortably met; discretization cost nothing here because the run's decisions collapsed to a single band.
- **A REAL BUG, found by the verifier, not by the tests.** `CockpitController` seeded `this.committed = { ...baseParams }` — a *shallow* copy. `apply()` commits through the path-aware `set()` (`spendingExpenseBands[0].monthlyAmount`), which mutates the **container**, so every epoch silently rewrote the caller's nested array. In the cockpit that caller is `_paramsToMap(scenario.params)`, i.e. **the active scenario's own band table / schedule entries** — an undeclared write outside both the actuate and harvest paths, and one that made the harvest diff's "from" column show the mutated value instead of the pre-run one. First symptom was a bogus +15.5% harvest drift. Fixed with `_deepCopyParams` on `baseParams` *and* `committed`; regression-tested. Worth noting it survived every existing test because nothing previously compared a pre-run param value to its post-run self.
- **Deviation from the plan as written:** the two scripts share `scripts/lib/harvest-lab.mjs` rather than duplicating the run/harvest/re-run machinery; `votv.mjs` is the `--resolve` path of the same lab.
- **Honesty guard added to the VoTV readout.** A first `DRAWDOWN_XBORDER` run returned `VoTV = 0`, which reads as "this lever wants to be a scalar" — but all three terminals equalled the *baseline*, i.e. the lever never bit in that scenario at all ([[mpc-lever-tests-scenario-shaped]]). The report now detects `A ≈ before` and prints **INCONCLUSIVE** instead of a verdict, because a zero from an inert lever says nothing about time-variation. Any Phase-3 (12g) decision must clear this guard first.

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

---

## 13. Harvesting a completed run back into the scenario

*Status: proposed (2026-07-25). Implements §11 Step 12. Closes the deferred
schedule-baking item in `design/61-holding-allocation-lever.md` §7 / OQ7 and the
same gap in designs 58 / 65 / 45 / 66 — every lever, one mechanism.*

### 13.1 The gap

The cockpit is a **discovery** surface: run the levers, let the controller find
values that beat trial-and-error (especially the ones no human tunes by hand — a
spending band table, a per-year Roth ladder, a four-way weight simplex). But when
the run ends, those values live in the controller's `committed` bag, the live sim's
re-wired reducers, and a session-only decision log. The user's loop —
**discover → copy into the loaded scenario → Rebuild → inspect → Save** — has no
copy step.

What happens *today* is worse than nothing, because it is invisible and lossy.
Each lever's `actuate()` (§Step 5b) persists its committed value into
`scenario.params` so the next Advise rollout (which recompiles from params) agrees
with the live sim. That write is a *side effect for consistency*, not a harvest,
and it splits three ways by the **shape of the target param**:

| Lever's target param shape | What ~20 epochs of `actuate` leave behind | Verdict |
|---|---|---|
| **Per-year schedule** (`rothConversionSchedule`, `earlyWithdrawalSchedule`) | one entry per decided year — accumulated, chronological | **accidentally correct**: a real schedule harvest already |
| **Band table** (`spendingExpenseBands[i]`) | the **last** epoch's amount written onto the band active at that epoch | lossy: every earlier decision overwritten |
| **Scalar** (`crossBorderDrawdown`, `withinTierDraw`, `drawdownWeight::*`, `sleeveWeight::*`, `allocWeight::*`, `bondLadderRungs`) | the **last** epoch's value only | lossy and silent: the whole time-path collapses to its final point |

So after an Auto run the scenario is in a half-harvested state nobody asked for or
can see, and a Rebuild produces a trajectory that does **not** match what the
cockpit just showed. Three separate defects: no **explicit** harvest, no
**visibility**, and no **schedule** form for the levers that need one.

There is a fourth, quieter one: the persist is `const p = params.find(…); if (p) p.value = v` at
every `actuate` site. When the target key isn't materialized in `cfg.params` the
write **silently disappears** (the [[two-param-stores-trap]] shape). It happens to
work today because `ScenarioLoader._mergeParamSchema` materializes the whole
combined schema — but nothing enforces it, and nothing reports a miss.

### 13.2 What a "run result" is — the harvest source

Harvest reads the **decision records** (`layer:'decision'`, Step 5c), not the
controller. The controller is the wrong source twice over: `committed` is a flat
bag with the time dimension already collapsed, and the cockpit nulls
`this._controller` after every Apply and every clock step, so it does not survive
the run it produced. The records do — `{ id, asOfDate, controlParams, result,
goalMetric }`, one per Apply, oldest-first, independent of controller lifecycle.

Three additions make them self-describing enough to harvest (12a):

- **`runId`** — stamped per cockpit run (a new one on each Advise-after-idle /
  Auto start). Without it, three exploratory runs in one session blend into one
  incoherent schedule. Harvest defaults to the newest run and lets the user pick.
- **`controlKeys`** — which levers were active, so a mixed-lever log routes each
  paramKey back to the lever that owns it.
- **`controlVars`** — the epoch's variable descriptors (`_role`, `_class`, `_year`,
  `_bandIndex`, `_effectiveYear`, `_controlKey`). `controlParams` alone is
  `{'spendingExpenseBands[3].monthlyAmount': 7500}` — enough to *replay*, not
  enough to *re-key* onto a band table whose indices the harvest is about to
  rewrite. The descriptors are already built (`_variables()`); they are just not
  recorded.

Records remain **session-only** (Step 5c). That is acceptable — harvest is the
thing you do at the end of a run, in the same session. Cross-reload persistence
(a `fin-sim-decisions` store) stays the Step 5c Option #2 follow-up; harvest is
what would finally justify it.

### 13.3 Three harvest forms

**POINT** — one value per param, no time dimension: take the last (or modal)
epoch's decision. Faithful only if the controller's per-epoch decisions were
(near-)constant; otherwise arbitrary. Correct and complete for a design-38 **OPT**
solve, which searches one fixed plan by construction (§13.9).

**SCHEDULE** — the per-epoch sequence baked into a time-keyed param the plant
already reads. Faithful to what the controller actually did.

**RESOLVE** — re-solve the *best static value over the whole run*, warm-started
from the MPC's committed values (§13.6.6). This is the principled answer to "what
one number should this param be?", and it is what a scalar-only lever deserves
instead of an arbitrary last-epoch collapse. It costs an optimizer run; it needs
no new plant.

The form is a property of the **plant**, not a preference: a lever can only be
harvested as a SCHEDULE if some param expresses "this value, from this age/year."

| Lever | Control param(s) | Enabling params | Schedule form in the plant today | Phase-1 harvest |
|---|---|---|---|---|
| `SPENDING` | `spendingExpenseBands[i].monthlyAmount` | `spendingStrategy ∋ EXPLICIT_BANDS` | **yes** — the band table *is* an age-keyed schedule | **SCHEDULE** (§13.6.1) |
| `ROTH` | `rothConversionSchedule[i].incomeTarget` | `rothConversionEnabled` | **yes** — per-year entries | **SCHEDULE** (§13.6.2) |
| `EARLY_WITHDRAWAL` | `earlyWithdrawalSchedule[i].{taxDeferredAmount,rothAmount}` | `earlyWithdrawalEnabled` + window | **yes** — per-year entries | **SCHEDULE** (§13.6.2) |
| `ALLOCATION_MIX` | `allocWeight::<CLASS>` | `behavioralStrategies ∋ TARGET_ALLOCATION`, `allocationStrategy=OPTIMIZED` | **yes, unused** — `allocationSchedule=GLIDEPATH` + `allocationGlidepath:[{age,weights}]` (design 61 Phase 3) | **SCHEDULE** (§13.6.4) |
| `DRAWDOWN_WEIGHTS` | `drawdownWeight::<role>` | `drawdownStrategy=WEIGHTED` | no | **RESOLVE**, else POINT + warning |
| `DRAWDOWN_SLEEVE` | `sleeveWeight::<CLASS>` | `drawdownSleeveOrder=WEIGHTED` | no | **RESOLVE**, else POINT + warning |
| `DRAWDOWN_XBORDER` | `crossBorderDrawdown` | — | no | **RESOLVE**, else POINT + warning |
| `DRAWDOWN_WITHINTIER` | `withinTierDraw` | — | no | **RESOLVE**, else POINT + warning |
| `BOND_LADDER` | `bondLadderRungs` | `behavioralStrategies ∋ BOND_LADDER` | no | **RESOLVE**, else POINT + warning |

Phase 1 therefore ships **four real schedule bakes on plant that already exists**,
**RESOLVE** for the five scalar levers (§13.6.6), and POINT as the zero-cost
fallback. New time-varying param forms for the bottom five are Phase 3 (§13.6.5)
and belong to their own designs — and §13.13.3 makes the case that they should be
justified by measurement first.

### 13.4 The seam

Mirrors `describe`/`actuate` — one optional hook per control spec, pure, testable
without a sim:

```js
// COCKPIT_CONTROLS.<LEVER>
harvest: ({ epochs, baseParams, state, epsilon }) => ({
  params:   { [paramKey]: value },      // the bake
  requires: { [paramKey]: value },      // enabling params (§13.5)
  warnings: [ 'string' ],               // collapses, ties, out-of-range
})
// epochs: [{ asOfDate, candidate, vars }] oldest-first, ALREADY filtered to this
//         control's own variable subset (routed by `_controlKey`).
```

No hook ⇒ the **POINT default**: last epoch's value per paramKey, plus a warning
naming how many epochs disagreed and by how much. Silence is never an option — a
collapsed lever must say so.

Two pure functions above it, in a new `src/finance/mpc/harvest.js`:

```js
harvestDecisions(records, { controls, baseParams, state, runId, epsilon }) -> HarvestPlan
applyHarvestPlan(scenario, plan, { schema })                              -> { applied, created, skipped }

HarvestPlan = {
  runId, goal, solver, levers, epochRange: [firstDate, lastDate], epochs: n,
  entries:  [{ paramKey, lever, form, from, to, epochs, label }],  // the diff model
  requires: [{ paramKey, from, to, reason }],
  warnings: [...],
}
```

`HarvestPlan` is the **review artifact**: the preview panel renders it, the user
approves it, `applyHarvestPlan` executes it. Nothing writes a param without
passing through it.

### 13.5 Writing into the scenario safely

Four rules, each fixing something that is wrong or absent today.

1. **Upsert, don't update-if-present.** Resolve the key against the combined
   scenario + toolset param schema and materialize a typed entry
   (`{name,label,type,group,description,node,options,…}`) exactly as
   `ScenarioLoader._mergeParamSchema._toEntry` does, when it is missing. A key that
   matches no schema entry is **reported as skipped**, never silently dropped. This
   replaces the `if (p) p.value = v` idiom at every `actuate` site too.
2. **One store.** Write `cfg.params` only, and let the loader's params→parameters
   sync do the rest on Rebuild. Writing both is how the two stores drift
   ([[two-param-stores-trap]]).
3. **Enabling params ride along, atomically.** A harvested `drawdownWeight::*` is
   *inert* unless `drawdownStrategy=WEIGHTED`; an `allocationGlidepath` is ignored
   unless `allocationSchedule=GLIDEPATH`. Each control declares `harvestRequires`,
   and the plan surfaces those flips in the diff as first-class rows — the user
   sees "and this switches your Drawdown Strategy to WEIGHTED" **before** approving.
   This is the single easiest way for a harvest to look successful and do nothing.
4. **Tell the UI.** The Scenario panel holds the live `params` array by reference,
   so values change under it without a re-render. Add a `WB_EVENTS.PARAMS_CHANGED`
   publish after apply; the scenario presenter subscribes and calls its existing
   `refreshParams()` (the same refresh the CSV import already performs locally).

Harvest **does not** Rebuild, save, or touch the running sim. It edits the loaded
scenario's params and stops — the user's existing Rebuild and Save buttons take it
from there. That keeps the blast radius at "an edit you could have typed."

### 13.6 The per-lever bakes

#### 13.6.1 `SPENDING` → age bands

The lever tunes the band **active at "now"**, so each epoch's committed amount is
what the plan spent from that epoch until the next decision — a step function,
which is exactly what `spendingExpenseBands` is. Bake:

- one `{ startAge, monthlyAmount }` per epoch, `startAge` = the primary's age at
  `asOfDate` (from the scenario's persons, not the disposable snapshot);
- collapse consecutive equal amounts (|Δ| ≤ ε, default \$1) into one band;
- two epochs in the same age-year ⇒ last wins;
- **preserve** pre-existing bands with `startAge` below the first epoch's age —
  that is the pre-MPC plan for the realized past, which the run never re-decided
  and the harvest must not delete;
- units are unchanged: the lever, the param, and the reducer all speak **real
  base-year USD** (the reducer compounds to nominal). No conversion, and none of
  the real/nominal confusion the card's `describe` has to manage.

A 20-epoch run typically collapses to a handful of bands — legible, editable, and
the exact table a human could never have found by trial and error.

#### 13.6.2 `ROTH` / `EARLY_WITHDRAWAL` → per-year schedules

The union of every epoch's decided year, positive amounts only (absence ==
skip-year, matching the toolsets). This is already what `actuate` accumulates, so
harvest here is **idempotent** — it re-derives the same schedule from the log
rather than trusting the side effect, and closes the case where the user reverted
params mid-run.

#### 13.6.3 The POINT levers

Last-committed value, plus a mandatory warning quantifying the collapse:
`"Drawdown order changed in 7 of 22 epochs — freezing the last decision; the
re-run will differ from the cockpit trajectory."` For `DRAWDOWN_XBORDER` /
`DRAWDOWN_WITHINTIER` (categorical) the warning reports the mode histogram, and
the plan offers **last** or **modal** as the collapse rule — a mode that held for
18 of 22 epochs is the better single answer than whatever the last epoch picked.

#### 13.6.4 `ALLOCATION_MIX` → GLIDEPATH anchors (design 61 §7 / OQ7)

The plant half is already built and unused: `allocationSchedule=GLIDEPATH` +
`allocationGlidepath: [{age, weights}]`, interpolated by the primary's age in
`RebalanceToTargetReducer.resolveScheduledTarget`. Bake:

- each epoch's committed weights → the **synthesized mix**
  (`synthesizeTargetAllocation`, i.e. what the run actually held, not the raw
  stick-breaking weights) → an anchor at that epoch's age;
- collapse an anchor whose L1 distance from its predecessor is ≤ ε (default 0.02)
  — the same hold-band idea design 61 §7 uses to avoid CGT-churning flip-flop,
  reused here to keep the table legible;
- **step vs smooth.** `interpolateGlidepath` *blends linearly* between anchors,
  while the MPC held each mix flat until the next decision. Default to a
  **step-faithful** bake (paired anchors: `{age_i, mix_i}` and
  `{age_{i+1}−δ, mix_i}`) so the re-run reproduces the run; offer **smooth** (one
  anchor per epoch) as the legible alternative, and let §13.7's verify report the
  difference rather than assert one is right;
- **prepend a start anchor.** `interpolateGlidepath` clamps below the first anchor,
  so without an anchor at the plan's start age a from-t₀ re-run would apply the
  first MPC epoch's mix to the entire *realized past* — silently rewriting years the
  run never decided. Prepend `{age: age at simStart, weights: the pre-run static
  mix}`;
- keep the last mix in `allocWeight::*` as well: it is the reducer's `targetAllocation`
  fallback when the glidepath is unconfigured or empty.

Sets `allocationSchedule=GLIDEPATH` via `harvestRequires`. `REGIME_CONDITIONED`
harvest (per-regime map) is the natural sibling and stays future work — it needs
epochs tagged with the regime active at each, which the record does not carry yet.

#### 13.6.5 Phase 3 — the levers with no schedule form

`drawdownWeight::*`, `sleeveWeight::*`, `crossBorderDrawdown`, `withinTierDraw`
and `bondLadderRungs` are static scalars; a faithful bake needs an age/year-keyed
form (a `drawdownWeightSchedule` of `{age, weights}`, the drawdown twin of the
allocation glidepath, and likewise for the sleeve/ladder). That is **plant work in
designs 58 / 65 / 66**, not here, and it should be justified by evidence — if the
POINT warning shows the controller's order was effectively constant, the schedule
buys nothing. Ship Phase 1, read the warnings, then decide (§13.13.3 turns that
into a measurement).

#### 13.6.6 `RESOLVE` — the best *static* value for the whole run

POINT asks "which epoch's answer do we keep?" — a question with no good answer.
The right question is **"given that this param must be one number for the whole
run, what number is best?"**, and that is not a collapse of the MPC's decisions at
all: it is a **design-38 optimization over the full horizon** with the lever as a
static variable. The machinery already exists; harvest just has to call it.

```
RESOLVE(lever) = OptimizationProblem({
  variables:    lever.buildVariables(...)            // the same encoding the cockpit searched
  baseParams:   scenario params + everything else already harvested
  objective:    the MPC run's goal (stamped on the records)
  initialState: t₀   ← NOT a snapshot: this is an open-loop, whole-run solve
}).solve({ start: <the MPC's committed values>, budget })
```

Three properties make this the right default for the five scalar levers:

1. **It answers the user's actual question.** "Optimal parameters for the entire
   run" is an open-loop, full-horizon problem — precisely design 38's problem, not
   design 39's. Harvest is where the two meet.
2. **The MPC run is a free warm start.** The controller has already explored this
   lever against realized state; its committed values (and the per-epoch spread)
   seed both the start point and a sensible search range. A cold OPT solve would
   redo that work.
3. **It composes with the schedule bakes.** RESOLVE runs *after* the SCHEDULE
   levers are applied to `baseParams`, so the static value is optimal **given** the
   harvested spending/Roth/allocation schedules — not against the pre-run scenario.
   Order matters and is part of the plan: schedules first, then RESOLVE, in one
   pass.

Cost is one budgeted solve per harvest (not per lever — the scalar levers resolve
**jointly**, for the same coupling reason as H1). It is opt-in per harvest with a
progress indicator, and it degrades to POINT if the user declines or it is
cancelled. The plan records which entries came from RESOLVE vs POINT vs SCHEDULE,
because a reader deserves to know which numbers were searched over the whole run
and which were snapshots of a moment.

**Honest limit.** RESOLVE finds the best static value *on the path it solves over*
— under design 74/75 stochastic returns that is one seed. It is a better number
than last-epoch-wins by construction, not a guarantee out of sample. §13.13.3's
diagnostic is what tells you whether a static value was ever adequate here.

### 13.7 What a baked scenario does and does not reproduce

This is the honest part, and it must be in the UI, not just the doc.

A harvested scenario is **open-loop**: a fixed schedule that re-runs
deterministically with no controller in the loop. Two distinct drifts follow.

1. **Discretization** — the bake approximates the policy (band collapse, anchor
   ε, step-vs-smooth, POINT collapses). Bounded, measurable, and reported.
2. **Loss of feedback** — the MPC *re-decided from realized state each epoch*. On
   the **same** realized path a faithful bake tracks it closely; on **any other**
   path (a different seed, an MC arm, an edited assumption) the baked schedule
   cannot react, because reacting is precisely what got left behind. Design 74/75
   made return and house paths stochastic, so this is not hypothetical: the same
   baked scenario under a different seed is a *different, worse* plan than the
   controller would have chosen there.

That is the semantics of a saved scenario, not a defect — but a user who harvests
a plan and then runs Monte Carlo over it must not read the failure rate as the
controller's. State it on the panel, in one line.

**Verify (12e).** After apply, offer a one-click check: re-run the harvested
scenario from t₀ **at the same seed** and compare to the MPC's committed terminal
on the goal's primary metric (`objectivePrimaryMetric`, already stamped on each
record). Report `Δ` and `Δ%`, and attribute: if the realized paths match but the
terminals diverge, it is discretization; if the harvest is a POINT collapse of a
lever that varied, the warning already said so. Headless twin:
`scripts/lab/verify-harvest.mjs` (a sibling of `verify-mpc-lever.mjs`), so this is
regression-testable and not only a browser gesture.

Fidelity targets are stated as goals, not gates: **schedule-form levers within
~1% of the committed terminal**; POINT levers *unbounded by construction* and
labelled as such.

### 13.8 UX

One new button on the cockpit toolbar — **"Copy to scenario…"**, enabled once the
current run has ≥1 decision record — opening an inline review panel:

```
Harvest run · 22 epochs · 2026 → 2047 · Goal: Die With Target (net liquidity) · CEM

  Monthly Spending          SCHEDULE   spendingExpenseBands
      age 62  $7,500   ·  age 68  $6,200  ·  age 79  $4,900        (22 epochs → 3 bands)
  Allocation Mix            SCHEDULE   allocationGlidepath   + allocationSchedule → GLIDEPATH
      age 62  E70/B25/C5  →  age 79  E40/B50/C10               (22 epochs → 5 anchors)
  Drawdown Order            POINT      drawdownWeight::×4    + drawdownStrategy → WEIGHTED
      ⚠ changed in 7 of 22 epochs — freezing the last decision

  [ Copy to scenario ]   [ Cancel ]
```

After apply: a confirmation naming what changed and what to do next
("14 params updated, 2 created — **Rebuild** to run it, then Save"). Deliberately
**not** auto-Rebuilding: Rebuild re-runs from t₀ and throws away the cockpit's
realized "now", which the user may still be working from.

### 13.9 The same seam serves the OPT panel

A design-38 solve produces exactly one candidate over a fixed plan — a
**single-epoch, POINT** harvest, which is the trivial case of the same machinery
and needs no schedule at all. The OPT results panel has no "apply best" affordance
today either, so `applyHarvestPlan` (§13.4) should be built lever-agnostic and
reused there: same upsert, same enabling params, same diff, same
`PARAMS_CHANGED`. One mechanism, two producers.

### 13.10 Decisions locked

- **D1 — Source is the decision log, not the controller.** Enriched with
  `runId`/`controlKeys`/`controlVars` (§13.2).
- **D2 — Destination is the loaded scenario's params, in place, behind an explicit
  preview.** No new scenario, no auto-Rebuild, no auto-Save — the user's existing
  Rebuild/Save flows finish the job.
- **D3 — Upsert + single store + enabling params + `PARAMS_CHANGED`** (§13.5).
  Applies retroactively to the existing `actuate` persist sites.
- **D4 — Form follows the plant.** SCHEDULE where a time-keyed param exists,
  RESOLVE (or POINT) elsewhere — with a mandatory, quantified collapse warning.
  Never a silent collapse.
- **D5 — Fidelity is reported, not assumed** (§13.7), and the open-loop caveat is
  surfaced in the UI.
- **D6 — A scalar-only lever gets a *searched* number, not a snapshot.** RESOLVE
  (§13.6.6) re-solves the best static value over the whole run, jointly across the
  scalar levers, warm-started from the MPC's committed values and applied **after**
  the schedule bakes. POINT remains the zero-cost fallback, labelled as such.
- **D7 — Which levers deserve a schedule form is a measurement, not a judgement.**
  Phase 3 (§13.6.5) is gated on the VoTV/VoFB readout (§13.13.3), and a ninth
  bespoke `*List` type should not be written before the question in §13.13.4 is
  settled.

### 13.11 Resolved questions (answered 2026-07-25)

- **H1 — Multiple runs in one session → harvest ONE run, jointly.** Default to the
  newest `runId`; no cross-run merge. Tuning spending in run A and Roth in run B and
  stapling the results together discards exactly the cross-lever coupling the
  multi-lever search exists to find (a Roth ladder is only optimal *given* a
  spending path, because conversions are funded out of the same drawdown). If you
  want both levers, run both levers. The picker lists prior runs for inspection,
  but harvest targets one.
- **H2 — Harvest is available at any point in a run**, with the epoch range stated
  on the plan and in the provenance stamp. A truncated schedule is a legitimate
  "first N years" plan; refusing to copy until simEnd would make the common case
  (explore a decade, take the answer) impossible.
- **H3 — `actuate`'s param write stays, re-labelled.** It is *live-value sync* —
  the mechanism that keeps recompiled Advise rollouts consistent with the live sim
  (§Step 5b) — not persistence, and the code should say so at all seven sites.
  Harvest is the persistence path and overwrites those values with the full
  schedule. §13.1's table stays as the record of what the sync leaves behind.
- **H4 — Decision records get durable storage** (Step 5c Option #2, `fin-sim-decisions`),
  since a page refresh currently destroys an un-harvested run. Lands in 12a: same
  `decision` layer, its own storage key, never `fin-sim-scenarios`.
- **H5 — Harvest stamps provenance on the scenario**: `harvestedFrom: { runId, goal,
  solver, levers, epochRange, date }`, in 12b. It's the difference between a
  shareable plan and a pile of magic constants — and it's what lets a later reader
  (or a later you) know which numbers were searched and which were typed.

### 13.12 Remaining open question

> **Superseded in part by `design/80-feasibility-preserving-harvest.md` (2026-07-26).**
> Field result: a `DIE_WITH_TARGET` harvest produces a scenario that goes **insolvent**
> while the closed-loop run it was baked from does not. That is a *feasibility* loss,
> not the bounded drift §13.7 promises, and it revises four things here: §13.6.3's
> variance-based collapse warning (a single decisive move at a statutory access age
> reads as near-constant), §13.6.6's RESOLVE inheriting the MPC's objective verbatim
> (a closed-loop objective is indifferent to solvency margin because feedback supplies
> it — see the `DEFAULT_DEFICIT_PENALTY` docblock, "zero for any solvent plan"),
> §13.7's `Δ%` fidelity targets, and §13.13.3's VoTV/VoFB, which is undefined when `B`
> is infeasible. Design 80 also supplies the gate §13.6.5 / D7 were waiting on.

- **H6 — Where the knots live.** §13.13 (below) argues that the POINT/SCHEDULE
  split is an artifact of the param system, not of the levers. Whether to factor a
  first-class schedule-valued param type — and for which levers time-variation is
  even the right upgrade — is deliberately left open, with a measurement (§13.13.3)
  that answers it empirically rather than by argument.

---

### 13.13 Static values, schedules, and policies — the representation question

*Raised 2026-07-25 while reviewing §13: if the controller re-decides every param
every epoch, why is a scenario param a single number? This section is the
grounded answer, and the argument for what to do about it. It is analysis, not a
committed plan — the framework change it points at (§13.13.4) should be its own
design doc if it is taken up.*

#### 13.13.1 The framework already has time-varying params — eight of them, unfactored

The premise "our params are static" is only half true. Time-variation has been
added **eight separate times**, each as a bespoke one-off:

| Param | Type | Key axis | Interpolation | Editor | Searchable? |
|---|---|---|---|---|---|
| `spendingExpenseBands` | `ExpenseBandList` | age | step | table | `opt:true`, hand-written per-band expansion |
| `spendingAgeBands` | `AgeBandList` | age | step + in-band drift | table | `opt:true` |
| `rothConversionSchedule` | `RothScheduleList` | year | step (absent = skip) | table | `controllable`, hand-written per-year expansion |
| `earlyWithdrawalSchedule` | `EarlyWithdrawalScheduleList` | year | step (absent = skip) | table | `controllable` |
| `primeSchedule` | `PrimeScheduleList` | year | step | table | no |
| `allocationGlidepath` | `Object` | age | **linear** | **JSON textarea** | no |
| `yieldCurveSchedule` | `Object` | year | step | **JSON textarea** | no |
| `usYieldCurveShape` / `auYieldCurveShape` | `Object` | tenor (not time) | linear + clamp | **JSON textarea** | no |

Every row re-invents the same four things: a **type name**, a **table editor**
(`scenario-tab-view.js` dispatches five near-identical `_build*ListEditor`
functions), a **resolver** (`bandForAge`, `interpolateGlidepath`,
`resolveScheduledTarget`, the toolsets' per-year `emitYear`…), and — for the two
that are searchable — a **hand-written knot expansion**
(`buildExpenseBandOptConfigs`, `buildRothScheduleOptConfigs`, siblings by
copy-paste). The three that reached for `Object` got the worst of it: a JSON
textarea, no validation, no search, no harvest.

So the real finding is not *"params are static"*. It is:

> **Time-varying params are pervasive, but there is no first-class notion of one —
> so each arrives with its own type, editor, resolver, and search encoding, and the
> ones that don't get that investment silently stay static.**

§13.3's POINT/SCHEDULE split is a **census of that history**, not a property of the
levers. `drawdownWeight::*` is POINT-only because nobody has yet written a
`DrawdownWeightScheduleList` type + editor + resolver + expansion — not because
drawdown order is naturally constant over 40 years (it obviously isn't: it should
turn over at retirement, at the move, and at RMD age).

#### 13.13.2 The ladder — four ways to represent a decision

Static-vs-time-series is the wrong axis; there are four rungs, and time series is
only the second:

| Rung | Form | Example in this codebase | Generalizes across paths? |
|---|---|---|---|
| 1 | **Static scalar** — one value, all times, all paths | `crossBorderDrawdown`, `bondLadderRungs` | trivially (it ignores everything) |
| 2 | **Time-varying schedule** — `value(t)`, same on every path | `spendingExpenseBands`, `allocationGlidepath` | **no** — open-loop; fitted to the path it was solved on |
| 3 | **State-conditioned rule** — `value(state)` | `allocationRegimeTargets`, `DOWNTURN_ROTH_CONVERSION`, guardrail spending (design 26), the drawdown rules | **yes** — reacts on any path |
| 4 | **Closed-loop policy** — `value(state, t)`, re-solved online | the MPC controller itself | **yes**, optimally — but only while it runs |

Harvest is a **projection down this ladder**: rung 4 → rung 2 (SCHEDULE) or rung 1
(POINT/RESOLVE). §13.7's "loss of feedback" is exactly the information destroyed
by that projection, and it is why a baked schedule that matches the MPC on its own
path can be *worse than the pre-run scenario* on a different seed.

Two consequences that matter more than the schedule question:

- **Rung 3 often beats rung 2.** A per-year spending schedule fitted on one path is
  overfit; "spend 4% of the portfolio, floored at \$X" reacts on every path and
  needs two numbers. Where a lever's variation is really *responding to state*
  (markets, balances, residency) and not to the calendar, the right upgrade is a
  **rule with searchable coefficients**, not more knots. This project already has
  the pattern — design 26 spending strategies, design 29 behavioral strategies,
  the regime-conditioned allocation — and rung-3 params are *static scalars again*
  (rule coefficients), which is why they harvest cleanly.
- **The Roth lever is the existence proof.** §12.2 chose an income-*target* control
  over a dollar-amount control precisely because the target is a **rule
  parameter**: `convert = min(IRA, target − ordinaryIncomeYTD)` self-adjusts to a
  low-income or down-market year. That is rung 3 wearing rung-2 clothes — and it
  predicts that a *static* income target loses little against the per-year
  schedule, because the rule already absorbs the variation. §13.13.3 measures it.

More knots is the answer only when the variation is genuinely **exogenous and
calendar-driven** — age (glidepaths, the retirement spending smile), statutory ages
(RMD, preservation age, Medicare), and known one-off events (the move, the house
sale). That list is short, and notably it is *exactly* where the eight existing
schedule params already are.

#### 13.13.3 The measurement — value of time variation (VoTV)

The argument above should not be settled by argument. The harvest produces all
three artifacts needed to settle it empirically, per lever, for **free**:

```
A = terminal under the MPC's committed closed-loop plan   (already recorded)
B = terminal under the baked SCHEDULE                     (§13.7 verify)
C = terminal under the best static value (RESOLVE)        (§13.6.6)

VoTV(lever) = B − C     ← what time-variation is worth
VoFB(lever) = A − B     ← what feedback is worth (and what harvest destroys)
```

Read out per lever, this answers the whole question with numbers:

- `VoTV ≈ 0` → **the lever wants to be a scalar.** Ship RESOLVE, don't build a
  schedule type for it. (My prior: `crossBorderDrawdown`, `withinTierDraw`, and
  quite possibly `bondLadderRungs`.)
- `VoTV` large → build the schedule form (Phase 3), and the number justifies the
  work.
- `VoFB` large *while* `VoTV ≈ 0` → **the variation is state-driven, not
  calendar-driven**: a rung-3 rule is the right upgrade, and a schedule would just
  overfit. This is the case a knot-count debate can't detect and the one most
  likely to be true for the drawdown levers.

Run it under two or three seeds and the out-of-sample story falls out too — a
schedule whose advantage vanishes on seed 2 was fitted, not found. This is a
one-evening script on top of Step 12 (`scripts/lab/votv.mjs`, sibling of
`verify-harvest.mjs`), and it should gate Phase 3 rather than following it.

#### 13.13.4 If the answer is "yes, factor it" — what that design would contain

Should the measurement justify it, the framework change is a **schedule-valued
param kind**, not nine more one-off types. Sketch, for a future design doc (79):

- **Declaration**: `type:'Schedule'` + `{ axis: 'age'|'year'|'date', interp:
  'STEP'|'LINEAR'|'SKIP', of: <the scalar/Object schema of one knot's value> }`.
  The eight existing params become declarations, keeping their stored shapes.
- **One resolver**: `resolveScheduled(param, { age, year, ms }) → value`, replacing
  `bandForAge` / `interpolateGlidepath` / the per-year `emitYear` dispatches.
- **One editor**: a generic knot table (add/remove/sort/validate rows), replacing
  the five `_build*ListEditor` twins — and, notably, upgrading the three
  `Object`-typed schedules off the JSON textarea for free.
- **One search encoding**: a schedule expands to K variables over a **fixed knot
  set** — which is already design 38 §6.0's fixed-dimension requirement and design
  39 §3's control vector, so `buildExpenseBandOptConfigs` and
  `buildRothScheduleOptConfigs` collapse into it.
- **One harvest**: every schedule-typed param becomes SCHEDULE-harvestable
  automatically, and §13.3's table stops being a census of past effort. This is the
  payoff that connects the two halves of this document.
- **Parsimony as a first-class control**: max-knots and an ε-collapse are
  properties of the schedule type, not per-lever code — the overfitting guard lives
  where the knots do.

**Cost to be honest about:** K knots × L levers explodes an open-loop search, which
is precisely why the closed-loop controller is the natural *producer* of schedules
and design 38 is not. A first-class schedule type makes it easy to add knots; the
VoTV measurement is what should keep that easiness from becoming overfitting.

#### 13.13.5 Recommendation

1. Ship Step 12 as specified — including **RESOLVE** (§13.6.6), which delivers
   "optimal parameters for the entire run" with no framework change.
2. Add the **VoTV/VoFB readout** (§13.13.3) as a byproduct; it costs one script.
3. **Do not** build schedule forms for the remaining levers on intuition. Let the
   numbers say which levers want rung 2, which want rung 3, and which were fine as
   scalars all along.
4. If ≥2 levers show a real `VoTV`, write design 79 (§13.13.4) and factor the type
   **once**, retrofitting the eight existing params — rather than adding a ninth
   bespoke `*List`.

---

## 14. The projection gap — why every epoch under-projects its own outcome

**Status**: **ANSWERED 2026-09-20 — H3, and the mechanism is named in §14.9.** A
snapshot-seeded rollout restores the snapshot's state and event QUEUE over the freshly compiled
ones, so what a candidate DERIVED at compile is discarded. For the two levers whose effect is
*which events the toolset schedules* (`ROTH`, `EARLY_WITHDRAWAL` — the `foldsAtCompile` pair) two
in-place shims patch the AMOUNTS and nothing patches the event SET, which is the half that pays:
measured at ~20% of terminal wealth on a real plan, an order of magnitude more than the gap this
section was chartered to explain. H1 and H2 are not needed and are not supported.

The fix is **BUILT (2026-09-20): §14.9.4's derivation manifest**, chosen after the cheaper
per-lever shim was tested against design 110's pool levers and failed (§14.9.4's table: half-live,
76% of the truth). It needed §14.9.6 fixed first, and that is built too (§14.9.8). The
gate is BUILT (§14.9.5). Two further findings surfaced while building it (§14.9.7): one real
defect, fixed, and one that turned out to be the gate's own harness comparing two different plans,
also fixed. **§14.10 is the ordered plan.**
What follows is kept as written, because the reasoning is what got here.

**Status of the original framing**: open, and now *isolated*. Inherited from `design/81` Q6, which sharpened the
question and handed it here. This section exists so the next session starts from the
measurement rather than from the surprise.

**Measured 2026-09-20, before any hypothesis was tested** — two findings that change what the
rest of the section is asking, both against the author's own plan rather than a fixture:

- the headline ratio is an artifact of a near-zero denominator (§14.1, restated);
- **five of the nine levers were inert on that plan**, four of them silently. §14.8 is that
  finding and its fix, which is BUILT. Nothing else below is.

### 14.1 The phenomenon, in dollars

On a real 44-epoch, nine-lever run under a `DIE_WITH_TARGET` goal, the last epoch projected a
terminal of **\$16,249** against a realized path of **\$106,476** (design 81 §12 Q6). A second
run, against a different base, reproduced the same *sign* at a smaller magnitude — so it is not a
one-off of that plan.

**State it as \$90,227, not as 6.5×.** The ratio was the original framing and it is the wrong
statistic here, for a reason this design already knows: under `DIE_WITH_TARGET` with a target at
or near zero the terminal IS a residual, so both terms are small and their quotient is unstable
by construction — design 80 §4.1's degeneracy arriving as a measurement error rather than as an
objective one. §14.6's last bullet says the goal metric cannot referee this; a ratio built out
of the goal metric cannot either. On a plan whose controllable wealth runs to millions, \$90k is
about a percent of the axis, and the "second run at a smaller magnitude" is consistent with
*both* observations being small absolute misses divided by small numbers. Any per-epoch rate
derived from the ratio (§14.4) inherits the same distortion.

So the honest scale for every measurement below is **dollars, and dollars as a fraction of the
net liquidity the epoch could actually steer** — not a multiple of the terminal.

What survives the restatement, undiminished, is the DIRECTION and the display defect. A
goal-seeking controller aimed at "die with ≈ target" told the user at every epoch that it was
landing on target, while the plan it was flying landed elsewhere. §7's recommended-move card
shows the projection and nothing else, so **the one number the user reads is the one that is
wrong** — and §14.8 found the card confidently rendering a full sell order chosen from a
completely flat objective, which is the same defect with no gap in it at all.

### 14.2 What design 81 excluded, and why that is the whole reason this is tractable

Before design 81 there were two suspects and no way to separate them: the run might be bad, or
the *harvest* of it might be. Design 80 established the harvest could turn a solvent run
insolvent, which made it the obvious culprit and buried the other.

Design 81 removed the harvest from the path entirely — a recorded run is now played decision for
decision, and `B ≡ A′` is a regression test rather than a finding. So the three terms are now
cleanly separable and `run:replay` prints all of them in one command:

| term | what it is | how to get it |
|---|---|---|
| **A** | what an epoch **projected** — the winning candidate's rollout terminal | off the decision record |
| **A′** | what the run **realized** — the sequence of first segments | `replayDecisions` |
| **B** | the recorded run **played from t₀** | `npm run run:replay` |

`B ≡ A′` is the design-81 gate. **`A′ − A` is this section's subject**, and it is now a pure
controller-accuracy question with no second execution path in it.

### 14.3 The structural fact underneath it

An epoch's projection is the terminal of *"commit this control and hold it for the rest of
life"* — an **open-loop tail** from "now". The realized path is the **sequence of first
segments**, each re-decided at the next epoch. Those are different plans, and in classical MPC
they are *expected* to differ: closed-loop performance is generally better than any single
open-loop prediction whenever feedback can exploit what arrives.

So a gap is not by itself a defect. **The defect is that the cockpit presents an open-loop
number as the forecast**, and that a systematically one-sided gap of this size means the
controller is also probably choosing differently than it would if it priced the gap.

### 14.4 Hypotheses, with what would discriminate them

**Amortize the gap before hunting**, but in dollars (§14.1): \$90,227 over 44 annual epochs is
about \$2,050 a year of missed projection. Small enough per
epoch to be invisible in any single solve, which is itself a strong hint — it points away from one
dramatic cause and toward something that accretes. (The earlier framing put this as ≈4.4%/yr
against ≈1.3%/yr for the second observation; both are quotients of near-zero terminals and
neither should be quoted again.)

- **H1 — The projection is honest; feedback really is worth that much.** Each epoch under-values
  the plan because it cannot see its own future re-decisions. *Prediction*: an explicitly
  open-loop arm — hold epoch 1's decision for the whole horizon — lands near **A**, and the
  per-epoch gap is roughly constant. *If true*: nothing is wrong with the search; the **display**
  is wrong, and §7's card must stop showing an open-loop terminal as the forecast.

- **H2 — The objective is asymmetric and every epoch sits on the safe side.** `feasibilityFirst`
  (design 80 U2) makes solvency outrank reward *structurally*, and an open-loop tail is far more
  fragile than the closed-loop path because it cannot re-decide. Each epoch therefore under-spends
  to protect a tail that will never be flown. *Prediction*: the gap shrinks materially with
  `feasibilityFirst: false`, and is larger for plans closer to the solvency boundary. *If true*:
  the closed-loop objective should price solvency the way feedback actually supplies it — which
  is exactly the argument the `DEFAULT_DEFICIT_PENALTY` docblock already makes and §13.12 already
  cites ("a closed-loop objective is indifferent to solvency margin because feedback supplies it").

- **H3 — A is not a projection of what was committed.** The record's `result` is the *winning
  candidate's* rollout. If what `apply()` commits differs from what that rollout modelled —
  `prepareBaseParams` scaffolding, a lever whose `actuate` does more than the rollout did, a
  forward-effective re-stamp the rollout lacked — then A answers a different question and the gap
  is bookkeeping. *Prediction*: re-running one epoch's rollout from its own snapshot with the
  **committed** params fails to reproduce the recorded `result`. **Check this first**: it is the
  cheapest, and it would invalidate every measurement built on A.

  ***CONFIRMED 2026-09-20 — see §14.9.*** The clause that bit is the third one, "a
  forward-effective re-stamp the rollout lacked", in its strongest form: the rollout does not
  re-derive the event queue at all. The rest of this bullet is the partial rule-out that led
  there, and it still stands for the levers that are NOT queue levers.

  *Partly ruled out already, 2026-09-20.* Four epochs of a headless `CockpitController`
  (`cfgTemplate` = a real plan, `DIE_WITH_TARGET_LIQUID`, one lever) projected the SAME terminal
  at every epoch, equal to that plan's own run to the dollar — so A ≡ A′ ≡ B exactly.
  Snapshot injection and `prepareBaseParams` therefore do not mis-bookkeep A in general, and no
  measurement built on A is invalid by default. What survives is H3's lever-specific form — a
  lever whose `actuate` does more than the rollout modelled — so experiment 1 runs **per lever**,
  over the live levers of the run in question, rather than once for the run. The arm that showed
  this used a lever §14.8 has since gated off, which is the point: with an inert lever feedback is
  worth exactly zero, so A − A′ = 0 is the prediction, and it held to the dollar.

- **H4 — Horizon / terminal-value mis-specification** (design 41, §10 Q2). Only bites in windowed
  mode; the die-with-target family is full-life today. *Prediction*: absent on full-life runs.
  Listed to be ruled out, not because it is likely.

H1 and H2 are not exclusive and are probably both true to some degree. The useful question is
their **ratio**, because they have opposite remedies: H1 is fixed by reporting, H2 by re-pricing.

### 14.5 The experiment order

Cheapest-first, and each one answers something even if the next is never run. The design-81 lab
supplies the arms, so none of this needs a new driver.

0. **Establish the live-lever set** (§14.8, and the reason it is step 0). On the author's plan
   five of nine levers moved nothing, so a nine-lever run had at most four live levers and any
   decomposition would have attributed to *feedback* whatever a dead lever contributed, which is
   nothing. The gates added in §14.8 make this a read rather than an experiment: ask each of the
   run's levers `appliesTo` against the run's OWN base params, and for `ALLOCATION_MIX` ask
   `leverHygieneProblems`. A run whose live set is empty has no gap to explain. **Do not skip
   this on the grounds that the gates now prevent it** — the recorded run that produced the 6.5×
   predates them, and its live set is a fact about that log.
1. **Rule out H3, per lever.** One epoch each. Re-run its rollout from its own snapshot with the
   committed params; compare to the recorded `result`. Already done once for a single-lever run,
   where it reproduced exactly (H3 above), so what remains is the levers that run had live.
2. **Decompose per epoch.** For each epoch *k*: the projection at *k*, and the realized terminal
   of the path that actually followed from *k*. `replayDecisions` already returns per-epoch
   entries, so this is a reporting change over an existing structure. The **shape of the series**
   is the discriminator: evenly accreting ⇒ H1/H2; arriving in a few steps ⇒ a specific lever or
   event, and the epoch dates name it. Read it only after step 0 — a flat series means "H1/H2
   accreting evenly" *or* "nothing was live", and those have nothing in common.
3. **Build the open-loop arm** (H1). Hold epoch 1's decision for the whole horizon — one bag
   entry with the first epoch's rows and nothing else, which is `withoutLever`'s sibling and a
   few lines in `run-lab.mjs`. Does it land near A?
4. **Flip `feasibilityFirst`** (H2) and re-run the loop. Does the gap shrink, and by how much of
   it?
5. **Across seeds** (`npm run run:seeds`). If the gap is feedback value, it should *grow* with
   path variance; if it is a fixed conservatism, it should not.

### 14.6 What the answer changes

- **If H1 dominates** — §7's card is the fix, and it is not cosmetic. The honest forecast for a
  closed-loop controller is a **closed-loop** number, which means the cockpit must either
  simulate forward under its own policy (expensive, exact) or report the projection *as* a lower
  bound and say so (cheap, honest). The fan already shows a distribution of open-loop futures; it
  should not be read as a distribution of outcomes.
- **If H2 dominates** — the controller is leaving real consumption on the table for decades, for
  a tail risk that feedback already covers. That is a live money question, not a display one, and
  it is the same shape as design 80's finding pointed the other way: there, the *bake* lost the
  margin feedback supplied; here, the *search* pays for margin feedback already supplies.
- **Either way** — `DIE_WITH_TARGET`'s degeneracy at target 0 (design 80 §4.1: a perfect
  spend-down and a plan that went broke both read \$0) means the goal metric cannot referee this.
  Use the solvency axis and the realized terminal separately, as design 80 established.

### 14.7 What this is not

- Not a harvest problem. Design 81 closed that, and re-opening it would be re-litigating a
  measured result.
- Not a stochastic question (§10 Q5). Every term above is deterministic on one path; seeds enter
  only as experiment 5, to test a prediction.
- Not blocked on anything. The measurement surface exists (`design/81` §10), the decision log
  exists, and the first experiment is one epoch.

### 14.8 The dead levers the search was advising on — BUILT 2026-09-20

Found while opening this section, on the author's own pooled plan, in about five minutes. It is
not the projection gap; it is the thing that had to be true before the gap could be measured at
all, and it is the same class of defect design 110's `targetScale` axis was: *a lever that
changes nothing is worse than no lever.*

#### 14.8.1 The measurement

Eight params across five levers were swept on a plan whose graph names a spend order, and
**every arm returned the identical net worth, net liquidity, lifetime tax and after-tax net
worth — to the dollar**:

| lever | pooled | with `liquidityGraphEnabled: false` |
|---|---|---|
| `DRAWDOWN_SLEEVE` | inert | −7.7% of terminal wealth |
| `DRAWDOWN_WEIGHTS` | inert | −12.8% |
| `DRAWDOWN_XBORDER` | inert | — |
| `DRAWDOWN_WITHINTIER` | inert | — |
| `ALLOCATION_MIX` | inert | — |

Live on the same plan, as a scale for those zeroes: `ROTH` moved terminal wealth by ~19% and
`BOND_LADDER` by ~6%. Correctly refused by the gates that already existed: `SPENDING` (no
EXPLICIT_BANDS) and `EARLY_WITHDRAWAL` (disabled). So the real search space was **two levers of
nine**, and the cockpit said nothing.

The harness objection is cleared the way `lever-reaches-loaded-sim` clears it: the same overrides
move the no-graph arms by several percent of terminal wealth each, so they do reach the sim. This
is inertness, not a forwarding bug.

The runs themselves are in this section's study directory, per the "findings live with the study"
rule — nothing below needs the numbers, only their shape.

#### 14.8.2 Why — one line of design 97, four consequences

`compileToDrawdownSequence` flattens the pools' claims into `state.drawdownSequence` (§12, and
the graph is the authority — authoring both throws). From there, inside `replenishSavings`:

- the `drawdownPriority` walk never runs ⇒ **DRAWDOWN_WEIGHTS** synthesizes priorities nobody
  reads;
- `sequenced = orderedSources !== sources` takes the ordered branch unconditionally ⇒
  **DRAWDOWN_WITHINTIER** never splits a tier;
- a sequence entry resolves against every drawable account, deliberately bypassing the
  LOCAL_FIRST country gate (§8 Q3 — naming an account is the more specific statement) ⇒
  **DRAWDOWN_XBORDER** is never consulted;
- each claim narrows its draw to ONE allocation class before the sleeve ranker runs ⇒
  **DRAWDOWN_SLEEVE** never has two classes to rank. This is exactly the structural fact design
  107 §5.3 had to correct about `drawdownRebalanceWeight`: under a graph, `spendOrder` IS the
  sleeve policy.

`ALLOCATION_MIX` fails for a different reason — `RebalanceToTargetReducer` sizes the classes its
pools claim (§12.4, one authority), and that plan's pools claim every class the lever searches.

#### 14.8.3 The fix, and why it is two different fixes

Two of the four drawdown gates were `appliesTo: () => true`, on a comment arguing they are inert
only under a DATA condition no gate can see. A compiled spend order is a CONFIG condition, in the
params bag, so that argument no longer holds and the comment is corrected in place.

`poolGraphCompilesSpendOrder(bp)` (`lever-schedule.js`) is the predicate: the master switch,
then whether any pool names a `spendOrder` in the base graph or in a **scheduled shape** (design
109 — an order that arrives in 2043 still kills the lever for the part of the horizon being tuned).
It re-reads the authored param rather than calling the normalizer, because that file may import
leaves only (design 81 §16.5) — which makes it a second derivation of one fact, and `PLG-2` is the
test that keeps the two from drifting: the predicate must be true exactly when
`compileToDrawdownSequence` returns a sequence.

Then the split that matters:

- **The four drawdown levers are GATED.** `appliesTo` says no, the cockpit greys out Advise and
  prints the reason.
- **`requirement` may now be a function.** A two-clause gate has two remedies, and telling an
  operator to set Drawdown Strategy to WEIGHTED when it already is and the graph is the problem
  costs a session. Read it through `leverRequirement(spec, bp)`, never off the spec.
- **`inertWhen(bp)` splits the load-time refusal.** `assertRunIsPlayable` throws for a DISABLED
  mechanic because the rows are dropped and the plan silently becomes a different plan. These
  rows are NOT dropped — they apply exactly as recorded and change nothing, so the run plays back
  byte-identically to the base plan. Throwing would refuse to load a saved scenario over a
  contradiction with no behaviour behind it. An inert lever therefore **warns and loads**.
- **`ALLOCATION_MIX` is reported, never refused** (`lever-hygiene.js`, the `pool-axis-hygiene`
  shape). Its inertness is a property of which classes the claims cover, not of pooling: freeing
  ONE class on that same plan — one claim deleted, everything else held — brought the lever back
  to life immediately, by more than a percent of terminal wealth. A gate keyed on "a graph
  exists" would be wrong on every plan that leaves a class free.

#### 14.8.4 What it says about the cockpit, beyond the gates

With every candidate scoring identically, CEM still converged and the card still rendered a
confident full sell order — the same weights at every epoch, presented as advice. **A flat
objective is a result and the cockpit does not report it.** That is §14.6's display argument
arriving from the other side: there the card shows an open-loop number as a forecast; here it
shows an arbitrary point from a flat surface as a recommendation. The same run also never
mentioned that its `DIE_WITH_TARGET` terminal target was being missed by the entire portfolio —
no lever it had could close that, and nothing said so.

Both belong with §7's card, and neither is a gate. Left open deliberately, because the honest
form of "the search found nothing" depends on what §14.6 decides the card should say.

### 14.9 The answer — a rollout cannot see a lever that works through the queue

Measured 2026-09-20. H3, in the form §14.4 flagged as "check this first: it would invalidate
every measurement built on A". It does.

#### 14.9.1 The mechanism

`OptimizationProblem._injectSnapshot` seeds a rollout by replacing the freshly compiled sim's
state and **queue** with the snapshot's:

```js
sim.state = structuredClone(snap.state);
sim.queue.restoreData(queue);      // ← the compiled queue is discarded
```

That is the whole point of apply-forward (§5): don't re-simulate the past. But the queue is not
past — it holds every future event the toolsets scheduled **under the params the snapshot was
taken with**. So for a lever whose effect *is* which events exist, a rollout prices the old plan
no matter what the candidate says.

Two levers are in that class, and design 81 §6.3 already named them: `ROTH` and
`EARLY_WITHDRAWAL`, the `foldsAtCompile: true` pair. They fold into year-keyed schedule params
that `us-roth-conversion-toolset.js` and its early-withdrawal sibling read **in `schedules()`,
at compile**. A rollout never compiles the future, so the fold never happens.

**Corrected 2026-09-20, while building §14.9.5's gate.** `_seededSim` is not silent about this:
it already carries `retargetRothConversionEvents` and `retargetEarlyWithdrawalEvents`, two
forward-effective shims that rewrite the AMOUNTS on queued events after injection. So the two
levers are not wholly blind — **they are amount-only**. A shim can change a number on an event
that exists; it can neither add one nor remove one. Every decision that changes which events
exist is still lost, and that is the expensive class: a single `rothConversionSchedule` row
switches the toolset out of window mode and cancels bracket-fill for every year the run did not
decide, which is where the measured fifth of terminal wealth goes. The shims patch the cheap half
of the lever and leave the expensive half invisible.

#### 14.9.2 The measurement

One ROTH schedule row dated a year strictly inside the rollout's own horizon, on a real plan:
through the COMPILE path it moves terminal wealth by **−20%**; through the SNAPSHOT path every
rollout uses, by **exactly 0** — byte-identical. A fifth of the plan's terminal wealth, invisible
to the controller and fully paid by the plan it hands back.

#### 14.9.3 What it explains, and what it retires

- **The sign and the size of A − A′**, with no appeal to feedback value or objective asymmetry.
  H1 and H2 are not needed; nothing measured supports either, and the ratio they were invoked to
  explain is the artifact §14.1 now says it is.
- **Why every ROTH recommendation in the log is the bottom of its range.** What the rollout can
  see of the axis is the amount on events it already holds; the part that pays — the event set —
  is invisible, so the landscape the solver searches is flat or nearly so and it returns what a
  flat landscape hands back — the §14.8 failure again, from a different cause.
- **Why every controlled arm in §14.5 measured a gap of exactly zero.** `SPENDING` mutates a
  reducer's band table, which injection does not overwrite, so A ≡ A′ to the dollar over 2, 3
  and 10 epochs, at both ends of the horizon, in and out of the solvency boundary. The gap was
  never a property of closed-loop control. It is a property of two levers.

A second amplifier is real but secondary: a die-with-target goal parks the optimum on the
solvency cliff, where terminal wealth is near-vertical in the decision. At the app's own budget
of 64, five solver seeds at one epoch agree on the move to within ~1,400/mo and still project
terminals spanning 4.1M. Any future A-vs-A′ number must be quoted against that spread, not
against zero.

#### 14.9.4 The fix — not a patch, a boundary

The first draft of this section offered three options: re-derive the queue levers' events on
injection (targeted), recompile the whole future queue (more correct, re-resolves every same-date
tie in the plan — the \$391k-across-the-goldens hazard), or compile rollouts from t₀ (exact,
abandons §5 outright and, in the app, replaces the live sim the user is looking at with a
reconstruction of it, because the cockpit snapshots the LIVE sim: state, `cloneQueue()`,
`rngState`).

**The targeted option was then tested against the next thing to be built — design 110's pool
levers — and failed.** Two pool changes, made through the optimizer's own paths:

| pool change | COMPILE | SNAPSHOT (every rollout) | verdict |
|---|---|---|---|
| a pool's size target (= D110 leg C's `targetScale`) | − 5.6% of terminal wealth | − 4.2% | **HALF-LIVE — 76% of the truth** |
| a pool's `spendOrder` | − 2.5% | **0** | **BLIND** |

The split is mechanical. `RebalanceToTargetReducer` takes `poolGraph: resolveLiquidityGraph(…)`
in its **constructor** at compile, and injection does not touch reducer objects — so the SIZING
half of a pool lever sees the candidate. `state.liquidityGraph` and `state.drawdownSequence` are
compile-time **state** projections, and injection replaces state wholesale — so the DRAW-ORDER
half sees the stale graph. One lever, two halves, two worlds.

**Half-live is worse than blind.** A blind lever shows a flat fan, which is eventually noticed —
that is how ROTH surfaced. A half-live lever shows a moving fan of plausible numbers that are
wrong by a quarter, and nothing in the app or the suite can tell.

So a per-lever shim is the wrong shape, because it is a shim in a place that already has two:
`_seededSim` carries `FORWARD_DRAWDOWN_STATE_FIELDS` (six field names, design 58 §11.2) and
`forwardPriorities` (§11.3). ROTH would be the third and the pool levers the fourth and fifth,
and nobody adding a pool axis edits a hardcoded list inside the optimizer. That is design 110
§12.2's trap and the `targetScale` dead-axis failure, returning a WRONG number instead of an
identical one.

**Invert the boundary.** Injection restores everything and then re-applies a growing list of
exceptions. Classify once instead:

- **realized history** — balances, holdings, cumulative counters, dates, `rngState`, and events
  already consumed. From the snapshot, always.
- **derived from params** — control-policy state fields, compiled sequences
  (`drawdownSequence`), the compiled graph, and the event series of toolsets whose `schedules()`
  is a pure function of params. From the fresh compile, always.

Mechanically: a toolset declares `derivedState` (with a path form such as
`'*.drawdownPriority'` for the per-account case) and `derivedEvents`. Injection becomes
`state = { ...snapshot.state, ...pick(compiled, derivedState) }` and
`queue = snapshot.queue − derivedEvents + compiled(derivedEvents)`. The two existing shims are
DELETED and become declarations; the queue levers add two event types; design 110's MPC portion
declares `liquidityGraph` + `drawdownSequence` and is correct on arrival instead of by memory.

Two consequences to plan for, not discover: splicing events re-resolves same-`(date, order)`
ties around them, so the whole-state goldens may legitimately move and must be measured and
regolded deliberately; and `derivedEvents` is only sound for a `schedules()` that reads no sim
state (both queue levers qualify today — they read `context.parameters`, `.people`, `.accounts`
and an inflation rate).

#### 14.9.5 The gate — one assertion that catches both failures

> For every MPC lever, on a loaded plan: **compile-delta == snapshot-delta**.

Non-zero is not enough; that is what lets half-live through. Equality is the invariant, and it is
the generalisation of `lever-reaches-loaded-sim`'s LRS-2 and §14.8's PLG-2. It fails today for
ROTH, EARLY_WITHDRAWAL and both pool axes, and it would have caught all four in minutes.

Built as `tests/unit/mpc-lever-reaches-rollout.test.mjs`, with the known-broken levers named in
an explicit list the test also *verifies are still broken* — so the suite stays green today and
tells whoever fixes one to strike it from the list, rather than quietly passing.

Until the boundary is fixed, an **interim refusal** belongs in the cockpit, on §14.8's rule and
one degree worse: a lever the rollout cannot see is not merely inert, it is *advised on wrongly*.
`inertWhen` carries the vocabulary; this needs a third kind, because "the search cannot see this
lever" is neither DISABLED nor INERT.

#### 14.9.6 A defect found alongside it

`ROTH.prepareBaseParams` appends `{ year, incomeTarget: 0 }` so the solver has a row to tune.
On a plan that converts through the **window** form (`rothConversionStartYear`/`EndYear` +
`rothConversionMaxBracket`), the toolset returns early on a non-empty schedule — so that one
scaffolding row silently cancels bracket-fill conversions for every year the run never decided.
Measured at −20% of terminal wealth on a real plan — worse than switching conversions off
altogether. The seeded row must carry the year's window-equivalent target, not 0.

#### 14.9.7 An open thread the gate surfaced, and the defect it already fixed

Both found while building §14.9.5, and the second is fixed.

**Resolved — the "missing sibling" was two plans, not a queue defect.** On the gate's base a t₀
compile carried TWO `ROTH_CONVERSION_POLICY_EVALUATE` events per year (one per owner) and a
snapshot rolled forward from "the same" base carried ONE. The heap and `cloneQueue` were never
involved: the instanceIds did not even line up, because the two queues came from two different
compiles. The test's `compiled()` helper handed `_seededSim` the raw param bag, while
`rollToSnapshot` compiles `_resolveBase()`. Those differ because of the
two-param-stores trap: the default template (`buildDefaultConfig`) is a flat `cfg.parameters` bag,
and `serializeScenario` keeps only the `cfg.params` list. So `_cfgTemplate()` drops all 37 of the
template's values, and a compile only sees what its params carry. `_resolveBase()` puts them back.
The raw bag had no `rothConversionOwner`, so the toolset schema's default (`'both'`) applied,
while the resolved base carried the template's (`INTL_RETIREMENT_DEFAULTS`: `'primary'`).

What it did and did not touch:

- **Production: nothing.** Every production caller (`evaluate`, `rollToSnapshot`,
  `rolloutSeries`) compiles `_resolveBase()`, and every UI caller passes the active scenario,
  whose `params` list survives serialization. The STUDY's measurements ran through a headless
  `CockpitController` on the real plan, so they stand.
- **The gate: fixed, verdicts unchanged.** Both helpers now compile the resolved base, the way
  production does. MLR-1..4 still hold with both sides on one plan, and the ROTH amount case the
  thread had blocked is added and **reaches**. ROTH is now pinned as a true split: the amount
  reaches the rollout, the event set does not.
- **The trap: still armed for direct callers.** `_seededSim(params)` / `_compile(params)` called
  with a partial bag and `cfgTemplate: null` run the toolset schema defaults, not the scenario's.
  The fix is not to merge inside `_compile`: a worker is handed a pre-serialized template and
  must not re-merge (`_resolveBase`'s docstring). The two disagreeing defaults
  (`rothConversionOwner` is `'primary'` in the scenario and `'both'` in the toolset schema) are a
  separate small cleanup.

**Fixed — a rollout wrote its candidate into the shared snapshot.** `Simulation.cloneQueue()` and
`_injectSnapshot` both copied events with `{ ...e }`, so every restored event shared its `data`
object with the snapshot's. The two re-target shims above rewrite that data IN PLACE, and the
write landed in the controller's snapshot: measured, one rollout's committed early-withdrawal
amount became the baseline the NEXT candidate was scored against, and a rollout of the untouched
base read it back. A fan stopped being a comparison of candidates against a fixed "now" and became
order-dependent, in a way no output made visible. Both copies now copy `data` a level down, the
whole suite is unchanged by it, and `MLR-4` pins it — with its own pristine snapshot, because the
shared one is already contaminated by the time it runs, which is the defect hiding itself.

This is also the sharpest argument for §14.9.4's boundary over any further shim: **four shims in,
one of them was silently corrupting the measurement the others were there to protect.**

#### 14.9.8 Built — the manifest, and the §14.9.6 fix it could not ship without

**The manifest** (`src/scenarios/toolsets/derived-manifest.js`). A toolset declares
`derivedState` (a top-level key, or `'*.<field>'` for a per-object field) and `derivedEvents`
(event types). `ScenarioCompiler` stamps the union onto the sim as `sim.derivedManifest`. The
stamp is not state, so no golden or serializer sees it. `_seededSim` captures the derived half of
the fresh compile, injects the snapshot, then lays the derived half back over it. The four
special cases in `_seededSim` are deleted: `FORWARD_DRAWDOWN_STATE_FIELDS`, the WEIGHTED
per-account priority forward, and both re-target shims. Declared today:

| toolset | declares |
|---|---|
| `US_RETIREMENT` | `drawdownMode`, the six fields the old list forwarded, `'*.drawdownPriority'` |
| `AU_RETIREMENT` | `'*.drawdownPriority'` (an AU-only plan has no US_RETIREMENT) |
| `US_ROTH_CONVERSION` | `ROTH_CONVERSION_POLICY_EVALUATE` |
| `US_EARLY_WITHDRAWAL` | `SCHEDULED_EARLY_WITHDRAWAL` |

`drawdownMode` is new: it is derived from `drawdownStrategy` the same way and was never forwarded.
The retirement toolsets retain their `retarget*` exports, because the LIVE `actuate` paths still
use them. Only the rollout-side use is gone.

Two decisions in the splice are load-bearing:

- **Events are replaced by pairing, through the heap's own operations.** `restoreData` trusts
  its array to already be a heap, so it cannot be filtered. A compiled event whose
  `(type, date, name)` matches a snapshot event only swaps in its `data`, keeping the heap slot
  and `instanceId`. Only a genuine difference removes or pushes a node. So a no-op candidate
  leaves the queue bit-identical to the snapshot's, and `MLR-5` pins it.
- **"After the snapshot" is strict.** `stepTo` runs events dated ≤ its target, so the snapshot
  holds exactly the events after its date, and the compiled twins are the ones strictly after.

**Known limit (written into the module):** a derived value is the compile's value at **t₀**. A
value that legitimately changes mid-run from params (a design 81 recorded decision applied at
its date, which `MpcDecisionScheduleReducer` writes into `drawdownPriority`; a design 109
scheduled pool shape) is reverted by the pick. The four deleted cases had the same limit.
Design 110's MPC portion (step 3) meets it head-on for `liquidityGraph`, because shapes swap the
graph mid-run. It needs "the compile's value AS OF now", which is not built.

**The goldens did not move, and should not have.** They compile from t₀ and never inject a
snapshot. The splice hazard §14.9.4 predicted is real, but it lives in rollouts: see the
measurement on the author's plan below.

**§14.9.6 had to come first.** Under the manifest a rollout's future ROTH events come from
compiling the cockpit's `committed` params, and the toolset reads a non-empty schedule as the
whole plan. `ROTH.prepareBaseParams`'s `{year, incomeTarget: 0}` scaffold would therefore have
told every rollout on a window-form plan that no undecided year converts. The old shims had been
hiding that. "Materialize the window when the schedule is empty" is not enough, because the
cockpit builds a fresh controller per Advise from `scenario.params`, and after the first
`actuate` that schedule names the decided year alone. The rule is instead: **the committed
schedule must describe the plan being flown**, and the snapshot's queue is that plan. Given the
snapshot, `prepareBaseParams` adds a row for every future conversion year the queue holds and the
schedule does not name. A window year becomes `{year, bracketCeiling}`, which the toolset resolves
through the same `usBracketGrossIncomeCeiling` as the window, so it is bit-exact. The now-year
row starts at the plan's own target, not 0. `MLR-6` asserts the prepared base compiles the live
future conversions to the bit, both from an empty schedule and after a decided row. Without the
snapshot it compiles one \$0 conversion where the live plan has ten. The live `actuate` still
persists only the decided year into `scenario.params`, so a **Rebuild** of a window-form plan
after an MPC session still cancels the undecided years. That is §14.9.6's other half, on the
persistence side, and it is still open.

**Measured on the author's plan** (values in `scenarios/d39-projection-gap/STUDY.md`, Part 6),
snapshot at an epoch inside the conversion window. The base reproduces exactly. A raw one-row
schedule now moves the rollout (it read exactly 0 before), and a no-op on the cockpit-prepared
base is exact. The study also found that on that plan **no conversion after the snapshot changes
anything**: the IRAs are already drained, and zeroing every remaining year's target, event set
held, is bit-identical to the base. So the raw row's entire delta, a few percent of terminal
wealth, is the no-op events it DELETES. The policy handler returns nothing at a 0 target, so the
difference can only be same-`(date, order)` ties re-resolving on the conversion date every
remaining year. That is the "queue is not a total order" property, now reachable from a rollout
because a rollout can change the event set. A t₀ compile of the same row carries the same noise,
so rollout ≡ compile holds. A total-order tiebreak in the queue comparator would remove it, and
would move every golden. That is a decision in its own right, not part of this step.

### 14.10 Where the next session starts

Everything above is measured. This is the order to act in, and the order matters: step 3 is unsafe
before step 2.

**1. ~~The missing sibling~~ (§14.9.7): RESOLVED 2026-09-20.** The gate's harness was comparing a
raw-bag compile against a resolved-base snapshot, which are two plans. No queue defect, production
untouched, and every number above stands. The gate now also asserts the ROTH amount half.

**2. ~~The derivation manifest~~ (§14.9.4): BUILT 2026-09-20, see §14.9.8.** ROTH_EVENT_SET
struck from the gate's `KNOWN_BROKEN`. The four `_seededSim` special cases are deleted, §14.9.6's
rollout half is fixed as the prerequisite, and the suite is unchanged. The lab verifier
(`verify-mpc-lever.mjs`) is byte-identical before and after.

**3. Design 110's MPC portion: NEXT.** Two declarations (`liquidityGraph`, `drawdownSequence`)
plus striking `POOL_TARGET` / `POOL_SPEND_ORDER` from the gate. First, settle §14.9.8's known
limit: design 109 shapes swap the graph mid-run, so a t₀ pick would revert a realized shape
change on any plan that schedules one, and the author's plan does.

**Independent of all three, and small:**

- **The interim cockpit refusal.** A lever the rollout cannot see is worse than inert — it is
  advised on wrongly. `inertWhen` carries the vocabulary; this needs a third kind, because "the
  search cannot see this lever" is neither DISABLED nor INERT (§14.8, §14.9.4).
- **~~`ROTH.prepareBaseParams`~~ (§14.9.6): rollout half BUILT (§14.9.8).** Still open: the
  persistence half. `actuate` writes only the decided year into `scenario.params`, so a Rebuild
  of a window-form plan after a session cancels every undecided year. The same fix applies:
  persist the rows the live queue implies.
- **Queue total order (§14.9.8).** Removing no-op events moved the author's plan by a few
  percent of terminal wealth. Decide whether the comparator gets a stable tiebreak. It would
  move every golden.
- **Two defaults for `rothConversionOwner`** (§14.9.7): `'primary'` in the scenario, `'both'`
  in the toolset schema.
- **Report a flat objective (§14.9.3, §14.8.4).** The card renders a confident move chosen from a
  flat surface, and says nothing when the goal's own target is unreachable. Quote any A against
  the seed spread §14.9.3 measured, never against zero.
