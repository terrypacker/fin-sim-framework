# FinSim Design and Technical Requirements

## General Rules
### Time
* Time should be tracked as UTC ms since epoch
* Time should be converted to a global timezone, which is selectable by the user and defaults to current timezone


## Implemented Features 
Not all features are listed here yet, just those added later.

---
### [Period Engine](0-period-engine.md)
This document defines a **general-purpose Period Engine** that:

* Operates on **UTC-based milliseconds since epoch**
* Supports financial, simulation, and system-wide temporal partitioning
* Integrates with:

    * Event-sourced architecture
    * Branching timelines
    * Adjustment system
    * Time scrubber UI

---
## Unimplemented Features

---
### [Prebuilt Scenario Parameter Editing](13-prebuilt-scenario-parameters.md)
This document defines a refactor that allows prebuilt scenarios to be re-run with
edited parameter values directly from the UI, by:

* Unifying the prebuilt vs. user-scenario data shapes around a single typed
  `params` array, populated eagerly from `getParamSchema()` when a prebuilt enters
  the registry.
* Distinguishing **Rebuild** (preserve current params) from **Load Defaults**
  (reset to schema defaults) as two explicit UI actions.
* Renaming the three overloaded "params" concepts (schema vs. current values vs.
  compiler-facing map) so they no longer collide.
* Preserving param edits across rebuilds by stopping `loadPrebuilt` from
  clobbering existing registry entries.

---
### [Config as Source of Truth](15-config-as-source-of-truth.md)
This document defines a refactor that makes the active scenario `cfg` the sole
authoritative description of a scenario, by:

* Materializing `buildDefaultConfig()` output onto a prebuilt's registry entry
  exactly once, at registration time, instead of re-firing it on every Rebuild.
* Removing the `Object.assign(activeConfig, defaultCfg)` clobber inside
  `BaseApp.initScenario` so loaded JSON / edited cfgs survive Rebuild.
* Switching Monte Carlo and Optimization runners to clone the live `cfg` as
  their per-iteration template, so user edits to non-param fields
  (`RealProperty.plannedSaleYear`, `Person.lifeExpectancy`, `drawdownPriority`,
  custom graph nodes) are honored across MC/Opt runs.
* Introducing an explicit "Reset to Defaults" action for the recovery path now
  that defaults no longer fire implicitly.

---
### [Adjustment Entry System](1-adjustment-entry-system.md)
This document defines the architecture, data model, invariants, APIs, and UI integration requirements for implementing an **Adjustment Entry System** within a time-aware, event-sourced financial + simulation platform.

The system integrates with:

* Event-sourced graph simulation (nodes/edges evolving over time)
* Time scrubber UI (continuous temporal navigation)
* Period-based accounting model using **Time Period**

---
### [Unified Event Schema](2-unified-event-schema.md)
This document defines a **single event model and processing pipeline** that supports:

* Financial ledger entries (including adjustments)
* Graph/simulation mutations (nodes, edges, weights, etc.)
* Time-based reconstruction (for scrubber + audit)
* Deterministic replay

The system MUST unify all state changes into one **append-only event stream**, eliminating divergence between financial and simulation logic.

---
### [Branching Event Streams](3-branching-event-streams.md)
This document defines the architecture for **branching event streams**, enabling:

* “What-if” simulations
* Parallel financial scenarios
* Safe experimentation without mutating canonical history
* Time-scrubber-based branching + comparison

This builds on the unified event pipeline and **Time Period** model.

---
### [Branch Diff and Insight Engine](4-branch-diff-insight-engine.md)
This document defines the architecture for a **Branch Diff Engine** with integrated **Automated Insight Generation**, enabling:

* Deterministic comparison of two branches at any time
* Cross-domain diffing (financial + simulation)
* Causal attribution of differences
* Automated explanation of *why differences matter*

The system operates on the unified event pipeline and **Time Period** model.

---
### [Branch Merge Reconciliation](5-branch-merge-reconciliation.md)
This document defines a **Branch Merge & Reconciliation Engine** that allows:

* Safe merging of scenario branches into parent branches (e.g., `main`)
* Conflict detection and resolution across:

    * Financial events (ledger + adjustments)
    * Simulation events (graph mutations)
* Deterministic, auditable integration of changes
* Insight-driven merge decisions

This system builds on:

* Unified event schema
* Branching timelines
* Diff + insight engine
* Period-aware accounting using **Time Period**

---
### Temporal Query Language
Temporal query language design — a DSL for querying “state across time, branches, and periods” in one unified way.

---
### Scenario Monte Carlo Improvements
* implementing a worker pool for parallel Monte Carlo
* Checkpoint-based Monte Carlo

--- 
### Journal System
* upgrade journaling to delta-based + compressed storage

---
### [Journal Reporting Plugin](16-journal-reporting-plugin.md)
This document defines a generic Journal Reporting capability whose first
consumer is a drill-down from the US/AU tax-return modal:

* `JournalDataSource` projects `Journal.journal` entries into flat rows for
  `QueryApi` predicates.
* `JournalQueryApi` extends `QueryApi` with `between()`, `periodOf()` (settle
  boundary lookup), and an `aggregate({ groupBy, aggregates })` rollup method.
* A `ReportDefinitionRegistry` declares saved reports (Ordinary Income by
  Source, Capital Gains by Disposal, Cash Flow by Account, …) with built-in
  facets — no DSL exposed to the user.
* A new `journal-report` workbench plugin renders a saved report with a
  faceted UI, expandable group rows, and CSV export.
* `TaxDocumentModal` line items gain an optional `drillReport` descriptor;
  clicking a number publishes `JOURNAL_REPORT_OPEN` and pre-filters the
  plugin to the line's source predicate.
* Phased: targeted tax-modal drill-down first (Phase 1), then cash-flow
  report + state-diff projection, then more definitions + facet polish.

---
### [Age-Banded Spending](33-age-banded-spending.md)
This document defines an `AGE_BANDED` spending strategy (a new entry in design
26's `SPENDING_STRATEGY_REGISTRY`) that replaces flat inflation-only spending
with the research-backed "retirement spending smile" (Blanchett; BLS CE; the
go-go/slow-go/no-go three-phase model), by:

* Adding a single `AgeBandedSpendingReducer` that layers a deterministic
  **real** age multiplier on top of inflation, driven by a pure
  `ageSpendingFactor(age, bands)` function over a configurable, round-tripped
  `spendingAgeBands` table (step multipliers + intra-band annual real drift).
* Reusing the materialized `state.expenses` slices and the
  `RegimeAwareSpendingReducer` apply/revert idempotency pattern exactly — one
  reducer, one `state.ageBandSpending` field, no new framework infrastructure.
* Acting on the discretionary slice by default and deferring the late-life
  health upturn to the `HEALTHCARE` strategy / design 27's late-life-care
  factor, so the smile's terminal spike is not double-counted.

