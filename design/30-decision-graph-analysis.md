# 30 — Decision-Graph Analysis & Scenario Comparison

**Status**: Draft
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

### Phase A — Scenario comparison (small)

1. Add `scenario-compare` workbench plugin. Reads two scenario node IDs; renders side-by-side state panel + journal overlay + summary KPIs.
2. Reuse existing `state-panel` and `timeline` rendering — the compare plugin is a thin coordinator that runs each scenario, captures its journal + final state, and renders the diff.
3. Tests: `evt-scenario-compare-state.test.mjs` (state-panel diff renders correctly), `evt-scenario-compare-timeline.test.mjs` (journal overlay marks divergence + amount deltas).

**Exit criteria**: user can select two saved scenarios and see them side-by-side with deltas highlighted.

### Phase B — Decision-graph runner (medium)

4. Add `DecisionPoint`, `DecisionGraph`, `DecisionGraphRegistry` (graph-backed, `layer: 'analysis'`).
5. Add `DecisionGraphRunner` — calls existing MC runner per leaf; produces `DecisionGraphResult`.
6. Add `decision-graph-config` and `decision-graph-results` workbench plugins (mirroring `mc-config` / `mc-results`).
7. Aggregation: ranked and weighted-expectation modes from §4.4.
8. Tests: `evt-decision-graph-expand.test.mjs` (cartesian expansion), `evt-decision-graph-mc-coupling.test.mjs` (per-leaf MC runs reproducible from seed), `evt-decision-graph-aggregation.test.mjs` (ranked + weighted modes).

**Exit criteria**: user can declare a decision graph (e.g. SS claim age × retire age), run it, see a ranked table of leaves with per-leaf MC summaries, and open any leaf in the comparison view from Phase A.

### Phase C — Polishing (small)

9. Decision-graph leaf persistence opt-in (default: cleared between runs to save storage).
10. Per-decision-point probability weights UI.
11. Export ranked results to CSV.

---

## 8. Testing

EVT-X test files under `tests/unit/`:

| File | Coverage |
|---|---|
| `evt-scenario-compare-state.test.mjs` | Side-by-side state-panel diff. |
| `evt-scenario-compare-timeline.test.mjs` | Journal overlay; divergence date marked. |
| `evt-decision-graph-expand.test.mjs` | Cartesian product is correct; each leaf has the expected param overrides; `DERIVES_FROM` edges land. |
| `evt-decision-graph-mc-coupling.test.mjs` | Per-leaf MC runs reproducible from seed; two runs of the same analysis produce identical results. |
| `evt-decision-graph-aggregation.test.mjs` | Ranked order matches objective; weighted-expectation matches manual calculation. |
| `evt-decision-graph-pruning.test.mjs` | > 100 leaves → warning; > 1000 leaves → rejection unless opt-in. |
| `evt-decision-graph-roundtrip.test.mjs` | DecisionGraph round-trips through storage. |

---

## 9. Out of Scope / Future Work

- **Heavier insight engine** — automated `top_driver` / `concentration` / `cascade` classification. Deferred; revisit only if the lightweight comparison UI proves insufficient.
- **Merge / reconciliation of two scenarios** — explicitly deprecated (design 5 supersede note).
- **Automatic state bucketing** — the proposal's "$1.0M–$1.1M bucket" compression. Out of scope while decision-graph leaves are user-declared and bounded by construction.
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
