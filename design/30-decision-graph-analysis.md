# 30 — Decision-Graph Analysis & Scenario Comparison

**Status**: Complete (Phases A, B, B.5, C)
**Supersedes**: `design/3-branching-event-streams.md` (the user-driven scenario-fork piece), `design/4-branch-diff-insight-engine.md` (the diff/insight piece — comparison view absorbed here; insight engine deferred), `design/5-branch-merge-reconciliation.md` (deprecated outright).
**Related**: `design/17-scenario-as-graph-node.md` (the substrate this builds on — scenarios are already `SimGraphNode`s with `DERIVES_FROM` parent edges), `design/21-financial-shock-and-regime-framework.md` (regime composition), `design/24-financial-modeling-roadmap.md` (designs 25–29 may produce decision points worth exposing here), the user's "Branching Decision Graphs / Superposition" proposal (the conceptual seed for §3).

**Author note**: This is a single design covering two layers that share the same user-facing surface but operate at different scales:
1. **Scenario comparison** — a low-cost UI for "show me scenario A vs scenario B side by side." Uses substrate already implemented in design 17. Small.
2. **Decision-graph analysis** — engine-driven combinatorial exploration of discrete strategic choices, coupled with the existing Monte Carlo runner. New. Larger.

These two are bundled because the *comparison UI* they need is the same: side-by-side state-panel, journal overlay, summary KPIs. Decision-graph leaves are compared the same way two user-saved scenarios are compared.

---

## 1. Purpose

The framework today supports three tiers of "many futures":

| Tier | Mechanism | What it varies |
|---|---|---|
| 1. Deterministic single run | `Simulation.stepTo(simEnd)` | Nothing — exactly one timeline |
| 2. Monte Carlo | `IntlRetirementMcRunner` | Exogenous uncertainty (returns, inflation, FX, mortality once design 27 lands, shock severity once design 21 ships) |
| 3. Optimization | `IntlRetirementOptimizer` | A single numeric parameter against an objective |

What's missing is a **fourth tier**:

| Tier | Mechanism | What it varies |
|---|---|---|
| 4. Decision-graph analysis | (this design) | **Endogenous discrete choices** — SS at 62 / 67 / 70; retire at 60 / 62 / 65; conservative / moderate / aggressive withdrawal; move-to-AU at 65 / 70 / never — combinatorially, each leaf running under MC |

The distinction matters: MC asks "what if the world unfolds differently?"; decision-graph analysis asks "what if I made a different *choice*?" Today the only way to answer the second is to manually clone a scenario, change a parameter, run it, and eyeball the difference. This design makes the discrete-choice exploration first-class and gives the user a coherent way to look at the results.

Alongside that, the same comparison surface — side-by-side state + journal overlay — works for two user-saved scenarios. So a small "scenario comparison" UI rides along.

---

## 2. Where We Are Today

| Concern | Today |
|---|---|
| Saved scenarios | `ScenarioRegistry` (graph-backed per design 17). Each scenario is a `SimGraphNode` with `kind: 'scenario'`, `layer: 'scenario'`, optional `DERIVES_FROM` parent edge. Persists across `ServiceRegistry.reset()`. |
| Parameter sweeps over a numeric param | `IntlRetirementOptimizer` |
| Parameter sweeps with distributions | `IntlRetirementMcRunner` (per-param distribution; runs N independent simulations; `summarize()` → mean / p10 / p50 / p90 / success rate) |
| Comparing two scenarios | None. User clicks between saved scenarios in the dropdown. |
| Modeling a discrete decision (e.g. SS claim age) | Numeric parameter sweep via the optimizer; no semantics of "this is a choice between a small set of named alternatives." |
| Aggregating outcomes across decisions | None. |

Design 17 already gives us the *storage substrate*: a scenario is a graph node with a parent. What's missing is (a) a side-by-side UI for comparing two of them, and (b) an analysis layer that generates a fan-out of them around explicit decision points and aggregates results.

---

## 3. Conceptual Model

Borrows the framing from the user's "Branching Decision Graphs" proposal: explicitly enumerate the decisions; sample the uncertainty. The two are orthogonal:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Decision-Graph Analysis                           │
│                                                                         │
│   DecisionGraph                                                         │
│   ├── DecisionPoint: "SS claim age"  options: [62, 67, 70]              │
│   ├── DecisionPoint: "Retire age"    options: [60, 62, 65]              │
│   └── DecisionPoint: "Move to AU"    options: [65, 70, never]           │
│                                                                         │
│   Cartesian product: 3 × 3 × 3 = 27 leaves                              │
│                                                                         │
│   Each leaf:                                                            │
│     - is a derived scenario (DERIVES_FROM the base)                     │
│     - has the chosen options applied as parameter overrides             │
│     - runs through:                                                     │
│        ┌─────────────────────────────────────────────────────────┐      │
│        │  Tier 2: MC over exogenous uncertainty (N draws)        │      │
│        │  each draw = Tier 1: deterministic single run           │      │
│        └─────────────────────────────────────────────────────────┘      │
│                                                                         │
│   Aggregation:                                                          │
│     per leaf:  p10 / p50 / p90 / success rate                           │
│     across leaves:  rank by chosen objective                            │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key claim**: the decision graph is **analysis-time only**. The scenarios themselves stay single-track — no decision-graph metadata baked into the scenario node. When the user triggers a decision-graph analysis, the runner reads the analysis configuration, expands the cartesian product, and produces leaves. When the analysis is done, the leaves are queryable; whether they're kept around or discarded is a configuration choice.

This keeps Tier 1 (single run), Tier 2 (MC), Tier 3 (optimization), and Tier 4 (decision-graph) clearly tiered. The scenario data model is unchanged.

---

## 4. Decision-Graph Analysis

### 4.1 `DecisionGraph` and `DecisionPoint`

```js
class DecisionPoint {
  id;           // e.g. 'ssClaimAge'
  label;        // e.g. 'Social Security claim age'
  paramKey;     // scenario param this binds to (e.g. 'primarySsClaimAge')
  options;      // [{ value, label }] — discrete alternatives
  weights;      // optional per-option probability weights (default uniform)
}

class DecisionGraph {
  id;
  baseScenarioId;     // graph node id of the base scenario
  decisionPoints;     // DecisionPoint[]
  objective;          // 'finalBalance' | 'cumulativeDeficit' | 'successRate' | etc.
  mcDrawsPerLeaf;     // default 1000
  mcSeed;             // base seed; per-leaf seed = mcSeed + leaf-index
}
```

A `DecisionGraph` has its own service-registered home — `DecisionGraphRegistry`, mirroring `ScenarioRegistry` but `layer: 'analysis'`. It is serialized into local storage so the user's named analyses survive reloads.

### 4.2 Leaf expansion

```
expandLeaves(DecisionGraph): DerivedScenario[]
```

For each combination in the cartesian product of `decisionPoints[i].options`:

1. **Materialize a derived scenario** — a new `BaseScenario` instance whose params are the base scenario's params with the chosen-options overrides applied. This reuses design 17's `instantiate(params, simStart, simEnd)` path.
2. **Attach a `DERIVES_FROM` edge** to the base scenario, with edge metadata recording the analysis-id and the leaf's option vector (`{ ssClaimAge: 67, retireAge: 62, moveToAu: 70 }`).
3. **Tag the leaf** with `kind: 'scenario'`, `layer: 'analysis-leaf'` so it's separable from user-saved scenarios in the graph.

Leaves are cleared by `graph.clearLayer('analysis-leaf')` between analyses (the existing layer-scoped reset from design 17 §3.8). Persisting leaves across reloads is opt-in (off by default — 1000-leaf analyses bloat local storage).

### 4.3 Per-leaf execution

Each leaf runs through the existing MC runner with one modification: the per-draw simulation is seeded as `mcSeed + leafIndex × mcDrawsPerLeaf + drawIndex` so leaves are reproducible independently.

Output per leaf: the same shape as `IntlRetirementMcRunner.summarize()` — `{ mean, p10, p50, p90, successRate, deficitDistribution }`.

### 4.4 Aggregation

Per the proposal's "path integral interpretation," outcomes can be aggregated across leaves two ways:

| Mode | Formula |
|---|---|
| **Ranked** (default) | Sort leaves by objective; report ordered list with per-leaf summaries. The user sees "leaf #7 (SS@67, retire@65, move-to-AU@65) is best for objective X." |
| **Weighted expectation** | If `weights` are set on each `DecisionPoint`, compute `E[outcome] = Σ Π(w_i) × leafOutcome`. Useful when the user thinks of decisions as choices with probability priors (e.g. 50% chance they actually retire at 62, 50% at 65). |

Both modes are supported; the runner produces a single `DecisionGraphResult` containing both.

### 4.5 Pruning

The state-explosion concern from the proposal is real but bounded by construction in this design: decision points are user-declared, count of leaves is `Π options.length`, and the practical ceiling is in the dozens of leaves, not thousands. If a user declares a graph with > 100 leaves, the runner emits a warning; > 1000 is rejected unless the user explicitly opts in. No automatic merging or bucketing in v1 — leaves remain distinct.

### 4.6 Runner

`DecisionGraphRunner` lives at `src/finance/decision-graph/decision-graph-runner.js`, structured like `IntlRetirementMcRunner`:

```js
class DecisionGraphRunner {
  constructor({ scenarioFactory, mcRunner }) { ... }
  run(decisionGraph, onProgress)  { ... }   // returns DecisionGraphResult
  summarize(result, mode)         { ... }   // returns ranked or weighted view
}
```

Internally it calls the existing MC runner per leaf, sharing infrastructure rather than reinventing it.

---

## 5. Scenario Comparison

### 5.1 Two consumers, one UI

The comparison view answers "show me A vs B" — where A and B can be:

- Two user-saved scenarios (from `ScenarioRegistry`).
- Two leaves of a `DecisionGraph` (from `DecisionGraphRegistry`).
- A user-saved scenario and a leaf.

The comparison UI doesn't care which; it operates on two graph-node IDs.

### 5.2 What the view shows

A new workbench plugin: `scenario-compare`. Layout:

```
┌──────────── Scenario Compare ──────────────────────────────────────┐
│ [A: International Retirement (saved)]   vs   [B: leaf SS@67/R@65]  │
│                                                                    │
│ Summary KPIs (side-by-side):                                       │
│   Final balance  $1.92M   $2.14M    Δ +$220k                       │
│   Success rate    87.3%    92.1%    Δ +4.8pp                       │
│   p10 deficit   -$340k   -$180k    Δ +$160k                        │
│                                                                    │
│ ┌─────────────────────────────────────────────────────────────┐    │
│ │  State Panel (overlaid; per-field diff)                     │    │
│ │  ─ rothAccount.balance     A: 480k    B: 612k    +132k      │    │
│ │  ─ iraAccount.balance      A: 980k    B: 1.04M   +60k       │    │
│ │  ─ usSavingsAccount.bal    A: 120k    B: 180k    +60k       │    │
│ └─────────────────────────────────────────────────────────────┘    │
│                                                                    │
│ ┌─────────────────────────────────────────────────────────────┐    │
│ │  Timeline (journal overlay)                                 │    │
│ │  A and B journal rows side-by-side at matching dates;       │    │
│ │  divergence date marked; rows that exist only in A or only  │    │
│ │  in B highlighted; matching rows with different amounts     │    │
│ │  shown with Δ.                                              │    │
│ └─────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
```

### 5.3 What it explicitly does *not* do

- **No causal attribution engine.** The existing execution-graph already records `EMITS` / `SCHEDULES` edges; if a user wants to know "what caused this difference?" they navigate the existing `lineage` plugin from the divergence row.
- **No automated insight generation.** No `top_driver` / `concentration` / `cascade` / `anomaly` taxonomy. If the journal makes the answer obvious, no engine is needed; if it doesn't, the user can ask a follow-up via existing tools.
- **No state-merging or bucketing.** Two scenarios are two scenarios; no probability-weighted "merged state" rendering.

The lightest viable comparison UI. If a heavier insight surface proves valuable later, it can be added; the comparison view doesn't preclude it.

### 5.4 Value-Level Journal Diff

The Phase A overlay shipped with the cheapest possible journal view: A's action names on the left, B's on the right, day-by-day. That's enough to see *that* the scenarios differ, but not *by how much* — and the data needed to do better is already on every `JournalEntry`. Each entry carries `stateDiff: [{ field, before, after, delta }, ...]` (populated by `Simulation` at reducer execution; see `src/simulation-framework/simulation.js` and `journal.js:46`). Phase A throws this away and renders the action's display name. Phase B.5 surfaces it.

#### 5.4.1 The pairing problem  *(landed early — see note)*

Two scenarios produce independent `JournalEntry` instances with independent `action.instanceId` UUIDs, so there is no natural cross-scenario identity. To put A's `WAGES` row next to B's `WAGES` row we need a *structural* pairing key. We use a deterministic tuple, in priority order:

| Priority | Key | Rationale |
|---|---|---|
| 1 | `(date, event.nodeId, action.nodeId, action.data.personKey ?? accountKey ?? ownerKey)` | The strongest key: config-graph node ids (`event.nodeId` from `sourceEvent.id`, `action.nodeId` from `action._actionId` — see `simulation.js:818` and `:597`) are **identical across A and B** for any event originating from the same config node. This pairs same-source events regardless of journal-seq drift. |
| 2 | `(date, action.type, scope)` | Type-based fallback when node ids are missing (anonymous or programmatically emitted actions). |
| 3 | `(date, action.type)` | Coarsest fallback when no scoping key is present. |
| 4 | Ordinal within group | When N entries on each side share the same key, pair by within-day order. Imperfect but predictable; the user can see "the 2nd of 3 WAGES rows" if needed. |

Pairing is computed per-day so cross-day mismatches don't propagate. An entry that doesn't pair becomes an **A-only** or **B-only** row, rendered with the existing single-side highlight.

The pairing key extraction lives in `scenario-compare-utils.js` as the pure function `journalPairKey(entry)` so it can be unit-tested without a DOM and reused by the decision-graph leaf-vs-leaf view.

**Note (2026-06-04):** The pairing key and row-aligned overlay landed ahead of Phase B.5 to fix a misalignment bug in the Phase A overlay (action rows in A and B were rendered in independent journal-seq order, producing visual mismatches whenever within-day order drifted between scenarios). `journalPairKey` + `pairEntriesWithinDay` are in `scenario-compare-utils.js`; `buildJournalOverlay` now returns `pairs: [{ kind, aEntry, bEntry, key }]` per day; the presenter renders row-by-row with hidden placeholder cells so heights align; the day header surfaces `⚠:N` when N rows are unmatched. **Cross-day alignment was rejected** as unprincipled: events on different days (e.g. A's SS check on the 1st vs. B's on the 15th) represent semantically different moments and should not be aliased. What remains for Phase B.5 is the *value-level* work in §5.4.2–§5.4.6 — field-aligned `before → after` rendering, paired Δ math, divergence banner, filter modes, running NW gutter — building on top of the now-correct pairing.

#### 5.4.2 What a paired row shows

A paired row is no longer a single line of action name — it expands to three logical strips:

```
┌─ 2032-04-15 ─────────────────────────────────────────────────────────────┐
│  WAGES   (person: alice)                                          [▼]    │
│  ───────────────────────────────────────────────────────────────────     │
│   Field                          A              B           Δ (B−A)      │
│   usCheckingAccount.balance      80,000 →       80,000 →    +2,500       │
│                                  82,500         85,000                   │
│   usOrdinaryIncomeYTD             8,000 →        8,000 →    +2,500       │
│                                  10,500         13,000                   │
│   …                                                                      │
└──────────────────────────────────────────────────────────────────────────┘
```

Three things to notice:

1. **Field-level alignment.** A's and B's `stateDiff` arrays are merged on `field` (full union, sorted by absolute delta-of-delta descending — biggest A↔B divergence first). Fields touched by only one side render `—` for the other.
2. **Before → After per side.** Renders as a single "X → Y" cell, not three columns; the eye reads "money flowed from 80k to 82.5k" in one glance. The framework already gives us this — we just stop discarding it.
3. **Δ (B−A) of the delta.** The headline number: how much *more* (or less) did this field move under B than under A? `(B.after − B.before) − (A.after − A.before)`. Zero deltas are dimmed; non-zero are colored pos/neg like §5.2's KPI strip.

Field paths come straight from `flattenNumericState`'s convention (dot-notation; already shared with the state-diff section in `scenario-compare-utils.js`), so the same paths show up across both sections — the user can match a field in the state-diff table to its journal-entry origin without translation.

A-only and B-only rows keep the existing single-side style but render the entry's own `stateDiff` array beneath the action name (single column, no pairing). The user sees "this action happened *only* in B and it moved field X by Y."

#### 5.4.3 Running net worth column

A running, per-side net-worth value is rendered as a tiny gutter on the right of every paired *and* unpaired row:

```
…  WAGES (alice)        A: $1,840k    B: $1,862k    Δ +$22k
```

This is `computeNetWorthUsd(stateDiff after-image)` evaluated incrementally — except `stateDiff` is a delta, not a full state. Two implementations are viable:

- **Cheap.** Re-derive net worth by walking each entry's `stateDiff`, keeping a running per-side dictionary of last-known balances and recomputing the sum each row. O(entries × fields-changed). No new infrastructure.
- **Correct.** Replay snapshots — `Journal.addSnapshot` already records full state at each event; `Journal.snapshotBefore(seq)` returns the nearest. Use those as anchors and accumulate diffs between snapshots.

V1 picks **cheap** — the only consumer is a display column; if the running value drifts from the true net worth, the right-hand KPI strip is the source of truth and we adjust later.

#### 5.4.4 Filter modes

The day-grouped overlay gets a small filter bar above the journal section:

| Mode | Effect |
|---|---|
| **All** (default) | Every day with at least one A or B entry. |
| **Differs** | Only days where at least one paired row has non-zero Δ, or where A-only / B-only rows exist. The common case after the user spots a deviation in the KPI strip. |
| **After divergence** | Detects the **first-divergence date** — the earliest day on which a paired row has non-zero Δ, or an A-only / B-only row appears — and hides everything before it. The divergence date itself gets a banner row: `── First divergence: 2031-06-15 ──`. |
| **Field path…** | A text filter; entries whose `stateDiff` doesn't touch a matching field are hidden. Reuses the same `contains` semantics as the existing journal-report plugin's predicate engine, so users get muscle-memory. |

Filters compose with the day-collapse UI — collapsing a day still shows its `A:n B:m` count, which now also includes a `Δ:k` indicator (count of paired rows with non-zero delta).

#### 5.4.5 What this still does *not* do

Still inside the §5.3 budget:

- **No causal walk.** The journal entry already carries `action.instanceId` and `emittedInstanceIds`; the user can right-click → "Open in lineage view" and the existing `lineage` plugin handles it. We don't render emit-edges inline.
- **No state-bucketing or rounding.** Raw deltas, raw before/after.
- **No automated "why did B's tax payment differ from A's?" explanation.** That's the deferred insight engine.
- **No reactive cross-highlighting** between the state-diff table and the journal overlay. The shared field-path convention is the only coupling; if click-to-highlight proves useful later, it's a small additive change.

#### 5.4.6 Data flow

No change to `ScenarioCompareRunner` — it already returns `journalEntries` with `stateDiff` populated. The work is entirely in `scenario-compare-utils.js` (add `journalPairKey`, extend `buildJournalOverlay` to return paired-and-field-aligned rows instead of flat action lists, add `firstDivergenceDate`, add `runningNetWorth` helper) and `scenario-compare-presenter.js` (render the new row shape; add filter bar). The plugin's CSS picks up new classes for the field-level grid (`sc-journal-fields`, `sc-journal-field-row`, `sc-journal-arrow`, `sc-journal-nw-gutter`, `sc-journal-divergence-banner`).

---

## 6. Integration with Existing Designs

### 6.1 Design 17 — Scenario as Graph Node

This design is the user of design 17. Every decision-graph leaf is a `BaseScenario` node with a `DERIVES_FROM` parent edge; the comparison UI reads graph nodes by id. No changes to design 17 are required.

The one minor extension: `layer: 'analysis-leaf'` is a new layer beside `'scenario'`. `graph.clearLayer('analysis-leaf')` is used between analysis runs; design 17 already supports layer-scoped reset.

### 6.2 Designs 25–29 (Financial Modeling roadmap)

Decision-graph analysis becomes more interesting as more discrete choices land:

- **Design 26 (Dynamic Spending)** — strategy selection (`FIXED` / `GUARDRAIL` / `REGIME_AWARE`) is naturally a `DecisionPoint`.
- **Design 27 (Mortality)** — `lateLifeCareMonths` per person is a numeric input but `whether to model late-life care at all` is naturally a decision.
- **Design 29 (Behavioral)** — `panicSellTrigger` enabled / disabled is a decision.

This design names the integration points but doesn't pre-emptively wire them; the follow-on designs reference this design when they introduce decision-bearing params.

### 6.3 Design 21 (Regimes)

A regime-bearing scenario already produces interesting "what if a 2030 crash happens?" questions, and the answer today is via MC over `shocks[0].severity`. Decision-graph analysis layers on top: "what's the best withdrawal strategy *if* a 2030 crash happens?" is a 1-decision-point × 3-option graph (with shock severity still varied via MC). The integration is automatic — regimes affect simulation behavior, decision-graph affects which scenarios are run.

### 6.4 Design 24 (Roadmap)

This design isn't in the roadmap (which is about financial-modeling depth). It's an *analysis-layer* design — it consumes the financial-modeling features as they land but doesn't depend on any specific one. Can ship before, during, or after the design-24 work.

---

## 7. Implementation Phases

### ✅ Phase A — Scenario comparison (small)

1. Add `scenario-compare` workbench plugin. Reads two scenario node IDs; renders side-by-side state panel + journal overlay + summary KPIs.
2. Reuse existing `state-panel` and `timeline` rendering — the compare plugin is a thin coordinator that runs each scenario, captures its journal + final state, and renders the diff.
3. Tests: `evt-scenario-compare-state.test.mjs` (state-panel diff renders correctly), `evt-scenario-compare-timeline.test.mjs` (journal overlay marks divergence + amount deltas).

**Exit criteria**: user can select two saved scenarios and see them side-by-side with deltas highlighted.

### ✅ Phase B — Decision-graph runner (medium)

4. Add `DecisionPoint`, `DecisionGraph`, `DecisionGraphRegistry` (graph-backed, `layer: 'analysis'`).
5. Add `DecisionGraphRunner` — calls existing MC runner per leaf; produces `DecisionGraphResult`.
6. Add `decision-graph-config` and `decision-graph-results` workbench plugins (mirroring `mc-config` / `mc-results`).
7. Aggregation: ranked and weighted-expectation modes from §4.4.
8. Tests: `evt-decision-graph-expand.test.mjs` (cartesian expansion), `evt-decision-graph-mc-coupling.test.mjs` (per-leaf MC runs reproducible from seed), `evt-decision-graph-aggregation.test.mjs` (ranked + weighted modes).

**Exit criteria**: user can declare a decision graph (e.g. SS claim age × retire age), run it, see a ranked table of leaves with per-leaf MC summaries, and open any leaf in the comparison view from Phase A.

### ✅ Phase B.5 — Value-level journal diff (small)

Splices in between B and C; no dependency on decision-graph leaves (it lifts the comparison view on its own). Detail in §5.4.

- A. ✅ **Pairing key** — `journalPairKey(entry)` in `scenario-compare-utils.js`; nodeId-first (priority 1), type-based fallback (priority 2–3), ordinal fallback (priority 4). *Landed 2026-06-04 ahead of phase to fix Phase A misalignment.*
- B. ✅ **Paired-row builder** — `mergeEntryFieldRows(aEntry, bEntry)` added; `pairEntriesWithinDay` now attaches `fieldRows: [{ field, aBefore, aAfter, aDelta, bBefore, bAfter, bDelta, deltaOfDelta }]` to every pair, sorted by `|deltaOfDelta|` descending.
- C. ✅ **Divergence detector** — `firstDivergenceDate(overlay)` exported from `scenario-compare-utils.js`; returns first ISO date with any unmatched pair or non-zero `deltaOfDelta`, or null.
- D. ✅ **Running net-worth column** — `runningNetWorthSeries(entries)` exported; cheap accumulator summing `*.balance` fields from running `after` dict; returns one number per entry. Used as NW gutter in the presenter.
- E. ✅ **Presenter** — `_buildJournalSection` refactored: per-day body replaces the two-column grid; each pair rendered via `_buildPairRowEl` with field-level grid, NW gutter, and A-only/B-only side stripe. Divergence banner inserted at first-divergence day.
- F. ✅ **Filter bar** — `_buildJournalFilterBar()` added; All / Differs / After divergence / Field path text filter; triggers `_rebuildJournalSection()` on change.
- G. ✅ **CSS** — new classes under `assets/css/plugins/scenario-compare.css`: `sc-journal-filter-bar`, `sc-filter-btn`, `sc-journal-day-body`, `sc-journal-divergence-banner`, `sc-journal-fields-hdr`, `sc-pair-row`, `sc-pair-row-header`, `sc-pair-action-name`, `sc-journal-nw-gutter`, `sc-journal-fields`, `sc-journal-field-row`, `sc-journal-arrow`, `sc-field-name`, `sc-field-delta`.

**Test coverage**: `tests/unit/evt-scenario-compare-value-diff.test.mjs` — 24 tests covering all new utils functions and `pairEntriesWithinDay` fieldRows attachment (all pass 2026-06-04).

**Exit criteria met**: opening Scenario Compare for two scenarios that differ shows, per day, paired action rows with `before → after` per side, `Δ (B−A)` per field, and a divergence banner at the first day where any paired row diverges. Filter bar narrows to differing-only and post-divergence views.

### ✅ Phase C — Polishing (small)

9. ✅ Decision-graph leaf persistence opt-in — `DecisionGraph.persistLeaves` flag; `DecisionGraphResultStorage`; "📋" load-last button in analysis list; "Persist results" checkbox in form; presenter saves on run / loads on request.
10. ✅ Per-decision-point probability weights UI — "Enable weights" toggle per DP; weight input per option row (with splice on remove); Ranked/Weighted mode toggle in results panel; `expectedValue` banner in Weighted view.
11. ✅ Export ranked results to CSV — `buildDecisionGraphCsv()` in `decision-graph-csv.js`; "↓ CSV" button in results panel; RFC 4180 escaping; columns: Rank + per-DP label + P10/P50/P90/Success Rate.

---

## 8. Testing

EVT-X test files under `tests/unit/`:

| File | Coverage |
|---|---|
| `evt-scenario-compare-state.test.mjs` | Side-by-side state-panel diff. |
| `evt-scenario-compare-timeline.test.mjs` | Journal overlay; divergence date marked. |
| `evt-scenario-compare-value-diff.test.mjs` | §5.4 — `journalPairKey` resolves the three priority tiers; paired-row builder field-aligns `stateDiff`; A-only / B-only routing; `firstDivergenceDate` returns the first day with a non-zero paired Δ or unmatched row; `runningNetWorth` matches `computeNetWorthUsd` on the final state. |
| `evt-decision-graph-expand.test.mjs` | Cartesian product is correct; each leaf has the expected param overrides; `DERIVES_FROM` edges land. |
| `evt-decision-graph-mc-coupling.test.mjs` | Per-leaf MC runs reproducible from seed; two runs of the same analysis produce identical results. |
| `evt-decision-graph-aggregation.test.mjs` | Ranked order matches objective; weighted-expectation matches manual calculation. |
| `evt-decision-graph-pruning.test.mjs` | > 100 leaves → warning; > 1000 leaves → rejection unless opt-in. |
| `evt-decision-graph-roundtrip.test.mjs` | DecisionGraph round-trips through storage. |

---

## 9. Out of Scope / Future Work

- **Heavier insight engine** — automated `top_driver` / `concentration` / `cascade` classification. Deferred; revisit only if the lightweight comparison UI proves insufficient.
- **Merge / reconciliation of two scenarios** — explicitly deprecated (design 5 supersede note).
- **Automatic state bucketing** — the proposal's "\$1.0M–\$1.1M bucket" compression. Out of scope while decision-graph leaves are user-declared and bounded by construction.
- **Continuous decision spaces** — the optimizer already covers single-numeric-param sweeps; combining the decision-graph with continuous optimization (mixed integer / continuous joint search) is its own design.
- **Real-time interactive branching** — paused-mid-run forking the way design 3 originally proposed. Not currently asked for; if it shows up, a separate design against the current architecture.
- **Multi-user collaborative branching** — design 5's late-stage idea. No traction; deferred indefinitely.
- **Policy-search / RL-style automated decision discovery** — the proposal's "Industrial-Scale Extension" section. Far future, requires a server-side runtime, and unrelated to the browser-tractable scope of this design.

---

## 10. Summary

The framework had three tiers of "many futures" (single run, MC, single-param optimization) but no tier for **structured combinatorial exploration of discrete strategic decisions**. This design adds a fourth tier, sitting *above* MC: decision-graph analysis enumerates user-declared discrete choices, runs each combination through MC, and aggregates results in either ranked or weighted-expectation form. Decision graphs are **analysis-time only** — scenarios stay single-track; no decision-graph metadata leaks into the scenario data model.

Alongside, the same comparison UI that decision-graph analysis needs is the right answer for "compare two saved scenarios," so a lightweight `scenario-compare` workbench plugin ships in the same design. It is deliberately small: side-by-side state, journal overlay, summary KPIs — no causal attribution engine, no automated insight taxonomy.

Designs 3, 4, and 5 are superseded. Design 3's substrate (scenarios with parent edges) was already implemented by design 17; design 4's diff and (lightweight) comparison piece moves here; the rest of design 4's insight engine and all of design 5's merge machinery are deferred or deprecated outright.

The result is a coherent analysis stack from deterministic single runs (Tier 1) to MC over exogenous uncertainty (Tier 2) to single-parameter optimization (Tier 3) to combinatorial decision-graph analysis (Tier 4), each tier independently runnable and sharing the same comparison surface for inspection.
