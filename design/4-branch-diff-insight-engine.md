# Branch Diff Engine & Automated Insight Generation

## Technical Design Document

---

## 1. Purpose

This document defines the architecture for a **Branch Diff Engine** with integrated **Automated Insight Generation**, enabling:

* Deterministic comparison of two branches at any time
* Cross-domain diffing (financial + simulation)
* Causal attribution of differences
* Automated explanation of *why differences matter*

The system operates on the unified event pipeline and **Time Period** model.

---

## 2. Design Goals

### 2.1 Functional Goals

* Compare any two branches at time `t`
* Support both:

    * `as_of` (economic truth)
    * `as_recorded` (historical knowledge)
* Provide:

    * Event-level differences
    * State-level differences
    * Causal explanations
    * Automated insights

---

### 2.2 Non-Functional Goals

* Deterministic results
* Sub-100ms response (with caching)
* Scalable to 1M+ events
* Extensible insight engine

---

## 3. System Architecture

```text
Diff Engine
 ├── Event Resolver
 ├── Divergence Detector
 ├── State Reconstructor
 ├── Diff Calculator
 ├── Causal Attribution Engine
 └── Insight Engine
```

---

## 4. Inputs / Outputs

---

### 4.1 Input

```ts
interface DiffRequest {
  branchA: string;
  branchB: string;

  time: number;
  mode: 'as_of' | 'as_recorded';

  entityScope?: string[];
  domainScope?: ('financial' | 'simulation')[];
}
```

---

### 4.2 Output

```ts
interface BranchDiffResult {
  divergenceSequence: number | null;

  eventDiff: EventDiff;

  stateDiff: {
    financial: FinancialDiff;
    graph: GraphDiff;
  };

  causalAnalysis: CausalExplanation[];

  insights: Insight[];
}
```

---

## 5. Processing Pipeline

---

### 5.1 Step 1 — Event Resolution

```ts
eventsA = resolveBranchEvents(branchA, time, mode);
eventsB = resolveBranchEvents(branchB, time, mode);
```

Requirements:

* Include inherited parent events
* Respect time filtering

---

### 5.2 Step 2 — Divergence Detection

```ts
function findDivergence(eventsA, eventsB): number | null;
```

Definition:

* First sequence index where event IDs differ

---

### 5.3 Step 3 — Event Diff

```ts
interface EventDiff {
  added: Event[];
  removed: Event[];
  modified: Event[];
}
```

Rules:

* Append-only assumption → `modified` is rare
* Matching based on `id`

---

### 5.4 Step 4 — State Reconstruction

```ts
stateA = reconstruct(branchA, time, mode);
stateB = reconstruct(branchB, time, mode);
```

Must use:

* Snapshot optimization
* Projection replay

---

### 5.5 Step 5 — State Diff

---

#### Financial

```ts
interface FinancialDiff {
  entries: {
    entryId: string;
    amountA: number;
    amountB: number;
    delta: number;
  }[];

  totalDelta: number;
}
```

---

#### Graph

```ts
interface GraphDiff {
  edges: {
    edgeId: string;
    weightA: number;
    weightB: number;
    delta: number;
  }[];

  nodes?: {
    nodeId: string;
    metricA: number;
    metricB: number;
    delta: number;
  }[];
}
```

---

### 5.6 Step 6 — Causal Attribution Engine

---

#### Objective

Map observed deltas → responsible events

---

#### Algorithm

```ts
function explainEntityDiff(entityId, branchA, branchB) {
  chainA = getEventChain(branchA, entityId);
  chainB = getEventChain(branchB, entityId);

  return diffChains(chainA, chainB);
}
```

---

#### Output

```ts
interface CausalExplanation {
  entityId: string;

  before: number;
  after: number;
  delta: number;

  contributingEvents: Event[];

  explanation: string;
}
```

---

### 5.7 Adjustment Awareness (MANDATORY)

* All financial comparisons MUST use:

```ts
effective = base + sum(adjustments)
```

* Chains MUST be resolved via `rootEntryId`

---

## 6. Insight Engine

---

## 6.1 Purpose

Automatically surface high-value explanations such as:

* Primary drivers of change
* Concentration of impact
* Structural vs financial causes
* Cascading effects

---

## 6.2 Insight Model

```ts
type InsightType =
  | 'top_driver'
  | 'concentration'
  | 'anomaly'
  | 'cascade'
  | 'structural_change';

interface Insight {
  type: InsightType;

  title: string;
  description: string;

  entities: string[];
  contributingEvents: string[];

  confidence: number; // 0–1
}
```

---

## 6.3 Insight Categories

---

### A. Top Driver Analysis

Identify largest contributors:

```ts
sortBy(|delta| desc)
take top N
```

Example:

```text
"80% of total variance driven by 2 adjustments"
```

---

### B. Concentration Analysis

```ts
concentration = sum(top_k) / total
```

Trigger if:

* > 0.7 (configurable)

---

### C. Anomaly Detection

Detect:

* unusually large adjustments
* rare event types
* deviations from baseline

---

### D. Cascade Detection (Graph-aware)

If:

* edge changes
* downstream nodes affected

Then:

```text
Edge E1 change propagated to Node N3 and N7
```

Requires:

* dependency graph traversal

---

### E. Structural Change Detection

Identify:

* new nodes/edges
* removed structures

---

## 6.4 Insight Generation Pipeline

```ts
function generateInsights(diff: BranchDiffResult): Insight[] {
  return [
    ...topDriver(diff),
    ...concentration(diff),
    ...anomalies(diff),
    ...cascades(diff),
    ...structural(diff)
  ];
}
```

---

## 7. Performance Design

---

### 7.1 Snapshot Optimization

* Use nearest snapshot per branch
* Replay only delta events

---

### 7.2 Hash Comparison

```ts
if (hashA === hashB) return no_diff;
```

---

### 7.3 Incremental Diff

Cache:

```ts
(branchId, time) → state + hash
```

---

### 7.4 Entity Indexing

```ts
Map<entityId, Event[]>
```

Enables:

* targeted diff
* faster causal lookup

---

## 8. UI Integration

---

### 8.1 Diff View

* Side-by-side or overlay
* Highlight deltas

---

### 8.2 Timeline Integration

* Mark divergence point
* Show branch-specific segments

---

### 8.3 Drill-down

User can:

* click entity → see chain
* inspect contributing events

---

### 8.4 Insight Panel

Display:

```text
Top Drivers:
- Entry E1 (-20)
- Edge E2 (-10)

Insights:
- 75% of variance from 2 events
- Cascade detected across 3 nodes
```

---

## 9. API Design

---

### 9.1 Diff Endpoint

```http
POST /diff
```

```json
{
  "branchA": "main",
  "branchB": "scenarioA",
  "time": 123456,
  "mode": "as_of"
}
```

---

### 9.2 Response

```json
{
  "divergenceSequence": 123,
  "stateDiff": {...},
  "causalAnalysis": [...],
  "insights": [...]
}
```

---

## 10. Validation Requirements

---

### 10.1 Determinism

* Same input MUST yield identical output

---

### 10.2 Adjustment Correctness

* Effective values MUST match ledger rules

---

### 10.3 Cross-Domain Consistency

* Financial + graph outputs MUST align

---

## 11. Testing Strategy

---

### 11.1 Unit Tests

* Divergence detection
* Chain resolution
* insight generation rules

---

### 11.2 Integration Tests

* Full branch diff scenarios
* Large event streams

---

### 11.3 Property Tests

* Replay invariance
* no false positives in identical branches

---

## 12. Anti-Patterns

---

* Diffing raw events only
* Ignoring adjustment chains
* Ignoring causality
* Generating insights without confidence scoring

---

## 13. Summary

This system provides:

* Deep, causal understanding of branch differences
* Integrated financial + simulation comparison
* Automated explanation layer

It transforms diffing from:

> “What changed?”

into:

> “What changed, why it changed, and what it means.”

---

## 14. Next Extensions

* ML-based insight ranking
* Natural language explanation generation
* Interactive causal graphs
* Merge recommendation engine
