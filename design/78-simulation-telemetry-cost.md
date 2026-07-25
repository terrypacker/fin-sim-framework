# 78 — Simulation performance: telemetry cost and history-proportional work

**Status: Phases 0 and 1 COMPLETE (implemented + green, 4,023 unit / 910 viz, on
`wip/sim-performance`). Phases 2 and 3 are DESIGNED, not implemented.**

| Phase | | Result |
|---|---|---|
| 0 | engine hot paths | step loop 9,540ms → 3,759ms (**2.5×**) |
| 1 | telemetry contract | `npm run scenario --fast` 3.90s → 0.46s (**8.5×** wall); MC 14.4s → 11.6s |
| 2 | MutationTracker coverage | designed — est. 1.5–2s of the remaining 3.76s in `full` |
| 3 | UI playback | designed — `TimelinePresenter` is 70% of playback wall time |

Cumulative for the batch tooling: **10.9s → 0.46s, ~24×.**

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
| Untracked reducers deep-clone + diff whole state | O(state) × 12,976 | reducer count | Phase 2 |
| `TimelinePresenter` re-renders the whole journal per playback frame | O(journal) × 100 | journal entries | Phase 3 |

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

## 5. Phase 2 — MutationTracker coverage

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

### 5.3 The approach

They share a seam. Every one of those 15 debits or credits an account, and does it through
`AccountService.transaction()` — which is precisely the seam `AccountTransactionReducer`
already uses to feed `MutationTracker`. Recording from inside `transaction()` rather than
from the reducer subclass covers all 15 at one site, and makes the coverage rule
*structural* ("mutations go through the seam") instead of *nominal* ("your class extends the
right base").

Sequencing:

1. Record from inside `transaction()`; verify the 15 classes go quiet as in-place mutators
   under the Phase 2 probe.
2. Flip the `useTracker` predicate from an `instanceof` test to "did the tracker observe
   anything, and did nothing else change?" — with a `deepClone` fallback retained for any
   reducer that still mutates outside the seam.
3. Only then remove the clone for the reducers proven covered.

The 12.3% no-op case falls out for free: `MutationTracker.flush()` already returns `null`
when nothing was recorded.

### 5.4 The compatibility argument (this is the risk)

**Phase 2 changes journal fidelity, not just speed.** `diffStates` produces
`{field, before, after, delta}` for every leaf that differs, derived structurally.
`MutationTracker` produces the same shape, but from what `record()` was *told*. These agree
only if the seam records everything the diff would have found.

`Journal.stateDelta` is consumed by the design 16 drill reports and by `npm run crossfoot`,
which foots multi-year tax exports. A reducer whose writes are partially recorded produces a
journal that still *looks* well-formed and quietly under-foots — the exact failure mode the
`startOffset` and CG-report bugs had.

So Phase 2 is gated on a **differential test**: run the scenario with both strategies active
simultaneously and assert `MutationTracker.flush()` equals `diffStates(prevState, state)`
entry-for-entry, for every untracked reducer, across a full run. That harness is the
deliverable of step 1 — not step 3. `JOURNAL_STRICT` freezing already proves the weaker
property (nobody mutates *recorded* leaves); this proves the stronger one.

Expected saving: 12,976 clones **and** 12,976 diff walks — the largest remaining item in
`full` mode, worth roughly 1.5–2s of the current 3.76s.

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

Fixes, cheapest first:

1. **Throttle the timeline during playback** like every other view. Mechanical, and it is
   simply an omission — the timeline should have been in that list.
2. **Stop double-computing `groups()`** — `update()` computes it to find the latest date key,
   then `_render()` computes it again.
3. **Make the scans incremental.** `dateBounds` and `allOptions` are running maxima and
   running distinct-sets; both can be maintained as entries are appended instead of rebuilt
   from scratch. This is the real fix — (1) reduces how often the O(journal) work happens,
   but only (3) stops it being O(journal).

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

## 8. Decisions

Locked:

1. **Silent suppresses observation, never computation** (§4.2). Derived metrics always run.
2. **Telemetry becomes a named level, not three booleans** (§4.3).
3. **Phase 2 is gated on a differential test** proving tracker output equals diff output,
   written before any clone is removed (§5.4).
4. **Phase 0's `deepClone` accepts two documented divergences** from `structuredClone`
   (cycles, functions) as impossible-by-construction in journalled state (§3.2).

5. **MC drops full history snapshots for a sampler** (§4.5) — was open, now closed by the
   two verifications recorded there. The optimizer keeps snapshots: `rollToSnapshot` is the
   MPC seam and genuinely needs them, so it sits at the `metrics` level.

Open:

1. **Remove `BaseService._serviceFilter`?** Now unreferenced (§3.4).
2. **Should playback be frame-count-based at all?** (§6) — 1%-per-frame means a 10-year and a
   44-year scenario both take 100 frames, so the per-frame work scales with scenario length.
   Out of scope here; noted because it caps how good playback can get.
3. **Should `openSim()` default to `off` too?** (§4.4) — it defaults to `full` because a tool
   that opens a sim without stepping it usually wants the journal. `run()` defaults to `off`.
   Worth revisiting if the split proves confusing in practice.
