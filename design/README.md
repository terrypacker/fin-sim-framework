# FinSim Design and Technical Requirements

## General Rules
### Time
* Time should be tracked as UTC ms since epoch
* Time should be converted to a global timezone, which is selectable by the user and defaults to current timezone

## Enhancement Specifications (Not Yet Implemented)

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

