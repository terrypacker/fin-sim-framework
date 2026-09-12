# 101 — Watchlists: named field sets that any panel can read and feed

**Status: PROPOSED (12 Sep 2026).** Discovery done against the code; decisions in §4 are
recommendations awaiting the user's confirmation, and §11 lists the questions that need an
answer before the phases they block. **W0 ✅ (12 Sep)**: the chart-by-path input is gone.
§9 (added the same day) reviews how the State panel renders values, and proposes a shared
typed renderer that the Watchlist panel builds on. **R1 ✅ (12 Sep)**: registry correctness
and the untyped-leaf gate. Untyped numeric leaves across the goldens went from 5,136 to 23
(§9.6). Text rows are hidden behind a toggle, per the user's decision (§9.5).
**W1 ✅ (12 Sep)**: `WatchlistModel` handles migration, the Overview seed, the
`metrics.<stateKey>` alias and persistence. **W2 ✅ (12 Sep)**: the model is wired in.
The chart plots the active list's charted entries, every watched path is captured at full
resolution, a State panel checkbox means "in the active list", the chip ✕ un-charts, and
there is an active-list picker, `runtime.watchlist`, and `WATCHLIST_CHANGED`. The user
confirmed the §4 decisions on 12 Sep. **R2 ✅ (12 Sep)**: `FieldFormatter` and the shared
field row are built. The chart takes its kinds, labels and tooltip values from the one
stamped registry (§9.7). **W3 ✅ (12 Sep)**: the Watchlist panel is built (§5.5).

**Builds on** `design/31-state-field-exploration.md`, which made every numeric state path
chartable, moved selection into the State panel, and gave the chart an allow-list
"active set" that it persists as `scenario.watchlists`. Design 31 did build a watchlist, but
the watchlist only exists as a background detail of the chart. This document gives it a
panel of its own, a name, more than one instance per scenario, and a contract that other
panels can use.

**Related:** `design/94-equity-as-security-positions.md` (why a Security carries no price),
`design/99-market-total-return-model.md` (one total return + yield per market),
`design/78-simulation-telemetry-cost.md` (derived metrics run in every run, MC included).

---

## 1. Purpose

Two use cases drive this:

- **UC1: values of securities and markets over time.** Show a security's value over the
  run. Where no such value exists in state, show the market it tracks instead (US equity,
  international ex-US, …).
- **UC2: a decluttered view.** Show only the state fields the user cares about, without the
  rest of the state tree.

Four parts follow from these:

1. **Building** a watchlist, using the State panel to find fields and add them.
2. A **Watchlist panel**: pick a watchlist, see its fields and their current values, and
   chart them from there.
3. **Maintenance**: create, name, rename, reorder, delete, and export, all on the Watchlist
   panel.
4. **Redefining "metric"**: `state.metrics.*` was the old "first-class, chartable" part of
   the state. Watchlists make that role unnecessary, so what remains of `metrics` needs a
   narrower, honest definition.

The watchlist has to work with any panel. Any panel that shows a state value can add it to
a watchlist, and any panel that plots or tabulates values over time can read one.

---

## 2. Where we are today (grounded)

### 2.1 The watchlist is the chart's active set

| Concern | Today |
|---|---|
| Shape | `scenario.watchlists: string[]`. The name is plural, but it holds one flat list of paths. |
| Meaning | Design 31 D11 says *checked row ⇔ watchlisted ⇔ charted*. The watchlist is literally `ChartPresenter._activePaths`. |
| Mutation | A single callback, `setCharted(path, active)`, in `workbench-app.js:819-830`. It updates the chart, `scenario.watchlists`, and `cfg.watchlists`. No other panel can reach it. |
| Default | If the list is empty, `workbench-app.js:815` seeds `['metrics.netWorth']`. As a result an empty watchlist cannot be represented. |
| Persistence | `ScenarioSerializer.serializeScenario()` always emits `watchlists` (`scenario-serializer.js:479`). The only reader is `workbench-app.js:741`. It round-trips through Download JSON, so it already "exports with the scenario". |
| Chart removal | The ✕ on a chip calls `setCharted(path, false)`, which removes the path from the watchlist as well as from the chart. |
| Cross-panel | The runtime bus (`WB_EVENTS`, `workbench-runtime.js`) has no watchlist event, and no panel other than the State panel knows watchlists exist. |

### 2.2 The State panel

`state-panel-plugin.js` renders, from top to bottom:

- a filter input (R6);
- a **"Chart a path by name"** input and a ＋ button (R9.2);
- a **Metrics** section, which is `state.metrics` split out of the tree;
- a collapsible **State** section containing the rest of the tree.

Every numeric row has a chart checkbox, and every section header has a tri-state
select-all. Clicking a row opens `_showFieldHistoryModal`, which shows a sparkline plus the
field-causal execution graph.

**The chart-by-path input** (`state-panel-plugin.js:12-16`, `state-panel-view.js:217-229`,
`assets/css/plugins/state-panel.css:107-114`) calls `onChartToggle(path, true)` with a
hand-typed path. It exists for one reason (design 31 §10.4): to arm a path that is **absent
at t0**, such as a holding bought in year 5, so that it buffers at full resolution from the
moment it first appears. No test references it.

### 2.3 Fidelity: two tiers (design 31 D12, unchanged)

A path captured *during* a run has every event. A path selected *after* a run is backfilled
from `SimulationHistory.snapshots`, roughly once a year, and is badged as coarse. The
workbench bus keeps no history, so the full-resolution signal exists only while the run is
in progress. Today only **charted** paths are captured live (`chart-presenter.js:115-120`).
A path that is watched but not charted cannot exist, because watched and charted are the
same thing.

### 2.4 UC1: market and security values are not in state

- **No market level exists anywhere in state.** `state.effectiveGrowthRates[<rateKey>]` is
  an annual *rate* per market (`EQUITY_US`, `EQUITY_AU`, `EQUITY_INTL_EX_US`,
  `EQUITY_INTL_EX_AU`, …), and `state.marketDividendYields[<rateKey>]` is the yield (D99).
  Nothing accumulates either of them into a level.
- **Growth is simple-rate per period.** `computeHoldingsGrowth`
  (`holdings-earnings.js:156`) credits `mv × rate × factor` per holding, where
  `factor = 1/12` for the monthly stream. On the taxable path, where the yield is paid
  separately, the rate is the price rate (`total − yield`). For a security it adds the
  security's overlay: `priceRate + securityReturnOverlay[securityId]`.
- **Shocks bypass the rate.** `RevalueAssetReducer` multiplies each holding's
  `marketValue` directly (a −40 % crash is a multiplier, not a rate). A market level
  reconstructed by integrating `effectiveGrowthRates` would therefore **miss every crash**.
- **A Security deliberately has no price** (design 94 §4). The registry is frozen and
  shared by reference across snapshots, and per-account rate seeding
  (`<rateKey>::<stateKey>`) means two positions in one security can legitimately carry
  different `pricePerUnit`s. `pricePerUnit` exists only on unitised positions, and only
  while they are held.

Conclusion: UC1 needs new state. §6 designs it.

### 2.5 What `state.metrics` actually contains

Measured against the 13 golden fixtures (`tests/fixtures/golden-*.json`, whole final
state):

| Kind | Written by | Keys | Honest? |
|---|---|---|---|
| **(a) Derived aggregates** | `DerivedMetricsRegistry` fns registered in `BaseScenario.buildSim` (`base-scenario.js:328-333`): `netWorth`, `netLiquidity`, `netWorthInclSpeculative`, `offsetAppliedCapacity`, `offsetIdleCapacity`, `afterTaxNetWorth`, `afterTaxNetLiquidity` | ~5–7 | **Yes.** Each is computed from many fields, exists nowhere else, and is recomputed at every event. |
| **(b) Account balance copies** | `BalanceSnapshotReducer` on `RECORD_BALANCE`: `metrics[stateKey] = <stateKey>.balance` at the moment the action fires. There are 124 emit sites. | one per account | **No: redundant and stale.** The copy refreshes only when a cash-flow action emits `RECORD_BALANCE`. Growth, shocks and rebalances move the balance without one. **29 of the 161 copies in the goldens disagree with the account's final balance.** In the worst case, `golden-au-single-homeowner`, `metrics.auStockAccount` shows about half of `auStockAccount.balance`. The State panel's Metrics section shows these copies labelled with the account's name, so they read as the balance. |
| **(c) Flow amounts** | `RECORD_METRIC` → `MetricReducer` (`reducers.js:336`): 27 call sites (`roth_earnings`, `monthly_expenses`, `dividends`, `out_of_funds`, …) | ~10–15 | **Misdescribed.** `MetricReducer` is a `FieldReducer`, so it writes the **last** amount, not a running total. Design 31 §2 and the README call these "cumulative accumulators", which they are not. `super_earnings` is recorded twice in one event (gross, then net), so only the net value survives. |

**Who reads `state.metrics`?** Almost nothing:

- The MC sampler (`mc-sampling.js`), the optimizer's `_readResult`
  (`optimization-problem.js:539`), and the scenario-compare runner all call
  `computeNetWorth` and related functions **directly on live state**.
- The readers are: the State panel's Metrics section, the chart's default seed,
  `StateSchemaRegistry` registrations (`state-schema-registry.js:166-178, 470`), two tests in
  `intl-retirement-scenario.test.mjs` (lines 332-359, asserting balance copies), one in
  `chart-view.test.mjs` (lines 319-328, using a balance copy as a currency example), and the
  goldens.

---

## 3. Conceptual model

> **A watchlist is a named, ordered list of watch entries. A watch entry is a pointer to one
> state path, plus how to show it.**

A **watch** only *points at* a value. It never creates one. A **metric** *creates* a value:
a derived aggregate that the simulation computes because it exists nowhere else in state.
The two concepts are orthogonal, and each of the two old jobs of `metrics` goes to one of
them:

| Old job of `state.metrics` | New home |
|---|---|
| "These are the fields worth looking at / charting" | **Watchlists** (any path, per scenario, user-curated) |
| "This value is computed; it is not a single field anywhere" | **Metrics**, narrowed to derived aggregates (§7) |

```
                 ┌──────────── producers: "add this path" ─────────────┐
                 │ State panel · Holdings · Securities · (Pools, …)    │
                 └──────────────────────────┬──────────────────────────┘
                                            ▼
  scenario cfg ◄── persist ──   ┌───────────────────────────┐   ── WATCHLIST_CHANGED ──►
  (watchlists,                  │  WatchlistModel           │
   activeWatchlistId)           │  lists · entries · active │
                                └─────────────┬─────────────┘
                                              │ capture set = ∪ all entry paths
                                              ▼
            sim bus EXECUTION_END ──►  WatchCapture ──► FieldSeriesStore (full-res)
                                                              │
                 ┌──────────── consumers: "read the list/series" ─────────────┐
                 │ Watchlist panel · Chart (charted entries) · History modal  │
                 │ · (later: MC Results fans, Scenario Compare)               │
                 └────────────────────────────────────────────────────────────┘
```

---

## 4. Decisions (confirmed by the user, 12 Sep 2026; W-D11 stays open as Q1)

| # | Decision | Recommendation | Rationale |
|---|---|---|---|
| **W-D1** | Watched vs charted | **Decouple.** Each entry carries `charted: boolean`. The chart plots the *charted entries of the active watchlist*. | UC2 wants fields you watch but don't plot. Today the two can't be separated (§2.1). |
| **W-D2** | What gets captured at full resolution | **The union of every entry in every watchlist**, not only charted entries and not only the active list. | Capture costs O(\|paths\|) per event and runs only in the UI (§8). Capturing all lists means switching lists or checking a box mid-run never falls back to coarse backfill. |
| **W-D3** | Number of watchlists | **Many per scenario**, plus one `activeWatchlistId`. | Part 3 (name, delete) implies more than one. Per-scenario scope is kept from design 31 D3, because paths name scenario-specific stateKeys and holding ids. |
| **W-D4** | State panel checkbox | **Means "in the active watchlist".** An entry added from the State panel is added with `charted: true`. | Keeps today's gesture ("check it, it appears on the chart") byte-for-byte, and it also appears in the Watchlist panel. Unchecking removes the entry. The tri-state header is unchanged. |
| **W-D5** | Chart chip ✕ | **Un-charts** (`charted = false`) and leaves the watchlist alone. | Removing a line from the chart should not silently delete a curated watch. Removal belongs to the Watchlist panel. |
| **W-D6** | Chart-by-path input | **Remove it** (user request). | See §5.1. The capability it served, arming future-only paths, is covered by run-then-check (D13). |
| **W-D7** | Cross-panel contract | A **`runtime.watchlist` facade** plus **`WB_EVENTS.WATCHLIST_CHANGED`**. Opening field history goes through **`WB_EVENTS.FIELD_HISTORY_OPEN {path}`**. | Plugins already receive the runtime and subscribe to its bus. `CROSS_ACTION_QUERY_OPEN` is the precedent for "any panel asks another panel to open something". |
| **W-D8** | UC1 values | **New state:** `state.marketIndex` (per market) and `state.securityIndex` (per security), both advanced by the same rate that holdings see, and both marked down by shocks (§6). | Rejected: integrating rates in the UI (misses shocks and duplicates the growth math), and picking a representative position's `pricePerUnit` (per-account, exists only while held). |
| **W-D9** | The State panel's Metrics section | **Remove it.** `metrics` renders as an ordinary branch of the tree. | Once watchlists carry the "first-class" role, the special section is exactly the clutter UC2 complains about. It also stops advertising stale balance copies. |
| **W-D10** | Balance copies (§2.5 b) | **Retire them.** `BalanceSnapshotReducer` becomes a pure no-op. `RECORD_BALANCE` keeps its other job as a pipeline-flush marker, so all 124 emit sites stay untouched. | They are redundant with `<stateKey>.balance` and wrong 18 % of the time. |
| **W-D11** | Flow amounts (§2.5 c) | **Open: see Q1.** | There's a currency subtlety that needs the user. |

---

## 5. Building and viewing watchlists

### 5.1 W0: remove "Chart a path by name" ✅ (12 Sep 2026)

Done. The input, its wiring and its CSS are removed. The State panel and chart viz suites
pass (133/133), and the running app was checked: no input, the filter still works, and no
new console errors.

- **What it is:** a text box that adds a hand-typed path to the chart and the watchlist.
- **Why it existed:** a path absent at t0 (for example a holding bought mid-run) has no row
  to check before Run.
- **Why removing it loses nothing material:** after one run the row exists, so you check it
  there, the entry persists, and the next run captures it at full resolution. That is design
  31 D13's "decide before you run", reached by running once.
- **Remove:** `state-panel-plugin.js:12-16`, `state-panel-view.js:217-229`, and
  `.lsp-add-path-row` / `.lsp-add-path` in `state-panel.css:107-114`. Delete the R9.2 comment
  at the call site. No tests change.

### 5.2 Building from the State panel

The checkbox and the tri-state header behave as they do today, with the new meaning
(W-D4): they add to or remove from the **active** watchlist. A small label above the tree
names the active list (*"Checking adds to: Net worth ▾"*) so the target of a check is never
a surprise. It is also a quick switcher.

### 5.3 The Watchlist panel (`watchlist` plugin)

Default pane: **right**, next to `state-panel`. It is built on `hostPanePlugin` /
`runtime.paneHost()`, never `getElementById`; see the 2 Sep boot-with-closed-tabs fix.
`workbench-boot-with-closed-tabs.test.mjs` then covers it automatically.

```
┌ Watchlist ──────────────────────────────────────────────┐
│ [ Markets ▾ ]  ＋New  ✎Rename  ⧉Duplicate  🗑Delete  ⇩⇧  │
├─────────────────────────────────────────────────────────┤
│ ☑ ⠿ US equity (price)      ╱╲╱‾   142.7                  │
│ ☑ ⠿ Intl ex-US (price)     ╱‾╲╱   118.3                  │
│ ☐ ⠿ Net worth             ╱╱╱‾   3.21M                  │
│ ☐ ⠿ Roth → Tech lot value  ‥‥     not in state at date  │
└─────────────────────────────────────────────────────────┘
  ☑ = charted   ⠿ = drag to reorder   click row = history
```

- **Rows** show `[chart ☑][drag ⠿][label][sparkline][current value][⋯]`. The `⋯` menu has
  *Rename label*, *Axis: auto/left/right*, *Copy path*, and *Remove*.
- **Values** update live from the sim bus by reading only the list's paths (the same
  allow-list pattern as the chart). Formatting comes from `StateSchemaRegistry` and display
  currency.
- A path **absent at the current date** renders muted ("not in state at this date"). This
  replaces design 31 R9.3's never-built "watchlisted but not yet observed" chip.
- **Row click** publishes `FIELD_HISTORY_OPEN {path}`. The State panel view, which owns
  `_showFieldHistoryModal`, handles it. Extracting the modal into a shared component is a
  follow-up, not a prerequisite.
- **Maintenance** (part 3): New (named), Rename, Duplicate, Delete (with a confirm; deleting
  the active list activates the next one), and drag reorder. Deleting the last list leaves
  zero lists. The chart is then empty, which is a legitimate state (§2.1 notes that today it
  cannot be expressed).

### 5.5 As built (W3, 12 Sep 2026)

- **`WatchlistPlugin`** (`plugins/finance/watchlist-plugin.js`, tab id `watchlist`) is
  self-contained, like `HoldingsPlugin`, not a `hostPanePlugin`. The app builds nothing
  for it. It works entirely through `runtime.watchlist` and `WATCHLIST_CHANGED`, the
  cross-panel contract, and holds no list state. Its default place is the right pane after
  State, and the Analysis and Review presets include it. The closed-tab boot sweep covers
  it automatically.
- **Values** are read from `sim.state` on each sim-bus step, coalesced to one per frame,
  so they follow the run and a scrub. They are formatted through `FieldFormatter` compact
  (`$3.21M`), with the conversion/untyped hover.
  - Rows are rebuilt only when a list changes. A step refreshes only the value and
    sparkline cells, so a drag or an open ⋯ menu survives a running simulation.
  - A path that is `null` or absent at the current date is muted and reads "not in state
    at this date".
- **Sparklines** come from `runtime.watchlist.series(path)`, the full-resolution capture
  buffer.
- **The facade grew** to serve the panel. Alongside `has`, `add`, `remove`, `active` it now
  has `lists`, `activeId`, `setActive`, `create`, `rename`, `duplicate`, `delete`,
  `setCharted`, `setLabel`, `setAxis`, `moveEntry` and `series`.
- **An entry's label and axis reach the chart.** The controller passes each charted entry
  to `ChartPresenter.applySeriesMeta`:
  - a user label replaces the context label, and clearing it restores that label;
  - `axis: 'left' | 'right'` forces the series onto that side through
    `ChartView.setSeriesAxis`. `_axisIndexFor(key)` replaces every per-series use of
    kind-only bucketing.
  - label and axis changes re-emit the series with `replaceMerge`, so a renamed legend
    entry does not linger.
  - the override survives a rewind.
- **`FIELD_HISTORY_OPEN {path}`** is published on a row click. The app routes it to
  `StatePanelView.openFieldHistory`, and the modal opens over the page whether or not the
  State tab is showing.
- **Maintenance:**
  - New and Rename use a prompt. Delete asks for confirmation, naming the field count;
    deleting the active list activates the next one, and deleting the last leaves an
    empty-state message with the list buttons disabled.
  - Drag the ⠿ handle to reorder.
  - The row's ⋯ menu offers Rename label (blank restores the automatic label), Chart axis
    (Auto/Left/Right, current value checked), Copy path, Move up/down (a keyboard-reachable
    alternative to dragging), and Remove from watchlist.
  - Lists themselves are not reordered in the UI; `moveList` exists in the model.
- **Not in W3:** export/import and the series CSV (W4), producers on other panels (W5).

### 5.4 Default for a scenario with no watchlists

Seed one list named **"Overview"** containing `metrics.netWorth` (charted). This keeps
design 31 D15's single net-worth line, and it happens **only on migration**, when the key
is absent or is a legacy empty array. Once the user deletes every list, the scenario stays
empty; it is not re-seeded.

As built (W1): a bare `watchlists: []` is ambiguous on its own, because
`serializeScenario` has always defaulted the key to `[]`. The presence of
`activeWatchlistId` (§8.1) decides it. With the key, `[]` means every list was deleted.
Without it, `[]` means a legacy scenario, which gets the seed. `fromCfg` never writes the
seed back, so an untouched scenario stays byte-identical until the user edits a list.

---

## 6. UC1: market and security index levels

### 6.1 What they are

Both indices start at **100 at `simStart`**.

| Path | Meaning |
|---|---|
| `marketIndex.<rateKey>.price` | Price-only level of the market, which is what an index chart shows |
| `marketIndex.<rateKey>.total` | Total-return level: dividends reinvested at the market yield |
| `securityIndex.<securityId>.price` | The market's price return plus that security's overlay (`securityReturnOverlay[id]`, design 94 §6.3) |
| `securityIndex.<securityId>.total` | The same, with reinvested yield |

The **per-period step mirrors `computeHoldingsGrowth` exactly**:
`level × (1 + rate × factor)`, with the same `rate` (the market's effective price or total
rate after the regime and stochastic fold) and the same `factor`. **Shocks** reach the index
through the multiplier `RevalueAssetReducer` already applies: one extra line that
multiplies `marketIndex[rateKey]` (and every security index tracking that market) when it
revalues a sleeve.

Per-account rate seeding (`<rateKey>::<stateKey>`) is **deliberately excluded**. The index
is the market, not a particular account's view of it.

**The invariant that makes this testable:** a lone β = 1 holding with no flows, in an
account on the bare market key, has `marketValue / marketValue₀ × 100 ===
marketIndex.<key>.total` at every step, and on the taxable path it equals
`marketIndex.<key>.price`. The index is thereby checked against the thing it claims to
summarise, rather than against itself.

### 6.2 Where it runs

- It must run on the **same clock as holdings growth**, so a monthly step lands on the
  monthly stream.
- It must **not** add an `EventSeries`. Adding any event re-resolves same-date ties
  elsewhere in the run and re-golds the whole repo with ordering noise (design 94 F5).
  It has to attach to an existing action. Choosing that carrier is Q2.
- It runs in **every** run, MC included, because it is state. The cost is 4 markets × 2
  levels plus 2 per registry security, one multiply each per period: negligible, but
  measured once with the existing probes rather than assumed.

### 6.3 Golden impact

The change is **additive**: every golden gains the `marketIndex` block, and the ones with a
registry also gain `securityIndex`. The regold diff must contain **only added keys**. Any
existing field that moves means the carrier perturbed ordering, and that has to be traced,
not regolded past.

### 6.4 Making UC1 one click

The **Securities panel** gets a ☆ per row that adds `securityIndex.<id>.price` to the
active watchlist. It also gets a per-market "☆ market" for each market a security tracks.
The State panel shows both blocks under the normal tree. `StateSchemaRegistry` registers
`marketIndex.*.*` and `securityIndex.*.*` with a new **`index`** value kind: 100-based and
unitless.

**Axis:** the chart has two axes today (left: everything that isn't a rate; right:
rate/percentage, `chart-view.js`). A 100-based index on a left axis beside millions of
dollars gets crushed. Recommendation: the `index` kind gets its own bucket, and the
existing per-entry `axis` override (design 31 §5.7 already sketched
`perPath: {axis}`) lets the user force it. See Q5.

---

## 7. Redefining "metric" (part 4)

> **A metric is a value the simulation computes that is not a single field anywhere else in
> state.** It lives under `state.metrics.*` and is written by a registered derived-metric
> function (`DerivedMetricsRegistry`) or by a reducer that *combines* values. Anything that
> copies or relabels an existing field is not a metric; it is a watch.

Consequences:

- **Keep:** the `DerivedMetricsRegistry` functions (§2.5 a) and the `metrics.*` namespace.
  Renaming the namespace would churn every golden and the schema registry for no user
  benefit.
- **Retire (W-D10):** the balance copies. `BalanceSnapshotReducer.reduce` returns
  `newState(state)`. Also delete:
  - the `metrics.${stateKey}` registration (`state-schema-registry.js:470`);
  - the State panel's per-account metric labelling (`state-panel-view.js:297-300`);
  - the stale `SimulationState` doc comment ("keyed metric arrays",
    `simulation-state.js:35`);
  - the README bullet on `RECORD_METRIC`, which is rewritten to this definition.

  Tests: the two `intl-retirement-scenario` assertions move to `<key>.balance`, and
  `chart-view.test.mjs` switches its currency example to a `.balance` path. The regold diff
  must be **removals of `metrics.<stateKey>` only**.
- **Migrate:** a saved watchlist entry `metrics.<stateKey>`, where `<stateKey>` names an
  account, rewrites on load to `<stateKey>.balance`. This is the same alias idea as
  `getParamAliases()`.
- **Flow amounts (§2.5 c): Q1.**
- **The Metrics section goes (W-D9).** `metrics` is just another branch of the tree, and
  "first-class" now means "on a watchlist".

---

## 8. Architecture

| Unit | Where | Responsibility |
|---|---|---|
| `WatchlistModel` | `src/visualization/watchlist/watchlist-model.js` (pure, no DOM) | Lists, entries, and active id. Operations: `add/remove/has(path)`, `setCharted`, `rename`, `reorder`, `create/duplicate/delete`, `normalize(cfg)` (legacy migration and aliases), `toCfg()`, and `onChange`. |
| Watchlist controller | `WorkbenchApp.initScenario` (replaces `setCharted`) | Builds the model from the active cfg. On change: persists to `cfg.watchlists` / `cfg.activeWatchlistId`, updates the chart's charted set, and publishes `WATCHLIST_CHANGED`. Exposes the `runtime.watchlist` facade. |
| `WatchCapture` | `src/visualization/watchlist/watch-capture.js` | Subscribes to the sim bus `EXECUTION_END(EVENT)`, reads the capture set (W-D2) via `mc-param-paths.get()`, and appends to `FieldSeriesStore`. This moves the capture loop **out of** `ChartPresenter._doRender` (`chart-presenter.js:119`), so capture no longer depends on what is charted. |
| `ChartPresenter` | existing | Its active set is fed from charted entries. `activatePath/deactivatePath` stay; the chip ✕ calls `onChipRemove`, which un-charts (W-D5). |
| `StatePanelView` | existing | Checkbox means membership (W-D4). Loses the Metrics section and the add-path input. Handles `FIELD_HISTORY_OPEN`. |
| `WatchlistPlugin` + view | `plugins/finance/watchlist-plugin.js`, `src/visualization/watchlist/watchlist-view.js` | §5.3. |

**`runtime.watchlist` facade**, the whole cross-panel contract:

```js
runtime.watchlist.has(path)                     // → boolean (active list)
runtime.watchlist.add(path, { label, charted }) // into the active list
runtime.watchlist.remove(path)
runtime.watchlist.active()                      // → { id, name, entries }
runtime.bus.subscribe(WB_EVENTS.WATCHLIST_CHANGED, ({ watchlistId, reason }) => …)
runtime.bus.publish({ type: WB_EVENTS.FIELD_HISTORY_OPEN, path })
```

A panel **produces** by calling `add` with a path it already shows. It **consumes** by
subscribing and reading `active()` plus `FieldSeriesStore`. A value a panel computes but
that is not in state, such as allocation-cube shares or security rollups, **cannot be
watched**; the path is the contract. Promoting such a value into state is a separate
decision each time.

### 8.0 As built (W2)

- **`WatchlistController`** lives in `src/visualization/watchlist/watchlist-controller.js`,
  not inline in `WorkbenchApp`, so it can be unit-tested with fakes. The app builds one per
  scenario load and destroys it in `destroyScenario`. On every model change it writes the
  cfg (loading alone never writes), calls `chart.syncActivePaths(chartedPaths)` (only the
  difference is touched), sets `capture.setPaths(capturePaths)`, refreshes the State panel
  picker and checkboxes (a coalesced `render()`), and publishes `WATCHLIST_CHANGED`
  (`reason: 'load'` after a scenario load).
- **The chart only reads `FieldSeriesStore` now.** `WatchCapture` subscribes synchronously
  to the sim bus, while the chart drains its queue a frame later. A path charted mid-run is
  therefore backfilled from the live buffer with points that are still waiting in the
  chart's queue. `ChartPresenter` remembers the last backfilled date and skips those queued
  points, so none is plotted twice.
- **With every list deleted**, checking a row creates a list called "Watchlist" instead of
  silently doing nothing. `runtime.watchlist.add` does the same.
- **Renamed** to match the new meaning: `StatePanelView.isPathCharted`/`onChartToggle` are
  now `isPathWatched`/`onWatchToggle`. The picker reads "Checking adds to [list ▾]" and
  sits above the filter's text toggle.
- **Not in W2:** `FIELD_HISTORY_OPEN` and every other maintenance gesture belong to W3.
  `runtime.watchlist` is §8's four methods.

### 8.1 Persistence shape

```jsonc
"watchlists": [
  { "id": "w1", "name": "Overview",
    "entries": [ { "path": "metrics.netWorth", "label": null, "charted": true, "axis": "auto" } ] }
],
"activeWatchlistId": "w1"
```

- **Legacy detection:** an array whose elements are strings. It becomes one list,
  "Watchlist", with every entry `charted: true`. That is exactly today's behaviour, so an
  old scenario looks identical after load.
- `activeWatchlistId` is also the **migration marker**. `WatchlistModel.toCfg()` always
  writes it, as `null` once every list is deleted. `serializeScenario` carries it only when
  the record has the key, so a scenario saved before W1 gains no key (design 93 §5a's "no
  payload gains a key" discipline). See §5.4 for why the marker is needed.
- **Alias keys** (§7): `metrics.<k>` is rewritten to `<k>.balance` when `<k>` is one of the
  cfg's accounts, a loan synthesized from one of its properties (`loanKeyForProperty`), or
  an inherited bequest account. The goldens carry balance copies for all three. A rewrite
  that duplicates an existing entry is dropped, and the first entry is kept.
- **Why nested and not flat tables joined by id:** the flat-table rule
  (`structured-editors-not-json-textarea`) exists for `row-list-editor` param editors. This
  is a dedicated panel with its own editor, not a param.
- **Export** comes in three forms:
  1. **With the scenario:** automatic, because `serializeScenario` already carries the key.
  2. **Watchlist definition JSON:** export or import one or all lists between scenarios.
     Import reports paths that don't resolve in the target scenario's current state
     (different stateKeys or holding ids) and keeps them muted rather than dropping them.
  3. **Series CSV:** the active list's captured series, one column per entry, with a column
     marking resolution (full-res or snapshot). This is the "values over time" half of UC1.
- **Known behaviour to preserve, not fix here:** edits on a **prebuilt** scenario (`p:<N>`)
  are not persisted until the user saves it as a user scenario. Today's single watchlist
  behaves the same way. On a user scenario, edits reach storage on the next save of any
  kind (`_persistUserScenarios` persists live records by reference).

### 8.2 Cost

- **Simulation:** unchanged except for the §6 index (a handful of multiplies per period).
- **UI capture:** O(\|capture set\|) `get()` calls per event, UI runs only. MC workers never
  construct a `WatchCapture`.
- **Memory:** one unbounded series per watched path (design 31 R10.2), bounded by the number
  of entries. Watchlists hold tens of paths, not thousands.
- **Header select-all:** keep the soft warning past ~25 paths (design 31 D18). It now guards
  capture size as well as chart legibility.

---

## 9. Rendering state values

A watchlist panel is only as good as the value it prints next to each path. It prints
whatever the State panel prints, so this section reviews that output first.

### 9.1 What the panel renders today

Two measurements were taken. The first was the running app on a real scenario at mid-run,
with every section expanded via the filter. Only proportions are quoted here, because the
scenario is private. The second was offline, against the committed goldens, with
`StateSchemaRegistry` directly.

- About **86 %** of numeric rows render as a bare `1,234.56`.
- **Under 7 %** carry a currency symbol, and nearly all of those are in the Metrics
  section.
- About a hundred rows are **epoch-millisecond timestamps printed as numbers**
  (`2,524,608,000,000.00`), each with a chart checkbox.
- Every annual rate prints as a raw decimal (`0.0715`).
- Non-numeric rows (ids, symbols, rate keys, names) outnumber numeric rows by more than 2:1.

Reproduction, using a registry with one USD account registered:

| Path | Resolved kind | Rendered |
|---|---|---|
| `usStockAccount.holdings.0.marketValue` | currency USD | `$123,456.79` |
| `usStockAccount.holdings[id=h1].marketValue` | **unknown** | `123,456.79` |
| `usStockAccount.holdings[id=h1].dividendYield` (0.0715) | **unknown** | `0.07` |
| `effectiveGrowthRates.EQUITY_US` (0.0715) | rate | `0.0715` |
| `effectiveExchangeRates.USD_AUD` (0.0715) | rate | `0.0715` (same kind as a growth rate) |
| `metrics.roth_earnings` | metric | `123,457` (money with no symbol) |
| `currentPeriods.US.startMs` | **unknown** | `2,524,608,000,000.00` |

### 9.2 Defects, each with its cause

| # | Defect | Cause | Fix |
|---|---|---|---|
| **R-1** | **No holding field is typed.** Market value, cost basis, yield, coupon and purchase date all render bare. They are not converted to the display currency, so the USD/AUD toggle does nothing for lots. A 4-dp yield is truncated to 2 dp. The chart puts the series on the wrong axis. | Design 31 R11 addresses lots as `holdings[id=h1]`. `_globToRegex` maps `*` to `[^.]+`, so `holdings[id=h1]` is **one** segment and never matches `*.holdings.*.marketValue`. That includes the per-account `registerPatternFront` stamps. | In `resolve()`, canonicalise `seg[key=val]` to `seg.val` before the glob test. That is one line, and every existing glob then applies. Add a test per `holdings.*` glob using a bracketed path. |
| **R-2** | Annual rates print as decimals. | `rate` formats with 3–6 decimals, and `rate` also covers **FX multipliers** (`baseExchangeRates`, `effectiveExchangeRates`, `fxAnchorRates`). Those must not become percentages. | Split the kind: `rate` becomes an annual rate shown as `7.15%`, and a new `fxRate` shows a multiplier as `1.5500`. The only other consumer of the kind is the chart's axis bucketing (`chart-view.js:242, 367`), whose right-axis formatter also becomes percent-aware. |
| **R-3** | Timestamps print as numbers and can be charted. | `*Ms` fields and `acquisitionDateByCountry.*` hold epoch ms, and `date` formats only `Date` instances. | Add a `dateMs` kind, formatted through the panel's timezone-aware `formatDate` (never raw `Date` methods). It renders as a static row with no chart checkbox. |
| **R-4** | Flow metrics are money but print as rounded integers. | They match the `metrics.*` glob, which uses the `metric` kind (integer, no symbol). | Folds into M3/Q1. In the meantime, type the known money flows by currency. |
| **R-5** | Ordinals and counts look like money: priority `8.00`, coupon frequency `2.00`, tenor, minimum age, units, beta. | Unregistered, so they fall back to 2 dp. | Register the recurring ones: `integer` for `drawdownPriority`, `couponFrequency` and `tenor`; `decimal(4)` for `units`; the account's currency for `pricePerUnit`; `decimal(2)` for `beta` and `idioVol`. |
| **R-6** | Year-keyed series (`bracketIndexAccumulatorByYear.US.2044`, `auSuperCapsByPerson.*.unusedByFy.*`) are untyped. | They are registered as an exact path on the **parent**, which never matches the children. | Register the `**` globs the matcher already supports. |
| **R-7** | Labels: `toLabel('AU')` renders as "A U" (it splits every capital). Leaf labels repeat ("Market Value" once per lot), which works inside the tree but means nothing in a flat watchlist or chart legend. | The camel splitter doesn't treat runs of capitals as acronyms, and `_pathLabel` resolves only one level of owner. | Keep acronym runs together. Add `contextLabel(path)` = owner record name · holding label/security symbol · field, for watchlist rows, chips and legends. |
| **R-8** | Account names can double their country prefix ("AU AU Savings"). | `_baseLabel` prepends `country` even when the name already starts with it. | Skip the prefix when the name already starts with `${country} `. |
| **R-9** | The chart resolves a series' kind from a **different registry** than the one it converts currency with (`chart-view.js:281-284` notes this). | `typeForPath` uses `state-paths.js`'s module-default registry, which has no per-account stamps. | Pass the injected, stamped registry to `typeForPath`, so the whole app has one registry. |

### 9.3 What must survive (the good parts of the Metrics section)

The Metrics section is the best-rendered part of the panel today, and W-D9 removes it. None
of its behaviour may go with it. Each of the following moves into the shared renderer:

- **Currency formatting with display-currency conversion** (`StateSchemaRegistry.format`,
  design 10 §Phase 4), which reformats live on `DISPLAY_SETTINGS_CHANGED`.
- **Record names instead of stateKeys** (design 70 `displayNameFor`), with the raw path on
  hover.
- **The inline sparkline**, with its trend colour and last-point dot. Once this is in the
  shared renderer, *every* captured row in the State tree gets it, not only metrics.
- **Row click → field history**, the chart/watch checkbox, and the tri-state header.

### 9.4 Proposal: one typed field renderer

Add a `FieldFormatter` (`src/visualization/state/field-format.js`). It becomes the **single**
formatting entry point for the State panel, the Watchlist panel, the chart's chips, axis and
tooltip, and the history modal. It is built on `StateSchemaRegistry.resolve` (after R-1)
plus the display settings, and it absorbs `_fmtChange`/`fmtVal`, which already carry a
`TODO Extract to shared UI class #139`.

```js
describe(path)                      // → { kind, currencyCode, label, contextLabel, chartable }
format(path, value, { state, compact })  // → string
```

| Kind | Example path | Today | Proposed |
|---|---|---|---|
| currency | `*.balance` | `$1,234.56` (when coded) | Unchanged. `compact` gives `$1.23M` / `A$450k` via `money-format.js`'s `fmtCompact` for dense rows and the watchlist. |
| rate | `effectiveGrowthRates.EQUITY_US` | `0.0715` | `7.15%` |
| fxRate *(new)* | `effectiveExchangeRates.USD_AUD` | `1.550` | `1.5500`, with the pair ("AUD per USD") on hover |
| percentage | `auCgtEffectiveRate` | `12.34%` | Unchanged |
| index *(new, §6)* | `marketIndex.EQUITY_US.price` | — | `142.7` |
| date *(now also epoch ms)* | `currentPeriods.US.startMs` | `2,524,608,000,000.00` | A display-timezone date. Not chartable. R1 built this by letting the existing `date` kind take ms, not by adding a `dateMs` kind. `people.*.residencySinceMs` was already typed `date`. |
| year *(new)* | `*.maturityYear` | `2,045.00` | `2045`. Not chartable. |
| integer | `*.drawdownPriority` | `8.00` | `8` |
| unknown | — | `1,234.56` | Unchanged, plus a subtle "untyped" marker (dotted underline; hover says "no schema entry"), so gaps are visible rather than silently plausible. |

Also: when a value was converted, hovering it shows the native amount and the rate used,
e.g. `A$1,234 native @ 1.5387`. The conversion is currently invisible.

**Guard, following the golden-coverage-gate pattern:** a test runs each golden's final state
through `describe()` and fails on any numeric leaf of kind `unknown` that is not on an
explicit allow-list. The README convention "register the `ValueType` when you add a state
field" then becomes enforced, instead of being discovered in the UI months later.

### 9.5 Non-numeric rows: hidden, but never out of reach (decided 12 Sep, built in R1)

**Decision (user):** hide non-numeric rows, since they can't be charted and don't change.
They must stay reachable, though, because they show what the state is *now*. Don't hide
them blindly.

**Measured before building.** Each of two goldens was stepped a year at a time, and the
non-numeric leaves were compared across the snapshots:

| Golden | Non-numeric paths | Value changed | Only appear/disappear (lots bought/sold) | Constant |
|---|---|---|---|---|
| `cross-border-reference` | 514 | 8 | 107 | 399 |
| `au-single-homeowner` | 180 | 4 | 17 | 159 |

The changing ones are exactly the "now" values the user meant: `people.*.residency` and the
current tax period (`currentPeriods.*.name` / `.id`). The only other change was one lot's
`allocation` and `taxExemption`. The premise holds for everything else.

**The rule** (`StatePanelView._leafVisible`):

- Chartable numbers always render.
- A static leaf (text, flag, date, year) renders when **any** of these is true:
  1. the **"Show text fields"** toggle under the filter is on (off by default, in memory);
  2. the **filter** matches its path, so typing `symbol` finds every symbol;
  3. the registry marks it as **status** (`ParameterValueType.status`): `boolean` fields,
     `people.*.residency`, `people.*.residencyState`, `currentPeriods.*.name`.
- A section renders only when some descendant would render, so a `currency: {code}` object
  no longer leaves an empty header. With the toggle on, every section shows.
- Identity stays visible without the rows: array items were already headed by
  `label ?? rateKey ?? name ?? id`, and an object with a `symbol` (a `securities` entry) is
  now headed "SWTSX · Schwab Total Stock Market". The registry was already a collapsed
  section.

Before this, the filter searched numeric paths only, so a text leaf could never be found
through it. Section visibility now walks every leaf.

### 9.6 R1 as built (12 Sep 2026)

**Result:** untyped numeric leaves across the 13 goldens dropped from **5,136 in 215 shapes**
to **23 in 7 shapes**. The count uses the stamped registry and the panel's `[id=…]` paths.

- **R-1:** `resolve()` rewrites `seg[key=val]` to `seg.val` before matching. One correction
  to §9.2: `costBaseByCountry.<CC>` is in the **account's** currency, not the country's.
  `AccountService.recordResidencyChange` stamps it from the lot's `marketValue`. It is
  stamped per account and per asset.
- **R-2:** the new `fxRate` kind covers `baseExchangeRates`, `effectiveExchangeRates`,
  `fxAnchorRates`, `*.fxBasisRate` and `*.bookingFxRate`. `rate` now renders as `7.15%`. On
  the chart, `fxRate` stays on the right axis. That axis, and the tooltip, show percent only
  when every right-axis series is a rate or percentage.
- **R-3 / R-5 / R-6 / R-8** as in §9.2. Two new kinds, `date` (ms) and `year`, are not
  chartable (`StateSchemaRegistry.isChartable`). Their rows are static and outside the
  header select-all.
- **R-7:** only the acronym fix, as a shared `toLabel` in `state-paths.js`. `contextLabel`
  stays in R2.
- **Also typed:** position fields (units, unit price, face, par, coupon frequency, roll
  term), account/asset settings, the property repair and running-cost model, yield-curve
  points, return deviations and overlays, active-regime fields, the security registry, the
  US payroll/§988/401(k) accumulators, and plan scalars.
  `registerMirrorPrefix('usPendingReturn.')` types the held-open return as the top-level
  YTD fields it copies.
- **Gate:** `tests/unit/state-schema-coverage.test.mjs` loads each golden's cfg without
  running it (about 0.2 s in total) and resolves every numeric leaf of the fixture. Any
  `unknown` leaf outside `ALLOWED_UNKNOWN` fails, and so does any allow-list row that no
  longer matches.

**Left on the allow-list, as follow-ups:**

1. **Loan records are never stamped.** `<prop>Loan` accounts come from the property
   toolsets and are not in `accountService`, so `ScenarioLoader._registerDisplayCurrencies`
   skips them. `monthlyPayment` is untyped, and `balance` falls to the code-less
   `*.balance` glob, so **the display-currency toggle does not convert a loan balance**.
2. **Wash-sale loss amounts** (`washPendingLosses.*.{long,short}Loss`,
   `washSaleLedger.*.{deferred,disallowedLong,disallowedShort}`): `wash-sale.js` doesn't
   pin their currency, so they stay untyped until someone confirms it.

### 9.7 R2 as built (12 Sep 2026)

- **`FieldFormatter`** (`src/visualization/state/field-format.js`) is built over the one
  stamped registry and provides:
  - `describe(path)`: `{ kind, currencyCode, label, contextLabel, chartable, typed }`;
  - `format(path, value, { state, compact })`;
  - `valueTitle(path, value)`, the hover for a value;
  - `contextLabel(path)`.

  It declines objects and arrays (it returns null), so the view's own object renderer
  handles them. This also removes a latent R1 regression. `auSuperCapsByPerson.**`
  matches the record objects as well as their leaves, so an action-detail diff of a whole
  caps record would have printed as "[object Object]".
- **`contextLabel`** (R-7) joins the owning record's name, the holding, and the field.
  The holding shows its `label`, else its security's symbol or name, else its id.
  - `metrics.<stateKey>` reads as the account.
  - Other metrics read as their own name.
  - A path with no owner lists every segment.

  The history modal title uses it too, so the separator there is now "·" where it was
  "—".
- **Hover and the untyped marker.**
  - A converted amount's hover shows the native amount and the rate, e.g.
    `A$1,000.00 native @ 0.6500 AUD→USD`.
  - A number with no schema entry gets a dotted underline, and its hover says it is a
    guess.
  - Compact money renders as `$3.21M` or `A$450k`. It is ready for W3; the State panel
    keeps the full form.
- **Shared row** (`src/visualization/state/field-row.js`) has `buildFieldRow`,
  `buildStaticRow` and `renderSparkline`.
  - Every captured row now draws a sparkline from its full-resolution buffer, not only
    the Metrics section (§9.3).
  - The sparkline is sampled down to 64 points, so a buffer of thousands of events stays
    cheap to redraw each frame.
  - `StatePanelView._fmtChange` and `_pathLabel` go through the formatter. `fmtVal`
    remains only for what the formatter declines.
- **Chart (R-9).** `ChartPresenter` takes each series' kind (its axis) and label from the
  formatter instead of `state-paths`' unstamped module registry. A balance copy used to
  resolve to `metric` there; it now resolves to money.
  - Labels are fixed when a series is charted, because the legend keys its on/off state
    by name. Equal labels get "(2)" appended.
  - Chips and the legend show the context label.
  - The tooltip formats money in the currency the series is plotted in, and everything
    else through the formatter.
- **A bug found and fixed.** `ChartView.resetHistory` clears the series kinds, and the
  presenter never restored them, so a rate series replayed on the money axis after a
  rewind. The presenter now re-applies kind and label for the surviving selection.
- **Left alone:** the chart's axis formatters. They already key off the kinds, which are
  now correct.

---

## 10. Phasing

Status legend: `[ ]` not started · 🔶 in progress · ✅ complete.

| Phase | Scope | Depends | Golden impact |
|---|---|---|---|
| **W0** ✅ | Remove chart-by-path (§5.1) | — | none |
| **R1** ✅ | Registry correctness (§9.2 R-1, R-2 split, R-3, R-5, R-6, R-8), the `toLabel` acronym fix, the untyped-leaf coverage gate (§9.6), and hidden text rows (§9.5). Display only. | — | none |
| **R2** ✅ | `FieldFormatter` + a shared row renderer (sparkline included) used by the State panel. The chart's axis, tooltip and chips go through `describe()`, with one registry (R-9). `contextLabel`. See §9.7. | R1 | none |
| **W1** ✅ | `WatchlistModel` (`src/visualization/watchlist/watchlist-model.js`) + legacy migration + `metrics.<stateKey>` alias + persistence (`activeWatchlistId` marker in `serializeScenario`) + default seed (§5.4, §8.1). Unit tests: `watchlist-model.test.mjs` (migration, round-trip, delete-last, alias, normalization, events) plus serializer cases. Not wired into the app; W2 wires it. | — | none |
| **W2** ✅ | `WatchCapture`, the chart fed from charted entries, chip ✕ un-charts, State checkbox = membership, active-list label/switcher, `runtime.watchlist` + `WATCHLIST_CHANGED`. Built as §8.2. | W1 | none |
| **W3** ✅ | Watchlist panel: picker, CRUD, rows, live values, sparklines, reorder, label edit, axis override, muted-absent rows, `FIELD_HISTORY_OPEN`. Browser-verified. See §5.5. | W2 | none |
| **M1** `[ ]` | `marketIndex` / `securityIndex` (§6): carrier (Q2), step, shock hook, schema kind, the holding-tracks-index invariant test, cost probe. | — (parallel to W) | **additive only** |
| **W4** `[ ]` | Export/import definition JSON + series CSV (§8.1). | W3 | none |
| **W5** `[ ]` | Producers: Securities ☆ (security + market index), Holdings ☆ (`<stateKey>.holdings[id=…].marketValue`, `pricePerUnit`). | W2, M1 | none |
| **M2** `[ ]` | Metrics cleanup: `BalanceSnapshotReducer` no-op, drop Metrics section, schema/labels/docs, tests (§7). | W1 (alias), W3 | **removals of `metrics.<stateKey>` only** |
| **M3** `[ ]` | Flow amounts, per the Q1 answer. | Q1 | depends on Q1 |
| **Later** | MC Results: the sampler records watched paths at year-boundary cadence and renders fans per entry (`mc-sampling.js` already records a point per year). Scenario Compare: watched paths side by side. | W2 | none |

Build order: **W0 ✅ → R1 ✅ → W1 ✅ → W2 ✅ → R2 ✅ → W3 ✅**, with **M1** alongside. Then **W4 / W5**,
then **M2**, then **M3**. R1 comes next because it is independent, display-only, and fixes
live defects (R-1 affects every lot today). R2 has to land before W3, because the Watchlist
panel renders through it.

---

## 11. Open questions

1. **Q1: What happens to the `RECORD_METRIC` flow amounts?** They record the *last* amount,
   not a total (§2.5 c). Options:
   - **(a) Make them true running totals** (a sum reducer), so "lifetime Roth earnings" or
     "lifetime dividends" become real derived metrics under §7's definition. **Catch:**
     `monthly_expenses` records a *native* amount, so a total across a residency move would
     add USD to AUD. The keys whose currency can change need a per-currency suffix or
     retirement. This needs a per-key audit.
   - **(b) Retire them.** The journal already records every flow as an action with its
     amount, and the Timeline and Journal Report surface them. This drops 27 emit sites and
     the actions, changes journals, and touches the golden coverage manifest.
   - **(c) Keep them as-is** and document them honestly as "last recorded amount".

   *Leaning (a) with the currency audit.* It is what the name has always promised, and it
   matches "a reducer that puts a value into state".
2. **Q2: Which action carries the market-index step?** It must be an existing action on the
   monthly growth clock, with no new `EventSeries` (§6.2). Resolve with a probe that shows
   the regold is additive-only before committing.
3. **Q3: Capture every list, or only the active list?** **Answered (12 Sep): every list
   (W-D2).** Revisit only if a user builds watchlists with hundreds of paths.
4. **Q4: Should the State checkbox mean "in the active watchlist"?** **Answered (12 Sep):
   yes (W-D4).**
5. **Q5: Index axis handling.** Should the `index` kind get a third axis bucket, or the
   right axis shared with rates, or should the chart gain a "rebase to 100 / % change"
   mode? Recommended: its own bucket, plus the per-entry override.
6. **Q6: Should watchlists be per-user as well?** Out of scope, as in design 31 D3. Paths
   are scenario-specific, and cross-scenario reuse goes through export/import (W4).
