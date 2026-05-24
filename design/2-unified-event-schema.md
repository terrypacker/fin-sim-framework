# Unified Event Schema — Financial + Simulation Pipeline

## 1. Objective

Define a **single event model and processing pipeline** that supports:

* Financial ledger entries (including adjustments)
* Graph/simulation mutations (nodes, edges, weights, etc.)
* Time-based reconstruction (for scrubber + audit)
* Deterministic replay

The system MUST unify all state changes into one **append-only event stream**, eliminating divergence between financial and simulation logic.

---

## 2. Core Concept

All changes—financial or structural—are expressed as:

> **Events applied to state over time**

These events are interpreted differently by projections (financial vs graph), but share:

* Storage
* Ordering
* Replay mechanics

---

## 3. Canonical Event Model

```ts
type EventDomain = 'financial' | 'simulation' | 'system';

type EventType =
  // Financial
  | 'ledger.entry.created'
  | 'ledger.entry.adjusted'
  | 'ledger.entry.reversed'

  // Simulation
  | 'graph.node.created'
  | 'graph.node.updated'
  | 'graph.edge.created'
  | 'graph.edge.updated'
  | 'graph.edge.deleted'

  // System
  | 'period.opened'
  | 'period.closed'
  | 'snapshot.created';

interface BaseEvent {
  id: string;

  // Classification
  domain: EventDomain;
  type: EventType;

  // Temporal axes
  eventTime: number;   // economic / simulation time
  postedAt: number;    // ingestion time

  // Ordering (monotonic)
  sequence: number;

  // Period association
  periodId: string;

  // Causality
  causationId?: string;     // parent event
  correlationId?: string;   // group of related events

  // Actor + audit
  actorId: string;

  // Payload (typed by event type)
  payload: unknown;

  // Metadata
  metadata?: Record<string, any>;
}
```

---

## 4. Financial Event Payloads

---

### 4.1 Ledger Entry Created

```ts
interface LedgerEntryCreatedPayload {
  entryId: string;

  amount: number;

  // Adjustment structure
  type: 'normal' | 'adjustment' | 'reversal';
  adjustsEntryId?: string;
  rootEntryId: string;

  // Optional linkage to simulation
  relatedNodeId?: string;
  relatedEdgeId?: string;
}
```

---

### 4.2 Ledger Adjustment (alias)

This is syntactic sugar over `ledger.entry.created` with `type = 'adjustment'`.

---

## 5. Simulation Event Payloads

---

### 5.1 Node Created

```ts
interface GraphNodeCreatedPayload {
  nodeId: string;
  attributes: Record<string, any>;
}
```

---

### 5.2 Edge Created

```ts
interface GraphEdgeCreatedPayload {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  weight: number;
}
```

---

### 5.3 Edge Updated (adjustment-aware)

```ts
interface GraphEdgeUpdatedPayload {
  edgeId: string;

  // Adjustment-compatible change
  deltaWeight?: number;

  // Optional linkage to financial event
  linkedEntryId?: string;
}
```

---

## 6. Key Unification Principle

### 6.1 Financial ↔ Simulation Linkage

Events MAY reference each other:

* Financial → Simulation:

    * `relatedNodeId`
    * `relatedEdgeId`

* Simulation → Financial:

    * `linkedEntryId`

This enables:

* Tracing financial impact of graph changes
* Reconstructing economic meaning of simulation events

---

## 7. Event Store Requirements

---

### 7.1 Append-Only Log

```ts
append(Event): void
```

* MUST assign:

    * `sequence` (global monotonic)
    * `postedAt`

---

### 7.2 Ordering Guarantees

* Events MUST be replayable in `sequence` order
* `eventTime` MAY be out-of-order (back-posting allowed)

---

### 7.3 Indexes (REQUIRED)

```ts
Map<eventId, Event>
Map<type, Event[]>
Map<periodId, Event[]>
Map<entityId (node/edge/entry), Event[]>
```

---

## 8. Projection Architecture

---

### 8.1 Concept

State is NOT stored directly. It is derived via projections:

```ts
interface Projection<T> {
  apply(event: BaseEvent): void;
  getState(): T;
}
```

---

### 8.2 Required Projections

---

#### A. Financial Projection

Tracks:

* Entries
* Adjustment chains
* Effective balances

---

#### B. Graph Projection

Tracks:

* Nodes
* Edges
* Weights

---

#### C. Period Projection

Tracks:

* Period states
* Open/closed enforcement

---

## 9. Unified Replay Engine

---

```ts
function replay(events: BaseEvent[], projections: Projection[]) {
  for (const event of events.sort(bySequence)) {
    for (const p of projections) {
      p.apply(event);
    }
  }
}
```

---

## 10. Time Scrubber Integration

---

### 10.1 Query Modes

```ts
type TimeMode = 'as_of' | 'as_recorded';
```

---

### 10.2 Event Filtering

```ts
function filterEvents(events, time, mode) {
  return events.filter(e => {
    if (mode === 'as_of') return e.eventTime <= time;
    if (mode === 'as_recorded') return e.postedAt <= time;
  });
}
```

---

### 10.3 Reconstruction

```ts
function getStateAt(time, mode) {
  const filtered = filterEvents(allEvents, time, mode);
  return replay(filtered, projections);
}
```

---

## 11. Adjustment Integration

---

### 11.1 Financial Adjustment

* Emits `ledger.entry.created` (type=adjustment)

---

### 11.2 Simulation Adjustment

Instead of mutating:

```ts
graph.edge.updated {
  deltaWeight: -20,
  linkedEntryId: "entry123"
}
```

---

### 11.3 Cross-Domain Consistency Rule

If an event has both:

* financial impact
* simulation impact

THEN:

* MUST emit **two events**
* MUST share `correlationId`

---

## 12. Causality + Correlation

---

### 12.1 causationId

Represents:

> “This event was caused by that event”

Used for:

* adjustment chains
* derived updates

---

### 12.2 correlationId

Represents:

> “These events belong to the same operation”

Used for:

* UI grouping
* transaction bundling

---

## 13. Snapshot Strategy

---

### 13.1 Snapshot Event

```ts
type: 'snapshot.created'
payload: {
  state: SerializedState;
  upToSequence: number;
}
```

---

### 13.2 Usage

* Accelerates replay
* MUST NOT break determinism

---

## 14. Concurrency Model

---

### 14.1 Optimistic Concurrency

* Each write checks latest `sequence`
* Retries on conflict

---

### 14.2 Idempotency

* Events MUST be idempotent
* Use `id` + deduplication

---

## 15. Validation Layer

---

Before append:

* Validate period is open (for financial writes)
* Validate adjustment linkage
* Validate graph entity existence

---

## 16. Example End-to-End Flow

---

### Scenario: Adjust edge weight with financial impact

---

#### Step 1: Original events

```text
E1: graph.edge.created (weight=100)
E2: ledger.entry.created (amount=100, linked to edge)
```

---

#### Step 2: Adjustment triggered

---

#### Step 3: Emit events

```text
E3: ledger.entry.created (amount=-20, type=adjustment, root=E2)
E4: graph.edge.updated (deltaWeight=-20, linkedEntryId=E3)
```

Shared:

```text
correlationId = X
```

---

#### Step 4: Replay result

* Edge weight = 80
* Financial total = 80

---

## 17. Testing Requirements

---

### 17.1 Cross-Domain Consistency

* Graph state and financial totals MUST reconcile

---

### 17.2 Replay Determinism

* Replaying full event stream MUST yield identical results

---

### 17.3 Adjustment Integrity

* Chains MUST resolve correctly

---

## 18. Anti-Patterns (MUST NOT DO)

---

* Mutating state directly
* Updating entries in-place
* Divergent pipelines for financial vs simulation
* Implicit adjustments without explicit events

---

## 19. Summary

This unified schema provides:

* Single source of truth (event log)
* Full auditability
* Seamless time travel
* Tight coupling between financial and simulation logic

It enables your system to function as:

* Ledger
* Simulation engine
* Temporal debugger

…all on the same foundation.
