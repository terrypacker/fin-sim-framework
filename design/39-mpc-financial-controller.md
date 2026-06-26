# 39 — MPC Financial Controller (closed-loop advisor cockpit)

**Status**: Proposed (draft 2026-06-26)
**Related**: `design/38-optimization-solver-framework.md` (**hard dependency** — the controller's inner solve *is* an `OptimizationProblem` + solver), `design/30-decision-graph-analysis.md` (the implemented scenario-comparison surface the "futures fan" rides on), `design/17-scenario-as-graph-node.md` (`DERIVES_FROM` parent edges — how a candidate future is recorded as a scenario derived from "now"), `design/33-age-banded-spending.md` / `EXPLICIT_BANDS` (the spending control lever), `design/18-performance-enhancements.md` (rollout cost).

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
- **Q4 — Snapshot seeding (resolved in approach; risk remains).** *Settled:* the snapshot already carries `state` + the event queue (§2), the primitive lives in design 38's `initialState: { kind: 'snapshot' }`, and the cross-registry hop re-hydrates the queue via `ScenarioSerializer._serializeEvent` + `TypeRegistry`. *Remaining risk to prove in Step 1:* the **deterministic-compile-across-registries** invariant (identical `stateKey` slots + wiring), and faithful event re-hydration (runtime-scheduled one-offs round-trip). Prototype before anything else stands on it.
- **Q5 — Stochastic MPC?** Replanning under Monte Carlo (maximize expected `J` s.t. success-rate ≥ threshold) is the realistic end state but multiplies cost by the MC sample count. *Recommended: deterministic MPC first*, stochastic as a later layer once the deterministic cockpit is proven.

---

## 11. Step-by-step implementation plan

### Status legend
- [ ] not started · [x] done

**Step 0 — Depends on design 38** — `OptimizationProblem`, solver registry, generalized objectives (`DIE_WITH_TARGET`), and `EXPLICIT_BANDS` must land first.

**Step 1 — Snapshot-seeded rollout primitive** [ ] *(the new core — prototype first, §10 Q4; lands in design 38 as `initialState: { kind: 'snapshot' }`)*
- Compile the scenario in an isolated `ServiceRegistry`, inject a `SimulationHistory` snapshot's `state` + re-hydrated event queue (via `ScenarioSerializer._serializeEvent` + `TypeRegistry`), `stepTo` forward.
- Prove the **deterministic-compile-across-registries** invariant + event-queue round-trip fidelity. Correctness test vs. full-horizon tail (§9).

**Step 2 — Apply-forward actuation** [ ]
- Forward-effective param edit at "now" via `SimulationSync` (no full Rebuild); record the path as a `DERIVES_FROM` scenario (design 17). Correctness gate (§9).

**Step 3 — MPC loop** [ ]
- Receding-horizon driver: build horizon `OptimizationProblem` from the now-snapshot → design-38 solver → apply first segment → advance → warm-started replan.

**Step 4 — Sampling-based MPC backbone** [ ]
- CEM/MPPI built on the design-38 solvers (elite set from `RANDOM`/`SA`). Running+terminal CRRA objective.

**Step 5 — Cockpit UI plugin** [ ]
- Timeline overlay: now scrubber, futures fan (design 30 comparison), recommended-move card, apply/override/advance. Register in `FINANCE_PLUGINS` + a workspace template.

**Step 6 — QP local polish (opt-in)** [ ]
- Finite-difference sensitivities → hand-rolled small QP on the continuous control sub-vector; second stage on the sampling elite. Graceful-degradation test (§9).

**Step 7 — Browser verification** [ ]
- Per CLAUDE.md: play a scenario to mid-life, confirm the recommended-move card + futures fan render, apply a move, advance, and confirm the controller replans onto the `DIE_WITH_TARGET` trajectory.

### Out of this plan (tracked elsewhere)
- Stochastic / MC-coupled MPC (§10 Q5).
- iLQR/DDP control.
- Worker-parallel rollout fan-out (design 18 territory).
- True mid-run branching event streams (superseded; not revived here).
