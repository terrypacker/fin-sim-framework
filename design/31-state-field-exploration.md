
# 31 — State-Field Exploration (Path-Addressable Time-Series)

**Status**: COMPLETE (2026-06-07) — v1 (Steps 1–16) **and** the §10 refinements (R1–R12) all implemented and tested. Selection is State-panel-driven (chart filter removed), chart ingestion is allow-list (hang fixed), rows are unified/foldable with per-row + tri-state chart toggles, tables are filterable, holdings use stable `[id=..]` paths, `metrics.netWorth` is a real seeded default, and coarse/backfilled series are badged. See §10.
**Related**:
- `design/16-journal-reporting-plugin.md` — grouped/faceted state reporting; this design shares the "the state is huge; let the user pick what to look at" problem but targets the *time-series chart* + *live state panel* surfaces rather than tabular reports.
- `design/18-performance-enhancements.md` — the `stateSnapshot` retention cost (~98 MB / 15 yr) and `snapshotInterval` are the binding constraints on §6 (where the time-series lives).
- `design/25-holding-level-state.md`, `design/28-time-varying-appreciation-and-bond-duration.md`, `design/23-fx-exchange.md`, `design/21-financial-shock-and-regime-framework.md` — the features that *produced* the new state fields (holdings `marketValue`, `effectiveExchangeRates.*`, regime `effective*Rates.*`) the user now wants to chart.
- `StateSchemaRegistry` (`src/finance/services/state-schema-registry.js`) — the existing path→type/format layer this builds on.

**Author note**: This design started from a concrete frustration — "I can't confirm the SF Bay shock is changing property values because I can't chart the property value." The investigation found that the data is *already on the bus*; the chart simply discards it. So this is less "build a new pipeline" and more "stop funneling everything through `state.metrics` and make the whole state addressable." Three UI surfaces converge on one shared concept: a **path-addressable time-series layer**.

---

## 1. Purpose

Today, to chart a value over the simulation you must route it through `state.metrics` via a `RECORD_METRIC` action, because the chart only reads `state.metrics`. That was the right call when the set of interesting series was small and well-defined. It no longer is:

- `effectiveExchangeRates.USD_AUD` (design 23) — want to see FX drift over time.
- `*.holdings.*.marketValue` (design 25/28) — want to confirm the SF Bay shock moves property/asset values.
- regime `effective*Rates.*` (design 21) — want to see the regime-adjusted appreciation/interest/inflation rates the sim is actually applying.

None of these are in `state.metrics`, so none are chartable today without adding bespoke `RECORD_METRIC` plumbing per field. That is the wrong default: it makes "look at a field over time" an O(code-change) operation when it should be O(click).

**Goal**: any numeric field anywhere in `sim.state` can be selected, charted, watchlisted, and drilled into (sparkline + execution context) from the UI, with **zero added simulation-runtime cost** and a bounded UI-memory cost.

---

## 2. Where We Are Today

| Concern | Today |
|---|---|
| Full state per event | `Simulation` does `structuredClone(state)` and attaches it as `stateSnapshot` on every `EXECUTION_END(EVENT)` bus message (`simulation.js:455-467`). **The whole state is already flowing.** |
| Chart ingestion | ~~`ChartPresenter._doRender()` narrows that to `msg.stateSnapshot.metrics` and **discards the rest** (`chart-presenter.js:82-85`).~~ **DONE (design 31)**: flattens entire state via `flattenStatePaths()`; all numeric paths reach the chart. |
| Chart series discovery | `ChartController.discoverKey()` now accepts a `group` and stores it; `StateFieldMultiSelect` renders grouped headers. |
| Chart selector | `StateFieldMultiSelect` (extends `MapFilterMultiSelect`) mounted on the chart filter bar, fed the full state path list with semantic groups. |
| Field formatting | `StateSchemaRegistry` already maps arbitrary state **paths** → typed `ParameterValueType` (currency/rate/percentage/…), with exact + glob resolution. FX, holdings, regime-rate, YTD, balance paths are **already typed**. |
| State panel | `StatePanelView` numeric-leaf rows now have click-to-chart ("+") and click-for-history affordances. `FieldSeriesStore` provides path-keyed 200-pt ring buffers + history backfill. |
| Metric row click-through | `_showFieldHistoryModal(path, history, backfilled)` — works for any state path. Exec-graph tab filtered to events whose subtrees wrote the path (`_subtreeTouchedPath`). |
| Time-series retention | The chart keeps thin per-series arrays *only for keys it has seen during the run*. `SimulationHistory` keeps full-state snapshots every `snapshotInterval` events (default **12**, ≈ 1/year — `simulation.js:102`). |

**Post-implementation**: `state.metrics` is now one curated group among many in the chart filter. `RECORD_METRIC` is reserved for genuinely derived/synthetic values that are not naturally present as a single state field (cumulative income-flow accumulators, out-of-funds deficits, cross-account KPIs). Existing call sites (earnings handlers, expense handlers, transfer handlers) are all legitimate derived accumulators — none are redundant given design 31.

---

## 3. Conceptual Model

One concept unifies three surfaces:

> **A path-addressable time-series layer.** A *path* is a dot-separated address into `sim.state` (e.g. `effectiveExchangeRates.USD_AUD`, `usSavingsAccount.holdings.0.marketValue`). Any numeric-valued path is a *series*. The chart, the state panel, and watchlists all speak in paths.

```
                         ┌──────────────────────────────┐
   EXECUTION_END(EVENT)  │  stateSnapshot (full clone)   │
   ───────────────────►  │  already on the bus, free     │
                         └───────────────┬──────────────┘
                                         │  extract selected paths
                                         ▼
   ┌───────────────────────────────────────────────────────────────┐
   │             Path-Addressable Time-Series Layer                 │
   │   • path discovery (flatten state → numeric leaf paths)        │
   │   • grouping (curated + auto path-prefix fallback)             │
   │   • typing/formatting (StateSchemaRegistry)                    │
   │   • series store: live thin buffers + lazy backfill           │
   └───────┬───────────────────┬────────────────────────┬──────────┘
           ▼                   ▼                         ▼
   ┌──────────────┐   ┌──────────────────┐   ┌────────────────────────┐
   │  Chart       │   │  State panel      │   │  Watchlists            │
   │  sidebar     │   │  row click →      │   │  saved path[] per      │
   │  (grouped    │   │  sparkline +      │   │  scenario; click-to-   │
   │   multi-     │   │  exec-graph for   │   │  promote from state    │
   │   select)    │   │  ANY field        │   │  panel                 │
   └──────────────┘   └──────────────────┘   └────────────────────────┘
```

The three surfaces are not three features; they are three views of one layer.

---

## 4. Decisions (resolved with the user)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Where does a series' history live? | **Hybrid** | Thin live buffers for the active/watchlisted set (full-resolution, off the bus, free). Fields selected *after* a run are backfilled lazily from `SimulationHistory`. No standing parallel cache; reuses snapshots we already keep. |
| D2 | Backfill fidelity when `snapshotInterval > 1` | **Accept snapshot granularity** | Backfilled series are only as fine as `snapshotInterval` (default 12 ≈ 1/yr). Documented limitation. Live-watchlisted fields remain full-resolution. No new memory cost. A small "this series was backfilled at snapshot resolution" affordance in the UI. |
| D3 | Watchlist scope | **Per-scenario (in JSON)** | A watchlist is "the fields that matter for *this* model"; travels with the scenario through export/import. (Per-user localStorage explicitly *not* in scope for v1.) |
| D4 | Sidebar grouping | **Hybrid: curated + auto fallback** | Curated semantic groups (FX, Regime Rates, Asset Values, Tax YTD, Balances, Metrics) mapped to path patterns; anything unmatched falls into auto path-prefix groups so nothing is ever hidden. |
| D5 | How far now | **Design doc first**, then phased implementation. | Matches the `design/*.md` convention. |
| D6 | Fold in row-click for all fields | **Yes** | The metric modal was never metric-specific (§2); generalizing it rides the same plumbing as the chart rewire and the same D1 time-series source. |
| D7 | `RECORD_METRIC` future | **Demote, don't remove** | Keep it for *derived/synthetic* values that aren't otherwise in state (sums, multiplicative accumulators, KPIs). It stops being the charting prerequisite; `state.metrics` becomes just one curated group (D4). |

---

## 5. Design

### 5.1 Path discovery & flattening

A `flattenStatePaths(state)` helper walks the state tree and returns the set of **numeric-leaf paths** (plus, for the sidebar, their current value and resolved type). Rules:

- Recurse objects and arrays; emit a path only for finite-number leaves.
- Arrays index by position (`holdings.0.marketValue`); the sidebar collapses repeated array shapes into a group (§5.3) rather than listing each index flat.
- Reuse the same traversal already implemented in `StatePanelView.renderState` — extract it to a shared util so the panel and the discovery layer cannot drift.

Discovery is **incremental**: paths are accumulated as snapshots stream (a field that only appears mid-sim — e.g. a holding created on a purchase event — is discovered when it first appears), mirroring how `ChartPresenter.addSnapshot` already discovers metric keys on first encounter.

### 5.2 Typing & formatting

Already solved by `StateSchemaRegistry.resolve(path)` → `ParameterValueType`. The sidebar uses it for the value-type badge and right-axis grouping (currencies vs rates vs percentages must not share a Y-axis); the chart uses `.format()` for tooltips. **New paths only need a registry entry if their type isn't already covered by an existing glob** — and FX/holdings/regime/YTD/balance globs already exist (`state-schema-registry.js:110-171`). Adding a regime-rate exact/glob entry if any are currently `unknown` is the only likely gap.

### 5.3 Grouping (D4)

A small `STATE_FIELD_GROUPS` table maps curated group labels → path patterns (reusing the registry's glob matcher):

| Group | Patterns (illustrative) |
|---|---|
| FX | `baseExchangeRates.*`, `effectiveExchangeRates.*`, `*FxFees.*` |
| Regime Rates | `effectiveInflationRates.*`, `effectiveExchangeRates.*`, `inflationRates.*`, regime effective-rate paths |
| Asset Values | `*.holdings.*.marketValue`, `*.holdings.*.costBasis`, real-property market paths |
| Balances | `*.balance` |
| Tax / YTD | `*YTD`, `cumulativeDeficit`, `ftcYTD` |
| Metrics | `metrics.*` |

`groupFor(path)` returns the first matching curated group, else an **auto group** keyed on the path's leading segment(s). This guarantees coverage (no field is unreachable) while keeping the common domains friendly. Groups are selectable as a unit in the sidebar (select-group = select all its currently-discovered paths).

### 5.4 Chart rewire

1. `ChartPresenter._doRender()` stops narrowing to `.metrics`. Instead it extracts the **currently selected paths** (active set ∪ watchlist) from `msg.stateSnapshot` via the path getter and feeds `{path: value}` to the view. (The view already discovers a series per key and already has `serializePrimitive` for non-numeric skipping — no view change needed beyond keying on path strings.)
2. The chart filter's `MapFilterMultiSelect` is fed the **grouped discovered path list** (§5.1/§5.3) instead of `ChartController`'s metric keys. `ChartController` generalizes from "metric keys" to "selected paths" — same shape (`{id, name}`), `name` from the registry label.
3. Multi-axis: series are bucketed onto Y-axes by `ParameterValueType.kind` so a rate (0–1) and a currency (10^6) don't crush each other.

### 5.5 Generalized row click-through (D6)

`StatePanelView` currently special-cases `state.metrics` rows for the sparkline + `_showMetricHistoryModal`. Generalize:

- Every numeric leaf row (anywhere in the tree, via `renderState`) gets the same click handler, keyed by its **full path** instead of a metric key.
- `_bufferMetrics` → `_bufferSeries(path, value)`, but **lazy** per D1: only buffer paths that are (a) watchlisted, (b) currently visible/expanded in the panel, or (c) charted. Clicking a not-yet-buffered row triggers a **backfill** (§5.6) before opening the modal.
- `_showMetricHistoryModal(path, history)` is unchanged structurally — it already takes a `[{date,value}]` array and a label. Rename to `_showFieldHistoryModal`.
- The exec-graph tab (`_renderExecGraphPane`) works **as-is** — it's already field-agnostic. **Phase 2 enhancement** (§7): filter it to executions that actually *wrote this path* (journal `stateDiff` already records per-action field changes; the panel already does field-history via `_renderSparkline(change.field, …)`), turning "all events in window" into true field-causal lineage.

### 5.6 Time-series store (D1 + D2)

A `FieldSeriesStore` owns:

- **Live buffers**: `Map<path, {date,value}[]>` for the active set, appended from the bus (full resolution, capped ring buffer as today).
- **`backfill(path)`**: when a path is selected/clicked that has no (or partial) live history, walk `SimulationHistory.snapshots` (already an ordered array with `date`), read the path from each snapshot, and synthesize a series at **snapshot granularity** (D2). Mark the series `backfilled: true` so the UI can show the coarser-resolution affordance.
- Cleared on rewind/replay alongside the existing `resetHistory()` / `clearMetricHistory()` paths.

No change to `Simulation`, `snapshotInterval`, or the snapshot mechanism — **runtime cost is unchanged**. The only new memory is buffers for paths the user is actively looking at.

### 5.7 Watchlists (D3)

- A watchlist is `{ id, name, paths: string[], perPath?: {color?, axis?} }`.
- Stored on the **scenario** (round-trips via `ScenarioSerializer` / `ScenarioStorage`), so it travels with export/import like the rest of the scenario config.
- **Click-to-promote**: a state-panel row gets an "add to watchlist / chart" affordance; emits a small runtime-bus event the chart subscribes to (no new plumbing — same pattern as existing `SCENARIO_READY` / annotations). Promoting a path adds it to the active set (live buffering begins) and, if a run already completed, triggers a one-shot backfill.

---

## 6. Cost Analysis

| Cost | Verdict |
|---|---|
| Simulation runtime | **Zero added.** Everything is downstream of the `stateSnapshot` already produced on every event. No sim-loop change. |
| Snapshot memory | **Unchanged.** Does not touch `snapshotInterval` or snapshot retention. |
| UI memory (live buffers) | Bounded: one capped ring buffer per **actively selected** path, not per state field. Worst case ≈ (watchlist + visible rows) × cap. |
| UI compute (backfill) | One-shot walk of existing `SimulationHistory.snapshots` per post-hoc selection. O(snapshots), and snapshots are coarse (≈ yearly) by default. |

This is the explicit "no simulation runtime cost" bar the user set for folding in §5.5, met for all three surfaces.

---

## 7. Phasing

| Phase | Scope | Notes |
|---|---|---|
| **1 — Chart rewire** | §5.1–5.4: flatten/discover paths, grouped sidebar, chart reads arbitrary paths from `stateSnapshot`, multi-axis by type. | Unblocks the original ask (chart FX / asset / regime fields). Largest user-visible win; no new persistence. |
| **2 — Generalized row click** | §5.5 basic: any numeric leaf row → sparkline + (existing, field-agnostic) exec-graph modal, with lazy buffering + backfill (§5.6). | Reuses the modal almost verbatim. |
| **3 — Watchlists** | §5.7: per-scenario saved path lists + click-to-promote. | Adds the only new persistence; depends on 1 & 2. |
| **4 — Field-causal exec graph** | §5.5 enhancement: exec-graph tab shows only executions that wrote the selected path (journal `stateDiff`). | Strictly-better-than-metric behavior; isolated, optional. |
| **5 — `RECORD_METRIC` demotion** | Documentation + treating `metrics.*` as one curated group; audit which `RECORD_METRIC` uses are now redundant (field already in state) vs genuinely derived. | Cleanup; no behavior change required for users. |

---

## 8. Open Questions / Risks

- **Backfill resolution surprise (D2)**: users may not expect a post-hoc-selected series to be coarser than a watchlisted one. Mitigation: explicit "backfilled @ snapshot resolution" badge + offer "watchlist this and re-run for full resolution."
- **Array-shape churn**: holdings are positional (`holdings.0`, `holdings.1`); a sale that removes index 0 shifts paths. **Resolved in refinements (D16/R11)**: address array-of-object elements by stable `id` (`holdings[id=<id>].marketValue`) so a watchlisted holding survives sales.
- **Y-axis explosion**: many selected series of mixed types could create too many axes. Cap to a small set of axes per `ParameterValueType.kind`; warn beyond a threshold.
- **Overlap with design 16 (journal reporting plugin)**: that plugin already does grouped/faceted *tabular* state reporting. This is the *time-series/chart* counterpart. They should share the grouping table (§5.3) and the `StateSchemaRegistry` typing rather than duplicate. Worth a follow-up to unify the group definitions.

---

## 9. Step-by-step Implementation Plan (added 2026-06-07)

### Status legend
- [ ] not started  🔶 in progress  ✅ complete

### Sequencing rationale

Mirrors the design-28 / design-29 approach: land the lowest-risk, highest-value piece first, validate end-to-end, then layer. Increment 1 (chart rewire) delivers the original ask — chart FX / asset / regime fields — and touches *only* the chart triad, no persistence, no sim changes. Increment 2 (generalized row-click) reuses the metric modal almost verbatim. Increment 3 (watchlists) is the only one that adds persistence and depends on 1+2. Increments 4 and 5 are isolated, optional polish.

**Build order:** Increment 1 (path-addressable chart) → Increment 2 (generalized state-panel row click + lazy backfill) → Increment 3 (per-scenario watchlists) → Increment 4 (field-causal exec graph) → Increment 5 (`RECORD_METRIC` demotion + audit).

**Grounding facts established before writing this plan (so steps cite real symbols, not §1-8 sketches):**
- **Full state is already on the bus.** `Simulation` does `const stateSnapshot = structuredClone(this.state)` and attaches it to the `EXECUTION_END(EVENT)` message (`simulation.js:455-467`). The chart already receives it — `ChartPresenter._doRender()` narrows to `msg.stateSnapshot?.metrics` and drops the rest (`chart-presenter.js:82-85`). **This is the single line the whole design hinges on.**
- **A nested-path get/set already exists.** `src/finance/monte-carlo/mc-param-paths.js` exports `get(obj, path)` and `set(obj, path, value)` (lines 35 / 50) with a `parsePath` that handles dotted + bracketed segments. Reuse it for path extraction — do **not** write a new getter. (Consider relocating it to a neutral util in Increment 1 since it'll now be used outside MC; or import as-is and relocate later.)
- **The chart triad is built in one place.** `workbench-app.js:456-463` constructs `new ChartController()`, `new ChartView({...})`, `new ChartPresenter({controller, view})`. `ChartPlugin` (`chart-plugin.js`) only builds DOM (`#chartFilterContainer`, `#chartContainer`, the failure banner). The filter bar mounts into `#chartFilterContainer` via `ChartView.mountFilterBar()` (template `tpl-chart-filter-bar`, inner `#chart-metric-select`).
- **The filter widget is already a filterable multi-select** — `MapFilterMultiSelect` (`map-filter-multi-select.js`). API: constructed with `{ container, queryApi, onToggle }`; calls `await queryApi.search(query)` → `{ items, total }` and `onToggle(item, added, selectedItems[])`. It has **no group/section rendering today** (grep-confirmed) — §5.3 grouping is the one genuinely new UI piece (Step 3).
- **`ChartController.getQueryApi()`** already returns a duck-typed `new QueryApi({ getAll: () => [...knownKeys] })` (`chart-controller.js:62`). Items are `{ id, name }`. Generalizing from metric-keys to paths keeps that shape — `name` comes from the registry label.
- **`StateSchemaRegistry.resolve(path)`** → `ParameterValueType` already covers FX (`effectiveExchangeRates.*` → rate), holdings (`*.holdings.*.marketValue` → currency), inflation (`effectiveInflationRates.*`), YTD/balance, etc. (`state-schema-registry.js:110-171`). Regime *effective-rate* paths beyond inflation/FX may resolve to `unknown` — verify and add globs in Step 5.
- **`SimulationHistory.snapshots`** is `[{ date, state, rngState, queue }]` (`simulation-history.js:30-39`), ordered, with `findSnapshotIndex` binary search (line 84). Backfill reads `get(snap.state, path)` across `snapshots`. **Default `snapshotInterval` is 12** (`simulation.js:102`, ≈ 1/yr) — backfilled series are coarse (D2).
- **State-panel metric click is not metric-specific.** `_bufferMetrics` (`state-panel-view.js:129`) buffers only `state.metrics.*` into `_metricHistory` (200-pt ring). `_renderMetricsPanel` (line 203) wires each row → `_showMetricHistoryModal(key, history)` (line 508). The modal's exec-graph tab `_renderExecGraphPane` (line 758) uses **only the history's date window** — it never reads the metric key, so it generalizes to any path unchanged.
- **Scenario persistence is a flat object.** `ScenarioSerializer.serializeScenario()` (`scenario-serializer.js:360-382`) returns a fixed shape (`persons/accounts/.../params/toolsets`). Adding `watchlists` means one line here + a read on the deserialize path (`scenario-loader.js` / `scenario-registry.js`). `ScenarioStorage` (`scenario-storage.js`) wraps `localStorage` and round-trips whatever `serializeScenario` emits.

---

### Increment 1 — Path-addressable chart

Decouple the chart from `state.metrics`; let the user select any numeric state path, grouped and typed. Pure UI/data-path change — no sim, no persistence. Unblocks the original need (chart FX / asset `marketValue` / regime rates).

**Step 1 — Path flatten + extract util** ✅
- Created `src/visualization/state/state-paths.js` exporting `flattenStatePaths(state)` → `{ path, value, type }[]` for finite-number leaves only, using `StateSchemaRegistry` for type. Recurses objects/arrays; indexes arrays positionally.

**Step 2 — `ChartPresenter` reads arbitrary paths** ✅
- `chart-presenter.js` `_doRender()` now uses `flattenStatePaths(msg.stateSnapshot)` to extract all numeric paths; `addSnapshot()` hides non-Metrics paths by default (backward-compatible). `StateFieldMultiSelect` replaces `MapFilterMultiSelect`.

**Step 3 — Grouped sidebar (the one new UI piece)** ✅
- `STATE_FIELD_GROUPS` + `groupFor(path)` in `state-paths.js`. `StateFieldMultiSelect` (`src/visualization/state/state-field-multi-select.js`) extends `MapFilterMultiSelect` with group-header rendering and group-first sort. `ChartController.discoverKey()` now stores `group` on each item.

**Step 4 — Multi-axis by value-type** ✅
- `ChartView.setSeriesKind(key, kind)` added; `_buildSeriesOption` assigns `yAxisIndex` (rate/percentage → 1 right; everything else → 0 left); `_doChartUpdate` calls `_buildYAxes()` which returns a single or dual yAxis depending on whether any rate/percentage series are active.

**Step 5 — Schema-registry gaps** ✅
- Added globs to `state-schema-registry.js`: `effectiveInflationRates.*`, `effectiveAppreciationRates.*`, `effectiveInterestRates.*`, `baseInflationRates.*`, `baseAppreciationRates.*`, `baseInterestRates.*`, `inflationRates.*` → all `rate`.

**Step 6 — Tests** ✅
- `tests/viz/state-paths.test.mjs` — 20 tests covering `flattenStatePaths` (numeric-leaf filtering, array indexing, type resolution, edge cases) and `groupFor` (curated groups, priority order, auto fallback).
- Updated `tests/viz/chart/chart-presenter.test.mjs` — tests reflect path-based keys, default visibility rules, and new `_doRender` behavior.

---

### Increment 2 — Generalized state-panel row click + lazy backfill

Promote the metric-row sparkline + history/exec-graph modal to **every** numeric state field, with lazy per-row buffering and snapshot backfill (D1/D2/D6). No sim cost.

**Step 7 — `FieldSeriesStore`** ✅
- Created `src/visualization/state/field-series-store.js`: live buffers `Map<path,{date,value}[]>` (200-pt ring) + `backfill(path)` walks `SimulationHistory.snapshots` via `mc-param-paths.get()`, marks series `backfilled: true`. `getOrBackfill(path)` prefers live buffer. `clear()` called from `StatePanelView.clearMetricHistory()`.
- Injected into `StatePanelView` via `fieldSeriesStore` setter; `simulationHistory` setter wired in `workbench-app.js` after `buildSim()`.

**Step 8 — Generalize buffering + row wiring in `StatePanelView`** ✅
- `renderState(obj, statGrid, prefix='')` now accepts a prefix for full-path construction. Every numeric-leaf row gets `lsp-clickable-row` class + click handler → `_onFieldRowClick(path)` → `FieldSeriesStore.getOrBackfill(path)` → `_showFieldHistoryModal`.

**Step 9 — Rename modal to field-scope** ✅
- `_showMetricHistoryModal(key, history)` → `_showFieldHistoryModal(path, history, backfilled=false)`. Title now reads "Field History — {label}" + "· snapshot resolution" when backfilled. `_renderMetricsPanel` click also uses renamed method.

**Step 10 — Tests** ✅
- `tests/viz/field-series-store.test.mjs` — 16 tests: append ring-cap, backfill from snapshots (missing paths skipped, nested paths, backfilled flag), `getOrBackfill` live-vs-snapshot preference, clear.

---

### Increment 3 — Per-scenario watchlists

A watchlist is a saved `string[]` of paths on the scenario, with click-to-promote from the state panel (D3).

**Step 11 — Watchlist model + persistence** ✅
- Add `watchlists` (`{ id, name, paths: string[], perPath?: {...} }[]`) to `ScenarioSerializer.serializeScenario()` output (`scenario-serializer.js:360`), defaulting `[]`. Thread the read through `scenario-loader.js` / `scenario-registry.js` so it lands on the live scenario object. Round-trips via `ScenarioStorage` for free.

**Step 12 — Active-set source + click-to-promote** ✅
- The chart's active selection = filter selection ∪ active watchlist. On `SCENARIO_READY`, seed the chart's active set + live buffers from the scenario's watchlist; if a run already completed, one-shot `backfill` each (Increment 2).
- State-panel row gets an "add to chart / watchlist" affordance emitting a small runtime-bus event the chart subscribes to (same pattern as existing annotations / `SCENARIO_READY` — no new plumbing).
- Implemented: `_addPromoteButton` on each numeric-leaf row in `StatePanelView`; `ChartPresenter.activatePath(path, fieldStore)` + `seedWatchlist(paths, fieldStore)`; wired in `WorkbenchApp` with watchlist mutation on promote; `activeConfig.watchlists` updated so save/reload cycle persists choices.

**Step 13 — Tests** ✅
- `scenario-roundtrip`-style test: a scenario with `watchlists` survives serialize→deserialize (3 tests in `scenario-serializer.test.mjs`).
- `activatePath` / `seedWatchlist` tests: 6 new tests in `chart-presenter.test.mjs`.

---

### Increment 4 — Field-causal execution graph (optional polish)

Make the modal's exec-graph tab show only executions that **wrote the selected path**, not all events in the window (§5.5 enhancement) — strictly better than today's metric behavior.

**Step 14 — Filter exec nodes by field write** ✅
- In `_renderExecGraphPane`, intersect the date-window event walk with journal entries whose `stateDiff` touched `path` (the journal already records per-action before/after; the panel already does field-history via `_renderSparkline(change.field, …)` at line 466). Fall back to the current all-events-in-window view when no diff data is available.
- Implemented: `_subtreeTouchedPath(node, fieldPath, eg)` helper walks the execution subtree checking reducer `stateDiff`; `_renderExecGraphPane(pane, filteredHistory, fieldPath = null)` filters event nodes to those whose subtrees touched `fieldPath`; info-bar shows "filtered to N that wrote <field>" note; falls back to full set when no nodes match (no diff data available).

**Step 15 — Tests** ✅
- A field touched by exactly one reducer shows only that reducer's lineage in the pane; an untouched window shows the empty-state.
- 6 new `_subtreeTouchedPath` unit tests in `state-panel-view.test.mjs`.

---

### Increment 5 — `RECORD_METRIC` demotion (cleanup)

**Step 16 — Treat `metrics.*` as one curated group + audit** ✅
- Document that `RECORD_METRIC` is for *derived/synthetic* values only (sums, multiplicative accumulators, KPIs), not a charting prerequisite. `metrics.*` becomes one curated group (§5.3) among many.
- Audit existing `RECORD_METRIC` call sites: all current uses (earnings-handlers, expense-handlers, transfer-handlers, out-of-funds-handler) are legitimately derived income-flow accumulators or cross-account KPIs — none are redundant given design 31. No behavior changes needed.
- Updated README chart-plugin row description + added `RECORD_METRIC` coding convention note. Updated this doc's §2 to reflect the new default.
- Updated design doc status to COMPLETE.

---

## 10. Refinements (added 2026-06-07)

### 10.1 Why refine

v1 shipped working plumbing but the wrong *interaction model*. The user's verdict after using it:

1. **The Chart Metrics Filter hangs the page when you add a series.** Root cause (grounded in code, not guessed): the chart ingests the entire state firehose. `ChartPresenter._doRender()` (`chart-presenter.js:82-93`) calls `flattenStatePaths(msg.stateSnapshot)` for *every* event and forwards *every* numeric path; `ChartView.addSnapshot` (`chart-view.js:104-133`) materializes a data array in `_seriesMap` for *every* path regardless of visibility; `_doChartUpdate` (`chart-view.js:294-308`) rebuilds a series option for *every* key each frame; and the filter's `onToggle` (`chart-presenter.js:192-206`) loops `getAllKeys()` issuing one `chart.setOption` legend call *per key* on every click. Cost scales with the number of discoverable paths — i.e. with exactly the holdings/FX/regime data this feature set out to expose. The feature's success is what triggers the hang.
2. **The chart filter is redundant with the State panel.** The State panel already renders the whole state tree. Selection belongs there, inline with the values, not in a parallel multi-select that re-derives the same path list.
3. **The State section looks worse than the Metrics section.** State rows use `stat-label`/`stat-value` (`tpl-state-details`, `index.html:481-489`); Metrics rows use the better `lsp-metric-row`/`lsp-metric-label`/`lsp-metric-value` (`state-panel.css:19-45`). The `+` promote button (`lsp-promote-btn`) has *no CSS at all* — it's referenced only from JS.

**Direction (resolved with the user):** delete the chart filter; make the State panel the single selection surface; add/remove a series via a per-row checkbox (replacing `+`) and a per-section header checkbox; make both tables filterable; restyle State to match Metrics.

> ⚠️ **Load-bearing insight:** Moving selection to the State panel does **not** by itself fix the hang. As long as `_doRender` flattens and `addSnapshot` materializes the full state, promoting one series still feeds every path into `_seriesMap`. **R1 (allow-list ingestion) is the actual fix and must land first.** R2–R6 are interaction/polish on top of it.

### 10.2 New decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D8 | Chart ingestion model | **Allow-list (active set), not firehose** | The chart stores/plots **only** paths in the active set (charted ∪ watchlist). `_doRender` extracts just those via `mc-param-paths.get()`; nothing else is materialized. Bounds per-frame work to \|active\|, not \|state\|. This is the hang fix. |
| D9 | Single selection surface | **State panel only** | Remove `StateFieldMultiSelect` from the chart. Path discovery already happens in the State panel's `renderState`; the chart no longer needs to flatten state for discovery. |
| D10 | Active set = the source of truth | **Chart owns it; panel reflects it** | Per-row checkbox `checked` state is derived from the chart's active set on every re-render (the panel rebuilds each event), never from panel-local state. Add `isPathActive(path)` + `deactivatePath(path)` to `ChartPresenter`. |
| D11 | Watchlist semantics | **Active set ⇔ watchlist** | A checked row *is* a watchlisted path. Checking persists to `scenario.watchlists`; unchecking removes it. Replaces the add-only `onPromoteField` flow. |

### 10.3 Refinement increments

Status legend: `[ ]` not started · 🔶 in progress · ✅ complete. Build order is strict: **R1 → R2 → R3 → R4 → R5 → R6 → R7 → R8** (with R11 interleaved per its R11.5 note; R9/R10/R12 fold in around R3/R4). R1 is the bug fix and the architectural pivot everything else assumes.

**Progress (2026-06-07):** ✅ **R1** (allow-list / hang fix), ✅ **R2** (filter removed), ✅ **R3** (unified rows + restyle + deep-render), ✅ **R4** (per-row checkbox), ✅ **R5** (header tri-state select-all), ✅ **R6** (filterable tables), ✅ **R7.1/R7.2** (watchlist add/remove persistence + seed), ✅ **R10.2** (ring cap dropped), ✅ **R11** (stable `[id=..]` holdings paths). Tests green: **2338 unit + 653 viz**.

**Post-verification polish (2026-06-07, from user testing):**
- **Tri-state sync fix:** toggling a row or the header select-all now calls `_refreshRows()` (re-render from `_pendingState`) so child checkboxes *and* the parent tri-state immediately reflect the chart — previously the series appeared but the boxes went stale.
- **Header layout fix:** section headers dropped the conflicting `data-row-header`/`single-row` grid classes (subgrid + `grid-column:1/-1` was stacking the checkbox above the label) for a clean flex row: `[caret][tri-state checkbox][label]`.
- **Collapsible sections (new):** every object/array section folds; **collapsed by default** (`_expandedSections` Set, persisted across re-renders), click header to toggle (▶/▼). An active filter auto-expands matching sections (and omits non-matching ones). Bodies are built lazily — collapsed subtrees aren't rendered, which also trims per-event DOM work. Descendant paths for tri-state/filter come from a DOM-free `_collectLeafPaths` walk. Tests added.

**ALL increments complete (2026-06-07).** Final batch: ✅ **R12** (real `metrics.netWorth` via an injected `deriveMetrics` hook in `Simulation`, wired in `buildSim`, liquid-balance sum — runs only in non-silent UI runs so MC/backend tests are untouched), ✅ **R9** (default-seed `metrics.netWorth`, removed the interim auto-metrics, "add path by name" input), ✅ **R10.1** (coarse/backfilled series render dashed + chip marked), ✅ **R10.3** (charted paths live-buffer into the shared `FieldSeriesStore`), ✅ **R7.3** (active-series chip strip with click-to-remove), ✅ **R8.5** (perf regression guard: ingestion is O(active set), not O(state)). Tests green: **2338 unit + 660 viz**.

---

#### R1 — Allow-list chart ingestion (the hang fix) ✅ (2026-06-07)

Flip the chart from "ingest all paths" to "ingest only the active set." This alone fixes the hang and is a prerequisite for every other refinement.

- **R1.1** ✅ `ChartPresenter` owns `_activePaths: Set<string>`. `_doRender()` no longer calls `flattenStatePaths`; per drained message it reads **only** active paths from `msg.stateSnapshot` via `mc-param-paths.get()` and forwards `{path: value}`. Per-frame cost is O(\|active\|).
- **R1.2** ✅ `activatePath(path)` adds to `_activePaths` and resolves the kind via new `typeForPath()` (`state-paths.js`) — **fixes the hard-coded `'unknown'` bug** so rates bucket onto the right axis. Backfills from `FieldSeriesStore` when given.
- **R1.3** ✅ Added `deactivatePath(path)` (removes from `_activePaths` + `ChartView.removeSeries(path)` via `replaceMerge`) and `isPathActive(path)`.
- **R1.4** ✅ `resetHistory()` preserves `_activePaths`; clears only data.
- **R1.5** ✅ Discovery/grouping removed from the chart hot path. `state-paths.js` kept (now also exports `typeForPath`); `flattenStatePaths`/`groupFor` reserved for the State panel (R3/R5).
- **~~Interim default~~ (superseded by R9.0/R12):** `_doRender` no longer auto-charts metrics. The chart is allow-list-only; the default `metrics.netWorth` is seeded into the watchlist at scenario load.
- **Note:** `deactivatePath`/`isPathActive` exist but are not yet wired to UI — that lands with the R4 checkbox. The `+` promote button still drives `activatePath`.

#### R2 — Remove the Chart Metrics Filter ✅ (2026-06-07)

Landed **together with R1** — R1 alone would orphan the now-dataless filter, so removing it kept the app coherent. Selection currently flows through the State panel's existing `+` promote button until R4 adds checkboxes.

With the State panel as the selection surface (R4), the chart's multi-select is dead weight (and the hang source).

- **R2.1** ✅ Deleted `_mountFilter()`/`_metricFilter` + `StateFieldMultiSelect` import from `ChartPresenter`.
- **R2.2** ✅ Removed `ChartView.mountFilterBar()`/`_filterBarEl`, the `tpl-chart-filter-bar` template, `#chart-metric-select`, and `chart-plugin.js`'s `#chartFilterContainer`. (Active-series chip strip deferred to R7 — optional.)
- **R2.3** ✅ `ChartController` shrunk to `discoverKey`/`getAllKeys` (+ label). Dropped `getQueryApi()`, `QueryApi` import, and the `isVisible`/`setVisible`/`clearHidden` hidden-key machinery.
- **R2.4** ✅ Deleted `state-field-multi-select.js` (grep-confirmed no importers). `MapFilterMultiSelect` base class kept (used by graph-node filter + timeline). Rewrote `chart-controller.test.mjs` for the slim API; rewrote `chart-presenter.test.mjs`; trimmed `chart-view.test.mjs` filter tests + added `removeSeries` tests.

#### R3 — Unify row rendering; restyle State to match Metrics ✅ (2026-06-07)

**Done:** `_buildFieldRow` + `_buildStaticRow` produce `lsp-metric-row`s for both Metrics and State; `renderState` now recurses fully and deep-renders arrays-of-objects via `_renderObjectArray` using stable `[id=..]` paths (R3.1a/R11.3); `createStateDetails` drops the `tpl-state-details` template for a plain `lsp-state-grid` container; grid is `auto 1fr auto auto` (checkbox·label·spark·value); `stat-label`/`stat-value` retired for leaves; the unused `.lsp-promote-btn` is gone (replaced by the checkbox).


Suggestion 4. Make State rows use the Metrics look and share one builder so future row controls are added once.

- **R3.1** Extract a single `_buildFieldRow({ path, value, history })` that produces an `lsp-metric-row` with `lsp-metric-label` + `lsp-metric-value` (and inline sparkline when history ≥ 2). Both `_renderMetricsPanel` and `renderState`'s numeric-leaf branch call it.
- **R3.1a** **Deep-render array-of-object numeric leaves.** Today `renderState` collapses an array of objects (e.g. `holdings`) into one summary row per item (`item.name`/`item.value`), so `holdings.N.marketValue` is *not* selectable from the panel. To make holdings chartable from the panel, descend into array-of-object elements and emit their numeric leaves as `_buildFieldRow`s, using the **stable `id`-addressed path** from R11 (not the positional index).
- **R3.2** Keep nested-object/array **header** rows (`renderHeaderRow`) but restyle to read as section headers consistent with `lsp-metric-row` density.
- **R3.3** Retire `stat-label`/`stat-value` for numeric leaves (non-numeric/object rows can keep a plain variant). Add the missing `.lsp-promote-btn` CSS only if R4 doesn't fully replace it (it does — see R4).
- **R3.4** Grid template gains a leading control column for the R4 checkbox: `grid-template-columns: auto 1fr auto auto` (checkbox · label · sparkline · value).

#### R4 — Per-row chart toggle checkbox (replaces `+`) ✅ (2026-06-07)

**Done:** every numeric row gets `_buildChartToggle(path)` — `checked` derives from injected `isPathCharted` each render (D10); `change` → `onChartToggle(path, checked)`; click `stopPropagation` so row-click still opens history. `workbench-app.js` wires `isPathCharted`/`onChartToggle` to `activatePath`/`deactivatePath` + watchlist mutation; the old `onPromoteField`/`_addPromoteButton` are removed. (A `_deactivated` guard on `ChartPresenter` keeps the interim auto-metrics from re-adding an unchecked metric.)


Suggestions 2. A checkbox at the start of every numeric-leaf row (State **and** Metrics) toggles the series on the chart, two-way synced to the active set.

- **R4.1** In `_buildFieldRow`, prepend a checkbox. Its `checked` is read from the injected predicate `this._isPathCharted(path)` (backed by `chartPresenter.isPathActive`) on every render — the panel rebuilds each event, so checkbox state must derive from the chart, never local DOM (D10).
- **R4.2** On change: checked → `onChartAdd(path)`; unchecked → `onChartRemove(path)`. Wire both in `workbench-app.js` to `chartPresenter.activatePath` / `deactivatePath` (R1) **and** the watchlist mutation (R7). Replace the old `onPromoteField`/`_addPromoteButton`.
- **R4.3** `stopPropagation` on the checkbox so row-click still opens the field-history modal (`_onFieldRowClick`). Row-click behavior is unchanged.

#### R5 — Header "select all under this" tri-state toggle ✅ (2026-06-07)

**Done:** `renderState`/`_renderObjectArray` return their descendant numeric paths; `renderHeaderRow(label, descendantPaths)` adds `_buildSectionToggle` — tri-state (`checked`/`indeterminate` recomputed from `isPathCharted` each render), toggling calls `onChartToggle` for each descendant, with the D18 soft `window.confirm` past 25 paths. **Deviation from R5.3:** descendants are toggled per-path (not a single batched re-render); acceptable because the soft cap bounds the count and `deactivatePath` is O(1) per call. No header checkbox when `onChartToggle` is unwired.


Suggestion 3. Each section/object/array header row gets a checkbox that adds/removes every numeric path beneath it.

- **R5.1** `renderHeaderRow` gains a checkbox. Compute descendant numeric paths for the subtree (reuse `flattenStatePaths` on that sub-object with the header's path prefix).
- **R5.2** Tri-state: checked = all descendants active, unchecked = none, indeterminate = some (`checkbox.indeterminate = true`). Recompute from the active set on each render.
- **R5.3** Toggling activates/deactivates the whole descendant set in one pass (batch, then a single chart re-render — do **not** call `setOption` per path; that was the old hang pattern).
- **R5.4** Guardrail (D18): if a subtree resolves to a large count (≈ > 25 paths), show a **soft warning** but still proceed (no hard cap) — many mixed-type series degrade axis/legend readability, but charting itself is cheap.

#### R6 — Filterable State & Metrics tables ✅ (2026-06-07)

**Done:** one shared `#lsp-panel-filter` input (in `state-panel-plugin.js`, wired in `initLiveState`) → `setFilter()` stores `_filterText` and re-renders. `_matchesFilter(path)` is a case-insensitive full-path substring test applied to every leaf; sections whose entire subtree is filtered out are omitted (`_appendSection` checks for empty fragments). Display-only — never touches the active set. Filter persists across re-renders (stored on the view).


Suggestion 1. A text filter at the top of the panel narrows visible rows by path/label substring.

- **R6.1** Add a filter `<input>` to `state-panel-plugin.js` (one shared input above both sections, or one per section — default: one shared, matches on full path so `marketValue` finds nested holdings).
- **R6.2** Filtering is a show/hide pass over already-rendered rows (the whole tree renders each event), case-insensitive substring on the full path. Hide header rows whose entire subtree is filtered out.
- **R6.3** Filter is *display only* — it never changes the active set. A filtered-out but charted series stays on the chart (and stays checked when it reappears).
- **R6.4** Persist the filter string across re-renders (store on the view; reapply after each `renderState`).

#### R7 — Watchlist reconciliation + persistence 🔶 (R7.1/R7.2 done 2026-06-07)

**Done:** `onChartToggle` add/remove both mutate `scenario.watchlists` and persist to `cfg.watchlists` (R7.1); `seedWatchlist` on load populates the active set and checkbox state (R7.2). **R7.3** ✅ active-series chip strip (`#chartActiveSeries`): chips per active path with click-to-remove (`onChipRemove` → deactivate + watchlist update + `StatePanelView.refresh()`); backfilled chips dashed.


The add-only promote flow becomes add **and** remove; both must round-trip.

- **R7.1** `onChartRemove(path)` removes from `scenario.watchlists` and the active config (`cfg.watchlists`), mirroring the existing add path (`workbench-app.js:471-479`).
- **R7.2** On `SCENARIO_READY`, `seedWatchlist` populates `_activePaths` and checkbox state; verify a checked-then-unchecked path does not resurrect on reload.
- **R7.3** (Optional) the repurposed chart strip from R2.2 shows active-series chips with click-to-remove, calling the same `onChartRemove`.

#### R8 — Tests + cleanup ✅ (2026-06-07)

**Done:** R8.5 perf regression guard added (`_seriesMap`/ingestion tracks the active set, not state size); chart-presenter, chart-view, chart-controller, state-panel-view, field-series-store, mc-param-paths, base-scenario test suites updated/added throughout the refinements. 2338 unit + 660 viz green.

- **R8.1** `chart-presenter.test.mjs`: rewrite for allow-list ingestion — only active paths reach `addSnapshot`; `activatePath` resolves the correct kind; `deactivatePath` drops the series; `resetHistory` preserves the active set. Remove filter-driven tests.
- **R8.2** `state-panel-view.test.mjs`: unified `_buildFieldRow`; checkbox derives `checked` from `isPathCharted`; header tri-state (all/none/some); row filter show/hide incl. header subtree hiding.
- **R8.3** Delete `state-field-multi-select.test.mjs` if the widget is removed (R2.4).
- **R8.4** Round-trip: a path checked then unchecked does not persist in `watchlists` (R7).
- **R8.5** Perf sanity: a holdings-heavy snapshot with N≈hundreds of numeric paths and a small active set stays responsive (assert `_seriesMap.size` tracks active set, not total paths) — the regression guard for the original hang.

### 10.4 Fidelity model & pre-run selection (resolved 2026-06-07)

**Question raised:** *How do you choose to chart a field before running? And is a field not charted live during the run reduced to a coarser sample set than one that was?*

**Answer (grounded in code):** Yes — there are two fidelity tiers, and the difference is structural, not incidental:

```
   DURING THE RUN                         AFTER THE RUN
   full stateSnapshot on every            bus.history is NOT retained
   EXECUTION_END (free, ephemeral)        (workbench bus keepHistory=false)
            │                                       │
            ▼                                       ▼
   active set → ChartView._seriesMap        only source left:
   (every event, FULL resolution)          SimulationHistory.snapshots
                                            (every snapshotInterval≈12 ≈ 1/yr)
            │                                       │
            ▼                                       ▼
     ████████████ full-res series          ▌  ▌  ▌  coarse backfill (badged)
```

- **Charted/watchlisted *during* the run → full resolution** (every event), because the full state is on the bus while the sim runs.
- **Selected *after* the run → coarse**, reconstructed by `FieldSeriesStore.backfill()` from `SimulationHistory.snapshots` (default every 12 events ≈ yearly), flagged `backfilled: true` (D2). The full-res signal is *gone* post-run — the workbench bus does not keep message history (`workbench-runtime.js:22`, design 18's ~98 MB/15 yr decision), so the only recovery is re-running.

**New decisions:**

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D12 | Fidelity tiers | **Two tiers, made explicit** | Full-res = captured live (watchlist/active-during-run); coarse = post-hoc backfill. The split is inherent: full state is on the bus only *while running*. Surface it honestly (badges) rather than hide it. |
| D13 | "Chart before running" mechanism | **Watchlist = the pre-run capture list** | A watchlisted path is seeded into the active set at `SCENARIO_READY` and buffers live from event 0 → full resolution. This is the supported way to get full-res for a field: decide before you run. |
| D14 | Making the coarse tier finer | **Re-run, don't retain** (confirmed) | User confirmed re-running is cheap, so full-res stays "decide before you run" (D13). `snapshotInterval` is *not* exposed as UI for v2 — default 12 is fine for the coarse tier; R10.4 is **dropped**. |
| D15 | Default chart contents (no saved watchlist) | **Introduce a real `metrics.netWorth` and seed it** | There is *no* `netWorth` metric today — metric keys are dynamic per-account balances (`metrics[account.stateKey] = account.balance`), so a literal default would blank the chart. Add a genuine net-worth metric (Σ balances in base currency) and seed the active set with just `metrics.netWorth`. Uncrowded, meaningful, guaranteed to exist. See R12. The Metrics group is no longer auto-charted wholesale (v1 behavior); users add the rest via checkbox. |
| D16 | Holdings array-element identity | **Stable `id`-addressed paths** (handle now) | Positional `holdings.0.marketValue` follows the wrong holding after a sale shifts indices — breaks the motivating "chart the SF-Bay property value" case. Address holdings (and any array-of-objects carrying `id`) by `holdings[id=<id>].marketValue`; display label from `label`/`rateKey`. See R11. |
| D17 | State section default | **Keep collapsed** (confirmed) | Metrics drives the default chart (D15); State expands on demand for field selection. Least disruptive to current layout. |
| D18 | Select-all readability | **Soft warning beyond N, no hard block** (confirmed) | Header "select all" (R5) may activate many mixed-type series and crush axes/legend. Warn past a threshold (≈25) but always proceed; charting itself is cheap. |

**Pre-run selection requires two things to be usable:** (1) rows must exist before Run — already satisfied: the panel renders initial state at t0 via `onReset` (`workbench-app.js:516-519`); (2) a way to capture paths absent at t0 (a holding bought in year 5) — an "add path by name" entry, since the watchlist holds arbitrary strings and `get()` skips a path until it appears, then buffers it live.

---

#### R9 — Pre-run selection & "add path by name" ✅ (2026-06-07)

**Done:** R9.0 seeds `metrics.netWorth` as the default watchlist when none saved (and the interim auto-metrics was removed); R9.1 leans on the existing t0 `onReset` render; R9.2 adds the "chart a path by name" input (`#lsp-add-path`) → `onChartToggle(path, true)`, so paths absent at t0 (e.g. a holding bought mid-sim) can be armed and buffer live on first appearance. R9.3 (muted unobserved chip) folded into the chip strip — minor.

Make the watchlist usable as the pre-run capture list.

- **R9.0** **Default watchlist (D15):** when `scenario.watchlists` is empty (all existing scenarios), seed the active set with `metrics.netWorth` (created in R12) so the chart is non-empty on first run. The State section stays **collapsed** by default (D17).
- **R9.1** Lean on the existing t0 initial-state render (`onReset`) so checkboxes (R4) are operable before Run; verify it fires on scenario load, not just rewind. Paths present at t0 are checkable immediately.
- **R9.2** Add an "add path by name" input (near the panel filter, R6) that pushes a raw path string onto the watchlist/active set even when no row exists yet. On the next run it buffers live from first appearance.
- **R9.3** Visually distinguish *watchlisted-but-not-yet-observed* paths (e.g. a muted chip in the active-series strip) so the user knows a future-only path is armed.
- **R9.4** Restate watchlist semantics in one place: **checked row = watchlisted = captured at full resolution on the next run.** Unchecking removes from capture (ties to R7).

#### R10 — Fidelity transparency & controls ✅ (2026-06-07)

Make the two tiers visible and the coarse tier tunable; remove the double-buffering and the misleading cap.

- **R10.1** **Badge coarse series on the chart**, not just in the modal: post-hoc/backfilled series render with a distinct affordance (e.g. dashed line + "≈ snapshot resolution" in the legend/tooltip), and offer the existing §8 CTA "watchlist this & re-run for full resolution."
- **R10.2** ✅ **Dropped the ring cap:** removed `FieldSeriesStore`'s 200-pt `RING_BUFFER_CAP` *and* `StatePanelView._metricHistory`'s 200-cap. Per-series length is now unbounded (the *count* of active paths is the bound). Test updated to assert full retention.
- **R10.3** **Unify live buffering:** after R1, active-set full-res data lives in *both* `ChartView._seriesMap` and `FieldSeriesStore`. Make one authoritative (the chart's store is the natural home) and have the field-history modal read from it; keep `FieldSeriesStore.backfill()` solely for the post-hoc coarse path. Removes double memory + the cap divergence.
- ~~**R10.4** Expose `snapshotInterval`~~ — **dropped** (D14): re-running is cheap, so full-res stays decide-before-you-run. No `snapshotInterval` UI.

#### R11 — Stable array-element identity (holdings churn) ✅ (2026-06-07)

Make watchlisted holding paths survive index shifts when a holding is sold (D16). Generalizes to any array of objects carrying an `id`.

- **R11.1** ✅ **Path syntax:** key-addressed array segment `holdings[id=<id>].marketValue` (general form `[<key>=<value>]`). `id` is the canonical holding identity.
- **R11.2** ✅ **Getter extension:** `parsePath`/`get`/`set` in `mc-param-paths.js` resolve `[key=value]` via `arr.find(el => String(el[key]) === value)`. Additive — numeric `[N]` and dotted paths unchanged (existing MC tests still pass); matcher-as-final-segment is a `set` no-op. Tests added in `mc-param-paths.test.mjs`. *(Util left in `monte-carlo/`; relocation still optional.)*
- **R11.3** ✅ **Discovery emits stable paths:** the panel's `_renderObjectArray` (R3.1a) emits `[id=..]` paths for array elements carrying an `id`, falling back to positional index otherwise. *(Note: the standalone `flattenStatePaths` util still emits positional paths — it's no longer on the chart hot path after R1; update it when a non-panel caller needs stable paths.)*
- **R11.4** ✅ **Display label:** element section label derived from `label` ?? `rateKey` ?? `name` ?? `id`; leaf rows label from the final path segment (brackets stripped), with the full path on the row's `title`.
- **R11.5** **Ordering:** land R11.1/R11.2 (syntax + getter) together with R1 (R1's ingestion `get()` and backfill both consume these paths); R11.3/R11.4 (discovery + labels) land with R3.1a. Watchlist persistence (R7) then stores stable paths, so a sold holding no longer corrupts a saved series.

#### R12 — Real `metrics.netWorth` metric ✅ (2026-06-07)

**Done:** added an optional `deriveMetrics(state)` hook to `Simulation` (called once per event inside the non-silent `EXECUTION_END` block, before the snapshot); `BaseScenario.buildSim` wires `_deriveNetWorth` = Σ liquid (drawdown) account balances in base currency via `computeGuardrailPortfolioValue` (real property excluded). Confined to UI runs — silent/MC sims and their tests are unaffected. Unit tests added.

Add a genuine net-worth metric so the default chart (D15) has a meaningful single line, and so "net worth over time" is chartable without bespoke plumbing.

- **R12.1** **Computation:** reuse `computeGuardrailPortfolioValue(state, baseCurrency)` (`src/finance/spending/guardrail-portfolio-value.js`) as the core — it already sums account `balance`s (objects with `drawdownPriority`) converted to base currency via `effectiveExchangeRates`. **Scope decision:** for v2, net worth = liquid account balances (its current scope). *Real-property `market` value and holding `marketValue` are **excluded** for now* — note as a follow-up; broadening risks double-counting holdings already reflected in `account.balance`.
- **R12.2** **Recording:** write `state.metrics.netWorth` once per period on the same cadence as existing per-period metric/balance recording (mirror `RECORD_BALANCE`/`RECORD_METRIC` emit sites — e.g. a handler on `PERIOD_ADVANCE`). Net worth is a computed aggregate, not a single state field, so it needs a dedicated reducer (e.g. `RecordNetWorthReducer`) rather than the generic fieldPath-reading `RECORD_METRIC`.
- **R12.3** **Typing:** register `metrics.netWorth` (or rely on the existing `metrics.*` glob) in `StateSchemaRegistry` as currency so it formats and axis-buckets correctly.
- **R12.4** **Consistency with §5.7 demotion:** this is a legitimately *derived* metric (a sum), exactly the kind D7/§Increment-5 says `RECORD_METRIC`/metrics should retain. No conflict with the demotion.
- **R12.5** **Tests:** net worth equals the base-currency sum of account balances at a snapshot; reflects FX drift; appears in `state.metrics` each period; is the seeded default when no watchlist exists.

### 10.5 Cost / risk delta vs v1

- **Runtime/sim:** still zero (unchanged downstream-of-snapshot design).
- **UI memory & compute:** *strictly lower* than v1 — `_seriesMap` now holds only active series instead of every state path. R8.5 guards it.
- **Risk:** R1 changes the chart's core data path; land it behind the existing test suite first, then build the UI on a known-good base. R5's "select all" is the main new way to over-select — R5.4 caps it.
