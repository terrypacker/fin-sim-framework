# 81 — The MPC run as a dated decision schedule the simulation plays

**Status**: **COMPLETE — all eight phases built, 2026-09-19 → 2026-09-20** (§14) · Direction revised 2026-09-19 (§0) · What the build measured, and where it revised the plan: §16 (eleven notes)

> **What is still open** is small and named: Q2 (sweeping a run's *contents*, which wants a
> design-110-style resolver axis, not a param path), Q3b (whether the picker should *offer*
> "re-solve from here"), Q4 (serializer / CSV round-trip), Q5's residue (`source.baseScenarioId`
> is stamped and read by nothing — no base edit beyond a disabled mechanic is yet known to
> deserve a refusal), and **Q6**, which this design sharpens rather than answers: with `B ≡ A′`
> now a regression test and the harvest permanently excluded as a suspect, the A-vs-A′ gap is
> isolated as a pure controller-accuracy problem. **Picked up in `design/39` §14**, which states
> the hypotheses, what discriminates them and the experiment order.

**Related**: `design/39-mpc-financial-controller.md` (the cockpit that produces runs; §13 the harvest this replaces), `design/80-feasibility-preserving-harvest.md` (**the evidence** — §2.11 is why a collapsing harvest is the wrong representation), `design/109-time-varying-pool-shapes.md` (**the precedent** — §8 is the mechanism this reuses wholesale), `design/58-drawdown-levers.md` §11 (the forward-effective state fields), `design/38-optimization-solver-framework.md` (the solver a re-solve calls), `design/30-decision-graph-analysis.md` (the compare surface, corrected in §9), `design/74-stochastic-return-paths.md` (per-seed replay)

> **Reading note**: design 39 treats a controller run as a *process* — you drive it, you harvest it, you throw it away. This design makes it a **scenario parameter**: a dated list of the decisions the controller committed, which the simulation applies as the clock reaches each one. You press Play and the plan unfolds exactly as the controller decided it, with no bake, no collapse and no separate playback engine.

---

## 0. The revision record — what changed on 2026-09-19, and why

The version of this document dated 2026-07-26 proposed an **offline playback surface**: a `replayDecisions` engine driving a scrubber inside the MPC cockpit, with a snapshot cache to make a drag interactive, branch variants as `analysis-leaf` nodes, and an as-of-T mode bolted onto the Scenario panel.

That design is superseded by a simpler one with the same goal:

> Save the controller's choices at each solve point into the scenario, select "use optimized parameters", and **play the simulation**. The ordinary time controls move the clock; the decisions apply as it passes them.

This is better for a reason that is not taste. The old design built a *second* execution path for a recorded run and a *second* place to read parameters, and then had to keep both honest against the real one. This one has no second path: the run becomes a parameter, and the one simulation plays it.

And a run reached through a **scalar selector** (§4) is reachable by every analysis surface the app already has. The 2026-07-26 draft spent §7 arguing for an epoch-rooted decision graph with a new evaluator; selecting among recorded runs turns out to be a `DecisionPoint` over one param, with no new machinery at all (§4.2). That is the part worth leaning into.

### What that dissolves

| Old item | Fate |
|---|---|
| **§4.2 / design 80 P1-1b** — a full effective param set on every decision record, ~13 KB × 44 epochs, because `spendingExpenseBands[19].monthlyAmount` silently re-keys | **Dissolved.** The schedule never addresses a band by index. Each lever applies its own value through a hook that speaks the lever's vocabulary (§4.2). There is nothing to re-key. |
| **§4.3** — a snapshot cache, declared "load-bearing for the interaction" | **Dropped from v1.** Its only justification was a debounced live-drag. "Toggle the mode and press Play" does not need it. *(Measured, so the trade is on the record: 45 ms per epoch roll and ~280 KB per snapshot on a real 44-year plan — a 44-epoch cache is ~12 MB of RAM to save ~2 s.)* |
| **§6.1 / D4** — an as-of-T mode in the Scenario panel | **Dissolved.** The schedule *is* a scenario param, so it is already in that panel, edited by the same typed-editor machinery as every other param. |
| **§6.2** — branch by dragging a control against a debounced replay | **Replaced** by: edit a row, press Play. |
| **§3 / D3** — playback as a mode of the cockpit | **Replaced.** Playback is the normal time controls. The only new UI is a master switch and a way to get a run into the param (§8). |
| **§4.1** — an `MpcRun` container node mirroring `DecisionGraphRegistry` | **Revived, in a different substrate.** The instinct was right — a run *is* a named artifact that owns its decisions — but a graph node cannot carry it: `DecisionRecordStorage` persists nodes without edges, so a graph-held run does not survive a reload, and a graph node is not reachable by `DecisionPoint`, the optimizer or an export. It becomes a `mpcRuns` bag entry instead (§4.1, §4.3). |

### What survives

`replayDecisions` (`src/finance/mpc/replay.js`) stays, in the role it was built for: the **A′ verification term**, and the engine behind the headless `run:*` scripts (§10). It is no longer the playback engine.

The run-file-as-interface argument (old §9) survives intact and gets stronger: the exported decision log is still what the scripts consume, and now what they *emit* is a single param.

### Two bugs this found in the running app

Both are consequences of the same fact and are fixed by the mechanism rather than patched:

1. **Apply-then-scrub-back replays the whole run at the last epoch's values.** `COCKPIT_CONTROLS.SPENDING.actuate` mutates `ExplicitBandsSpendingReducer.bands` in place via `reducerService.updateReducer`. `TimeControls._doRewindTo` → `sim.rewindToStart()` restores **state, `rngState` and queue only** (`simulation-history.js:42`); `configPresenter.resetForReplay()` only clears UI debug flags. So the mutated reducer survives the rewind and the run replays from t₀ at the new amount. This is design 80's "last-epoch-wins applied from t₀" failure happening live, with no harvest involved.
2. **`actuate` writes each epoch's value into the active scenario param.** Harmless for SPENDING (age-keyed — each epoch writes a different band) but `bondLadderRungs` and `allocWeight::*` are point params, so the saved scenario silently accumulates last-epoch-wins.

---

## 1. Purpose

Design 80 established, against the user's real 44-epoch decision log, that a **solvent** controller run harvests into an **insolvent** scenario, and that *every schedule bake individually causes ruin while being faithful* (§2.11). The bake errors were tiny — an ε-collapse, a ±1-year step shift, a glidepath L1 tolerance — and the plan had no margin for any of them, because a die-with-zero objective spends the margin by construction and **feedback was silently paying for it**.

The old conclusion was "harvest at a finer granularity". The right conclusion is stronger:

> **Stop collapsing.** A controller run already *is* a schedule — one decision per epoch per lever, each with a date. Store that, play that. Every collapse rule in the harvest is a lossy compression of something the engine can hold exactly.

A run then stops being a thing you approximate into a scenario and becomes a thing the scenario *contains*. `B ≡ A′` by construction: the baked plan and the realized closed-loop path are the same object, so design 80's central confound — was it the run or the bake? — cannot recur.

**Non-goal.** This does not delete the legible harvest (design 39 §13). Collapsing forty-four decisions into three age bands produces something a human can read, edit and argue with, and that remains worth having as an **export**. What it stops being is the only representation, and the one the plan is judged on.

---

## 2. The constraint that decides the mechanism

Measured, because everything below turns on it.

```js
// src/simulation-framework/reducers.js:128
reduce(state, _action, _date) { … }
```

That is the whole signature. A reducer sees **state, the action, and the date**. It has no service registry, no event queue, and no reach into another reducer's instance fields. `PoolShapeScheduleReducer` confirms the shape: it takes its resolved schedule at construction and emits one state patch.

The consequence is not obvious and it is the crux:

> A lever whose runtime value lives on **another reducer's instance field** cannot be changed mid-run by anything inside the simulation.

The only alternative is `ReducerService.updateReducer`, which mutates the instance in place and publishes `SERVICE_ACTION` → `SimulationSync`. That is a **configuration-layer** edit: not an event, not in the journal, not in a snapshot, and nothing drives it on a schedule. It exists for the UI's live Apply. If the schedule rode on it, then Monte Carlo, the optimizer, the CLI tools and the goldens would all play the run **without** the decisions — the plan would be one thing on screen and another everywhere the numbers are actually checked.

So the values have to live where the simulation can reach them: **state**, or the **event queue**, or **compiled in from a param**.

This is a forward-play constraint, not a rewind constraint. Rewind-safety (§0 bug 1) comes along for free.

---

## 3. Where the nine levers keep their value today

| Lever | runtime home | reached by the engine? |
|---|---|---|
| `DRAWDOWN_XBORDER`, `DRAWDOWN_WITHINTIER`, `DRAWDOWN_WEIGHTS`, `DRAWDOWN_SLEEVE` | state — `FORWARD_DRAWDOWN_STATE_FIELDS` (`optimization-problem.js:49`) plus per-account `drawdownPriority` | ✅ already |
| `ROTH`, `EARLY_WITHDRAWAL` | queued events, seeded at compile from `rothConversionSchedule` / `earlyWithdrawalSchedule` (both already **year-keyed params**) | ✅ via compile (§6.3) |
| `SPENDING` | `ExplicitBandsSpendingReducer.bands` | ❌ instance field |
| `ALLOCATION_MIX` | `RebalanceToTargetReducer.targetAllocation` | ❌ instance field |
| `BOND_LADDER` | `BondLadderReducer.targetRungs` | ❌ instance field |

`bond-ladder-reducer.js:27-31` states the property outright — *"its target (the rung count) is held on the reducer instance (`targetRungs`), NOT in a per-account state field, so it survives MPC snapshot injection and re-wires live via `reducerService.updateReducer(reducer, { targetRungs })` with no `_seededSim` re-stamp."* That is a **feature** for a snapshot-seeded rollout, where the fresh compile carries the new value, and precisely the wrong property here.

Three accessors close the gap. §6 says what they are.

### 3.1 There are already two implementations of "apply a lever forward"

Worth stating before adding a third:

- **`COCKPIT_CONTROLS[*].actuate`** — live, mutates services, UI-only, not rewind-safe.
- **`OptimizationProblem._seededSim`'s re-stamp block** (`optimization-problem.js:400–475`) — state fields, per-account priorities, `repinExpensesIfChanged`, `retargetRothConversionEvents`, `retargetEarlyWithdrawalEvents`.

They exist for different reasons (a live sim vs a fresh compile with an injected stale snapshot) and they have drifted. The `applyAt` hook of §4.2 is the third, and it is the one that runs **inside** the simulation, so it is the one the numbers come from. **D7** makes it the authority the other two route through.

---

## 4. The structure: a bag of runs, and a parameter that selects one

Two params, declared in the strategy-registry form every other param uses (`{ key, label, type, group, mc, opt, defaultValue, description, visibleWhen }`), plus a convenience switch.

```
mpcRuns: {
  '<runId>': {
    source:    { recordedAt, baseScenarioId, goal, goalMetric, levers[],
                 solverKey, budget, seed, epochs, first, last, derivedFrom },
    decisions: [ { date, lever, key, value }, … ],
  },
  …
}

mpcActiveRun:  '<runId>' | null      // which one governs this run of the plan
mpcRunEnabled: true                  // the OFF switch that keeps the selection
```

This is `liquidityShapes` + `liquidityGraphSchedule` again, and deliberately: **named payloads in a bag, a scalar that selects one.** Design 109 §4 chose that shape for referential-integrity reasons that do not apply here, and it turns out to be the right shape for a second, larger reason that does.

### 4.1 Why the indirection, and not a single flat param

A single `mpcDecisionSchedule: [ … ]` array — the previous draft of this section — works, and it is simpler to describe. It is also a dead end, for three reasons that only show up downstream:

1. **A scenario holds one plan at a time.** Recording a second run overwrites the first, so comparing two runs means two scenario files and a study. Runs are the *cheapest* thing the cockpit produces and the thing you most want several of.
2. **An array param cannot be an axis.** `DecisionPoint.options` are `{ value, label }` pairs and `makeLeafEntry` writes `p.value = leafParams[p.name]`. A scalar run id is a perfect option value. A four-hundred-row array is not, and `liquidityGraphSchedule[i].year` is the exact trap `generated-param-keys.js:37` and `pool-shape-year-axis.js` were written for — a nested path is not a dotted key.
3. **Provenance drifts from its payload.** The previous draft had a sibling `mpcDecisionScheduleSource` param, and §15 had to list "two params to keep in agreement" as an honest limit. Folding `source` into each bag entry removes the limit rather than documenting it.

### 4.2 The payoff: two MPC runs compared **is** a decision graph

This is the part worth leaning into, and it needs no new machinery at all.

```js
new DecisionPoint({
  id: 'plan', label: 'Plan', paramKey: 'mpcActiveRun',
  options: [
    { value: null,            label: 'No MPC run (base plan)' },
    { value: 'run:2026-09-14', label: 'Spending-only, CEM/64' },
    { value: 'run:2026-09-18', label: 'Nine levers, CEM/128' },
  ],
});
```

Three leaves. `DecisionGraphRunner._expandLeaves` builds the cartesian product, `makeLeafEntry` writes the selection into each leaf scenario, and each leaf gets `mcDrawsPerLeaf` Monte Carlo draws with its own reproducible seed offset. The ranked view then answers the question design 80 §14 said a single replay *cannot*:

> Which of these recorded plans is actually robust, rather than which one happened to land well on one path?

And because a `DecisionPoint` is one axis among several, crossing it with anything else is free — "is run A still the better plan if the move slips two years" is a 2 × 3 grid, not a project.

**The old §7.1 objection dissolves too.** The 2026-07-26 draft noted that design 30's cartesian assumption does not generalise to branching *within* a run, because changing epoch 5 changes the state epoch 20 starts from. True, and irrelevant here: whole runs are **independent by construction**, which is exactly the leaf model design 30 already has. The thing that did not fit was branching mid-run; selecting among recorded runs fits perfectly.

The same scalar reaches the optimizer as an `ENUM` variable over run ids, and `scripts/lib/variant.mjs`'s generic `params {name: value}` escape hatch, with no plumbing in either.

### 4.3 What stays in the graph, and what moves to the param

The bag is **not** a replacement for the `decision` graph layer, and conflating them would repeat design 39 Step 5c's bug in a new place. They are different objects with different lifecycles:

| | the recording | the plan |
|---|---|---|
| **What** | `layer:'decision'` nodes — one per epoch, with the projection, the fan, `extra.feasibility` | a `mpcRuns` bag entry — dates, levers, keys, values |
| **Where** | `fin-sim-decisions` storage, via `DecisionRecordRegistry` | the scenario, like any other param |
| **Travels with an export?** | no | yes |
| **Read by the engine?** | never | every period advance |
| **Lifecycle** | a session's log; deletable | part of the plan; versioned with it |

Promotion from one to the other is the **design 80 F1-gated** step (§8). That direction is one-way: a bag entry is not re-recordable into the log.

**Note for anyone tempted to put the bag in the graph instead.** The `decision` layer cannot carry a plan today: `DecisionRecordStorage.save` persists `{ records }` — **nodes only, no edges** — and `DecisionRecordRegistry._init` re-adds nodes without them. Every `DERIVES_FROM` edge the cockpit lays is lost on reload. That is also why the 2026-07-26 draft's D2 ("epoch nodes chain, so `paramsAt` is a `traceBackward`") would not have survived a page refresh.

**Lineage without edges.** Old **Q3** asked whether a run re-solved from epoch *k* is a new run sharing a prefix. It is, and `source.derivedFrom: '<runId>'` records it inside the entry — a tree, held as a parent pointer, needing no edge persistence and travelling with the export. The run picker can render the tree from the bag alone.

### 4.4 A run's `decisions` — a flat table

```
decisions: [ { date, lever, key, value }, … ]
```

One row per decision variable per epoch. It is the union of the run's `controlParams`, with the date attached and nothing else — no projection, no feasibility block, no param bag.

**Flat, and four scalar columns, deliberately.** A nested `{ date, params: {…} }` row would be a JSON blob in a table cell: unsortable, unfilterable, undeletable row-by-row, and it is the shape every structured editor in this repo exists to avoid. Flat buys the interaction for free — filter to one lever, sort by date, delete the one epoch that was wrong, change the one value you want to try. That is the 2026-07-26 draft's "pin one value and try variations" ask, arriving as a table rather than as a feature.

- **`date`** — the epoch's `asOfDate`. A row takes effect at the **first period advance on or after** it.
- **`lever`** — a `COCKPIT_CONTROLS` key. It selects the `applyAt` hook; it is not decoration.
- **`key`** — the lever's **stable** decision key, from a new `scheduleKey(variable)` hook on the lever spec.
- **`value`** — the committed scalar.

**The index-keyed trap, closed at the root.** Six of the nine levers already emit a stable `paramKey` from `buildVariables` and `scheduleKey` is the identity for them. **Three do not** — and they are exactly the three whose decision is inherently dated, so each already stamps the anchor it needs:

| Lever | `buildVariables` emits | `scheduleKey` returns | anchor already stamped? |
|---|---|---|---|
| `SPENDING` | `spendingExpenseBands[19].monthlyAmount` | `band@69` | ✅ `_startAge` |
| `ROTH` | `rothConversionSchedule[3].incomeTarget` | `year@2039` | ✅ `_year` |
| `EARLY_WITHDRAWAL` | `earlyWithdrawalSchedule[3].taxDeferredAmount` | `year@2039::taxDeferredAmount` | ✅ `_year` |
| `DRAWDOWN_XBORDER` | `crossBorderDrawdown` | *(identity)* | — |
| `DRAWDOWN_WITHINTIER` | `withinTierDraw` | *(identity)* | — |
| `DRAWDOWN_WEIGHTS` | `drawdownWeight::<role>` | *(identity)* | — |
| `DRAWDOWN_SLEEVE` | `sleeveWeight::<class>` | *(identity)* | — |
| `ALLOCATION_MIX` | `allocWeight::<class>` | *(identity)* | — |
| `BOND_LADDER` | `bondLadderRungs` | *(identity)* | — |

*(Built with one shared `year@` prefix rather than `roth@` / `earlyWithdrawal@`: the lever column already says which schedule a row addresses, so a second copy of that in the key is a second thing to keep in step. The field separator is `::`, matching the `drawdownWeight::` / `allocWeight::` convention a `.` would break — see `DRAWDOWN_WEIGHT_SEP`.)*

An index is a position into a table *as it stood during that run*. Edit the table and every recorded decision silently points somewhere else — which is not hypothetical: it produced a wrong `A′` during design 80's investigation, and `scripts/lab/replay-vs-bake.mjs:80–120` still carries forty lines of heuristics reconstructing the pre-run band table *by shape*, ending in `process.exit(2)` when a hole makes it impossible.

Under this design **no index is ever stored**, because nothing ever writes back into those tables: `applyAt` stamps state keyed by age or year. The old §4.2's 13 KB-per-epoch param bag was the fix for a problem this mechanism does not have.

### 4.5 `applyAt` — the hook that makes a row mean something

```js
applyAt({ state, rows, asOfMs }) → statePatch | null
```

Seven of the nine levers get one, beside their existing `buildVariables` / `describe` / `harvest` / `actuate`. It receives the rows in force for this lever at `asOfMs` and returns a state patch, or `null` for "nothing to do" — the same no-op discipline `PoolShapeScheduleReducer` keeps (§5). `ROTH` and `EARLY_WITHDRAWAL` act on queued events and take a different route; §6.3 says why, and it is the one place the mechanism is not uniform.

The hook speaks **the lever's vocabulary**, not the param system's. `SPENDING.applyAt` returns a band table; it does not address a band by index. `DRAWDOWN_SLEEVE.applyAt` writes `drawdownSleeveOrder` / `drawdownSleeveWeights` directly, which is what its `actuate` already does. That is why the bag needs no param paths and no re-keying.

### 4.6 Size

Measured on a real 44-year plan: ~44 epochs × up to 9 levers ≈ 400 rows, ~24 KB serialized per run. Ten recorded runs is ~240 KB in a scenario that already serializes at ~350 KB. The bag is affordable; a cap is not needed in v1, and a "delete run" in the picker is (§8).

## 5. The application: `MpcDecisionScheduleReducer`

Straight from design 109 §8, which is the precedent in every particular.

- Fires on **`US_PERIOD_ADVANCE` / `AU_PERIOD_ADVANCE`**, like `PoolFlowReducer` and `PoolShapeScheduleReducer`.
- Priority **`PRE_PROCESS + 0.25`**. The slot is narrower than it looks and the reasoning is worth recording, because both obvious answers are wrong.

  It must be **after** `PRIORITY.PRE_PROCESS` (`10`), where **fifteen reducers already sit** — among them `UsPeriodAdvanceReducer` / `AuPeriodAdvanceReducer`, which write `state.currentPeriods[cc] = action.period` and whose docstring says they run there *"so the correct period and filing status are in state before any tax or cash-flow reducers run on the same step."* A decision reducer placed below `10` would resolve its "now" against the **previous** period whenever it fell back off `action.date` — a silent one-period error, on exactly the date the controller chose, of precisely the kind this design exists to remove.

  It must not **join** the tie at `10` either: fifteen reducers on one priority are ordered only by the stable sort's tie-break, i.e. by where their `push` lands in `US_RETIREMENT.reducers`. Position by accident is not position.

  And it must be **before** every consumer — `MarketIndexReducer` (+0.5), `PoolShapeScheduleReducer` (+1), `PoolFlowReducer` (+3), `ExplicitBandsSpendingReducer` (+4), `RebalanceToTargetReducer` (+4), `BondLadderReducer` (+5) — because a period that applies a decision must evaluate its flows and size its targets on the decision that has just taken over. Switching after them makes the first period of every decision run on the previous one.

  Fractional priorities are an established idiom here, with the precedent documenting this exact reasoning: *"It runs at PRE_PROCESS + 0.5, after PeriodAdvanceReducer (10) and BEFORE RegimeApplyReducer"* (`market-index.js:46`). `+0.25` is free; `+0.5` is not.
- **Resolves once, applies the delta.** It asks each lever named in the active rows for a patch and merges. A lever whose rows have not changed since the last advance returns `null`.
- **No change ⇒ no patch at all**, via `this.newState(state)`. In every period of every run but the handful that decide something, this reducer costs a map lookup and writes nothing, and the journal carries no diff.
- **Registered only when `mpcActiveRun` resolves to a run in the bag and `mpcRunEnabled` is not `false`**, in `US_RETIREMENT.reducers(context)` beside `PoolShapeScheduleReducer` (`us-retirement-toolset.js:1510`). A scenario with no active run has an identical reducer list, an identical journal and an identical run. **Absent is absent** — every golden stays byte-identical. Note the condition is on the *selection*, not on the bag: a scenario can carry ten recorded runs and play none of them, which is what makes the bag safe to accumulate.

**Why not an event.** A `MPC_DECISION` event on the queue is the natural-looking design and is the one to refuse, for the reason design 109 §8 records and the goldens have measured: this engine's event queue is not a total order, so adding any event re-resolves tie-breaks among events already scheduled on the same instant. A feature whose job is to change a *policy* must not perturb the ordering of the *transactions*, or every A/B between two plans is confounded by an ordering change it did not ask for.

**The consequence to state rather than discover.** A decision bites at the first period advance on or after its date. On a semi-annual advance cadence that is up to six months of lag, deterministically. The panel should show the date a decision *became live*, not the date that was recorded.

**One visible marker.** The patch carries `state.mpcDecisionApplied = { date, levers }` so the journal diff and the timeline show *that* a decision landed. Without it the whole feature is invisible in exactly the surface a user watches while it plays.

---

## 6. The three state reads

Each is the `_poolGraphOf` refactor design 109 already did on this same reducer:

```js
// rebalance-to-target-reducer.js:387 — the pattern, already in the tree
_poolGraphOf(state) { return state?.liquidityGraph ?? this.poolGraph; }
```

### 6.1 `ExplicitBandsSpendingReducer`

`_bandsOf(state) { return state?.mpcSpendingBands ?? this.bands; }` — a **full replacement band table**, not a merge map (old Q3, resolved).

A merge would be smaller in state and would need merge semantics that only one reader understands; a replacement is the same shape `this.bands` already is, so `bandForAge` and the re-pin logic work unchanged and there is one vocabulary rather than two. The cost objection is measured and does not survive: a 21-band table is ~1 KB against the ~280 KB a snapshot of this plan already carries.

The reducer's existing re-pin logic then does the rest untouched: it already re-pins when `band.monthlyAmount !== state.explicitBandSpending.appliedAmount`, which is exactly the case an override creates. Within an unchanged band it stays hands-off, so inflation and the reactive strategies keep their say — the property the lever was built around, preserved.

### 6.2 `RebalanceToTargetReducer` and `BondLadderReducer`

`_targetAllocationOf(state) ?? this.targetAllocation` and `_targetRungsOf(state) ?? this.targetRungs`. Both have several read sites (`rebalance-to-target-reducer.js:630, 657`; `bond-ladder-reducer.js:91`); **every** read must route through the accessor or the override applies in some paths and not others, which is worse than not applying at all.

### 6.3 `ROTH` and `EARLY_WITHDRAWAL` — the one place the mechanism is not uniform

These two levers act on **queued events**, and a reducer cannot touch the queue. But they are also the two levers whose params are *already* year-keyed schedules, consumed at compile to seed those events. So under play-from-t₀ they need no mid-run mechanism at all: their rows **fold into `rothConversionSchedule` / `earlyWithdrawalSchedule` at compile**, before the toolsets build the events.

`retargetRothConversionEvents` / `retargetEarlyWithdrawalEvents` exist only because `_seededSim` injects a *stale snapshot queue* into a fresh compile — a rollout-specific problem that does not arise when the clock starts at t₀.

This is the one load-order dependency in the design: the fold must happen before `US_ROTH_CONVERSION` and `US_EARLY_WITHDRAWAL` build their schedules. It needs a test that names it, not a comment.

---

## 7. Record mode and play mode are mutually exclusive

Because the schedule is a param, `MpcCockpitPlugin._ensureController` reads it through `_paramsToMap(scenario.params)` like anything else — which means **Advise at epoch 12 would solve against a world where epochs 13–44 are already decided.** The controller would be optimising against its own answers, and the futures fan would be a fan of plans that already contain their own futures.

**D8** settles it with a rule rather than a mode flag:

> A rollout seeded at "now" sees only schedule rows **strictly before** "now".

`CockpitController` truncates the resolved schedule at `this.snapshot.date` before every `advise` / `apply` / `advance`. That one rule gives the correct behaviour in all three cases: a fresh run sees nothing, a resumed run sees its own committed past (which is exactly right — it *is* the realized plan), and "re-solve from epoch k" gets the prefix and nothing else, for free.

The UI still wants an unmissable indicator of which mode it is in; that is §8, not this rule.

---

## 8. UI — a picker, a switch, and a way in

Small, because the runs are params and the params panel already exists.

- **`mpcActiveRun`** — a select over the bag's keys, with `— none —` first. This *is* the "use optimized parameters" control; no separate mode flag is needed to turn it on. Each option is labelled from the entry's `source` (`Nine levers · CEM/128 · 2026-09-18 · 44 epochs`), because a raw run id is not a choice anyone can make.
- **`mpcRunEnabled`** — the OFF switch that **keeps the selection**, mirroring `liquidityGraphEnabled` (`behavioral-strategy-registry.js:733`). Selecting `— none —` also turns it off but forgets which run you were on, and toggling a plan on and off is the most common thing anyone will do with this.
- **The run picker** — `buildMpcRunsEditor`, a list of named blocks like `buildLiquidityShapesEditor`: each entry shows its `source` line, a row count, **Delete**, and expands to the decision table. `source.derivedFrom` (§4.3) renders the tree.
- **The decision table** — `buildRowListEditor` (`src/visualization/components/row-list-editor.js`) scoped to the expanded entry, four typed columns: `date` (date), `lever` (select over `COCKPIT_CONTROLS`), `key` (select, options provided by the selected lever), `value` (number/select by the lever's variable type). Sorted by date, filterable, row-deletable. Same machinery as `buildLiquidityGraphScheduleEditor`.
- **Cockpit: "Save run to plan"** beside the existing "Copy to scenario…", writing a new `mpcRuns` entry from the decision log and selecting it, through the **design 80 F1 feasibility gate** (which takes a plan, and a run's decisions are a valid plan).
- **Mode indicator** — live plan / playing a recorded run must never be ambiguous. §6.3 of the original design was right about this and it still holds.
- **Timeline / journal marker** — from `state.mpcDecisionApplied` (§5), so a decision landing is visible while it plays.

The ordinary time controls do the rest. **Step-back is not dropped**: it stays a full re-simulation from t₀ and therefore stays slow, but with the schedule compiled in and the reducer reading state it becomes *correct*, which it is not today (§0 bug 1).

---

## 9. What the rest of the app gets for free

This is the strongest argument for the runs being ordinary scenario params rather than a session overlay, and for §4's indirection: every one of these reaches a run through the **scalar selector**, not through the payload.

| Consumer | What it gains | Cost |
|---|---|---|
| **`DecisionGraph`** | N recorded runs ranked by MC, crossable with any other axis — §4.2 | — |
| **Monte Carlo** | "MC this plan" — the 2026-07-26 draft's §7 promotion step, arriving as nothing at all | Q1 |
| **Optimizer** | `mpcActiveRun` as an `ENUM` variable: search *over* recorded plans | — |
| **`ScenarioCompareRunner`** | A/B a run against its own base, side by side | — |
| **Goldens** | one fixture carrying an active run pins the whole mechanism | — |
| **`variant.mjs` / `grid.mjs`** | a run is an axis value through the generic `params` escape hatch | — |
| **Export / diff / CSV** | runs are shareable and diffable like any other plan | — |

**A correction to the original §3.** It claimed design 30's compare surface "operates on two graph-node IDs and does not care which". It does not: `ScenarioCompareRunner.run(entry)` takes a **full serialized scenario** and runs it from t₀ through `ScenarioLoader`. An epoch node is not one. That was the load-bearing claim under the old §6.2's compare step, and it was wrong. Under this design the point is moot — a run *is* a scenario, so compare works with no new code.

---

## 10. The script surface

Unchanged in intent from the original §8; `replayDecisions` still drives it, and `scripts/lib/grid.mjs` (serial in-process cells, progress + ETA + a results envelope) hosts the sweep rather than a new driver. A shared `scripts/lib/run-lab.mjs` holds load / schedule / branch / sweep.

| Command | Purpose |
|---|---|
| `run:inspect <run> [--at DATE]` | the epoch table; with `--at`, the decisions in force |
| `run:save <run> --out <scenario>` | write the decision log into the scenario's `mpcRuns` bag and select it — the headless twin of §8's button |
| `run:replay <run> --scenario <s>` | the A / A′ / B table (generalises `replay-vs-bake.mjs`). **Under this design B ≡ A′ is a regression test, not a finding.** |
| `run:branch <run> --at DATE --set 'key=value'` | one counterfactual: terminal, solvency, delta vs baseline |
| `run:sweep <run> --at DATE --key K --values a,b,c` | N runs, ranked |
| `run:attribute <run>` | swap-one-lever-group table (built by hand in design 80 §2.11) |
| `run:seeds <run> --seeds 1,2,3` | the recorded plan across design-74 seeds → robustness |

Every one is discovered into `help/REFERENCE.md` automatically via `parseFlags`, so the only help work is the topics (§14 Phase 5).

---

## 11. Decisions locked

- **D1 — A run is a scenario param, reached through a scalar selector.** `mpcRuns` is a bag of named recorded runs, each carrying its own `source`; `mpcActiveRun` picks one; `mpcRunEnabled` turns it off without forgetting which. The indirection is not tidiness — a scalar is what makes a run an axis for `DecisionPoint`, the optimizer's `ENUM` and `variant.mjs` (§4.1, §4.2). Not a graph container, not a session overlay.
- **D1a — The graph keeps the recording; the param keeps the plan** (§4.3). They have different lifecycles, and `DecisionRecordStorage` persists nodes without edges, so the graph cannot hold a plan that survives a reload anyway. Lineage between runs rides on `source.derivedFrom`, not on edges.
- **D2 — All nine levers go through one mechanism.** Design 80 §2.11 exonerated the POINT collapse on *one* log; that is not a general result, and two representations of a run's decisions is two places a fidelity bug can hide.
- **D3 — The switch is a reducer, not an event** (design 109 §8). Adding to the queue re-resolves tie order portfolio-wide.
- **D4 — Absent is absent, and the condition is the *selection*.** No active run ⇒ no reducer registered ⇒ every existing golden byte-identical. A scenario may carry runs it does not play.
- **D5 — A run stores no param paths.** Each lever's `scheduleKey` returns a stable key and its `applyAt` writes state. The index-keyed re-key trap is closed at the root, not mitigated.
- **D6 — A decision bites at the first period advance on or after its date**, with the lag stated in the UI.
- **D7 — `applyAt` is the single "apply a lever forward" authority.** `actuate` and `_seededSim`'s re-stamp block both route through it; three implementations is how they drift.
- **D8 — A rollout seeded at "now" sees only rows strictly before "now"**, so the controller never solves against its own future (§7).
- **D9 — Promotion stays gated** by design 80 F1. Writing a bag entry is a promotion.
- **D10 — The lossy harvest survives as an export**, not as the representation. A three-band summary a human can argue with is worth having; it is no longer what the plan is judged on.
- **D11 — An active run and a study axis over a key it pins are refused, not reconciled** (Q1, resolved). Split the way design 110 already splits it: a scenario-level contradiction **throws at load**, the way `normalizeLiquidityGraph` throws on a hand-authored `drawdownSequence` beside a graph; a *study* misconfiguration **reports and never repairs**, the way `poolAxisProblems` does at `monte-carlo-presenter.js:354`. Silently letting either side win is how an arm and its control come to differ in two ways.
- **D12 — `SPENDING.applyAt` stamps a full replacement band table** (Q3, resolved), not a merge map — one vocabulary, `bandForAge` unchanged, and ~1 KB against a ~280 KB snapshot.

---

## 12. Open questions

- ~~**Q1 — What does Monte Carlo do to a pinned key?**~~ **RESOLVED → D11: refuse to author both.** An active run pins `allocWeight::EQUITY` at 44 dates; an MC or optimizer variable perturbs it; today the later write wins and nothing says which. Neither "the run wins" nor "MC wins" is honest, because both produce a grid that *looks* comparable and is not. The refusal has two halves, following design 110's existing split — a load-time throw for a scenario-level contradiction, and a report-never-repair warning at study launch (`poolAxisProblems`' home). **Note what this does *not* refuse**: `mpcActiveRun` as the axis itself is the whole point of §4.2, and it pins nothing MC is perturbing.
- **Q2 — Should a run's *contents* be sweepable?** Selecting *among* runs is solved (§4.2). Transforming one — shift every date a year, scale every spending decision by 0.95 — is not, and `mpcRuns['<id>'].decisions[i].value` is the exact trap `generated-param-keys.js:37` and `pool-shape-year-axis.js` were written for: a nested path is not a dotted key. If that is wanted it needs a resolver-level axis family in the design-110 style, not a param path. **Cheap interim**: a "duplicate run with a transform" action in the picker, which is `buildLiquidityShapesEditor`'s `+ Duplicate` argument (§11 of design 109) applied here.
- ~~**Q3 — Is `state.mpcSpendingBands` the right shape?**~~ **RESOLVED → D12: a full replacement band table.** The size objection was the only argument for a merge map and it does not survive measurement (~1 KB vs a ~280 KB snapshot). A replacement is the shape `this.bands` already is, so nothing downstream learns a second vocabulary.
- **Q3b — Does a run re-solved from epoch *k* become its own entry?** Yes — `source.derivedFrom` (§4.3) makes runs a tree held as parent pointers. Open: whether the picker should *offer* "re-solve from here" or whether that stays a cockpit action that happens to write a derived entry.
- **Q4 — Does the schedule round-trip through `ScenarioSerializer` and the CSV param export?** Dates in a table cell are the usual place that breaks.
- ~~**Q5 — Staleness.**~~ **RESOLVED in phase 3 → a lever-gate refusal at load, and (for now) that is the whole of it.** The answer §16.3 forced is below, and phase 3 built it generalized: every recorded lever's `appliesTo` gate is asserted against the base at compile, and a false gate throws. What phase 3 did **not** add is a general "the base moved" detector — `source.baseScenarioId` still records provenance and still drives nothing. That is deliberate and is the second half of the original question, now standing alone: a run that stores no param paths survives most base edits intact, so the remaining candidates for a refusal are edits that change what a *key* means, not edits that change a number. None has been found. **Q5's residue**: name one, or close it. The original text follows.
- **Q5 (original) — Staleness.** `source.baseScenarioId` lets us detect that the base moved under a recorded run. What should that *do* — warn, refuse to select, or nothing? A run that stores no param paths is far more robust to a base edit than the 2026-07-26 draft was, so this looked like a badge on the picker entry rather than a gate. **§16.3 found the case that decides it and it is not a badge**: a run recorded with `rothConversionEnabled: true`, selected against a base where it has since been switched off, has every ROTH row dropped by the toolset's opening gate and plays back as a different plan in silence. A run whose levers name a disabled mechanic must refuse at load. Open: whether *any* other base edit rises to a refusal, or whether that one gate is the whole of it.
- **Q6 — Why does every epoch under-project its own outcome by ~6.5×?** On the real log the last epoch projected a \$16,249 terminal; the realized path delivered **\$106,476**. Every epoch's projection is the terminal of "hold this decision for the rest of life", but the realized path is the *sequence* of first segments, and they are not the same plan. The cockpit only ever displays the projection — so for a die-with-target goal the user is told they will land on target while the plan overshoots by 6.5×. **This design sharpens the question rather than answering it**: once `B ≡ A′` is a regression test, the A-vs-A′ gap is isolated as a pure controller-accuracy problem with the harvest permanently excluded as a suspect. A goal-seeking controller that systematically misses its goal by that margin is either mis-reporting or under-spending, and both matter. **Owned by `design/39` §14** (written 2026-09-20), which names the hypotheses, the experiment that discriminates them and the one to run first — and which `run:replay` (§10) now feeds directly.

---

## 13. Testing sketch

- `mpc-run-absent.test.mjs` — no active run (and, separately, **a bag with entries but `mpcActiveRun: null`**) ⇒ `MpcDecisionScheduleReducer` is not in the reducer list, and a golden fixture is byte-identical. **The gate for D4**, and the second case is the one that makes the bag safe to accumulate.
- `mpc-schedule-noop.test.mjs` — a period that changes nothing emits no patch and no journal diff.
- `mpc-schedule-boundary.test.mjs` — a row dated mid-period takes effect at the next advance, not at the instant; the lag is the stated one.
- `mpc-schedule-equals-replay.test.mjs` — **the headline.** A scenario carrying a run's schedule, run from t₀, reproduces `replayDecisions` on the same log. `B ≡ A′`, which is design 80's finding turned into a regression test.
- `mpc-schedule-state-reads.test.mjs` — for each of the three: the override wins where present, the instance field wins where absent, and **every** read site honours it.
- `mpc-schedule-rewind.test.mjs` — play to simEnd, rewind, replay: identical state. Fails today for SPENDING / ALLOCATION_MIX / BOND_LADDER (§0 bug 1).
- ~~`mpc-schedule-roth-fold.test.mjs`~~ — **landed as `mpc-run-queue-levers.test.mjs` MRQ-3 / MRQ-4**: the rows reach the compiled event schedules, and the fold happens before the toolsets read them (§6.3).
- ~~`mpc-schedule-truncation.test.mjs`~~ — **landed as `mpc-run-record.test.mjs` MRR-6 / MRR-7**: `CockpitController` at epoch k sees rows < k and no others (D8).
- ~~`mpc-run-editor.test.mjs`~~ — **landed as `tests/viz/mpc-run-editors.test.mjs`**: the row editor round-trips, sorts by date, and an emptied bag syncs to `null`. One deviation: deleting the selected run does **not** clear `mpcActiveRun` — it leaves it dangling *visibly*, as `(not found)`, because silently rewriting the selection is the §15 failure this surface exists to prevent.
- ~~`mpc-run-as-decision-point.test.mjs`~~ — **the §4.2 gate, BUILT and PASSING (phase 8).** A `DecisionPoint` over `mpcActiveRun` with three options expands to three leaves, `makeLeafEntry` writes the selection into each, and the three leaves produce three different results. The whole analysis surface reaches MPC runs with no further work.
- ~~`mpc-run-refuses-conflicting-axis.test.mjs`~~ — **landed in two halves**: the load-time throw is `mpc-run-queue-levers.test.mjs` MRQ-5/MRQ-6, the launch-time report is `mpc-run-record.test.mjs` MRR-8, and `mpcActiveRun` as the axis itself does neither.

---

## 14. Step-by-step plan

### Status legend
- [ ] not started · [x] done

**Phase 1 — The whole path, end to end, on one lever** — **BUILT 2026-09-19**
- [x] **1a** — `mpcRuns` / `mpcActiveRun` / `mpcRunEnabled` param declarations (`us-retirement-toolset.js`, group `MPC Runs`); `resolveActiveMpcRun(params)` + `activeDecisionsAt(run, asOfMs)` in `src/finance/mpc/run-schedule.js`, exported and used by every consumer — the `activeGraphAt` discipline (design 109 §7: *"normalizing it three times with three slightly different option sets is how the same object comes to mean three things"*). `mpcActiveRun` ships `opt: false`: §9's ENUM-over-runs needs its candidate set to come from the bag, which is phase 8, and `SWEEP-18` refuses a flag whose engine cannot yet sweep it.
- [x] **1b** — `scheduleKey(variable)` and `applyAt({ state, rows, asOfMs, baseParams })` on the lever spec. *Two deviations, both recorded here rather than discovered later.* (i) The hooks are **defined** in `src/finance/mpc/lever-schedule.js` and spread into `COCKPIT_CONTROLS`, so the spec surface is the one §4.5 describes while the reducer and the toolset that registers it reach them without importing `cockpit-controller.js` and the solver registry behind it. (ii) `applyAt` also receives **`baseParams`**: SPENDING rebuilds the whole authored band table (§6.1) and a reducer cannot reach the param bag any other way.
- [x] **1c** — `MpcDecisionScheduleReducer` (`PRE_PROCESS + 0.25`), registered only when a run is selected and enabled. Change detection is one scalar — the greatest row date not after "now" — because the active set can only change when a row's date is crossed; that covers every lever at once and keeps `mpcDecisionApplied` the `{ date, levers }` marker §5 asks for. A lever named by a row with no `applyAt` **warns once, loudly**, rather than playing the run back short.
- [x] **1d** — `SPENDING`: `scheduleKey` → `band@<startAge>`, `applyAt` → a full `state.mpcSpendingBands` table (D12), and `ExplicitBandsSpendingReducer._bandsOf(state)`. The table is rebuilt from the **authored base** every period rather than from the previously stamped one, because `rows` is already the whole history in force — so the patch is a pure function of (base, rows, now) and cannot accumulate drift across a rewind.
- [x] **1e** — `mpc-run-schedule.test.mjs` (MRS-1…8) and `mpc-run-absent.test.mjs` (MRA-1…5), plus the design 37 §6 coverage row. **Equals-replay is covered in its stronger, cheaper form**: MRA-4 asserts a played run is state-for-state identical to the from-scratch run whose band table is date-keyed the same way. The `replayDecisions` comparison proper waits on phase 4a — there is no recorder yet, so a `records` log would have to be hand-built and would test the hand-building.
- **Milestone**: ✅ hand-write a bag entry, select it, press Play, and the run reproduces the date-keyed plan exactly (MRA-4). Recording one from the cockpit is 4a.

**Phase 2 — The rest of the state-backed levers** — **BUILT 2026-09-20** (§16.1, §16.2 revised it; §16.5 is what it cost)
- [x] **2a** — `DRAWDOWN_XBORDER`, `DRAWDOWN_WITHINTIER`, `DRAWDOWN_SLEEVE`: no reducer refactor, they already write `FORWARD_DRAWDOWN_STATE_FIELDS`. The categorical two **refuse an illegal mode** rather than stamping it, because `replenishSavings` reads them with a default branch and a typo'd mode on disk would play back as a plan nobody chose. `DRAWDOWN_SLEEVE` stamps `drawdownSleeveOrder: WEIGHTED` alongside the weights — weights the selector never consults are not a decision, and it makes the recorded run self-contained against a base that has since been switched off (a free partial answer to §16.3). **`DRAWDOWN_WEIGHTS` was not in that class** (§16.2): its `applyAt` is now the **D7 authority** (`drawdownPriorityPatch`), `actuate` calls it, and `_presentRolesFromState` moved to `lever-schedule.js` as `presentRolesFromState`. One call site is left for 7a — `_seededSim`'s re-stamp in `optimization-problem.js`.
- [x] **2b** — `ALLOCATION_MIX` → `state.mpcTargetAllocation` + `RebalanceToTargetReducer._targetAllocationOf` (all five read sites); `BOND_LADDER` → `state.mpcBondLadderRungs` + `BondLadderReducer._targetRungsOf` (`:91`). Today's glidepath/regime anchor semantics are inherited exactly and now **asserted** (MRL-6), so they cannot drift by accident; the gating question goes to design 39 unchanged. The mix is synthesized over the classes the ROWS name — the same narrowed set `describe`/`actuate` pass — because passing all four would reproduce a different mix from the one the run held.
- [x] **2c** *(unplanned — see §16.5)* — `scenarios/params/lever-weights.js`, a leaf module holding the Lever-A/Lever-B weight vocabulary and `synthesizeWeightedPriorities`, re-exported from its two old homes. Not tidying: without it phase 2 cannot be written at all.
- **Tests**: `mpc-run-levers.test.mjs` (MRL-1…8). MRL-4 is the D7 gate — `actuate` and `applyAt` must produce identical per-account priorities. MRL-8 is the import-cycle gate (§16.5).

**Phase 3 — The two queue levers** — **BUILT 2026-09-20** (§16.6)
- [x] **3a** — `ROTH` / `EARLY_WITHDRAWAL` fold into `rothConversionSchedule` / `earlyWithdrawalSchedule` at compile, in `src/finance/mpc/run-compile-fold.js`, called from the one seam in `ScenarioCompiler.compile` between `_resolveParameters` and `_buildContext`. `scheduleKey` is `year@<year>` (and `year@<year>::<field>` for EARLY_WITHDRAWAL, which decides two numbers a year) — D5 in its purest form, because both levers' `buildVariables` emit an index that their own `prepareBaseParams` moves by appending and re-sorting. `foldsAtCompile: true` on the spec is what makes `MpcDecisionScheduleReducer` skip those rows **silently** instead of firing its missing-hook warning on every run that converts. **MRQ-4 asserts the order**, not the outcome: a probe toolset records what `context.parameters` held at the instant its `schedules()` was called.
- [x] **3b** — D11's first half, **generalized**. Not just the two `Enabled` flags: `assertRunIsPlayable` throws when **any** recorded lever's `appliesTo` gate is false against the base, because the same silent failure exists wherever a gate decides whether a consumer is compiled at all (no `EXPLICIT_BANDS` ⇒ no `ExplicitBandsSpendingReducer` ⇒ a band table stamped and read by nobody). The error names every offending lever and its `requirement` sentence.
- [x] **3c** *(structural, forced by 3b)* — every lever's `appliesTo` + `requirement` moved from `COCKPIT_CONTROLS` into `LEVER_SCHEDULE` and spread back. One predicate, two consumers (§16.6).
- **Tests**: `mpc-run-queue-levers.test.mjs` (MRQ-1…7).

**Phase 4 — Record → bag** — **BUILT 2026-09-20** (§16.7)
- [x] **4a** — `src/finance/mpc/run-record.js`. `decisionsFromRecords` routes the log the way `harvest.js:_epochsFor` does (`controlKeys` → `controlVars` → `controlParams`), so record and harvest are two views of one log rather than two parsers that can disagree; `scheduleKey` is where the index dies. `buildRunEntry` stamps `source` (levers, epochs, range, goal, solver, `baseScenarioId`, `derivedFrom`) and `describeRunSource` is §8's picker label, shared by the UI and the CLI. `saveRunToScenario` writes **one store** (`scenario.params`) through `upsertParam`, and selecting a run also sets `mpcRunEnabled: true` — selecting a run whose switch is off looks like a no-op and reads as a bug. **One addition to §4.4**: rows that merely *restate* the value already in force are dropped (`dedupeUnchanged`, default on). That is not D2's collapse — it keeps every CHANGE and discards only repetitions — and MRR-3 asserts both forms have identical decisions in force at every instant.
- [x] **4b** — D8, as `truncateActiveRunAt(params, asOf)` + `CockpitController._rolloutParams()`, applied at all three rollout seams (`_problem`, `apply`, `advance`). **Non-destructive**, which is the part that is easy to get wrong: "now" only moves forward, so truncating `this.committed` in place at epoch 1 deletes rows epoch 12 is entitled to see. A fresh run clears the *selection* rather than leaving an entry with no rows, because an empty `decisions` warns on every rollout.
- [x] **4c** — `scripts/scenario/save-run.mjs`, the headless twin of §8's button through the *same* three calls. Takes the two files `replay-vs-bake.mjs` takes (an exported `fin-sim-decisions` log + the scenario), and refuses to write an insolvent plan unless `--no-check`.
- [x] **4d** — both halves. The first landed in phase 3 (`assertRunIsPlayable`, throws at load). The second is `src/finance/mpc/run-axis-hygiene.js` — `runAxisProblems` reports, never repairs, in `poolAxisProblems`' shape and beside it in the grid-axis surface. `mpcActiveRun` as the axis itself is explicitly never flagged: that is §4.2, the entire justification for the indirection.
- **Tests**: `mpc-run-record.test.mjs` (MRR-1…8).

**Phase 5 — Picker and UI** — **BUILT 2026-09-20** (§16.8)
- [x] **5a** — `buildMpcRunSelect` on a new `MpcRunSelect` param type, not an `Enum`: the options come from a sibling **bag** and each is labelled from its `source` (`describeRunSource`, shared with the editor and `run:save`). A dangling selection renders as `(not found)` and says the base plan runs — §15's sharp edge, and the reason this could not be an `Enum`, which would silently re-point at the first run in the bag and re-save as that.
- [x] **5b** — `buildMpcRunsEditor` over `buildRowListEditor`: named blocks, provenance line, `derivedFrom` lineage, Delete, and the four-column decision table. Sorted by `(date, lever, key)` **on open**, not only after an edit — that is the comparator `resolveActiveMpcRun` applies on every load, so the sorted form is the canonical one and the file matches what plays.
- [x] **5c** — the cockpit's `Save run to plan…` beside `Copy to scenario…` (D10's two exits, through the same three calls as `save-run.mjs`), the mode indicator, and the journal marker. The marker needed no new surface: registering the design-81 paths in `StateSchemaRegistry` is what makes `mpcDecisionApplied.date` render as a date and a band amount as currency, in the journal diff and the state viewer both.
- [x] **5d** — help. The `recorded-mpc-runs` concept topic and the `mpc-cockpit` panel topic carry phases 2–5; no restamp was needed, because `panel:<id>` hashes title + category and neither moved.
- **Tests**: `tests/viz/mpc-run-editors.test.mjs`.

**Phase 6 — The lab** — **BUILT 2026-09-20** (§16.9)
- [x] **6a** — `scripts/lib/run-lab.mjs` (`pickRun` / `withActiveRun` / `withoutRun` / `inForceAt` / `branchAt` / `withoutLever` / `parseSet`), plus `run:inspect`, `run:replay`, `run:branch`. All seven commands are `npm run run:*` aliases, and every one is `withActiveRun` + `runCfg` — §9's payoff arriving as an absence of code.
- [x] **6b** — `run:sweep` over `grid.mjs`, `run:attribute`, `run:seeds`.
- **Tests**: `mpc-run-lab.test.mjs` (MRL6-1…6) over the shared half; the six tools are thin by construction.
- **Exercised end to end** on the real 44-epoch, nine-lever log design 80 investigated — which is where the two findings in §16.9 came from.

**Phase 7 — Consolidation** — **BUILT 2026-09-20** (§16.10)
- [x] **7a** — D7's last drift, which was **not** where the plan expected it (§16.10). `_seededSim` turns out not to be a third implementation at all: it FORWARDS what the compile produced across snapshot injection, which is already the one authority and is stronger than re-deriving — routing it through `drawdownPriorityPatch` would have replaced a capture of the truth with a second computation of it. What *was* duplicated is the owner-banding **table**: the cascade read it off the `accountPriority` node and the online/replay path re-derived it from hard-coded literals. Both now call `resolveOwnerBanding` over one `DRAWDOWN_OWNER_MODES`, and `_seededSim` shares the `WEIGHTED` sentinel. **MRL-9** compares the two PATHS on a real compile, for every mode in the table, and was mutation-tested to prove it is not vacuous.
- [x] **7b** — D10. The harvest is kept and demoted: `Save run to plan…` is the primary action, `Export as settings…` the secondary, and the review panel states in its own words that what it writes is a lossy summary and names the lossless exit. Nothing was deleted — "explain this run in settings someone can argue with" is a real question the lossless representation answers badly.

**Phase 8 — Lean into the decision graph** — **BUILT 2026-09-20** (§16.11). §4.2 said "mostly wiring"; it was.
- [x] **8a** — `mpcRunOptions(params)` is the one candidate-set builder (leaf, beside the resolver). The `DecisionPoint` param picker fills its options from the **base scenario's** bag when `MpcRunSelect` is chosen, read at pick time rather than captured; the optimizer gets an `ENUM` over the same set via `buildMpcRunOptConfigs`. The schema entry stays `opt: false` and that is the honest answer — see §16.11.
- [x] **8b** — `+ Compare recorded runs` on the decision-graph form: one click builds the whole decision point, every run plus the base plan as the control. It **appends**, so it composes — add it beside a retirement-age point and the graph is "each recorded plan × each retirement age", ranked, for free.
- **Tests**: `mpc-run-as-decision-point.test.mjs` (MDP-1…5) — **§13's gate**, and it passes: the leaves produce three different results, so the indirection's main justification is proven rather than asserted. `tests/viz/dg-mpc-runs.test.mjs` (DGR-1…4) covers the two affordances, mutation-checked.

---

## 15. Honest limits

- **A schedule is one path.** Playing a recorded run reproduces one deterministic trajectory. It says nothing about robustness until `run:seeds` or an MC promotion is run, and the UI must not let a one-path number read as a forecast.
- **A plan with no margin still has no margin.** This makes the *representation* lossless; it does not add the error budget design 80 §2.1 showed a die-with-zero objective spends by construction. What changes is that there is no longer a bake to blame, so the next investigation starts in the right place (Q6).
- **Editing a row is not re-planning.** A hand-edited schedule is a counterfactual under a fixed policy — legitimate, useful, and not a plan the controller endorses. The distinction the original §5 drew between *frozen policy* and *re-solve from here* survives this redesign intact, and the UI must keep drawing it.
- **The lag is real.** A decision takes effect at the next period advance (§5). On an annual cadence that is invisible; on a semi-annual one it is up to six months and it is not a bug.
- **The bag grows and nothing prunes it.** Ten runs is ~240 KB (§4.6) and fine; a hundred is not, and only Delete in the picker stands between them. A cap or an age-out may be wanted once this is used in anger.
- **A selection is a sharp edge.** `mpcActiveRun` pointing at a deleted or renamed entry must degrade to "no run", visibly — the `liquidityGraphSchedule` editor's *"not found"* row is the precedent for saying so rather than silently playing the base plan.

---

## 16. Notes from the build (§16.1–16.4 phase 1, 2026-09-19; §16.5–16.11 phases 2–8, 2026-09-20)

Measured while building phase 1, against the tree rather than against the 2026-07 draft's line
numbers. Each one changes what a later phase has to do, so it is here rather than in a commit
message.

### 16.1 `RebalanceToTargetReducer` has FIVE reads of `targetAllocation`, not two — and four of
them are one funnel

§6.2 names `rebalance-to-target-reducer.js:630, 657`. The live count is **630, 657, 666, 669,
671**, and 657 / 666 / 669 / 671 are all inside `_scheduledMix`. So phase 2b's accessor work is
smaller than five sites suggests — `_targetAllocationOf(state)` inside `_scheduledMix`, plus the
GOLD clamp at 630 — but the *semantics* at 666 and 669 need a decision the design has not taken:

```js
// _scheduledMix — under a glidepath, `this.targetAllocation` is the fallback ANCHOR
return interpolateGlidepath(this.glidepath, age, this.targetAllocation);
return resolveRegimeTarget(this.regimeTargets, state.activeRegimes, this.targetAllocation);
```

Under `GLIDEPATH` or `REGIME_CONDITIONED`, a committed mix does **not** become the target — it
becomes the value the schedule falls back to, and the schedule still governs. A controller that
commits 60/40 and gets a glidepath-interpolated 55/45 is precisely the fidelity gap this design
exists to close.

**But it is not a gap this design opens.** `ALLOCATION_MIX.actuate` already writes only
`targetAllocation` (`cockpit-controller.js:1011`), so the live cockpit has behaved this way all
along, and routing every read through the accessor **reproduces today's behaviour exactly**.
That is the right phase 2b default — inherit the ambiguity, do not create a second one — with
the question raised where it belongs, in design 39: *should `ALLOCATION_MIX` be gated on
`scheduleMode === NONE` the way `DRAWDOWN_WEIGHTS` is gated on `WEIGHTED`?* An ungated lever
whose value is silently re-interpolated is a lever the solver is searching through a filter it
does not know about.

`BondLadderReducer` is as advertised: one read, `bond-ladder-reducer.js:91`.

### 16.2 `DRAWDOWN_WEIGHTS` is not a "no refactor" lever, and it is where D7 should land first

§14 phase 2a says the four `DRAWDOWN_*` levers need "no reducer refactor — they already write
`FORWARD_DRAWDOWN_STATE_FIELDS` and per-account `drawdownPriority`". True for three of them:
`DRAWDOWN_XBORDER` and `DRAWDOWN_WITHINTIER` each stamp one top-level field, and
`DRAWDOWN_SLEEVE` writes state-resident config the disposal primitive re-reads every draw.

`DRAWDOWN_WEIGHTS` is different. Its `actuate` runs a whole cascade — `synthesizeWeightedPriorities`
over the present roles, then owner banding read from the `drawdownOwnerOrdering` **param**, then a
per-account re-stamp of `drawdownPriority`. That logic exists twice today (there, and in
`_seededSim`'s re-stamp block) and is exactly the drift **D7** exists to collapse. Writing a
third copy in `applyAt` and deleting it in phase 7a is the wrong order.

> **Revision to the plan: pull D7 forward for this one lever.** Build `DRAWDOWN_WEIGHTS.applyAt`
> as the authority in phase 2a and have `actuate` call it, rather than deferring the
> consolidation wholesale to 7a. The other levers can still consolidate late.

Two mechanical consequences: `_presentRolesFromState` (a private helper in
`cockpit-controller.js`) moves to `lever-schedule.js` beside the hook that needs it, and the
owner-banding read is a **third** vindication of `applyAt` taking `baseParams` — a reducer
cannot reach `drawdownOwnerOrdering` any other way.

### 16.3 Phase 3's fold point is concrete, and its real risk is a silent drop

Both schedules are read in the same place and the same way, inside each toolset's
`schedules(context)`:

```js
// us-roth-conversion-toolset.js:226
const schedule = Array.isArray(p.rothConversionSchedule) ? p.rothConversionSchedule : [];
// us-early-withdrawal-toolset.js:209
const schedule = Array.isArray(p.earlyWithdrawalSchedule) ? p.earlyWithdrawalSchedule : [];
```

So the fold has one clean seam: `context.parameters` must carry the folded schedule before
either `schedules()` runs. §6.3 already says this needs a test that names it rather than a
comment — agreed, and the test should assert the **order**, not just the outcome, because an
outcome test passes for a fold that happens to run first today.

The risk §6.3 does not mention is upstream of the fold. Both toolsets open with a gate:

```js
if (!p.rothConversionEnabled) return [];
if (!p.earlyWithdrawalEnabled) return [];
```

A run recorded with conversions on, selected against a base scenario where they have since been
switched off, drops **every** ROTH row on the floor and plays back as a different plan, silently.
The lever's `appliesTo` gate cannot catch it — that ran at record time. This is **Q5 (staleness)
made concrete**, and it is the case that decides Q5: a badge on the picker entry is not enough
when the failure mode is a plan quietly becoming a different plan. A recorded run whose levers
name a disabled mechanic should **refuse at load**, in D11's first half.

### 16.4 Three repo gates any later phase will hit

Phase 1 hit all three; naming them saves the next session the rediscovery.

| Gate | What trips it | Fix |
|---|---|---|
| `SWEEP-18` (`param-sweep-schema.test.mjs`) | `mc`/`opt: true` on a param type the engine cannot sweep and no curated row | flag it when the machinery lands, not before — this is why `mpcActiveRun` ships `opt: false` |
| `reducer-coverage-gate.test.mjs` | a new `src/` reducer absent from the manifest | `tests/helpers/reducer-coverage-manifest.js` **and** a row in design 37 §6 |
| `check-help.test.mjs` | **any** uncited param — the repo enforces `0 params uncited`, not a backlog | cite it in a `help/` topic and `npm run help:restamp`; concept topics are capped at **400 words** |

### 16.5 `lever-schedule.js` must import only LEAF modules — measured, not guessed

Phase 2's hooks need the design-58 role weights, the design-61 allocation classes and
`synthesizeWeightedPriorities`. All three lived in `intl-retirement-scenario.js` /
`scenario-loader.js`, and importing them from `lever-schedule.js` looked free.

It is not. `us-retirement-toolset.js` imports `MpcDecisionScheduleReducer`, which imports
`lever-schedule.js`; `intl-retirement-scenario.js` imports every toolset. The added import
closes that loop, and the loop does **not** degrade gracefully — four entry points that load
today each died at import:

```
us-retirement-toolset.js          Cannot access 'US_RETIREMENT' before initialization
intl-retirement-scenario.js       Cannot access 'IntlRetirementScenario' before initialization
mpc-decision-schedule-reducer.js  Cannot access 'MpcDecisionScheduleReducer' before initialization
cockpit-controller.js             Cannot access 'IntlRetirementScenario' before initialization
```

Worth knowing *why* it is easy to miss: `src/index.js` and `scenario-loader.js` still load
fine, because the entry point decides which module in the cycle is left half-initialized. A
smoke test that imports the package would have passed.

The fix is to move the constants **down**, never to inline a copy of them — a copy is the
drift D7 exists to collapse. `scenarios/params/lever-weights.js` is the new leaf (it imports
only `account-roles.js` and `allocation.js`), and both old homes re-export everything, so no
existing import site changed. The precedent was already in the tree: design 65's sleeve
weight-key helpers live in `holdings-selection.js` for exactly this reason.

**The rule, for every later phase**: every import in `lever-schedule.js` must be a leaf. If a
hook needs something that is not, move that thing. `MRL-8` imports all seven modules and is
what stops the loop coming back.

### 16.6 The gate is a lever fact, and the refusal is not ROTH-specific

Phase 3's refusal needs `appliesTo`. It lived on `COCKPIT_CONTROLS`, which the compiler cannot
import (§16.5), and the obvious move — re-declare the two `Enabled` checks in the loader — is
two copies of a predicate whose two answers must never diverge. So all nine gates moved into
`LEVER_SCHEDULE` beside `scheduleKey` / `applyAt`, and are spread back into `COCKPIT_CONTROLS`.

That is the right home on the merits, not just for the import graph. A gate answers one
question — *is this lever meaningful against this base?* — and two very different consumers ask
it: the cockpit, to decide whether a lever is worth **searching**; the loader, to decide whether
a recorded run can be **played at all**. `requirement` travels with it, because the sentence
that tells a user how to satisfy the gate is exactly the sentence the refusal must print.

Having them in one place made the generalization visible and cheap. §16.3 found the ROTH case,
but it is not special:

| lever | gate false ⇒ | the silent failure |
|---|---|---|
| `ROTH` / `EARLY_WITHDRAWAL` | toolset returns `[]` | every recorded row dropped, no events |
| `SPENDING` | no `ExplicitBandsSpendingReducer` | band table stamped, read by nobody |
| `ALLOCATION_MIX` | no `RebalanceToTargetReducer` | mix stamped, read by nobody |
| `BOND_LADDER` | no `BondLadderReducer` | rung count stamped, read by nobody |
| `DRAWDOWN_WEIGHTS` | strategy is not `WEIGHTED` | **worse** — the priorities bite anyway, so the run silently imposes a weighted order the base does not use |

`DRAWDOWN_XBORDER` and `DRAWDOWN_WITHINTIER` stay `appliesTo: () => true`: they are inert only
under a *data* condition (no cross-border draw, every tier a singleton), which no gate can see,
so they must never refuse.

One phase-2 decision is revised by this. `DRAWDOWN_SLEEVE.applyAt` stamps
`drawdownSleeveOrder: WEIGHTED` alongside the weights, and §14 phase 2a called that "a free
partial answer to §16.3" — making the run self-contained against a base switched to FIFO. With
3b in place that reading is wrong: letting the run quietly re-enable a mechanic the user turned
off is *reconciling* a contradiction, which is precisely what D11 refuses. The refusal now runs
first, so by the time `applyAt` fires the base **is** WEIGHTED and the stamp is an idempotent
restatement. It is kept only because the snapshot/rollout path may hand the reducer a state
that does not carry the field, and it is no longer load-bearing.

### 16.7 The F1 gate needed no new machinery, and the record/harvest split held

Two things worth recording from phase 4, both of them "the earlier design was right".

**The promotion gate.** `harvest-feasibility.js`'s header predicted this exact reuse — *"the
check takes a PLAN, and a plan with one entry is a valid input"* — and it is true with nothing
added: a bag entry folds as three plan entries (`mpcRuns`, `mpcActiveRun`, `mpcRunEnabled`) and
`checkHarvestFeasibility` runs the result from t₀. It is in fact a **stronger** gate here than
over a harvest. There, the check had to mirror `applyHarvestPlan` entry-for-entry and could
drift from it; here the thing checked *is* the thing saved, byte for byte, so there is nothing
to mirror.

**The log's shape.** `_epochsFor`'s three fields (`controlKeys` / `controlVars` /
`controlParams`) were added for the harvest's re-keying problem, and they turn out to be exactly
what a recorder needs — because the recorder's hard part is the same one: mapping an epoch's
`paramKey` back to the lever that owns it. Reading the log through the same rule is what keeps
"record" and "harvest" two views of one thing. The one deliberate difference is the tagging
fallback: both modules treat untagged `controlVars` as belonging to the single active lever, and
that rule is now written twice. It is three lines and it is load-bearing for old logs; a third
copy would be the moment to extract it.

**What phase 4 did NOT resolve.** The bag entry carries `source.baseScenarioId`, and nothing
reads it. That is Q5's residue, stated in §12 and still open: phase 3's gate catches a run whose
*mechanic* was disabled, which is the failure that was measured; a run whose base merely moved
is not yet known to be a problem worth refusing.

~~Phase 5's editors will also need `scenario-tab-view.js` to dispatch on the `MpcRuns` param
type~~ — **done in 5a/5b**, along with a second dispatch for `MpcRunSelect`.

### 16.8 The two editor params have to see each other, and the marker was already built

**The sibling problem.** `mpcRuns` and `mpcActiveRun` are separate params with separate
editors, and each invalidates the other: delete or rename a run and the select is either
offering something gone or *selecting* something gone. The dispatch wires it both ways — the
runs editor is handed a callback that refreshes the select, and the select reads the bag live
rather than capturing it. The precedent is `LiquidityGraphSchedule`, which reads its shape ids
live off `liquidityShapes` for exactly this reason.

It is also why `mpcActiveRun` is a new param type rather than an `Enum` with
`dynamicOptionsFrom`. That hook reads a sibling **list** and takes each entry's `name`; a run
bag is an object whose keys are the values and whose labels live inside each entry. Bending
`Enum` to that would make one mechanism mean two things — and the `Enum` path silently selects
the first option when the stored value has no match, which is precisely the failure §15 names.

**The journal marker cost one registration block.** §8 asks for a timeline / journal marker
from `state.mpcDecisionApplied`, and the instinct is to build one. There was nothing to build:
`diffStates` already emits the field, and `StateSchemaRegistry` already decides how a path
formats. Phase 1 simply never registered the design-81 paths, so the marker was rendering as a
raw ISO string and a bare number — present, and illegible. Eight registrations fixed it in both
surfaces at once.

**One budget note for the next topic.** `check-help` caps a concept topic at 400 words and a
panel topic at 250, and the count is tight enough that adding three paragraphs means cutting
three. That is the gate working: the cut fell on history the design doc already tells better.

### 16.9 Two things running the lab on a real log found

Both were found by *running* the tools rather than by testing them, which is the lesson this
repo has already recorded once (`equityShift` was dead for a month behind a passing suite).

**A refusal is not an unverifiability, and conflating them writes a broken plan.** Phase 4's
`checkRunFeasibility` calls `checkHarvestFeasibility`, whose try/catch turns *any* exception
into `feasible: null` — "could not verify". `assertRunIsPlayable` throws. So a run whose
mechanic the target scenario had switched off came back as `feasible: null`, and both callers
— `save-run.mjs` and the cockpit button — treat that as a soft warning and save anyway. It
printed **"created and selected"** for a run that cannot load at all.

The fix is a separate, prior verdict: `checkRunFeasibility` runs the playability assert first
and returns `playable: false` with the message, and the feasibility check never runs, because
there is nothing to check. Worth stating as a rule: *a try/catch that flattens every failure
into one verdict will eventually flatten a refusal into a warning.*

**A leave-one-out table must distinguish INERT from "worth nothing".** On the real log, five of
the nine levers changed the terminal by exactly zero — not approximately, identically, on every
metric the probe reports. That is not "this lever broke even": it is *nothing read the rows*.
In this plan the reasons are already known to the repo (a pool graph claims the classes an
allocation mix targets; a sleeve-narrowed claim leaves one class per draw), so it is a property
of the plan rather than a defect in phase 2 — but a table that prints `$0` invites exactly the
wrong conclusion, and this repo has twice shipped a lever that was dead behind a number that
looked fine. `run:attribute` now says INERT and names the gates to check.

Note what the probe is and is not: equal on four terminals is strong evidence, not byte
identity, so it says "check the gate", never "the lever is dead".

**A limitation to know.** `run:replay` warns when the scenario differs from `source.baseScenarioId`,
because A′ replays the log by INDEX and will address different rows of a different table. But
`save-run.mjs` stamps the scenario it saves *into*, not the one the log was *recorded against* —
so the warning catches a moved file, not a re-homed log. Closing that needs the recorder to
stamp at record time, which is a cockpit change, not a CLI one.

### 16.10 D7's last drift was the banding TABLE, not a third cascade

§14's 7a says to route `_seededSim`'s re-stamp through `drawdownPriorityPatch`, on the reading
that it is the last copy of the cascade. Reading it for phase 7 shows that premise is wrong, in
a way worth recording because the instinct is to "finish the job" and make it worse:

> `_seededSim` does not synthesize anything. It reads the priorities the COMPILE has already
> written into `sim.state` and carries them across snapshot injection. That is a capture of the
> one authority, it works for every strategy, and it knows nothing about weights or banding.
> Routing it through `drawdownPriorityPatch` would replace a capture of the truth with a second
> computation of it — a step backwards dressed as consolidation.

The drift was one level down, and it had survived every phase so far. The cascade resolved
owner banding from `node.ownerModes`, a table on the `accountPriority` node. `actuate` — and
therefore `drawdownPriorityPatch`, which inherited it verbatim in phase 2a — re-derived the
same thing from literals:

```js
const ownerOrder  = mode === 'SPOUSE_FIRST' ? ['spouse', 'primary'] : ['primary', 'spouse'];
const ownerStride = mode === 'POOLED' ? 0 : 100;
```

Two tables, agreeing because they happened to say the same thing, on a field nothing prints.
Add a fourth mode and the plan the controller commits stops matching the plan the compile
produces — silently, and only for households with a spouse. `DRAWDOWN_OWNER_MODES` +
`resolveOwnerBanding` in the leaf is now the one authority, and MRL-9 pins it.

**Two things about that test worth keeping.** It compares the two *paths* on a real compile,
not the two tables, so a new mode is covered without editing it. And it nearly shipped vacuous:
the first version passed `drawdownStrategy` through the harness's `params`, where
`buildDefaultConfig` consumes it to stamp per-account priorities directly and the cascade never
runs — the two-param-stores trap, which would have compared the DEFAULT order against itself.
It now goes through `cfg.parameters` and asserts the cascade ran before comparing anything.

### 16.11 §4.2 was right, and the one wrinkle is a flag that cannot be plan-independent

Phase 8 is the shortest in the design and the one that most needed to be true: the entire case
for a bag plus a scalar selector (§4.1), rather than one flat `mpcDecisionSchedule` array, was
that a scalar is something the rest of the app already treats as a choice. It held. The decision
graph needed **no changes at all** below the panel — `_expandLeaves` and `makeLeafEntry` already
do the right thing with a run id, because a run id is an ordinary param value. What phase 8 adds
is one option builder and two places to reach it.

`MDP-4` is the claim under test and is worth keeping as a gate: three leaves, three different
terminals. Without it the surface could "support" recorded runs while every arm ran the same
plan, which is the exact shape of a dead axis this repo has shipped twice.

**The wrinkle: `opt` cannot answer this param honestly.** `mpcActiveRun` is searchable on a plan
that carries recorded runs and on no other — its sweepability is a property of the SCENARIO. The
schema is plan-independent, so:

- `opt: true` fails `SWEEP-18` on a bag-less reference, and correctly: it would be "a promise no
  panel can keep".
- `opt: false` with a plain curated row would fail `SWEEP-10`'s converse rule on a plan that
  *does* carry runs.

The resolution is the `synthetic` escape hatch, used in the sense that gate actually means: the
row is **not derived from the schema entry**. Two different things share the key — a schema
entry describing a selector, and a contributor row whose candidate values come from the bag —
and the design-98 harvest cannot build the second from the first, because the values are
scenario data rather than schema. `MDP-5` pins both halves so the next reader does not "fix" the
flag.

Worth naming as a general shape rather than a one-off: **a param whose candidate set is scenario
data will always sit awkwardly in a plan-independent schema flag.** The pool axes already live
this way (they are curated rows over generated keys with no schema entry at all); this is the
first one where the key exists in the schema too.
