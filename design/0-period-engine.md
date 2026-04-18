# Period Engine (UTC Epoch-Based)

## Technical Design + Requirements Specification

---

## 1. Purpose

This document defines a **general-purpose Period Engine** that:

* Operates on **UTC-based milliseconds since epoch**
* Supports financial, simulation, and system-wide temporal partitioning
* Integrates with:

    * Event-sourced architecture
    * Branching timelines
    * Adjustment system
    * Time scrubber UI

The engine formalizes **Time Period** as a first-class system primitive.

---

## 2. Design Goals

---

### 2.1 Functional Goals

* Deterministic mapping: `timestamp → period`
* Support arbitrary period definitions:

    * Fixed (monthly, daily)
    * Custom (user-defined ranges)
* Period lifecycle management:

    * `open → closed → locked`
* Enforce write constraints based on period state
* Enable efficient querying and partitioning

---

### 2.2 Non-Functional Goals

* Timezone-agnostic (strict UTC)
* O(log n) lookup for period resolution
* Immutable period boundaries once created
* High performance for large datasets

---

## 3. Core Concepts

---

### 3.1 Period Definition

A Period is a **half-open interval**:

```text
[start, end)
```

Where:

* `start` is inclusive
* `end` is exclusive
* Both are UTC epoch milliseconds

---

### 3.2 Period Identity

Each period MUST have:

```ts id="y8f7t3"
type PeriodStatus = 'open' | 'closed' | 'locked';

interface Period {
  id: string;

  start: number; // inclusive (UTC ms)
  end: number;   // exclusive (UTC ms)

  status: PeriodStatus;

  // Optional hierarchy
  parentPeriodId?: string;

  // Metadata
  label?: string;
  metadata?: Record<string, any>;
}
```

---

### 3.3 Invariants

---

#### Non-overlapping

```ts id="n0w2lq"
∀ P1, P2:
  P1.id !== P2.id ⇒
  P1.end <= P2.start OR P2.end <= P1.start
```

---

#### Full coverage (optional mode)

System MAY enforce:

```ts id="9o7wra"
∀ t ∈ timeline:
  ∃ exactly one period P such that t ∈ P
```

---

#### Immutability

* `start` and `end` MUST NOT change after creation

---

## 4. Period Types

---

### 4.1 Fixed Interval Periods

Generated automatically:

* Daily: 86400000 ms
* Monthly: variable length
* Custom cadence

---

### 4.2 Custom Periods

Manually defined arbitrary ranges

---

### 4.3 Hierarchical Periods

```text
Year
 ├─ Quarter
 │   ├─ Month
 │   │   ├─ Day
```

---

```ts id="3i3k3d"
parentPeriodId: string | null
```

---

## 5. Core APIs

---

### 5.1 Resolve Period

```ts id="9j0x6k"
function getPeriodForTimestamp(ts: number): Period;
```

Requirements:

* O(log n) lookup
* MUST return exactly one period (if full coverage enabled)

---

### 5.2 Validate Write

```ts id="q4t2fi"
function assertWritable(ts: number): void;
```

Logic:

```ts id="j4rqrs"
const period = getPeriodForTimestamp(ts);

if (period.status !== 'open') {
  throw Error('Period is not writable');
}
```

---

### 5.3 Transition Period

```ts id="lht7hx"
function transitionPeriod(
  periodId: string,
  newStatus: PeriodStatus
): void;
```

Rules:

* `open → closed → locked`
* No backward transitions

---

### 5.4 Create Period

```ts id="a3l9x2"
function createPeriod(input: {
  start: number;
  end: number;
  parentPeriodId?: string;
}): Period;
```

Validation:

* No overlap
* Valid interval (`start < end`)

---

## 6. Data Structures

---

### 6.1 Storage Model

```text
periods(
  id,
  start,
  end,
  status,
  parent_period_id
)
```

---

### 6.2 Indexing

Required indexes:

```ts id="8xz7oz"
// Sorted by start
BTree<start, Period>

// Optional:
Map<id, Period>
```

---

### 6.3 Lookup Optimization

Binary search:

```ts id="y1s7sp"
function findPeriod(ts) {
  // binary search over sorted start times
}
```

---

## 7. Integration with Event System

---

### 7.1 Event Contract

All events MUST include:

```ts id="r41g1g"
event.periodId: string;
```

---

### 7.2 Assignment Rule

```ts id="n1d9a4"
event.periodId = getPeriodForTimestamp(event.eventTime).id;
```

---

### 7.3 Validation

On write:

* MUST validate period is `open`
* MUST reject if `closed` or `locked`

---

## 8. Adjustment System Integration

---

### 8.1 Rule

Adjustments MUST:

* Use current open period
* NOT modify original period

---

### 8.2 Enforcement

```ts id="7t5s6x"
if (targetPeriod.status !== 'open') {
  createAdjustmentIn(currentOpenPeriod);
}
```

---

## 9. Branching Integration

---

### 9.1 Shared Periods

* Period definitions are **global**
* Not branch-specific

---

### 9.2 Branch Behavior

* Events in different branches reference same period IDs
* Period status applies across all branches

---

## 10. Time Scrubber Integration

---

### 10.1 Behavior

* Cursor maps to:

```ts
(time) → period
```

---

### 10.2 UI Requirements

* Highlight active period
* Display status (open/closed/locked)
* Snap-to-boundary capability

---

## 11. Snapshot Integration

---

### 11.1 Snapshot Trigger

* At period boundaries
* On period close

---

### 11.2 Snapshot Schema

```ts id="p8y4ht"
interface Snapshot {
  periodId: string;
  timestamp: number;
  state: SerializedState;
}
```

---

## 12. Performance Requirements

---

### 12.1 Lookup

* Period resolution: O(log n)

---

### 12.2 Creation

* Period insertion: O(log n)

---

### 12.3 Validation

* Write validation: O(log n)

---

## 13. Edge Cases

---

### 13.1 Gaps in Periods

Two modes:

* Strict: no gaps allowed
* Flexible: allow undefined time

---

### 13.2 Overlapping Definitions

* MUST reject at creation time

---

### 13.3 Large Time Ranges

* Support full epoch range (±2^53 ms safe range)

---

### 13.4 Backfilled Events

* Allowed
* Assigned to correct historical period
* May require adjustment logic

---

## 14. Testing Requirements

---

### 14.1 Deterministic Mapping

* Same timestamp → same period always

---

### 14.2 Boundary Conditions

* Test:

    * exact `start`
    * exact `end - 1`
    * exact `end`

---

### 14.3 Transition Enforcement

* Cannot write to closed/locked periods

---

### 14.4 Overlap Prevention

* No two periods overlap

---

## 15. Security / Governance

---

### 15.1 Period Closure Permissions

* Only authorized actors can:

    * close
    * lock

---

### 15.2 Audit Trail

All transitions MUST emit events:

```ts id="z9h6kw"
type: 'period.transitioned'
```

---

## 16. API Design

---

### 16.1 Get Period

```http
GET /periods?timestamp=...
```

---

### 16.2 Create Period

```http
POST /periods
```

---

### 16.3 Transition Period

```http
POST /periods/:id/transition
```

---

## 17. Anti-Patterns

---

* Using local timezones internally ❌
* Inclusive end boundaries ❌
* Allowing period mutation ❌
* Implicit period assignment ❌

---

## 18. Acceptance Criteria

---

System is complete when:

* Periods can be created and queried deterministically
* Events correctly map to periods
* Closed/locked enforcement works
* No overlaps occur
* Performance meets requirements

---

## 19. Summary

This Period Engine provides:

* A universal temporal partitioning system
* Deterministic time-to-period mapping
* Enforcement of temporal constraints
* Foundation for:

    * accounting correctness
    * simulation consistency
    * time-based reasoning

It serves as the **temporal backbone** of your entire architecture.

---

## 20. Future Extensions

* Timezone projection layer (view-only)
* Dynamic period generation (on-demand)
* Period versioning (rare cases)
* Multi-calendar support
