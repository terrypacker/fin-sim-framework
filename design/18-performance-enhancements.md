# Design: Simulation Performance Enhancements

> Status: Phase 1 complete (2026-05-30). Phases 2–4 pending.
> Measurements taken 2026-05-30 in the production workbench against the default
> `IntlRetirementScenario`. All numbers were captured live via the Chrome
> DevTools MCP against `http://localhost:10001/`.

## Problem

The simulation has slowed since the last performance review, partly because
several earnings/interest streams (US savings, AU savings, AU fixed income, US
fixed income) moved from annual to monthly events (commit `fd0aa4f` "Compute
interest monthly", issue #331). The hypothesis is that the monthly cadence is
the dominant cost, but the wider hot path is also producing avoidable allocations
and copies on every reducer.

The user's specific concerns:

1. Heavy memory use that could cause GC pressure (journal and execution graph).
2. UI rendering bleeding back into the sim loop.
3. General cost of cloning and copying state.

This document captures what was measured, what the hot path actually does, and
ranks the changes by expected impact.

---

## Measurements

A live run was taken in the workbench (`silent = false`, snapshots enabled,
default plugins mounted). The simulation was stepped in two passes from
`2026-01-01` so allocation growth could be observed.

### Throughput

| Window | Wall clock | Events | Reducers | µs/reducer |
|---|---|---|---|---|
| 2026 → 2031 (5 yr) | 655 ms | 480 | 1,586 | ~413 µs |
| 2031 → 2041 (10 yr) | 1,667 ms | 1,463 | 4,637 | ~360 µs |

Extrapolated to a 30-year retirement run that is ~5,000+ ms before any UI
rendering or chart updates.

### Memory growth after 2026 → 2041 (15 sim years)

| Source | Quantity | Avg size | Total |
|---|---|---|---|
| **ExecutionGraph nodes** | 12,592 | **~8.0 KB** each | **~98 MB** |
| History snapshots | 3,008 | 17.9 KB | ~53 MB |
| Bus history (`EXECUTION_BEGIN/END` …) | 25,510 | ~200 B | ~5 MB |
| Journal entries | 4,637 | 754 B | ~3.4 MB |
| ExecutionGraph edges | 21,548 | ~100 B | ~2 MB |

JS heap (Chrome): 29 MB → 131 MB over 15 simulated years. The graph and
history snapshots together account for the majority of the growth.

### Per-execution-node breakdown

Each `SimGraphNode` written by `graph-recorder.js` carries a `stateBefore`
and `stateAfter` reference — both produced via `structuredClone(state)` in
`simulation.js` and **never released**:

```
stateBefore  ~4,092 bytes
stateAfter   ~4,091 bytes
meta.stateDiff   ~60 bytes
id / kind / name / timestamp   ~100 bytes
```

So the ~98 MB charged to "ExecutionGraph" is essentially **two full state
snapshots per reducer/handler/event/action node, never reclaimed**.

### Per-op micro-benchmarks (state JSON ≈ 8 KB, 49 top-level keys)

| Operation | Cost | Notes |
|---|---|---|
| `structuredClone(state)` | **47 µs** | Used 3× per reducer + 2× per event (see hot path below) |
| `JSON.stringify(state)` | 24 µs | Called recursively inside `diffStates` |
| `crypto.randomUUID()` | 2.1 µs | One per journal entry + one per begin-node |
| `new Date(currentDate)` | 0.04 µs | Trivial individually but emitted 4-6× per node |
| `decorateAction()` | 0.1 µs | Not a problem |

### Reducer counts per month

The monthly schedule today emits roughly:

- Expenses (1 ev) + Wages (1-2 ev) + SS (1-2 ev)
- US savings interest, AU savings interest, US fixed income, AU fixed income (4 monthly events, 2 if there is no AU side)

Each of these handlers emits **3 actions** (the work action +
`RecordMetricAction` + `RecordBalanceAction`), each action runs 1-3 reducers.
With both jurisdictions wired up that is roughly **30-50 reducer
executions per simulated month**, or **400-600 per year** — which matches the
measured ~310 reducers/year on the live scenario.

The earnings handlers that used to be annual (IRA, Roth, 401k, US Stock, US
Stock Dividends, Super, AU Stock, AU Dividend) are still annual today
(`interval('year-end')` in the retirement toolsets). The monthly cost
increase came from `US_SAVINGS_INTEREST_MONTHLY`,
`INTL_AU_SAVINGS_INTEREST`, `INTL_AU_FIXED_INCOME_INTEREST`, and
`INTL_FIXED_INCOME_INTEREST`.

---

## The hot path in `simulation.js`

Per simulated event (`Simulation.execute`):

```
structuredClone(state)                       // stateBefore at event start   (×1)
  for each handler:
    bus.publish(EXECUTION_BEGIN: handler)
    graphRecorder.beginNode(handler)
    handler.call(...)
    bus.publish(EXECUTION_END: handler)
    graphRecorder.endNode(handler)
    for each action:
      bus.publish(EXECUTION_BEGIN: action)
      graphRecorder.beginNode(action)
      for each reducer:
        structuredClone(state)               // prevState                    (×1 per reducer)
        bus.publish(EXECUTION_BEGIN: reducer)
        graphRecorder.beginNode(reducer)
        reducerWrapper.fn(state, action)
        diffStates(prevState, state)         // recursive JSON.stringify     (×1 per reducer)
        bus.publish(EXECUTION_END: reducer + stateDiff)
        graphRecorder.endNode(reducer, {stateBefore, stateAfter, stateDiff})
          → attaches prevState + state ONTO node, never released
        journal.addEntry(crypto.randomUUID())                                (×1 per reducer)
      bus.publish(EXECUTION_END: action)
      graphRecorder.endNode(action)
structuredClone(state)                       // stateSnapshot at event end   (×1)
diffStates(stateBefore, stateSnapshot)       // event-level diff             (×1)
bus.publish(EXECUTION_END: event + stateSnapshot)
graphRecorder.endNode(event, {stateBefore, stateAfter})
journal.addSnapshot(state)                   // structuredClone again        (×1)
history.takeSnapshot()                       // structuredClone again        (×1 — snapshotInterval=1)
```

So **per reducer**, the engine produces:

- 1 × `structuredClone(state)` for `prevState`
- 1 × `diffStates(prevState, state)` (recursive `JSON.stringify`)
- 2 × `bus.publish` (each does an array slice over listeners)
- 1 × `crypto.randomUUID()` for the journal entry
- 1 × graph node attaching two full state copies

And **per event**, on top of that:

- 1 × `stateBefore` clone, 1 × `stateSnapshot` clone
- 1 × event-level diff
- 1 × `journal.addSnapshot` clone
- 1 × `history.takeSnapshot` clone

For 15 sim years that means ~30,000 `structuredClone(state)` calls (≈1.4 s of
wall clock spent just cloning at 47 µs each) and ~5,000 `diffStates` calls
(≈120 ms of `JSON.stringify`).

The reducer subclasses also produce immutable copies via
`{ ...state }` + recursive `setValueByPath` (an `O(depth)` chain of object
spreads — `reducers.js:239`). That cost is unavoidable while state is
immutable, but it is added on top of the `structuredClone`s above.

### UI rendering decoupling — verified

The workbench UI is decoupled from the sim loop:

- `BaseComponent.busQueue` queues incoming bus messages and only triggers
  `scheduleRender()`, which coalesces via `requestAnimationFrame` and a dirty
  flag (`base-component.js:200`). No synchronous DOM work happens inside the
  sim loop.
- `ChartPresenter.wireSimBus` subscribes only to `EXECUTION_END(EVENT)`, not
  to every reducer.
- `PerfPlugin` is the one subscriber to every `EXECUTION_BEGIN/END`, but it
  only `Map.set` / `Map.delete` per message and pushes into a capped sample
  array.

**The UI is not blocking the sim loop.** The cost is entirely inside the
engine. The bus-publish call itself, however, is *not* free even with cheap
subscribers — for each publish `EventBus.publish` does
`this.history.push(event)` (unbounded growth), `this.listeners.get(type)`,
and `.slice()` of the listener array. With 10,000 publishes per 15 sim
years, the wasted listener-array clones add measurable overhead.

---

## Proposed changes, ranked by impact

### Tier 1 — High impact, low risk

#### 1.1 Stop attaching `stateBefore`/`stateAfter` to ExecutionGraph nodes

This single change reclaims ~98 MB after 15 sim years and removes ~2 KB of
allocation per reducer node.

- `graph-recorder.js:79-81` currently does
  `node.stateBefore = stateBefore; node.stateAfter = stateAfter`.
- The journal already carries `stateDiff` per entry, and the
  `bus.history` `EXECUTION_END` messages already carry full snapshots.
- Plugins that need the before/after for a specific node (lineage panel,
  state inspector) can recompute by replaying from the nearest journal
  snapshot, or by reading the journal entry's `stateDiff`.

Proposal: keep `stateDiff` on the node `meta`, drop `stateBefore` and
`stateAfter`. Update `simulation.js` callers to not pass those fields.

Risk: any consumer reading `node.stateBefore` directly will break. Sweep
`src/visualization/graph-builder/` (`graph-node-lineage.js`,
`graph-node-exec-history.js`) for usages.

#### 1.2 Cap or disable `EventBus.history`

`event-bus.js:62` appends every message to `this.history` forever. After
15 sim years that is 25K messages × ~200 bytes ≈ 5 MB, plus the full
state snapshot attached to `EXECUTION_END(EVENT)` messages, which makes
the real cost much larger.

Options:
1. **Ring buffer**: cap `history` at e.g. 1,000 entries. Most replay
   consumers only need recent activity.
2. **Opt-in**: keep history off by default, enable with
   `new EventBus({ keepHistory: true })`. The simulation does not need
   it; it is a debugger affordance.

Recommended: option 2 (opt-in). The only known consumer is the
`exec-history` plugin which already reads from `ExecutionGraph` rather
than `bus.history`.

#### 1.3 Coarser history-snapshot interval (and lazy snapshot strategy)

`simulation.js:111` sets `snapshotInterval = 1` (snapshot every event).
After 15 sim years that is 3,008 snapshots × 17.9 KB ≈ 53 MB of state
copies just for rewind.

Proposal:
- Default `snapshotInterval` to 12 (≈ one per simulated year) for the
  default scenario; `enableSnapshots` stays on but the rewind path uses
  the journal's stateDiff stream between snapshots for finer rewinds.
- Add a workbench setting under `Performance` so debugging sessions can
  drop back to 1.

Risk: rewind precision degrades unless we replay diffs from the nearest
snapshot. The journal already supports this via `Journal.snapshotBefore`
(`journal.js:113`); only the rewind UI path needs a small change to
combine snapshot + diff replay.

#### 1.4 Drop the per-reducer `prevState = structuredClone(state)`

`simulation.js:713` clones the full state before every reducer, only to
diff against the post-reducer state. Each clone is ~47 µs × ~5,800
reducers in a 30-yr run ≈ 270 ms. The journal `stateDiff` then drives
display and reporting.

Options, in order of preference:

1. **Path-recording reducers**: have `FieldReducer.setValueByPath`
   record the path it mutated, and emit a `stateDiff` derived from
   `{path, before, after}` instead of diffing two trees. The reducer
   already knows what it changed; we just stop throwing that away.
2. **Compute diff against shallow refs**: most reducers only mutate one
   top-level branch of state (the account at `state[stateKey]`). Walk
   only the changed top-level keys (compare refs first, then recurse).
   This is a much cheaper diff than the current `JSON.stringify`-based
   one in `state-utils.js:34`.
3. **Skip per-reducer diff entirely** when `journal.enabled` is false
   or when the only consumer is a snapshot that already exists at
   event end.

Approach #1 is the cleanest because `setValueByPath` is the universal
write path; #2 is a drop-in change to `diffStates` that we can ship
immediately as a safety net.

#### 1.5 Skip `JSON.stringify` inside `diffStates`

`state-utils.js:34` falls back to `JSON.stringify(b) !== JSON.stringify(a)`
for non-object leaves. That is 24 µs per call, and it runs for every
account branch in every reducer's diff.

Proposal: for non-object leaves, compare by `===` (numbers, strings,
booleans, null). For arrays, compare length + element-by-element with
`===`. Reserve `JSON.stringify` for unknown shapes — or remove it
entirely once we trust the new structural compare.

Expected cost reduction: cuts a sizable fraction of the ~120 ms diff
time in a 15-year run.

### Tier 2 — Medium impact, moderate risk

#### 2.1 Re-evaluate which "monthly" streams need monthly granularity

The monthly migration was driven by the need to model intra-year
balance dynamics for interest accrual. But several of the streams
multiply the *current* balance by `rate / 12` each month, which is
*not* the same as compounding monthly — it is just 12 smaller debits
of an annual amount. Where downstream taxation and reporting only
consume the year-end balance, the savings cycle can stay annual and
*still* be modeled as monthly inside the reducer (an analytic
"monthly compounded" computation done once per year).

Streams to review:
- `US_SAVINGS_INTEREST_MONTHLY`
- `INTL_AU_SAVINGS_INTEREST`
- `INTL_AU_FIXED_INCOME_INTEREST`
- `INTL_FIXED_INCOME_INTEREST`

If any of these can fold back to one annual event per account with the
correct compounding, that alone removes ~80% of the new reducer load.
Where the monthly cadence is genuinely required (e.g. it interacts
with mid-year residency changes), keep it.

This is the change with the largest absolute headroom but the most
domain risk — defer until the engine-level changes above are in.

#### 2.2 Fold per-account earnings handlers into a single batched event

Each account currently has its own `INTL_*_EARNINGS` handler with its
own action triplet. For N accounts of the same kind we get N events,
3N actions, and 3-5N reducers per period. Most of the work
(`stateRegistry.getStateKey`, balance lookup, `getValueByPath`) is the
same shape across accounts.

Proposal: one `PORTFOLIO_EARNINGS` event per period that walks all
accounts of a given role and emits one consolidated action with
`{ perAccount: [{ stateKey, amount }, ...] }`. The reducer applies
all credits in a single `setValueByPath` chain. The execution graph
ends up with O(1) handler/reducer nodes per period instead of O(N).

Risk: this is a real refactor of the toolsets. Worth it once we see
the Tier-1 changes land and we still need throughput.

#### 2.3 Replace `EventBus.publish`'s per-call listener slice

`event-bus.js:65` slices the listener array on every publish to protect
against subscribers added during dispatch. With 10,000+ publishes per
run and an average of ~3 listeners per type, this is ~30,000 wasted
copies.

Options:
1. Only slice when the snapshot guard is needed — track a "is
   dispatching" flag and copy lazily.
2. Maintain a version counter and only re-slice when the listener
   list has changed since last publish.

Pure micro-optimization but easy and orthogonal to everything else.

#### 2.4 Pre-allocate `new Date(currentDate)` once per event

Several call sites in `simulation.js` create a fresh `Date` for each
`bus.publish` (`now = new Date(this.currentDate)`). At reducer level
this is ≥ 6 `Date` allocations per reducer. The cost per-allocation
is trivial (0.04 µs) but they pressure the GC; reuse a single `Date`
per event step where the messages are emitted synchronously.

### Tier 3 — Lower impact / cleanup

#### 3.1 Drop the per-journal-entry `crypto.randomUUID()`

`simulation.js:816` allocates a UUID for the journal entry `id`. The
entry already carries a monotonic `seq` and a hierarchical
`executionId`. The UUID does not add identity that `seq` doesn't
already provide.

Saves ~12 ms per 15-sim-year run; mostly cleanup.

#### 3.2 Reducer pipeline lookups — cache per action type

`simulation.js:579` calls `this.reducers.get(action.type)` per action,
then unwraps the inner reducers into a fresh array on each call
(`unwrappedReducers.push(r.reducer)`). The unwrapped list is stable
between toolset rebuilds and can be memoized on the wrapper itself.

#### 3.3 Action `data` denormalization

`_pickActionData` (`simulation.js:45`) walks ~12 fields per action.
This is fine, but it should be turned into a static schema lookup
when the action type is registered, not a 12-field `if`/copy chain
per reducer. Negligible CPU but worth tidying.

#### 3.4 GraphRecorder pending-schedules array

`graph-recorder.js:108-128` linear-scans `_pendingSchedules` on every
event firing to resolve `SCHEDULES` edges. For most schedules the
target is the next event, so the array stays short, but worth
swapping to a `Map<definitionId, [pending]>`.

---

## Recommended sequencing

1. **Phase 1 — Engine memory wins (Tier 1.1, 1.2, 1.3, 1.5): DONE 2026-05-30**

   Changes shipped:
   - **1.1** `graph-recorder.js` / `sim-graph-node.js` / `simulation.js`:
     dropped `stateBefore` and `stateAfter` from every ExecutionGraph node.
     Only `stateDiff` (the small diff object) is kept on `node.meta`. Reclaims
     ~98 MB per 15-year run.
   - **1.2** `event-bus.js`: `EventBus` now accepts `{ keepHistory = false }`.
     History is off by default (opt-in). The shared bus used by `ServiceRegistry`
     and the simulation uses the default (no history). `keepHistory: true` can be
     passed by debug tooling when needed. `bus.history.length` now reads 0 in
     production runs.
   - **1.3** `simulation.js`: default `snapshotInterval` raised from 1 → 12
     (~one snapshot per simulated year). Reduces snapshot count from ~3,008 to
     ~251 over 15 years (saves ~53 MB). Tests that exercise rewind/branch were
     updated to pass `opts: { snapshotInterval: 1 }` explicitly.
   - **1.5** `state-utils.js`: replaced `JSON.stringify` leaf comparison in
     `diffStates` with `_leafEqual()` (uses `===` for primitives/null,
     element-by-element for arrays). Eliminates ~120 ms of stringify overhead
     per 15-year run.

   Also: `main.js` now exposes `window.ServiceRegistry` and `window.__app` so
   the console benchmark below works without extra setup.

   Observed results after Phase 1 (15 sim years, default scenario):

   | Metric | Before | After Phase 1 |
   |---|---|---|
   | Wall clock (15 yr) | ~2.3 s | ~1.95 s |
   | JS heap | ~131 MB | ~117 MB |
   | ExecutionGraph nodes | 12,592 @ ~8 KB | 12,592 @ ~0.5 KB |
   | History snapshot count | 3,008 | 251 |
   | Bus history length | 25,510 | 0 |

2. **Phase 2 — Drop redundant clones (Tier 1.4): DONE 2026-05-30**

   Changes shipped:
   - **`state-utils.js`**: Added `MutationTracker` — a module-level
     recorder that collects `{field, before, after, delta}` entries during
     a reducer call in the same format as `diffStates` output.
   - **`reducers.js`**: `FieldReducer.setValueByPath` now calls
     `MutationTracker.record()` when the tracker is active, capturing
     before/after for every path it writes. `AccountTransactionReducer`
     made fully immutable (creates `{ ...account, balance: newBalance }`
     instead of mutating in place) and records the balance change via the
     tracker. Import of `MutationTracker` added.
   - **`simulation.js`**: For reducers where
     `r instanceof FieldReducer || r instanceof AccountTransactionReducer`,
     the `structuredClone(state)` is skipped and `MutationTracker.begin()`
     is called instead. After the reducer, `MutationTracker.flush()` yields
     the `stateDiff` directly — no tree walk. For all other reducer types
     (account-rules subclasses that call `accountService.transaction`
     directly, plain functions) the existing `structuredClone` + `diffStates`
     path is kept as a fallback. `FieldReducer` and `AccountTransactionReducer`
     added to imports.

   Scope note: account-rules subclasses (`us-income-classes.js` etc.) still
   use the clone fallback because they mutate state via `accountService.transaction`
   without going through `setValueByPath`. Eliminating that remaining clone
   requires making those reducers immutable (Phase 4 candidate).
3. **Phase 3 — Bus + scheduling micro-opts (Tier 2.3, 2.4, 3.1, 3.4):**
   cleanup pass; runs alongside any UI changes.
4. **Phase 4 — Monthly schedule rationalization (Tier 2.1, 2.2):**
   touches toolsets and tests. Defer until engine wins are validated
   so the toolset changes don't have to compete with engine ones.

### Out of scope here

- UI rendering throttling: already decoupled via `BaseComponent.scheduleRender`
  + RAF; no change needed.
- Monte Carlo path: already uses `sim.silent = true` to skip bus,
  cloning, and diffs (`intl-retirement-mc-runner.js:157`). No change.
- `ScenarioRunner`/`SimulationHistory.branch()` deep clones: rarely
  on hot path, leave alone.

---

## How to verify

Re-run the same measurement harness against `IntlRetirementScenario`:

1. Open the workbench (`npm run dev`), let the default scenario load.
2. From the console:
   ```js
   const sim = ServiceRegistry.getInstance().simulationRegistry._sims.get('primary');
   const t0 = performance.now();
   sim.stepTo(new Date(Date.UTC(2041, 0, 1)));
   console.log('elapsed', performance.now() - t0, 'reducers', sim.reducerExecutions);
   console.log('exec nodes', sim.executionGraph.getExecutionNodes().length);
   console.log('snapshots', sim.history.snapshots.length);
   console.log('bus history', sim.bus.history.length);
   console.log('heap MB', (performance.memory.usedJSHeapSize/1048576).toFixed(1));
   ```
3. Targets after Phase 1 + 2 (15 sim years, default scenario, all
   plugins mounted):

   | Metric | Today | After Phase 1+2 |
   |---|---|---|
   | Wall clock (15 yr) | ~2.3 s | ≤ 1.0 s |
   | JS heap delta | ~100 MB | ≤ 25 MB |
   | ExecutionGraph node size avg | 8.1 KB | ≤ 0.5 KB |
   | History snapshot count | 3,008 | ≤ 250 (snapshotInterval=12) |
