# 81 — The MPC run as a dated decision schedule the simulation plays

**Status**: Proposed (2026-07-26) · **Direction revised 2026-09-19** (§0 — the revision record)
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
| `ROTH` | `rothConversionSchedule[3].incomeTarget` | `roth@2039` | ✅ `_year` |
| `EARLY_WITHDRAWAL` | `earlyWithdrawalSchedule[3].taxDeferredAmount` | `earlyWithdrawal@2039.taxDeferredAmount` | ✅ `_year` |
| `DRAWDOWN_XBORDER` | `crossBorderDrawdown` | *(identity)* | — |
| `DRAWDOWN_WITHINTIER` | `withinTierDraw` | *(identity)* | — |
| `DRAWDOWN_WEIGHTS` | `drawdownWeight::<role>` | *(identity)* | — |
| `DRAWDOWN_SLEEVE` | `sleeveWeight::<class>` | *(identity)* | — |
| `ALLOCATION_MIX` | `allocWeight::<class>` | *(identity)* | — |
| `BOND_LADDER` | `bondLadderRungs` | *(identity)* | — |

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
- **Q5 — Staleness.** `source.baseScenarioId` lets us detect that the base moved under a recorded run. What should that *do* — warn, refuse to select, or nothing? A run that stores no param paths is far more robust to a base edit than the 2026-07-26 draft was, so this is probably a badge on the picker entry rather than a gate.
- **Q6 — Why does every epoch under-project its own outcome by ~6.5×?** On the real log the last epoch projected a \$16,249 terminal; the realized path delivered **\$106,476**. Every epoch's projection is the terminal of "hold this decision for the rest of life", but the realized path is the *sequence* of first segments, and they are not the same plan. The cockpit only ever displays the projection — so for a die-with-target goal the user is told they will land on target while the plan overshoots by 6.5×. **This design sharpens the question rather than answering it**: once `B ≡ A′` is a regression test, the A-vs-A′ gap is isolated as a pure controller-accuracy problem with the harvest permanently excluded as a suspect. A goal-seeking controller that systematically misses its goal by that margin is either mis-reporting or under-spending, and both matter. Own it in design 39.

---

## 13. Testing sketch

- `mpc-run-absent.test.mjs` — no active run (and, separately, **a bag with entries but `mpcActiveRun: null`**) ⇒ `MpcDecisionScheduleReducer` is not in the reducer list, and a golden fixture is byte-identical. **The gate for D4**, and the second case is the one that makes the bag safe to accumulate.
- `mpc-schedule-noop.test.mjs` — a period that changes nothing emits no patch and no journal diff.
- `mpc-schedule-boundary.test.mjs` — a row dated mid-period takes effect at the next advance, not at the instant; the lag is the stated one.
- `mpc-schedule-equals-replay.test.mjs` — **the headline.** A scenario carrying a run's schedule, run from t₀, reproduces `replayDecisions` on the same log. `B ≡ A′`, which is design 80's finding turned into a regression test.
- `mpc-schedule-state-reads.test.mjs` — for each of the three: the override wins where present, the instance field wins where absent, and **every** read site honours it.
- `mpc-schedule-rewind.test.mjs` — play to simEnd, rewind, replay: identical state. Fails today for SPENDING / ALLOCATION_MIX / BOND_LADDER (§0 bug 1).
- `mpc-schedule-roth-fold.test.mjs` — ROTH / EARLY_WITHDRAWAL rows reach the compiled event schedules, and the fold happens before the toolsets read them (§6.3).
- `mpc-schedule-truncation.test.mjs` — `CockpitController` at epoch k sees rows < k and no others (D8).
- `mpc-run-editor.test.mjs` — the row editor round-trips, sorts by date, and a blank row syncs to `null`; deleting the selected run clears `mpcActiveRun` rather than leaving it dangling.
- `mpc-run-as-decision-point.test.mjs` — **the §4.2 gate.** A `DecisionPoint` over `mpcActiveRun` with three options expands to three leaves, `makeLeafEntry` writes the selection into each, and the three leaves produce three different results. If this passes, the whole analysis surface reaches MPC runs with no further work; if it is missing, the indirection's main justification is unproven.
- `mpc-run-refuses-conflicting-axis.test.mjs` — an active run plus a study axis over a key it pins throws at load / reports at launch, per D11, and `mpcActiveRun` as the axis itself does neither.

---

## 14. Step-by-step plan

### Status legend
- [ ] not started · [x] done

**Phase 1 — The whole path, end to end, on one lever**
- [ ] **1a** — `mpcRuns` / `mpcActiveRun` / `mpcRunEnabled` param declarations; `resolveActiveMpcRun(params)` + an `activeDecisionsAt(run, asOfMs)` selector, exported and used by every consumer — the `activeGraphAt` discipline (design 109 §7: *"normalizing it three times with three slightly different option sets is how the same object comes to mean three things"*).
- [ ] **1b** — `scheduleKey(variable)` and `applyAt({ state, rows, asOfMs })` on the lever spec.
- [ ] **1c** — `MpcDecisionScheduleReducer`, registered only when a run is selected and enabled.
- [ ] **1d** — `SPENDING`: `scheduleKey` → `band@<startAge>`, `applyAt` → a full `state.mpcSpendingBands` table (D12), and `ExplicitBandsSpendingReducer._bandsOf(state)`.
- [ ] **1e** — the absent / no-op / boundary / equals-replay tests.
- **Milestone**: record a spending run, hand-write a bag entry, select it, press Play, and watch it reproduce the run.

**Phase 2 — The rest of the state-backed levers**
- [ ] **2a** — the four `DRAWDOWN_*` levers. No reducer refactor — they already write `FORWARD_DRAWDOWN_STATE_FIELDS` and per-account `drawdownPriority`.
- [ ] **2b** — `ALLOCATION_MIX` + `RebalanceToTargetReducer._targetAllocationOf`; `BOND_LADDER` + `BondLadderReducer._targetRungsOf`. Every read site.

**Phase 3 — The two queue levers**
- [ ] **3a** — `ROTH` / `EARLY_WITHDRAWAL` fold into `rothConversionSchedule` / `earlyWithdrawalSchedule` at compile, before the toolsets read them, with the load-order test.

**Phase 4 — Record → bag**
- [ ] **4a** — write a bag entry from the decision log and select it, F1-gated; `source` stamped, `derivedFrom` when re-solved from an existing run.
- [ ] **4b** — `CockpitController` truncation at "now" (D8).
- [ ] **4c** — `run:save` headless.
- [ ] **4d** — the D11 refusals, both halves.

**Phase 5 — Picker and UI**
- [ ] **5a** — `mpcActiveRun` select (labelled from `source`) + `mpcRunEnabled`.
- [ ] **5b** — `buildMpcRunsEditor` (named blocks + delete + the `derivedFrom` tree) over `buildRowListEditor`.
- [ ] **5c** — mode indicator; timeline / journal marker from `state.mpcDecisionApplied`.
- [ ] **5d** — help: param descriptions in the toolset, a `kind: concept` topic for recorded runs, and `npm run help:restamp -- mpc-cockpit` for the panel changes.

**Phase 6 — The lab**
- [ ] **6a** — `scripts/lib/run-lab.mjs`; `run:inspect` / `run:replay` / `run:branch`.
- [ ] **6b** — `run:sweep` over `grid.mjs`; `run:attribute`; `run:seeds`.

**Phase 7 — Consolidation**
- [ ] **7a** — route `actuate` and `_seededSim`'s re-stamp through `applyAt` (D7), deleting the drift.
- [ ] **7b** — demote the collapsing harvest to an explicit "export a legible plan" action (D10).

**Phase 8 — Lean into the decision graph** (§4.2 — mostly wiring, once Phase 1–5 land)
- [ ] **8a** — offer `mpcActiveRun` in the `DecisionPoint` param picker, with options auto-populated from the bag and labelled from `source`.
- [ ] **8b** — "compare these runs" straight from the picker: build the `DecisionGraph`, run it, show the ranked table.

---

## 15. Honest limits

- **A schedule is one path.** Playing a recorded run reproduces one deterministic trajectory. It says nothing about robustness until `run:seeds` or an MC promotion is run, and the UI must not let a one-path number read as a forecast.
- **A plan with no margin still has no margin.** This makes the *representation* lossless; it does not add the error budget design 80 §2.1 showed a die-with-zero objective spends by construction. What changes is that there is no longer a bake to blame, so the next investigation starts in the right place (Q6).
- **Editing a row is not re-planning.** A hand-edited schedule is a counterfactual under a fixed policy — legitimate, useful, and not a plan the controller endorses. The distinction the original §5 drew between *frozen policy* and *re-solve from here* survives this redesign intact, and the UI must keep drawing it.
- **The lag is real.** A decision takes effect at the next period advance (§5). On an annual cadence that is invisible; on a semi-annual one it is up to six months and it is not a bug.
- **The bag grows and nothing prunes it.** Ten runs is ~240 KB (§4.6) and fine; a hundred is not, and only Delete in the picker stands between them. A cap or an age-out may be wanted once this is used in anger.
- **A selection is a sharp edge.** `mpcActiveRun` pointing at a deleted or renamed entry must degrade to "no run", visibly — the `liquidityGraphSchedule` editor's *"not found"* row is the precedent for saying so rather than silently playing the base plan.
