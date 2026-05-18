# Simulation Workbench UI Redesign Proposal

## Vision

Transform the current simulation UI from a collection of feature panels into a true Simulation Workbench:

* modular
* dockable
* extensible
* runtime-aware
* optimized for power users
* scalable across multiple simulation domains

The redesign separates the system into:

1. Framework Core
2. Domain Plugins
3. Dockable IDE-style Workspace
4. Simulation Runtime Layer

This creates a long-term foundation for:

* financial planning
* robotics
* optimization systems
* Monte Carlo analysis
* generalized event simulation domains

---

## Core Design Principles

### 1. Workspace-Driven Architecture

The UI is organized into workspaces instead of large monolithic pages.

Primary Workspaces

Workspace	Purpose
Runtime	Timeline + live execution
Graph	Event/Handler/Action/Reducer tracing
Analysis	Monte Carlo + Optimization
Configuration	Graph editing + domain setup

This reduces visual overload while preserving fast access for advanced users.

---

### 2. IDE-Style Docking System

The redesign adopts a professional IDE-style docking architecture similar to:

* VSCode
* Blender
* Unreal Editor
* Grafana
* Datadog

Features

* draggable tabs
* resizable panes
* nested split layouts
* detachable future windows
* persistent workspace layouts
* reusable panel composition

Users can organize the environment according to their workflow.

---

### 3. Panels Become Runtime Components

The existing static UI structure evolves into a mounted component system.

Each panel supports:

* mount()
* unmount()
* rerender()
* event subscriptions
* lifecycle management

This enables:

* plugin loading
* detachable windows
* isolated rendering
* runtime synchronization
* future virtualization

---

### 4. Plugin-Oriented Architecture

The system is split into:

#### Framework Core

Generic simulation infrastructure:

* Event
* Handler
* Action
* Reducer
* Timeline
* Graph Runtime
* Monte Carlo Engine
* Optimization Engine
* Journal
* Runtime State

#### Domain Plugins

Specialized implementations:

Finance Plugin

* Person
* Account
* FIRE metrics
* retirement analysis
* out-of-funds annotations

#### Future Domains

Potential future plugin targets:

* robotics
* supply chains
* manufacturing
* AI agents
* operations research
* process simulation

---

## Runtime-Centric UI Model

The redesign treats the UI itself as part of the simulation runtime.

Global Runtime Invariants

Shared Across All Panels

* current simulation time
* selected node
* selected event/action
* execution state
* breakpoints
* active scenario

This enables synchronized behavior across:

* timeline
* graph
* inspectors
* charts
* Monte Carlo views

---

## Event Bus Integration

The UI integrates directly into the existing pub/sub architecture.

Benefits

* UI reacts to runtime events naturally
* low coupling between panels
* cross-window synchronization becomes possible
* plugins remain isolated
* runtime replay/time-travel becomes feasible

The UI becomes another consumer of the simulation event stream.

---

## Persistent Layout System

The redesign introduces persistent workspace state.

Persisted Data

* dock layout
* active tabs
* workspace configurations
* panel visibility
* split positions
* selected runtime context

Future Expansion

* named workspace presets
* shared team layouts
* domain-specific workspace templates

---

## Proposed Spatial Layout Philosophy

### Left Pane

Configuration & controls

Examples:

* scenario setup
* filters
* parameter editors
* runtime controls

---

### Center Pane

Primary visualization

Examples:

* timeline
* graph
* charts
* Monte Carlo distributions

---

### Right Pane

Inspection & detail

Examples:

* node lineage
* state explorer
* action detail
* runtime metrics
* debugger-style inspectors

---

## Timeline as Primary Runtime Surface

The timeline remains the dominant visual feature.

Why

The simulation framework is fundamentally:

* event-driven
* temporal
* replayable

The timeline acts as:

* execution history
* replay engine
* debugging surface
* state reconstruction tool

Future iterations may evolve it into:

* full time-travel debugger
* breakpoint controller
* causal replay system

---

## Graph System Philosophy

The graph view is treated as a power-user debugging/runtime analysis tool.

Responsibilities

* configuration graph
* execution lineage
* runtime edge highlighting
* causal tracing
* breakpoint management
* dependency exploration

The graph is not the primary operational UI, but a deep introspection tool.

---

## Monte Carlo & Optimization

Monte Carlo and Optimization become framework-level capabilities, not finance-only features.

Monte Carlo

* parameter sweeps
* probabilistic analysis
* scenario distributions
* result replay

Optimization

* search-space exploration
* objective scoring
* candidate ranking
* algorithm experimentation

These systems are exposed as dockable analysis plugins.

---

## Architectural Direction

The redesign intentionally moves toward:

“Simulation IDE Platform”

rather than:

“Single-purpose financial planning app”

This creates a reusable foundation for multiple domains while preserving the current FIRE-focused use case as a plugin layer.

---

## Current Prototype Milestones

### V1–V3

* workspace separation
* layout simplification
* panel grouping concepts

### V4

* component lifecycle architecture
* mount/unmount rendering model

### V5

* split-pane docking system
* nested layout trees
* tab groups

### V6

* drag-and-drop tab migration
* pane re-parenting

### V7

* persistent layouts
* plugin registry
* runtime integration
* simulation-aware UI state

---

## Recommended Next Phases

### Phase 1

Stabilize the docking/runtime architecture.

### Phase 2

Convert existing production panels into plugins.

### Phase 3

Add:

* detachable windows
* multi-monitor support
* BroadcastChannel synchronization

### Phase 4

Implement:

* replay debugger
* timeline virtualization
* graph virtualization
* performance instrumentation

### Phase 5

Develop:

* domain plugin SDK
* third-party plugin support
* workspace templates

----

## End Goal

A scalable simulation workbench capable of supporting:

* financial planning
* stochastic analysis
* optimization systems
* robotics workflows
* generalized event-driven simulations

within a unified runtime-centric IDE environment.
