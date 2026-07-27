# 81 — The run as a replayable artifact: playback, branching, and a decision graph rooted at an epoch

**Status**: Proposed (2026-07-26)
**Related**: `design/39-mpc-financial-controller.md` (the cockpit that produces runs; §13 the harvest this reframes), `design/80-feasibility-preserving-harvest.md` (**the evidence** — §2.11 is why whole-run harvesting is the wrong granularity), `design/30-decision-graph-analysis.md` (the container/leaf/compare patterns reused wholesale), `design/17-scenario-as-graph-node.md` (the `SimGraphNode` + `DERIVES_FROM` substrate), `design/38-optimization-solver-framework.md` (the solver a re-solve calls), `design/74-stochastic-return-paths.md` (per-seed replay)

> **Reading note**: design 39 treats a controller run as a *process* — you drive it, you harvest it, you throw it away. This design treats it as an **artifact**: a recorded, replayable, inspectable, branchable object that keeps paying out long after the solve. The enabling fact is a measured cost asymmetry — a full solve is minutes, replaying the same run is **0.8 seconds**.

---

## 1. Purpose

Design 80 established, against the user's real 44-epoch decision log, that a **solvent** controller run harvests into an **insolvent** scenario, and that *every schedule bake individually causes ruin while being faithful* (§2.11). The natural conclusion is "make the bakes better." That is wrong: the bake errors were already tiny, and the plan had no margin for any of them.

The right conclusion is that **whole-run harvesting is the wrong granularity.** Committing nine levers × 44 epochs in one shot is an all-or-nothing operation where every approximation compounds. What the user actually wants is smaller and more powerful:

> Stop the controller at any point, look at exactly what it decided and what state it was looking at, take the one value that is good, and try variations from there — cheaply enough to do it dozens of times.

That is not a harvest feature. It is a **playback and branching** feature, and it makes the expensive solve worth paying for, because a run stops being a one-shot and becomes a substrate you interrogate.

**Non-goal.** This does not replace the params harvest (design 39 §13). Params remain the legible, editable, searchable, shareable representation and the only thing downstream consumers (MC, OPT, the goldens, CSV export) understand. Replay is instrumentation and an iteration loop; it is not a scenario.

---

## 2. Why this is possible now

| Operation | Cost |
|---|---|
| Full cockpit solve, 44 epochs × budget 64 × 9 levers | minutes |
| `replayDecisions` over the same 44 epochs | **0.8 s** (measured, design 80 §2.11) |
| A branch at epoch *k* with a snapshot cache | proportional to `n − k` |

`src/finance/mpc/replay.js` already exists (design 80 F6). It is the MPC loop with the solve deleted: apply what the controller committed, roll to the next epoch, repeat. It reconstructs the realized trajectory exactly, deterministically, from the decision log alone.

Two orders of magnitude changes what interactions are possible. A slider you drag is a different product from a button you press and wait on.

---

## 3. Conceptual model — a run is a path in the graph

Designs 17 and 30 already put everything in **one shared `Graph`**, partitioned by `layer`, with `DERIVES_FROM` as the only derivation edge:

| Layer | Owner | Contents |
|---|---|---|
| `scenario` | `ScenarioRegistry` | user saves |
| `analysis` | `DecisionGraphRegistry` | `DecisionGraph` containers |
| `analysis-leaf` | the runner | cartesian leaves; cleared between analyses, opt-in persistence |
| `decision` | `DecisionRecordRegistry` | MPC epochs (design 39 §13 H4) |

So MPC records and decision-graph leaves are already siblings in one graph. The concepts were built on a shared substrate and never wired together. The distinction that matters:

- a **decision graph** is a *fan* — independent leaves off one base, explored combinatorially;
- an **MPC run** is a *chain* — epoch *k*'s state is the product of epoch *k−1*'s decision.

Both are `DERIVES_FROM` structures. The comparison surface (design 30 §5.1) already "operates on two graph-node IDs" and does not care which.

### 3.1 The mismatch to fix first

`CockpitController.parentId` is assigned once in the constructor and never updated, so all 44 epochs attach `DERIVES_FROM` **the same base scenario**. A run that is inherently a chain is stored as a fan, and its temporal order survives only as an `asOfDate` field.

Chaining the epochs (`epoch_k DERIVES_FROM epoch_{k−1}`) is a one-line change with disproportionate payoff, because `graph-query-api.js` already has the traversals:

- **`traceBackward(epoch_k)`** = exactly the decisions needed to reconstruct state at *k*. This *is* `paramsAt(date)` — a graph query, not a new fold.
- **`traceForward(epoch_k)`** = everything a branch at *k* invalidates, which is what the UI must grey out.

---

## 4. Substrate changes

### 4.1 `MpcRun` — the missing container node

Today a run exists only as a `runId` string repeated across 44 records. Design 30 already solved this shape with `DecisionGraph` (layer `analysis`), which owns its leaves and carries the analysis configuration. The direct analogue:

```js
MpcRun {                       // layer: 'analysis', kind: 'mpc-run'
  id, name,
  baseScenarioId,              // DERIVES_FROM this
  goal, goalMetric,            // objective + primary metric
  controlKeys, controlRanges,  // the lever set and its search bounds
  solverKey, budget, seed,     // reproducibility (see design 80 U5)
  simStart, simEnd,
  epochRange, epochCount,
  createdAt,
}
```

Naming, storage, lifecycle and the picker all come from mirroring `DecisionGraphRegistry`. "Runs as named artifacts" becomes reuse rather than new machinery.

### 4.2 Per-epoch effective params (design 80 P1-1b) — a prerequisite, not a nicety

Records write `spendingExpenseBands[19].monthlyAmount` — an **index into the band table as it stood during that run**. Edit the scenario's bands and every recorded decision silently points somewhere else. This is not hypothetical: it produced a wrong `A′` during design 80's investigation, and it failed *silently*, which is exactly how it will fail in a UI.

Each record therefore stores the **full effective param set** alongside the `controlParams` delta. The delta stays authoritative for "what the controller decided"; the full set makes the record self-describing, survives scenario edits, and is what `paramsAt` returns.

### 4.3 Snapshot cache — load-bearing for the interaction, not an optimisation

`OptimizationProblem.rollToSnapshot` already produces a snapshot per epoch. Caching them on first replay makes a branch at epoch *k* cost `n − k` epochs instead of `n`. Late branches become near-instant; early ones stay sub-second. **Without this the live-drag interaction in §6 is not viable**, so it belongs in the design rather than in a later performance pass.

---

## 5. Replay semantics — two modes, always labelled

A branch changes a decision at epoch *k*. Everything after *k* was decided by a controller that never saw that change. Two honest responses, and the UI must never blur them:

| Mode | What it does | Cost | What it is |
|---|---|---|---|
| **Frozen policy** (default) | replay forward with the recorded decisions unchanged | `n − k` epochs, sub-second | a *counterfactual under the same policy* — legitimate and useful |
| **Re-solve from here** | run the real solver from *k* forward | epochs × budget, minutes | a plan the controller endorses |

Frozen-policy variants carry a badge; the re-solve button shows its estimated cost. Design 30 never needed this distinction because all its leaves are open-loop by construction. It is genuinely new vocabulary and getting it wrong means people read a patched trace as an optimum.

---

## 6. UI — Playback mode inside the cockpit

**Decision: Playback lives inside the existing MPC cockpit plugin**, with the run controls collapsed when no run is attached. The cockpit already has every widget this needs, pointed at a live solver instead of a recording:

| Cockpit widget (Record mode) | Same widget (Playback mode) |
|---|---|
| "now" scrubber | observation scrubber over recorded epochs |
| recommended-move card | **what the controller decided here** — `describeRecord` already renders exactly this |
| futures fan | the fan drawn *at that epoch*, plus variant lines |
| Apply / Advance | **Pin** / **Branch** |

If it outgrows the cockpit it can be split out later; the renderers are shared either way.

```
┌ ⏺ RUN: die-with-zero · 9 levers · CEM/64 · 44 epochs ── [Runs ▾] [Re-solve] [×] ┐
│ 2026 ●─●─●─●─●─●─●─●─●─●─●─●─●─●─●─●─▮─●─●─●─●─●─●─●─●─●─●─● 2070              │
│                                       ▲ T = 2049-01-01  epoch 24 of 44          │
│ [◀]  [▶ play]  [▶]                    realized ──  projected-at-T ···  variant ─│
└─────────────────────────────────────────────────────────────────────────────────┘
┌ DECIDED AT THIS EPOCH ──────────────────────────────────────────────────────────┐
│ Set monthly spend for age 69 to $8,831/mo   ·   Draw order: ira → us-stock → …   │
│ projected terminal $12,401   ·   realized $106,476   ·   ✅ solvent, deficit $0   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 6.1 Parameters are shown in the Scenario panel, not a new one

A second place to read parameters would drift from the first. The existing Scenario panel gains an **as-of-T mode** fed by `paramsAt(T)`:

```
Scenario params                    ⏱ as of 2049-01-01   [ live | as-of-T ]
● Monthly Spending    $8,831   was $8,470     [pin] [branch] [sweep]
  Drawdown Order      ira 0.66, us-stock 0.30, …
● allocWeight::EQUITY 0.43     was 0.31       [pin] [branch] [sweep]
  Roth income target  —        (skip year)
```

`●` marks a param the controller changed **at** this epoch; the `was` column diffs against the previous epoch. Scrub anywhere and every parameter in force is visible, with the just-moved ones called out. This is the core ask.

### 6.2 The interaction loop

- **Observe** — scrub or step; params, decision card and chart follow. The chart shows the realized path against *what the controller projected from here*, which is where the design 80 §2.6 divergence becomes visible (projected \$16,249, realized \$106,476).
- **Pin** — copy one value into the live scenario. The smallest possible edit, landing in the normal params diff, feasibility-checked. This is design 39 §13.1's missing "copy" step at single-decision granularity.
- **Branch** — inline control on the row; dragging runs a debounced replay and draws a variant line against the original.
- **Sweep** — 3–5 values (or min/max/step) → N replays → N lines + a ranked table (§7).
- **Compare / Promote** — two variants into design 30's existing side-by-side; promote a variant to a saved scenario, gated by design 80 F1.

### 6.3 Honesty affordances

- **Frozen-policy badge** on every branched variant, beside a costed **[Re-solve from here]**.
- **Feasibility chip** on every variant and every pin, from the `extra.feasibility` block records now carry (design 80 U2). Non-negotiable: `finalNetLiquidity` is degenerate at target 0, so a ruined plan renders as "\$0 — on target" (§2.6). Solvency must be shown separately, always.
- **An unmissable mode indicator** — live scenario / run playback / unsaved variant must never be ambiguous.

---

## 7. A decision graph rooted at an epoch

Design 30's `DecisionPoint {paramKey, options}` expands a cartesian product off one base scenario at t₀. **Branch-from-epoch is the same object rooted at epoch *k*'s snapshot.** The runner generalises from "base = scenario node" to "base = any node with a resolvable initial state," and an epoch node has one.

**This is where the two features stop being neighbours and become one thing — because of cost.** Design 30 §4.5 caps analyses at *"dozens of leaves, not thousands"* because each leaf is N Monte Carlo draws. A replay leaf is 0.8 seconds. Rooting a decision graph at an MPC epoch and evaluating leaves by **replay** instead of MC moves that ceiling by two orders of magnitude: "spend 7000/7500/8000/8500 at 2035" × "move 2031/2033" is 8 leaves in about 7 seconds, each an exact reconstruction.

The two evaluators are complementary rather than competing, and the funnel is the point:

| Evaluator | Produces | Cost | Use |
|---|---|---|---|
| **replay** | one exact number per leaf, one path | ~0.8 s | sweep wide, narrow the field |
| **Monte Carlo** | p10 / p50 / p90 / success rate | minutes | confirm the survivors |

So a leaf gets **"run MC on this leaf"** as a promotion step. Cheap to explore, expensive to decide.

Leaf lifecycle needs no new thinking: `analysis-leaf` semantics already are ephemeral-by-default, cleared between analyses, opt-in persistence — exactly right for replay variants.

### 7.1 Where the analogy breaks

- **Branching is a tree, not a product.** Design 30's leaves are independent by construction. Changing epoch 5 changes the state epoch 20 starts from, so multi-epoch branching does not factor and `expandLeaves`' cartesian assumption does not generalise. **v1 branches at one epoch at a time**; a genuine tree is the honest structure if multi-point branching is wanted later.
- **Different epistemics.** A replay leaf is a single deterministic path; an MC leaf is a distribution. The evaluator must be visible on every result, or a one-path number gets read as a forecast.

---

## 8. The script surface

The UI is the user's half; the scripts are the other half, and design 80 demonstrated that the scripts are where the answers actually came from. Every UI capability must be reachable headlessly, fast, and `--json`-able for chaining. A shared `scripts/lib/run-lab.mjs` (sibling of `harvest-lab.mjs`) holds load / replay / branch / sweep.

| Command | Purpose |
|---|---|
| `run:inspect <run> [--at DATE]` | epoch table; with `--at`, the full param set in force — `paramsAt` on the CLI |
| `run:replay <run> --scenario <s>` | the A / A′ / B table (generalises `replay-vs-bake.mjs`) |
| `run:branch <run> --at DATE --set 'key=value'` | one counterfactual: terminal, solvency, delta vs baseline |
| `run:sweep <run> --at DATE --param K --values a,b,c` | N replays, ranked — §7 headless |
| `run:attribute <run>` | swap-one-lever-group table (built by hand in design 80 §2.11; promote to a tool) |
| `run:seeds <run> --seeds 1,2,3` | the recorded policy across design-74 seeds → robustness |

---

## 9. The run file is the interface between the two halves

This deserves to be a stated goal rather than an accident of how design 80 went. The browser's `fin-sim-decisions` export — `{ records: [...] }` — is exactly what the scripts consume. The user dumps localStorage, the analysis happens headlessly, a scenario file comes back. **That loop is what solved design 80**, after four in-code reconstructions produced four different wrong mechanisms.

Therefore: keep the export format stable, give the UI a one-click **Export run**, make every script accept it directly, and let the scripts *write* a scenario back. Two additions make the file self-sufficient — the **base scenario identity** it was recorded against (§4.1) and the **per-epoch effective params** (§4.2).

---

## 10. Decisions locked

- **D1 — A run is a first-class artifact**, an `MpcRun` container node (layer `analysis`) owning its epoch nodes, mirroring `DecisionGraph`.
- **D2 — Epoch nodes chain.** `epoch_k DERIVES_FROM epoch_{k−1}`, making `paramsAt` a `traceBackward` and branch-invalidation a `traceForward`.
- **D3 — Playback is a mode of the existing cockpit**, not a new surface, reusing its scrubber / card / fan / `describeRecord`. Revisit only if it outgrows the panel.
- **D4 — Parameters are shown in the Scenario panel** in an as-of-T mode. No parallel params UI.
- **D5 — Frozen-policy and re-solved variants are always distinguished**, with the re-solve cost shown.
- **D6 — Replay is instrumentation, not a harvest destination.** Params remain the shareable, searchable representation; promotion to a scenario goes through the design 80 F1 gate.
- **D7 — Per-epoch effective params are a prerequisite**, not a follow-up: index-keyed decisions fail silently without them.
- **D8 — Leaf evaluator is selectable and labelled** — replay to explore, MC to confirm.

---

## 11. Open questions

- **Q1 — Does `paramsAt` fold deltas or read the stored effective set?** Folding is elegant and makes the chain edges load-bearing; reading is robust to a corrupted/partial log. Probably read, with folding as a cross-check that can flag divergence.
- **Q2 — How much of a run should persist?** 44 epochs × a full param set is not free in localStorage. Options: store the full set only every *k*-th epoch and fold deltas between; or compress by storing only changed keys plus a periodic keyframe. A keyframe-plus-delta scheme is the obvious answer but wants measurement first.
- **Q3 — Should a branch be re-recordable as its own run?** A variant that has been re-solved from epoch *k* is arguably a new run sharing a prefix. If so, runs form a tree and the picker needs to show it.
- **Q4 — Does the fan replay too?** Each record stores its projection's terminal but not the full fan series. Re-deriving the fan at epoch *k* costs a handful of rollouts. Worth it for the "what it was thinking" overlay, or is the single projected number enough?
- **Q6 — Why does every epoch under-project its own outcome by ~6.5×, and does that matter?** On the real log the last epoch projected a \$16,249 terminal; the realized path (A′) delivered **\$106,476**. Every epoch's projection is the terminal of "hold this decision for the rest of life," but the realized path is the *sequence* of first segments, and they are not the same plan. The cockpit only ever displays the projection — so for a die-with-target goal the user is being told they will land on target while the plan actually overshoots by 6.5×. **Playback makes this visible for the first time** (§6.2 plots both), which is reason enough to build it, but the gap itself may be a design-39 controller-accuracy problem worth its own investigation. Do not assume it is benign: a goal-seeking controller that systematically misses its goal by that margin is either mis-reporting or under-spending, and both matter.
- **Q5 — What happens when the base scenario is edited after a run?** The run's decisions may no longer apply cleanly. Detect via the stored base identity and mark the run stale rather than replaying it against a scenario it never saw.

---

## 12. Testing sketch

- `run-graph.test.mjs` — epochs chain; `traceBackward(epoch_k)` returns exactly epochs 1…k in order; `traceForward` returns k+1…n.
- `params-at.test.mjs` — `paramsAt(T)` equals the folded deltas up to T; equals the stored effective set; the two agree on a real log.
- `replay-branch.test.mjs` — a branch at epoch *k* leaves epochs < k byte-identical and diverges only after; a no-op branch reproduces the baseline exactly.
- `snapshot-cache.test.mjs` — a cached branch at *k* produces the identical result to an uncached full replay (correctness), and issues `n − k` rolls rather than `n` (the performance contract).
- `epoch-rooted-decision-graph.test.mjs` — leaves expand off an epoch snapshot; replay and MC evaluators produce results tagged with which one ran.
- `run-staleness.test.mjs` — editing the base scenario's band table marks the run stale instead of silently re-keying (the §4.2 failure).

---

## 13. Step-by-step plan

### Status legend
- [ ] not started · [x] done

**Phase 1 — Substrate** (small, independently useful, unblocks everything)
- [ ] **1a** — Per-epoch effective params on the decision record. **This is design 80's P1-1b — the same task, moved here; do not do it twice.** *Do it first; §4.2 says why it fails silently otherwise.*
- [ ] **1b** — Chain the epoch `DERIVES_FROM` edges; `parentId` advances per epoch.
- [ ] **1c** — `MpcRun` container node + registry mirroring `DecisionGraphRegistry`; base-scenario identity stamped.
- [ ] **1d** — `paramsAt(run, date)` over the graph, plus `run:inspect`.

**Phase 2 — Replay as a service**
- [ ] **2a** — Snapshot cache in `replayDecisions`; branch cost proportional to the tail.
- [ ] **2b** — `branchFrom(run, epoch, overrides)` → frozen-policy variant as an `analysis-leaf` node.
- [ ] **2c** — `run:replay` / `run:branch` / `run:attribute` / `run:seeds`.

**Phase 3 — Playback UI**
- [ ] **3a** — Run picker + attach/detach; epoch ticks on the timeline; observation scrubber.
- [ ] **3b** — Decision card via `describeRecord`; projected-vs-realized readout; feasibility chip.
- [ ] **3c** — Scenario panel as-of-T mode with the `●` changed-here marker and `was` diff.
- [ ] **3d** — Pin (single value → live scenario, F1-gated).
- [ ] **3e** — Branch with live drag; variant line on the fan; frozen-policy badge + costed re-solve.

**Phase 4 — Epoch-rooted decision graph**
- [ ] **4a** — Generalise the decision-graph base from "scenario node" to "any node with an initial state."
- [ ] **4b** — Replay evaluator alongside the MC evaluator; results tagged with which ran.
- [ ] **4c** — Sweep UI + ranked table; "run MC on this leaf" promotion.
- [ ] **4d** — `run:sweep`.

**Phase 5 — Promotion**
- [ ] **5a** — Promote a variant/leaf to a saved scenario through the design 80 F1 feasibility gate; unify with `applyHarvestPlan`.

---

## 14. Honest limits

- **A replay is one path.** Everything in Phases 2–4 reconstructs or perturbs a single deterministic trajectory. It says nothing about robustness until `run:seeds` or an MC promotion is run, and the UI must not let a one-path number read as a forecast.
- **A frozen-policy branch is not a plan.** The controller would have re-decided. It is a clean counterfactual under a fixed policy, which is genuinely useful and genuinely not the same thing.
- **This does not fix design 80's failure; it routes around it.** A whole-run harvest of a zero-margin plan will still go insolvent. What changes is that the user no longer has to do one — they can take the values they want and check each edit. Design 80 **F1** (block an infeasible promotion) remains required. **F2** (margin-aware re-solve) is de-prioritised by this design rather than refuted: if you can sweep eight margin levels by replay in seven seconds and *look* at them, having the harvest guess a margin for you is a much weaker offer.
- **Storage is unbounded-ish.** Q2 is real: keeping many runs with full per-epoch param sets will strain localStorage well before it strains anything else.
