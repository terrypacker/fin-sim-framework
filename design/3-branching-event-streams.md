# Branching Event Streams (Forkable Timelines)

## Design Document

---

## 1. Purpose

This document defines the architecture for **branching event streams**, enabling:

* “What-if” simulations
* Parallel financial scenarios
* Safe experimentation without mutating canonical history
* Time-scrubber-based branching + comparison

This builds on the unified event pipeline and **Time Period** model.

---

## 2. Core Concept

A **Branch** is a logical fork of the event stream:

> A branch = a reference to a parent timeline + additional events

Branches do NOT duplicate data. They:

* Reference a base sequence point
* Append their own events

---

## 3. Mental Model

```text
Main Timeline:
E1 → E2 → E3 → E4 → E5

Branch A (fork at E3):
E1 → E2 → E3 → E3a → E3b

Branch B (fork at E4):
E1 → E2 → E3 → E4 → E4a
```

---

## 4. Branch Model

```ts
type BranchType = 'main' | 'scenario' | 'simulation';

interface Branch {
  id: string;

  name: string;
  type: BranchType;

  // Fork point
  parentBranchId?: string;
  forkSequence: number;

  // Metadata
  createdAt: number;
  createdBy: string;

  // Lifecycle
  status: 'active' | 'archived' | 'merged';

  metadata?: Record<string, any>;
}
```

---

## 5. Event Extension

All events MUST include:

```ts
interface BaseEvent {
  ...
  branchId: string;   // REQUIRED
}
```

---

## 6. Event Resolution Algorithm

To reconstruct a branch:

```ts
function getEventsForBranch(branchId: string): Event[] {
  const branch = getBranch(branchId);

  if (!branch.parentBranchId) {
    return getEventsUpTo(branch.forkSequence, branchId);
  }

  const parentEvents = getEventsForBranch(branch.parentBranchId)
    .filter(e => e.sequence <= branch.forkSequence);

  const branchEvents = getEventsByBranch(branchId);

  return merge(parentEvents, branchEvents);
}
```

---

## 7. Merge Rules

### 7.1 Ordering

* Parent events up to `forkSequence`
* Then branch events ordered by `sequence`

---

### 7.2 Conflict Handling (initial version)

* No automatic merging into parent
* Branches are **read-only relative to parent**
* Parent remains authoritative

---

## 8. Time Scrubber Integration

---

### 8.1 UI Model

Add branch selector:

```text
[ Branch: Main ▼ ]
[ Branch: Scenario A ]
[ Branch: Scenario B ]
```

---

### 8.2 Behavior

* Scrubber operates within selected branch
* Time = `(branchId, timestamp)`
* State reconstruction uses branch-specific event set

---

### 8.3 Visual Indicators

* Divergence point marked on timeline
* Branch events color-coded
* Overlay comparison mode (optional)

---

## 9. Adjustment Behavior in Branches

---

### 9.1 Rule

Adjustments in a branch:

* DO NOT affect parent
* ONLY apply within branch

---

### 9.2 Example

Main:

```text
E1: +100
```

Branch:

```text
E2: adjustment -20
```

Result:

* Main = 100
* Branch = 80

---

## 10. Cross-Domain Consistency

Branching MUST apply equally to:

* Financial events
* Simulation events

Shared constraints:

* Same `correlationId`
* Same `branchId`

---

## 11. Snapshot Strategy (Branch-Aware)

```ts
interface Snapshot {
  branchId: string;
  sequence: number;
  state: SerializedState;
}
```

Snapshots are NOT shared across branches unless:

* They originate before fork point

---

## 12. Storage Model

---

### 12.1 Tables

#### Branches

```text
branches(id, parent_branch_id, fork_sequence, ...)
```

#### Events

```text
events(id, sequence, branch_id, ...)
```

---

### 12.2 Indexes

* `(branch_id, sequence)`
* `(parent_branch_id)`
* `(fork_sequence)`

---

## 13. API Design

---

### 13.1 Create Branch

```http
POST /branches
```

```json
{
  "name": "Scenario A",
  "parentBranchId": "main",
  "forkSequence": 12345
}
```

---

### 13.2 Append Event (Branch)

```http
POST /events
```

```json
{
  "branchId": "scenarioA",
  "type": "...",
  ...
}
```

---

### 13.3 Query State

```http
GET /state?branchId=...&time=...&mode=...
```

---

## 14. Performance Considerations

---

### 14.1 Event Resolution Cost

* O(depth of branch tree + event count)
* MUST use caching/snapshots

---

### 14.2 Snapshot Strategy

* Snapshot at:

    * Fork points
    * Period boundaries
    * Every N events

---

## 15. Security / Isolation

* Branches MUST be isolated by default
* No accidental writes to `main`
* Optional permission model:

    * read-only branches
    * restricted merges

---

## 16. Future Enhancements

* Branch merging (3-way merge)
* Conflict resolution UI
* Diff engine (state comparison)
* Multi-user collaboration

---

# Requirements Document

---

## 1. Functional Requirements

---

### 1.1 Branch Creation

* System MUST allow creating a branch from any sequence point
* MUST store `parentBranchId` and `forkSequence`

---

### 1.2 Event Routing

* All events MUST include `branchId`
* System MUST reject events without branch

---

### 1.3 State Reconstruction

* MUST correctly merge parent + branch events
* MUST respect fork boundary

---

### 1.4 Time Scrubber

* MUST support branch selection
* MUST reconstruct state per branch
* MUST support:

    * `as_of`
    * `as_recorded`

---

### 1.5 Adjustment System Compatibility

* Adjustments MUST:

    * Respect branch isolation
    * Resolve within branch only

---

### 1.6 Cross-Domain Events

* Financial + simulation events MUST coexist in branch
* MUST maintain correlation consistency

---

## 2. Non-Functional Requirements

---

### 2.1 Performance

* State reconstruction ≤ 100ms for typical workloads
* Snapshot usage REQUIRED

---

### 2.2 Scalability

* Must support:

    * 1M+ events
    * 100+ branches

---

### 2.3 Consistency

* Replay MUST be deterministic across branches

---

### 2.4 Storage

* Branching MUST NOT duplicate base events

---

## 3. Validation Requirements

---

### 3.1 Branch Integrity

* No cycles in branch hierarchy
* Fork sequence MUST exist

---

### 3.2 Event Integrity

* Event.branchId MUST exist
* Event.sequence MUST be monotonic per branch

---

### 3.3 Adjustment Integrity

* Adjustments MUST resolve to correct root within branch

---

## 4. Testing Requirements

---

### 4.1 Branch Replay

* Replaying branch MUST match expected state

---

### 4.2 Isolation

* Changes in branch MUST NOT affect parent

---

### 4.3 Divergence

* Branch states MUST differ when events diverge

---

### 4.4 Cross-Domain Consistency

* Graph + financial projections MUST remain aligned

---

## 5. Acceptance Criteria

---

System is complete when:

* Branch can be created at arbitrary point
* Events can be appended to branch
* Scrubber can navigate branches
* Adjustments work independently per branch
* State reconstruction is deterministic and performant

---

## 6. Summary

This system introduces:

* Safe “what-if” experimentation
* Parallel financial + simulation realities
* Zero-risk exploration of adjustments

It transforms your architecture into:

> A multi-timeline, event-sourced system with full temporal and financial integrity
