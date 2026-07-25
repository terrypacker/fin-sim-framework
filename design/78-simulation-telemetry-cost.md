# 78 — Simulation performance: telemetry cost and history-proportional work

**Status: Phases 0–3 COMPLETE (implemented + green, 4,030 unit / 925 viz, on
`wip/sim-performance`). §8 lists measured candidates for phases 4+, none started.**

| Phase | | Result |
|---|---|---|
| 0 | engine hot paths | step loop 9,540ms → 3,759ms (**2.5×**) |
| 1 | telemetry contract | `npm run scenario --fast` 3.90s → 0.46s (**8.5×** wall); MC 14.4s → 11.6s |
| 2 | cheaper diff snapshot | `full` run 4,497ms → 2,899ms (**1.55×**); journal bit-identical |
| 3 | UI playback | playback ~20.3s → ~4.5s (**4.5×**); timeline 70% of wall → ~1% |
| 4+ | §8 — proposed | event-diff composition (~658ms), bus granularity, graph bounding |

Cumulative: batch tooling **10.9s → 0.46s (~24×)**; headless `full` **9.5s → 2.8s**;
UI playback **~20.3s → ~4.5s**.

The simulation got slower as toolsets, events, handlers and reducers were added. The natural
reading is "more work per period, so it costs more". Profiling says otherwise. **The
financial math is ~285ms of a 9.5s run.** Everything else is *observation* — journal clones,
state diffs, execution-graph nodes, bus telemetry — and a large part of it was not merely
expensive but **quadratic in run length**.

This document names one recurring defect shape, shows where it occurs, and phases the fixes.

**Relates to:**
- **`design/16` (journal reporting plugin)** — owns `Journal.journal` and the `stateDelta`
  contract that the tax drill reports read. Phase 2 changes how those deltas are *produced*,
  so §5.4 is the compatibility argument that keeps `npm run crossfoot` footing.
- **`design/74` (stochastic return paths)** — owns the MC runner and its per-iteration seed.
  Phase 1 §4.5 changes where MC's yearly `timeSeries` comes from; design 74's path-shape
  diagnostics consume that series.
- **`design/3` (branching event streams)** / **`design/2` (unified event schema)** — own
  `SimulationHistory` snapshots and deterministic replay. Phase 1 must not weaken either.
- **`inconsistencies.md #1.5`** — already flags `getAll()` aliasing on `Graph`. Phase 0 §3.1
  resolves the performance half of that note.

---

## 1. The one-line summary

The engine repeatedly does work proportional to **everything that has already happened**,
once per **thing that happens next**. That is O(n²) in run length, and it is why the slowdown
tracked feature growth: more reducers means more history accumulated per period, which
inflates the cost of every subsequent period.

Three independent instances of the same shape, all measured:

| Instance | Per-step work | Grows with | Status |
|---|---|---|---|
| `BaseService.getAll()` scans the whole `Graph` | O(all nodes) | execution-graph nodes | **fixed** (Phase 0) |
| Untracked reducers deep-clone + diff whole state | O(state) × 12,976 | reducer count | **fixed** (Phase 2) |
| `TimelinePresenter` re-renders the whole journal per playback frame | O(journal) × 100 | journal entries | **fixed** (Phase 3) |

## 2. Evidence

Measured on `scenarios/fin-sim-scenarios.json` (44 years, 2026–2070, all toolsets),
6,363 events / 28,464 reducer executions, via `node --cpu-prof` on the headless runner.

**Baseline profile, before any change (9.5s in `stepTo`):**

| Cost centre | Self time | Share |
|---|---|---|
| `structuredClone` | 4,502ms | 44.7% |
| `diffStates` / `walk` | 1,588ms | 15.8% |
| `getAll` + its filter predicate | 1,530ms | 15.2% |
| everything else (incl. all financial math) | ~1,900ms | 19% |

**The quadratic, isolated.** `Graph` holds two layers in one node map: `config` (~570
definition nodes, effectively fixed) and `execution` (one node per event/handler/action/
reducer *execution*). Cost of a single `accountService.getAll()` call, sampled during a run:

| Year | Graph nodes | `getAll()` |
|---|---|---|
| 2027 | 2,692 | 45µs |
| 2047 | 38,239 | 562µs |
| 2067 | 71,450 | **1,089µs** |

The account count never changes — there are 18 accounts throughout. The 24× degradation is
entirely execution-trace nodes being re-scanned by a per-period lookup
(`StateRegistry.resolveTransactionAccountKey` → `resolveCashKey`).

**Telemetry vs. math.** The same scenario under each configuration that exists in the code
today:

| Configuration | Set by | Time | Notes |
|---|---|---|---|
| everything on | `scripts/lib/run.mjs` | 3,779ms | nothing disabled — the unclaimed win |
| `silent` + journal off | `optimization-problem.js:403-404`, `intl-retirement-mc-runner.js:267-268` | ~530ms | still takes 1,803 full-state clones for history |
| + snapshots off | — | **~370ms** | the floor: this is the actual financial math |

Both batch callers already suppress the bus and the journal. Neither can suppress
history snapshots, because both read them — MC for its yearly series (§4.5), the
optimizer for the MPC snapshot seam (`rollToSnapshot`). So the 1,803 full-state
clones are the entire remaining batch overhead.

## 3. Phase 0 — landed

Commit `91ca969`. Net worth is bit-identical before and after (4,810,931), which is the
invariant every phase of this document is held to.

### 3.1 `getAll()` reads the maintained kind index

`GraphQueryApi` already maintained an incremental `_kindIndex` (kind → Set<node>), kept fresh
by the `Graph` index-observer hooks. `BaseService.getAll()` simply wasn't using it — it did
`[...this._graph.getNodes().filter(...)]`, materialising and scanning every node in both
layers. Now:

```js
getAll() {
  return this._query.getByKind(this._kind).filter((n) => n.layer === this._layer);
}
```

O(76k) → O(18). **−2.3s.**

### 3.2 `structuredClone` → `deepClone`

The structured-clone algorithm pays for cycle detection, transferables and every exotic
built-in. Sim state is plain objects, arrays and `Date`s. A hand-rolled recursive walk
(`state-utils.js`, exported as `deepClone`) is **3.3× faster** on real state — 199µs → 61µs
per clone. **−3.1s.**

Equivalence is exact for this state shape. In particular `structuredClone` *also* returns
plain objects for class instances, so dropping prototypes is not a behaviour change (verified
directly). Two deliberate differences are documented at the function: cycles recurse until
the stack blows rather than being preserved, and functions are copied by reference rather
than throwing. Both are impossible-by-construction in state that is journalled and persisted.

### 3.3 Event-boundary clone reuse

`execute()` cloned state at event start (`stateBefore`) and again at event end
(`stateSnapshot`). Nothing mutates state between two events in a `stepTo` loop, so the second
clone of each pair was producing a byte-identical copy — **1 in 4 of all clones**. The
end-of-event clone is now carried forward as the next event's `stateBefore`, guarded on
reference identity (`carry.from === this.state`) so that rewind, `restoreSnapshot`, or any
external state swap falls back to a fresh clone. **−0.3s.**

### 3.4 Latent bug found: stale index entries

Phase 0 §3.1 immediately broke `scenario-serializer.test.mjs` — correctly. `QueryApi._updateIndexes`
only re-pointed an index when the *indexed field itself* changed:

```js
if (prev.id !== item.id) { /* ...only then update _idIndex... */ }
```

But `Graph.updateNode` routinely replaces a node with a **different object carrying the same
id** — that is exactly what a workbench reducer-type edit does. The index kept the stale
object while the `Graph` held the new one, so `getById`/`getByKind` returned pre-edit nodes.
This was live before Phase 0; it was invisible only because `getAll()` bypassed the index.
Now the base evicts `prev` and inserts `item` unconditionally, which also lets `GraphQueryApi`
delete its override entirely.

**Result: 9,540ms → 3,759ms in the step loop; 10.9s → 3.9s wall on the headless runner.**

`BaseService._serviceFilter` is now unreferenced. Left in place deliberately pending a
decision, not removed.

---

## 4. Phase 1 — a telemetry contract

### 4.1 The problem is that "silent" has no stated meaning

`silent` exists and is used — `intl-retirement-mc-runner.js` and `optimization-problem.js`
both set it. But it was never given a contract, so three things went wrong independently:

1. **It suppresses computation, not just observation.** `_derivedMetrics` runs *inside*
   `if (!this.silent)` in `execute()`. Under silent, `state.metrics.netWorth` is not absent —
   it is **`0`**. MC and Opt accidentally dodge this by calling the standalone
   `computeNetWorthUsd(sim.state)` instead of reading the field.
2. **Callers poke the flag after construction.** Every call site does
   `sim.silent = true` *after* `buildSim()`, which works only because nothing runs in
   between, and means `BaseScenario.buildSim()` cannot forward it.
3. **The three switches are independent booleans** — `silent`, `journal.enabled`,
   `history.enableSnapshots` — set individually at each call site with no name for the
   combination being asked for, and no way to state one up front.

Consequence (2) is why `scripts/` gets no benefit: there is no way to ask for a fast run.
Consequence (1) is the trap waiting for anyone who adds one — `scripts/lib/run.mjs`'s
`summarize()` reads `state.metrics?.netWorth`, so naively enabling silent there would report
**net worth 0** on every grid cell, silently.

### 4.2 The contract

> **Silent suppresses *observation*, never *computation*.**
> Bus telemetry, state clones, diffs and execution-graph nodes are observation. Derived
> metrics write real state that downstream code reads — they are computation, and they always
> run.

Moving the `_derivedMetrics` call out of the `!silent` block is the whole of the correctness
fix. Verified: silent + derived metrics = **319ms** with the correct net worth 4,810,931.

### 4.3 Named levels, not three booleans

| Level | Bus / clones / diffs | Journal | History snapshots | Consumer |
|---|---|---|---|---|
| `full` | on | on | on | workbench UI (default) |
| `journal` | off | **on** | off | `ScenarioCompareRunner` (needs journal by design) |
| `metrics` | off | off | **on** | MC (needs the yearly series) |
| `off` | off | off | off | optimizer, `scripts/` grids and sweeps |

Threaded as a `telemetry` option through `BaseScenario.buildSim({ telemetry })` →
`new Simulation(...)`. The existing post-hoc `sim.silent = true` assignments keep working, so
no call site is forced to change in the same commit.

### 4.4 `--fast` for the script tooling

`scripts/lib/run.mjs` `openSim()` is the single seam all 7 scripts share. Adding `--fast`
(→ `telemetry: 'off'`) picks up `run-scenario`, `diff-scenarios`, `sweep-scenario`,
`audit-scenario`, `export-tax-csv` and the probes at once. **~3,779ms → ~300ms, 12×**, on
exactly the tooling used for grid/frontier/ceiling sweeps. Default stays `full` so
single-scenario debugging output is unchanged.

### 4.5 MC's 1,803 full-state clones

`extractYearlyTimeSeries` deep-clones the **entire state** 1,803 times (every 12th event) in
order to extract **three numbers per year**: net worth, net liquidity, house value. Replace
the full-state history snapshot with a lightweight per-year sampler — 44 small records
instead of 1,803 state clones. **441ms → ~300ms.**

**Implemented as a `sampler` hook** on `Simulation`, called at the history-snapshot cadence
and at the same point in the event loop, so provenance is preserved exactly. It receives live
state and returns numbers only. MC now builds with `telemetry: 'off'` plus
`sampler: sampleTimeSeriesPoint`, and reads `sim.samples`.

**The risk was that this changes the series' provenance** — metrics computed during the run
rather than against a retained snapshot — and design 74's path-shape diagnostics consume that
series. Verified two ways rather than assumed:

1. Deterministic run, both paths side by side: **45 yearly points, identical** in year, net
   worth and net liquidity.
2. Full MC via `mc-run.mjs`, 4 arms × 30 stochastic paths, old code vs new:
   **all 4 arm result files byte-identical.** Wall 14.4s → 11.6s.

Note that history snapshots must remain available generally: `design/3` branching, the time
scrubber, `stepBack()` and `rewindTo` all depend on them. This changes what *MC* asks for,
not what `SimulationHistory` can do.

---

## 5. Phase 2 — the diff snapshot (MutationTracker coverage, rejected)

### 5.1 What the clone is for

`_processReducers` needs a before-image to compute the reducer's `stateDelta` for the
journal. It has two strategies:

```js
const useTracker = !this.silent && (r instanceof FieldReducer || r instanceof AccountTransactionReducer);
const prevState  = (!this.silent && !useTracker) ? deepClone(this.state) : null;
```

`MutationTracker` records field-level writes as they happen — no clone, no diff. Everything
else pays a full `deepClone` **plus** a full `diffStates` walk. Of 28,464 reducer executions,
**15,488 are tracked** (`BalanceSnapshotReducer` 13,066 + `MetricReducer` 2,422) and
**12,976 are not** — spread across ~55 reducer classes.

### 5.2 Measured shape of the untracked path

Instrumented over a full run:

| | Count | Share |
|---|---|---|
| Untracked invocations | 12,976 | |
| …that change nothing (**clone is pure waste**) | 1,599 | 12.3% |
| …that change state | 11,377 | |
|   — already **copy-on-write** | 8,630 | 75.9% of changes |
|   — **mutate in place** | 2,747 | 24.1% of changes |

Average top-level state keys touched per change: **2.88 of 136.**

Two things follow. First, the clone is enormously oversized: it copies 136 keys to observe
~3. Second, three quarters of the untracked reducers are *already* copy-on-write — the
in-place mutators are a **bounded, enumerable set of 15 classes**, and they are all
cash/transaction reducers:

`AuRentalIncomeApply` (528), `ExpenseDebit` (513), `SsIncomeApply` (508), `IntlTransferApply`
(459), `ReplenishSavings` (284), `UsSavingsInterestCredit` (209), `LoanPaymentApply` (182),
`AuTaxPaymentDebit` (27), `WagesIncomeApply` (12), `AuWagesIncomeApply` (12),
`UsTaxPaymentDebit` (8), `StateTaxPaymentDebit` (2), `UsHouseSaleApply` (1),
`CompanySaleApply` (1), `ChangeResidencyApply` (1).

### 5.3 The approach the harness rejected

The plan above was to record from inside `AccountService.transaction()` — the seam all 15
in-place mutators share — then flip `useTracker` from an `instanceof` test to "did the
tracker see everything?".

Building the differential harness first (§5.4) is what killed it. Its verbose output shows
what the untracked reducers actually miss, and it is **not** account balances:

```
DynamicTaxReducer               1670x missed:usOrdinaryIncomeYTD
                                1124x missed:auPersonOrdinaryIncomeYTD.spouse
                                1119x missed:usNetInvestmentIncomeYTD
AccumulateConsumptionReducer     528x missed:cumulativeConsumption
CashSleeveInterestApplyReducer   680x missed:usOrdinaryIncomeYTD
```

These are **plain state fields written directly**, not account mutations. `transaction()`
covers `<account>.balance` and `.holdings` and nothing else. To make a reducer fully tracked,
*every* write it makes must pass a recording seam — so this was never 15 reducers and one
seam, it was ~58 reducers and their several-dozen direct field writes, each an opportunity to
introduce exactly the silent under-footing §5.4 warns about.

That is a bad trade for ~1.5s. Rejected.

### 5.5 What was implemented instead: a cheaper snapshot, same diff

The clone exists only to be the left-hand side of `diffStates`. It is never published, never
retained, never read as data. So the question is not "can we avoid diffing?" but **"how much
of state does the snapshot actually have to preserve?"**

Reducers change state two ways. Copy-on-write leaves the old object untouched, so holding its
reference suffices. In-place writes need a real copy — but every in-place write in the
codebase lands **one level down**, on an account field, via `transaction()`. That is the same
finding as §5.2's "15 in-place mutators", read structurally instead of nominally.

So a **two-level copy** — new top-level object, plus a shallow copy of each top-level value —
should be sufficient. The harness settles it rather than arguing it:

| Snapshot strategy | Untracked runs producing the same diff as `deepClone` | Blocking reducers |
|---|---|---|
| shallow `{ ...state }` | 10,186 / 12,976 (78.5%) | 15 |
| **two-level copy** | **12,976 / 12,976 (100%)** | **0** |

Implemented as `snapshotForDiff` in `state-utils.js`, used for `prevState` on the untracked
path. **`diffStates` remains the producer of `stateDelta`**, so this is a pure
snapshot-strategy change with no journal-fidelity question at all — which is why it sidesteps
the entire §5.4 risk. Zero domain code changed; no reducer, and none of the 105
`transaction()` call sites, was touched.

Cost per untracked reducer, measured on real mid-run state:

| | deepClone path | snapshotForDiff path |
|---|---|---|
| snapshot | 35.4µs | 10.0µs |
| `diffStates` | 67.0µs | 41.0µs (level-2 reference fast-path) |
| **combined** | **102.3µs** | **51.0µs (2.0×)** |

### 5.6 Verification

- **Journal bit-identical.** Dumped every one of the 28,464 entries with its full
  `stateDelta` before and after; `cmp` reports no difference. This is the strongest possible
  statement of the compatibility argument §5.4 asked for, and it is stronger than the
  entry-for-entry tracker comparison originally proposed.
- `npm run crossfoot` — all 50 linked lines foot; tax worksheet footing checks pass.
- All four telemetry levels still agree at netWorth 4,810,931.
- 4,030 unit + 915 viz green.

**Result: `full`-telemetry run 4,497ms → 2,899ms (1.55×).**

### 5.7 The invariant this rests on, and its guard

Two levels is an **empirical** property of today's reducers, not a structural guarantee. A
reducer that mutates three levels down in place (`state.a.b.c = …`) would produce an
incomplete diff — and the journal would still look well-formed while under-reporting, which
is precisely the failure mode §5.4 exists to prevent.

Two guards, because this cannot be left to inspection:

- `tests/unit/snapshot-for-diff.test.mjs` (SNAP-1) runs a scenario with **both** snapshot
  strategies live and asserts the diffs match field for field. Mutation-verified: degrading
  `snapshotForDiff` to a one-level copy fails it.
- `node scripts/dev/diff-mutation-tracker.mjs <scenario>` is the same check over a full
  44-year run, and additionally reports which reducers `MutationTracker` could take over if
  that path is ever revisited.

---

## 6. Phase 3 — UI playback

Phase 0 was measured on the headless path, which has **zero bus subscribers**. The UI does
not behave the same way, and the difference is stark. Measured in the live workbench
(instrumented `TimeControls.stepTo`, `Simulation.stepTo`, `TimelinePresenter.update`):

| | Time | Share of wall |
|---|---|---|
| Wall clock, play → end | 20.4s | |
| `TimelinePresenter.update()` (100 calls) | **14,208ms** | **70%** |
| `Simulation.stepTo` (the actual simulation) | 4,813ms | 24% |
| Bus dispatch, 151,210 publishes | 537ms | 3% |
| everything else | ~1.4s | 7% |

**The simulation is not the bottleneck in the UI.** Phase 0 did help — sim compute fell from
~9.5s to 4.8s, so playback went from roughly 25s to 20s — but it improved a quarter of the
problem.

Two causes, both the §1 shape:

**Playback is structurally 100 frames.** `SimulationAnimator.animate()` advances the slider
by exactly 1 percentage point per `requestAnimationFrame`, so a full run is always 100
frames regardless of scenario length. Each frame does 1% of the sim, then a full UI update.

**The timeline is the one view that is never throttled.** `startPlaying()` calls
`setRenderThrottle(PLAYBACK_THROTTLE_MS)` on the graph renderer, state panel, chart, accounts
presenter and dash cards — but not the timeline, because `setRenderThrottle` is a
`BaseComponent` method and `TimelinePresenter` is a presenter. So on every one of the 100
frames it runs `_render()`, which makes **five full passes over a journal that grows to
28,464 entries** — `groups()` (twice: once in `update()`, once in `_render()`),
`allOptions()`, `dateBounds()`, `causalGroups()` — and then re-renders the DOM. 142ms per
frame at the end of the run.

### 6.1 What was actually slow

Benchmarking the controller against a real 28,464-entry journal redirected the plan. The
static read above blamed the five scans; the numbers blamed something else:

| Controller call | Before | After |
|---|---|---|
| `groups()` | **155.9ms** — of which **87% was `sum()`** | 30.0ms |
| `causalGroups()` | 20.5ms | 31.8ms |
| `dateBounds()` | 4.3ms | 7.2ms |
| `allOptions()` | 0.7ms | 1.3ms |
| `_render()` total | 181.4ms | 70.3ms |
| per playback frame (`_render` + `update`'s second `groups()`) | **337.3ms** | 70.3ms |

`sum()` formats an action's amount for display, and `fmtNative` built a
**`new Intl.NumberFormat` per call**. Constructing an `Intl.NumberFormat` is far more
expensive than using one, and `groups()` called it for every journal entry. That single
line was 135ms of the 142ms-per-frame figure.

Worse, it was formatting ~28,000 values to display about twenty: the view is
**virtualized**, and `sum` is read only by `_renderFlatAction`, for visible rows only.

### 6.2 The fixes

1. **Cache the `Intl.NumberFormat` per currency code.** A handful of codes exist in a run.
2. **Make `sum` lazy** — a prototype getter on a small `TimelineItem` class, memoised, so it
   is computed when a row is actually painted. Transparent to the view and its tests, which
   destructure `{ entry, idx, sum, taxDoc }` exactly as before.
3. **Stop double-computing `groups()`.** `update()` built the entire grouped map to read one
   string — the latest date key — then `_render()` built it again. New
   `TimelineController.latestDateKey()` scans backward and stops at the first match.
4. **Throttle the timeline during playback** like every other view. `TimelinePresenter` gains
   `setRenderThrottle`, and the animator drives it. Only the playback path (`update()`) is
   throttled; interactive renders stay synchronous. `setRenderThrottle(0)` also **flushes** a
   pending render, so stopping playback never leaves a stale final frame.

Item 3 of the original plan — making `dateBounds`/`allOptions` incremental — was **dropped
as unnecessary**. Together they are ~8ms of a 70ms render, and throttling cut renders from
100 per playback to under a dozen, so the whole remaining scan cost is well under 100ms per
run. Making them incremental would add mutable index state to the controller for no
measurable gain.

### 6.3 Result

Measured in the live workbench, warm page, three consecutive playbacks:

| | Old | New |
|---|---|---|
| Playback wall, play → end | 20.09s / 20.41s | 9.55s / 8.04s / 10.43s |
| `TimelinePresenter` total | 14,208ms | 33–162ms |
| Timeline renders per playback | 100 | 2–10 |
| Timeline share of wall | **70%** | **~1.5%** |

**Playback ~20.3s → ~9.3s, about 2.2×.**

A measurement caveat worth recording: the first playback after a page reload is
**cold-JIT** and runs roughly twice as slow as subsequent ones. An early comparison here
was confounded by exactly that — old numbers came from a warm page, new from a cold reload,
which made the engine look 3× slower than it was. Compare warm to warm.

### 6.4 What is left in the UI

The simulation is now the bulk of playback wall time. This section originally named the bus
subscribers as the next target, on an inference from the browser/headless gap; **§8.1
measures them directly and that inference was wrong** — they are ~12%, not the bulk. After
Phase 2 the UI is dominated by the same engine work as the headless run, so §8's candidates
serve both.

One artefact worth keeping: a one-shot `stepTo` to the end in the browser costs ~21s, *more
than a whole 100-frame playback*, because outside playback the subscribers are unthrottled
and render per message.

---

## 7. Verification

Every phase is held to the same bar:

- **Net worth invariant.** `scenarios/fin-sim-scenarios.json` must end at **4,810,931**
  under every telemetry level. This is the check that catches the Phase 1 derived-metrics
  trap, because a silent run that skips metrics reports 0 rather than failing.
- `npm run test:unit` (4,023) and `npm run test:viz` (910) green.
- `npm run crossfoot` — mandatory for Phase 2, which touches journal production.
- Phase 1 §4.5 and Phase 2 additionally require a before/after comparison of an MC run
  (ranking and failure rates), because both change what MC observes.

## 8. Phases 4+ — proposed, not implemented

Where the engine stands after phases 0–3. Headless `full` telemetry, same
scenario, 2,835ms total:

| Cost centre | Self time | Share |
|---|---|---|
| `diffStates` + its `walk` | 1,088ms | 38% |
| `deepClone` | 423ms | 15% |
| garbage collector | 214ms | 7% |
| `snapshotForDiff` | 181ms | 6% |
| `_processReducers` | 180ms | 6% |
| execution-graph `addNode`/`addEdge` + index upkeep | 162ms | 6% |

Diffing is now the single largest cost, and it splits almost evenly:

| | Calls | Per call | Total |
|---|---|---|---|
| event-level (`stateBefore` vs `stateSnapshot`) | 6,363 | 103.4µs | **658ms** |
| reducer-level (`snapshotForDiff` vs live state) | 12,976 | 51.9µs | **673ms** |

The event-level diff is dear because both sides are independent deep clones with
no shared references, so `walk` compares every leaf. The reducer-level diff is
half the price precisely because §5.5's snapshot shares references below level 1
and short-circuits.

### 8.1 Correcting an earlier claim about the bus

An earlier draft of §6.4 said the 16 bus subscribers were the next UI target,
inferring ~4s from the gap between in-browser and headless `stepTo`. Measured
directly, with every subscriber individually timed across a full playback, that
is **wrong**:

| | |
|---|---|
| playback wall | 5.19s |
| `sim.stepTo` | 3,910ms (75%) |
| publish machinery (message construction + predicate matching + dispatch) | 642ms |
| …of which the subscriber callbacks themselves | 522ms |
| …of which bus overhead | 119ms |
| publishes per run | 151,210 |

The bus is ~12% of playback, not the bulk of it. The gap that produced the wrong
inference had already closed: headless `full` fell from 3.76s to 2.83s in Phase 2,
so browser (3.9s) minus headless (2.8s) is ~1.0s, and the bus explains most of it.

**The UI is now dominated by the same engine work as the headless run.** There is
no separate UI problem left to solve beyond what follows.

### 8.2 Candidates, most valuable first

**A. Compose the event-level diff from the reducer diffs it already has (~658ms).**
Every state change inside an event passes through a reducer, and each reducer's
diff is already computed and journalled. Re-deriving the event diff with a full
walk over two deep clones re-does work that was just done. Merging the per-reducer
diffs would replace a 103µs walk with a cheap concatenation.

Not free of risk, which is why it is not done here:
- Derived metrics run *after* the reducers and before the snapshot, so
  `metrics.*` changes appear in no reducer diff. They would need a targeted diff
  of that subtree.
- A field written by two reducers in one event yields two entries; the composed
  diff must coalesce to first-before/last-after to match today's output.
- Event-level `stateDiff` is a *published bus contract*
  (`echarts-graph-renderer.js` reads it for node `stateChanges`), so this is a
  behaviour change, not an internal refactor. It needs the §5.6 treatment — dump
  and `cmp` every event-level diff before and after.

**B. Stop cloning state twice at the end of an event (~30ms).** `execute()` builds
`stateSnapshot`, then `journal.addSnapshot(date, this.state)` deep-clones the same
unmutated state again. Small, obviously correct, needs `addSnapshot` to accept an
already-detached snapshot.

**C. Bound the execution graph (~162ms + memory).** It reaches 76k nodes and 130k
edges on a 44-year run; `addNode`/`addEdge`/index upkeep is 6% of the run and the
graph is retained for the whole session. It is already suppressed at every
telemetry level but `full`. A ring buffer, or recording only event-kind nodes,
would cut both. Note this is the structure whose growth caused the original §2
quadratic.

**D. Reduce bus granularity (~642ms in-browser).** 151,210 publishes for 6,363
events — 96% are sub-event (handler/action/reducer) messages, each an allocation
plus predicate matching across 19 subscribers. Most subscribers use `busQueue`,
which pushes **every** message into an array drained only at render time; under
playback throttling that is ~75,000 messages accumulated per subscriber between
drains, which is also where a good share of the 214ms GC comes from. Publishing
sub-event telemetry only when something subscribes at that granularity would cut
allocation, dispatch and GC together.

**E. `holdings-plugin` has a third hand-rolled render scheduler** (rAF-only, no
throttle, with a mounted-guard), so it repaints per frame during playback while
every other view is throttled. Small, but it belongs with (D).

---

## 9. Decisions

Locked:

1. **Silent suppresses observation, never computation** (§4.2). Derived metrics always run.
2. **Telemetry becomes a named level, not three booleans** (§4.3).
3. **Phase 2 is gated on a differential test** written before any clone is removed (§5.4).
   Held — and the harness earned its keep by rejecting the plan it was built to validate.
4. **Phase 0's `deepClone` accepts two documented divergences** from `structuredClone`
   (cycles, functions) as impossible-by-construction in journalled state (§3.2).
5. **MC drops full history snapshots for a sampler** (§4.5) — closed by the two
   verifications recorded there. The optimizer keeps snapshots: `rollToSnapshot` is the MPC
   seam and genuinely needs them, so it sits at the `metrics` level.
6. **Extending MutationTracker coverage is REJECTED** (§5.3). It is ~58 reducers' direct
   field writes, not 15 reducers and one seam, and every one is a chance to under-foot the
   journal. `snapshotForDiff` (§5.5) gets most of the win by changing no domain code at all.
7. **`snapshotForDiff` is two levels deep, and that is an empirical bound** (§5.7), held by
   SNAP-1 and the harness script rather than by inspection.

Open:

1. **Remove `BaseService._serviceFilter`?** Now unreferenced (§3.4).
2. **Should playback be frame-count-based at all?** (§6) — 1%-per-frame means a 10-year and a
   44-year scenario both take 100 frames, so the per-frame work scales with scenario length.
   Out of scope here; noted because it caps how good playback can get.
3. **Should `openSim()` default to `off` too?** (§4.4) — it defaults to `full` because a tool
   that opens a sim without stepping it usually wants the journal. `run()` defaults to `off`.
   Worth revisiting if the split proves confusing in practice.
