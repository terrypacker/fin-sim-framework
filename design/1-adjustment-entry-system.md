# Adjustment Entry System — Technical Requirements Specification

## 1. Overview

This document defines the architecture, data model, invariants, APIs, and UI integration requirements for implementing an **Adjustment Entry System** within a time-aware, event-sourced financial + simulation platform.

The system integrates with:

* Event-sourced graph simulation (nodes/edges evolving over time)
* Time scrubber UI (continuous temporal navigation)
* Period-based accounting model using **Time Period**

---

## 2. Core Principles (MUST HOLD)

### 2.1 Immutability

* Entries belonging to a `closed` or `locked` period **MUST NOT be mutated or deleted**
* All corrections MUST be represented as new entries

### 2.2 Append-Only Ledger

* The system MUST be fully append-only at the storage layer
* No UPDATE or DELETE operations on financial entries

### 2.3 Deterministic Reconstruction

* System state MUST be reconstructible solely from:

    * Event stream
    * Period definitions

### 2.4 Referential Adjustment Integrity

* Every adjustment MUST explicitly reference the entry it modifies
* No implicit or inferred adjustments allowed

---

## 3. Data Model

### 3.1 Entry

```ts
type EntryType = 'normal' | 'adjustment' | 'reversal';

interface Entry {
  id: string;

  // Temporal fields
  eventTime: number;   // Economic occurrence (epoch ms)
  postedAt: number;    // System insertion time
  periodId: string;    // FK → Period.id

  // Financial payload
  amount: number;

  // Classification
  type: EntryType;

  // Adjustment linkage
  adjustsEntryId?: string;   // Immediate parent
  rootEntryId: string;       // Root of adjustment chain

  // Audit
  createdBy: string;
  reason?: string;

  // Extensibility
  metadata?: Record<string, any>;
}
```

---

### 3.2 Period

```ts
type PeriodStatus = 'open' | 'closed' | 'locked';

interface Period {
  id: string;
  start: number; // inclusive
  end: number;   // exclusive
  status: PeriodStatus;
}
```

---

### 3.3 Derived Indexes (REQUIRED)

For performance, the following indexes MUST exist:

```ts
// Lookup adjustments by root
Map<rootEntryId, Entry[]>

// Lookup direct adjustments
Map<adjustsEntryId, Entry[]>

// Period partitioning
Map<periodId, Entry[]>

// Time-ordered index
Sorted array or B-tree keyed by eventTime
```

---

## 4. Adjustment Models

### 4.1 Supported Pattern: Delta Adjustment (PRIMARY)

Adjustment entries represent the **delta** between original and corrected value.

```
corrected = original + Σ(adjustments)
```

---

### 4.2 Optional Pattern: Reversal

Reversal entries:

* MUST have `type = 'reversal'`
* MUST set `amount = -original.amount`
* MUST reference original via `adjustsEntryId`

---

## 5. Invariants

### 5.1 Root Consistency

```ts
if (entry.type === 'normal') {
  entry.rootEntryId === entry.id
}

if (entry.type !== 'normal') {
  entry.rootEntryId === parent.rootEntryId
}
```

---

### 5.2 Adjustment Chain Validity

* No cycles allowed
* Graph must be a DAG
* Depth is unbounded but SHOULD be optimized for <10

---

### 5.3 Period Integrity

* Adjustments MUST be created only in `open` periods
* System MUST reject writes to:

    * `closed`
    * `locked`

---

## 6. Core Algorithms

---

### 6.1 Effective Amount Resolution

```ts
function getEffectiveAmount(entryId: string): number {
  const root = getEntry(entryId).rootEntryId;
  const chain = getEntriesByRoot(root);

  return chain.reduce((sum, e) => sum + e.amount, 0);
}
```

---

### 6.2 State Reconstruction

```ts
function getStateAt(time: number, mode: 'as_of' | 'as_recorded') {
  return events.filter(e => {
    if (mode === 'as_of') return e.eventTime <= time;
    if (mode === 'as_recorded') return e.postedAt <= time;
  });
}
```

---

### 6.3 Snapshot Optimization

```ts
interface Snapshot {
  periodId: string;
  timestamp: number;
  state: GraphState;
}
```

Reconstruction:

```ts
function reconstruct(time: number) {
  const snapshot = getNearestSnapshot(time);
  const deltaEvents = getEventsBetween(snapshot.timestamp, time);
  return applyEvents(snapshot.state, deltaEvents);
}
```

---

## 7. Adjustment Creation Workflow

---

### 7.1 Input

```ts
interface AdjustmentRequest {
  targetEntryId: string;
  newValue: number;
  reason: string;
  actor: string;
}
```

---

### 7.2 Process

```ts
function createAdjustment(req: AdjustmentRequest) {
  const original = getEntry(req.targetEntryId);

  assertPeriodOpen(getCurrentPeriod());

  const effective = getEffectiveAmount(original.id);
  const delta = req.newValue - effective;

  if (delta === 0) return null;

  const entry: Entry = {
    id: generateId(),
    type: 'adjustment',
    amount: delta,
    adjustsEntryId: original.id,
    rootEntryId: original.rootEntryId,
    eventTime: original.eventTime,
    postedAt: now(),
    periodId: getCurrentPeriod().id,
    createdBy: req.actor,
    reason: req.reason
  };

  persist(entry);
  index(entry);

  return entry;
}
```

---

## 8. UI Integration (Time Scrubber)

---

### 8.1 Behavior Rules

| Condition              | Behavior                               |
| ---------------------- | -------------------------------------- |
| Period = open          | allow edits                            |
| Period = closed/locked | disable edit → trigger adjustment flow |

---

### 8.2 Interaction Flow

1. User scrubs to time `t`
2. User attempts modification
3. System checks `period.status`
4. If not `open`:

    * Show adjustment modal
    * Precompute delta
    * Confirm → create adjustment

---

### 8.3 Visualization Requirements

* Entries rendered as timeline markers
* Adjustment chains MUST be visually linked
* Hover/selection MUST display:

    * Original amount
    * Adjustments (ordered)
    * Effective value

---

### 8.4 Rendering Logic

```ts
function renderEntry(entryId) {
  const chain = getEntriesByRoot(entryId);

  return {
    original: chain[0],
    adjustments: chain.slice(1),
    effective: sum(chain.map(e => e.amount))
  };
}
```

---

## 9. API Requirements

---

### 9.1 Create Adjustment

```
POST /adjustments
```

Request:

```json
{
  "targetEntryId": "string",
  "newValue": number,
  "reason": "string"
}
```

---

### 9.2 Get Entry Chain

```
GET /entries/:id/chain
```

Response:

```json
{
  "rootEntryId": "string",
  "entries": [Entry],
  "effectiveAmount": number
}
```

---

### 9.3 Time Query

```
GET /state?time=...&mode=as_of|as_recorded
```

---

## 10. Edge Cases

---

### 10.1 Adjustment of Adjustment

* MUST resolve to root
* MUST NOT create nested trees

---

### 10.2 Zero Delta

* MUST NOT create entry

---

### 10.3 Concurrent Adjustments

* Must be serialized or use optimistic concurrency
* Recompute delta at commit time

---

### 10.4 Deletion

* Not allowed
* MUST use reversal entries

---

## 11. Performance Requirements

* Reconstruction time: O(log n + k)
* Adjustment lookup: O(1) via index
* Snapshot frequency: configurable (default: per period close)

---

## 12. Testing Requirements

---

### 12.1 Determinism

* Replaying event stream MUST yield identical state

---

### 12.2 Chain Integrity

* No orphan adjustments
* No cycles

---

### 12.3 Period Enforcement

* Writes rejected in non-open periods

---

### 12.4 Financial Consistency

* Effective value MUST equal sum of chain

---

## 13. Future Extensions (Non-Blocking)

* Double-entry ledger support (debits/credits)
* Multi-ledger views (GAAP vs tax)
* Branching timelines (what-if scenarios)
* Automated anomaly detection for adjustments

---

## 14. Summary

This system establishes:

* Immutable historical record
* Explicit correction mechanism
* Deterministic replay
* Tight integration with temporal UI

It is designed to support both:

* Financial correctness
* Simulation-driven state evolution

All implementations MUST preserve the invariants defined above.
