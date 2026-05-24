# Branch Merge & Reconciliation Engine

## Technical Design + Requirements Specification

---

## 1. Purpose

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

## 2. Core Principle

> A merge is **not** copying events — it is **reconciling intent under constraints**

Key constraints:

* Financial immutability (no rewriting history)
* Period enforcement (closed periods cannot change)
* Event causality preservation

---

## 3. Merge Types

---

### 3.1 Fast-Forward Merge

* Branch has no divergence beyond parent
* Simply advances pointer

```text id="1xj8c6"
main:    E1 → E2 → E3
branch:  E1 → E2 → E3 → E4 → E5

Result:
main:    E1 → E2 → E3 → E4 → E5
```

---

### 3.2 Reconciliation Merge (Primary)

* Branch diverges
* Requires:

    * Diff analysis
    * Conflict detection
    * Resolution plan

---

### 3.3 Selective Merge

* Only subset of events/entities merged
* Requires entity-level filtering

---

## 4. Merge Pipeline

```text id="9y7s2h"
1. Diff
2. Conflict Detection
3. Resolution Planning
4. Validation
5. Merge Execution
6. Audit Recording
```

---

## 5. Inputs / Outputs

---

### 5.1 Input

```ts id="hxg61n"
interface MergeRequest {
  sourceBranch: string;
  targetBranch: string;

  time: number;
  mode: 'as_of' | 'as_recorded';

  strategy: 'auto' | 'manual' | 'hybrid';

  entityScope?: string[];
}
```

---

### 5.2 Output

```ts id="6h8q6w"
interface MergeResult {
  status: 'success' | 'conflict' | 'rejected';

  mergedEvents: Event[];

  conflicts: Conflict[];

  appliedResolutions: Resolution[];

  auditId: string;
}
```

---

## 6. Conflict Detection

---

### 6.1 Conflict Definition

A conflict exists when:

> Two branches modify the same logical entity differently after divergence

---

### 6.2 Conflict Types

---

#### A. Financial Conflict

```text id="o6rrcq"
Entry E1:
  main:   100
  branch: 80
```

---

#### B. Simulation Conflict

```text id="lwh2y5"
Edge E1:
  main:   weight 100
  branch: weight 70
```

---

#### C. Structural Conflict

* Node/edge exists in one branch but not the other

---

#### D. Period Conflict

* Branch modifies data belonging to a closed period in target

---

### 6.3 Detection Algorithm

```ts id="sx3y89"
function detectConflicts(diff: BranchDiffResult): Conflict[] {
  return diff.stateDiff.entities
    .filter(e => e.amountA !== e.amountB)
    .map(e => classifyConflict(e));
}
```

---

## 7. Resolution Strategies

---

### 7.1 Strategy Types

```ts id="k9q3wv"
type ResolutionStrategy =
  | 'take_source'
  | 'take_target'
  | 'merge_delta'
  | 'create_adjustment'
  | 'manual';
```

---

### 7.2 Financial Resolution Rules

---

#### Closed Period

* MUST NOT modify original entries
* MUST create **adjustment events**

---

#### Open Period

* MAY allow direct adoption of source events

---

#### Merge via Adjustment (preferred)

```ts id="8uyw7t"
delta = sourceValue - targetValue

createAdjustment(targetEntry, delta)
```

---

### 7.3 Simulation Resolution Rules

---

#### Edge/Node Updates

* Apply delta events
* Maintain causality via `correlationId`

---

#### Structural Conflicts

* Either:

    * Create missing entities
    * Reject merge

---

## 8. Resolution Planning Engine

---

### 8.1 Objective

Produce a **deterministic merge plan**

---

### 8.2 Output

```ts id="p8c9rl"
interface Resolution {
  conflictId: string;

  strategy: ResolutionStrategy;

  resultingEvents: Event[];

  explanation: string;
}
```

---

### 8.3 Planning Logic

```ts id="c1qlx3"
for each conflict:
  if financial && closedPeriod:
    strategy = create_adjustment
  else if no conflict:
    strategy = take_source
  else:
    strategy = manual or merge_delta
```

---

## 9. Automated Merge Insights

---

### 9.1 Purpose

Guide user or system in choosing resolution strategies

---

### 9.2 Insight Types

---

#### A. Risk Analysis

```text id="7p0g6h"
"Merge affects 3 closed periods — high risk"
```

---

#### B. Impact Analysis

```text id="n1i8rs"
"85% of change driven by 2 entries"
```

---

#### C. Conflict Concentration

```text id="q8d8e3"
"Conflicts concentrated in 1 node and 2 edges"
```

---

#### D. Suggested Strategy

```text id="7rz0ju"
"Recommended: apply adjustments instead of overwrite"
```

---

### 9.3 Insight Model

```ts id="mbh0o2"
interface MergeInsight {
  type: string;

  severity: 'low' | 'medium' | 'high';

  description: string;

  suggestedAction?: ResolutionStrategy;
}
```

---

## 10. Merge Execution

---

### 10.1 Rules

* MUST append new events only
* MUST NOT rewrite existing events
* MUST preserve:

    * causationId
    * correlationId

---

### 10.2 Execution Algorithm

```ts id="l7c2r3"
function executeMerge(plan: Resolution[]) {
  for (const r of plan) {
    for (const event of r.resultingEvents) {
      append(event);
    }
  }
}
```

---

## 11. Audit Trail

---

### 11.1 Merge Event

```ts id="z9i0d1"
type: 'branch.merged'
payload: {
  sourceBranch,
  targetBranch,
  resolutionSummary,
  timestamp
}
```

---

### 11.2 Requirements

* Every merge MUST be auditable
* Must include:

    * conflicts
    * resolutions
    * actor

---

## 12. Validation Layer

---

### 12.1 Pre-Merge Validation

* Period constraints enforced
* Adjustment rules validated
* Graph consistency checked

---

### 12.2 Post-Merge Validation

* Replay merged branch
* Ensure:

    * no invariant violations
    * consistent state

---

## 13. API Design

---

### 13.1 Preview Merge

```http id="y7p1fj"
POST /merge/preview
```

Returns:

* conflicts
* insights
* proposed resolutions

---

### 13.2 Execute Merge

```http id="z2pn6x"
POST /merge/execute
```

---

## 14. Performance Considerations

---

### 14.1 Incremental Merge

* Only process divergent events

---

### 14.2 Snapshot Use

* Pre/post merge snapshots

---

### 14.3 Parallel Conflict Detection

* Partition by entityId

---

## 15. Security / Permissions

---

* Only authorized users can merge into `main`
* Optional:

    * approval workflows
    * multi-signature merges

---

## 16. Testing Requirements

---

### 16.1 Conflict Scenarios

* financial-only conflicts
* simulation-only conflicts
* mixed conflicts

---

### 16.2 Determinism

* repeated merge MUST yield same result

---

### 16.3 Adjustment Integrity

* no incorrect overwrites

---

## 17. Acceptance Criteria

---

System is complete when:

* Branch diff feeds merge engine
* Conflicts detected accurately
* Resolution strategies applied correctly
* Merge produces valid, replayable state
* Audit trail is complete

---

## 18. Anti-Patterns

---

* Overwriting historical events
* Ignoring period constraints
* Mixing direct edits with adjustments
* Non-deterministic merge behavior

---

## 19. Summary

This system enables:

* Safe integration of scenario branches
* Financially correct reconciliation
* Simulation-consistent merges
* Insight-driven decision making

It transforms your platform into:

> A fully auditable, multi-branch, decision-support system with controlled convergence

---

## 20. Next Steps (Optional)

* Interactive merge UI with guided resolution
* ML-assisted merge recommendations
* Real-time collaborative branching
