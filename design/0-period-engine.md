# Period Engine (UTC Epoch-Based)

## Technical Design + Requirements Specification

---

## 1. Overview

The Period Engine is a **general-purpose temporal abstraction system** that:

- Represents time using **UTC epoch milliseconds**
- Supports **multiple overlapping calendar hierarchies**
- Enables **deterministic period resolution and aggregation**
- Serves as a foundational layer for finance, simulation, and analytics systems

---

## 2. Core Design Principles

### 2.1 Time is Absolute

All periods are defined as:

```ts
startMs <= ts < endMs
````

* UTC only
* No timezone ambiguity
* No implicit calendar assumptions

---

### 2.2 Periods Form a DAG (Not a Tree)

The system models time as a:

> **Directed Acyclic Graph (DAG)**

Where:

* A period can have **multiple parents**
* A period can belong to **multiple hierarchies simultaneously**

Example:

```
Jan 2024
 ├── US Year 2024
 └── AU Year 2023-2024
```

---

### 2.3 Hierarchy is Explicit

No relationships are inferred.

All parent-child relationships must be explicitly defined.

---

## 3. Data Model

### 3.1 Period

```ts
type PeriodType = 'MONTH' | 'YEAR_US' | 'YEAR_AU'

type Period = {
  id: string
  type: PeriodType
  name: string
  startMs: number   // inclusive
  endMs: number     // exclusive
  metaData?: {} //Optional auxilary data
}
```

---

### 3.2 PeriodRelationship

```ts
type PeriodRelationship = {
  parentId: string
  childId: string
  ordinal?: number   // ordering within parent (e.g., month 1–12)
}
```

---

## 4. Concrete Dataset (Derived from CSV)

### 4.1 Atomic Periods (Months)

Example:

```ts
{
  id: 'M-2024-01',
  type: 'MONTH',
  name: 'Jan/2024',
  startMs: 1704067200000,
  endMs: 1706745600000
}
```

---

### 4.2 Composite Periods

#### US Calendar Year

```ts
{
  id: 'US-2024',
  type: 'YEAR_US',
  name: '2024',
  startMs: 1704067200000,
  endMs: 1735689600000
}
```

#### AU Fiscal Year

```ts
{
  id: 'AU-2023-2024',
  type: 'YEAR_AU',
  name: '2023-2024',
  startMs: 1688169600000,
  endMs: 1719792000000
}
```

---

### 4.3 Relationships

```ts
{ parentId: 'US-2024', childId: 'M-2024-01', ordinal: 1 }

{ parentId: 'AU-2023-2024', childId: 'M-2024-01', ordinal: 7 }
```

---

## 5. Indexing Strategy

### 5.1 Core Indexes

```ts
periodById: Map<string, Period>

childrenByParent: Map<string, PeriodRelationship[]>

parentsByChild: Map<string, PeriodRelationship[]>
```

---

### 5.2 Time Index

```ts
periodsByStart: Period[] // sorted by startMs
```

---

### 5.3 Optional (Scale Optimization)

* Interval tree for time queries
* Precomputed rollup caches

---

## 6. Core APIs

---

### 6.1 `getPeriodsAt(ts)`

#### Purpose

Return all periods containing a timestamp.

#### Signature

```ts
function getPeriodsAt(ts: number): Period[]
```

#### Example

```ts
getPeriodsAt(Date.parse('2024-01-15'))
```

Returns:

```ts
[
  M-2024-01,
  US-2024,
  AU-2023-2024
]
```

#### Implementation

```ts
function getPeriodsAt(ts: number): Period[] {
  const result: Period[] = []

  for (const p of periodsByStart) {
    if (p.startMs <= ts && ts < p.endMs) {
      result.push(p)
    }
  }

  return result
}
```

---

### 6.2 `rollup(periodId)`

#### Purpose

Return all **leaf descendant periods** under a given period.

#### Signature

```ts
function rollup(periodId: string): Period[]
```

#### Example

```ts
rollup('US-2024')
```

Returns:

```ts
[ M-2024-01 ... M-2024-12 ]
```

#### Implementation

```ts
function rollup(periodId: string): Period[] {
  const result: Period[] = []
  const stack = [periodId]

  while (stack.length) {
    const current = stack.pop()!
    const children = childrenByParent.get(current) || []

    if (children.length === 0) {
      result.push(periodById.get(current)!)
    } else {
      for (const rel of children) {
        stack.push(rel.childId)
      }
    }
  }

  return result
}
```

---

### 6.3 `aggregate(periodId, metricFn)`

#### Purpose

Aggregate values across all leaf periods under a parent.

#### Signature

```ts
function aggregate(
  periodId: string,
  metricFn: (period: Period) => number
): number
```

#### Behavior

* Expands period via `rollup`
* Applies metric function
* Returns aggregated result

#### Example

```ts
aggregate('US-2024', (p) => revenueByPeriod[p.id])
```

#### Implementation

```ts
function aggregate(
  periodId: string,
  metricFn: (period: Period) => number
): number {
  const leaves = rollup(periodId)

  let total = 0
  for (const p of leaves) {
    total += metricFn(p)
  }

  return total
}
```

#### Variants

* Weighted aggregation:

```ts
metricFn(period) => value * weight
```

* Multi-metric aggregation (return object instead of number)

---

### 6.4 `getParents(periodId)`

```ts
function getParents(periodId: string): Period[] {
  return (parentsByChild.get(periodId) || [])
    .map(rel => periodById.get(rel.parentId)!)
}
```

---

### 6.5 `getPath(periodId, targetType)`

#### Purpose

Traverse upward to a specific hierarchy.

#### Example

```ts
getPath('M-2024-01', 'YEAR_AU')
// → AU-2023-2024
```

---

## 7. Engine Behavior

### 7.1 Multi-Hierarchy Support

A single timestamp maps to multiple valid period contexts.

---

### 7.2 Deterministic Resolution

All queries are:

* Pure functions
* Deterministic
* Based solely on time + graph

---

### 7.3 No Implicit Logic

The engine must never infer:

* Calendar membership
* Period grouping

Everything must come from data.

---

## 8. Validation Rules

### 8.1 No Cycles

Graph must remain acyclic.

---

### 8.2 Time Consistency

For every relationship:

```ts
child.startMs >= parent.startMs
child.endMs <= parent.endMs
```

---

### 8.3 Full Coverage (Optional)

Ensure no gaps in required hierarchies.

---

## 9. Extension Points

### 9.1 Additional Period Types

* QUARTER
* WEEK (ISO)
* CUSTOM_FISCAL

---

### 9.2 Alternative Calendars

* Retail 4-5-4
* Academic calendars
* Simulation timelines

---

### 9.3 Precomputed Aggregates

* Cached rollups
* Incremental updates
* Event-driven recomputation

---

## 10. Integration Considerations

### 10.1 With Simulation Systems

* Time scrubbing maps directly to `getPeriodsAt`
* Branching timelines reuse same structure

---

### 10.2 With Financial Systems

* Multi-calendar reporting (US vs AU)
* Consistent aggregation across hierarchies

---

### 10.3 With Analytics

* Period slicing
* Multi-dimensional rollups

---

## 11. Key Insight

This system is not just a calendar.

It is:

> A **time-indexed, multi-hierarchy aggregation graph**

That cleanly separates:

* **Time (intervals)**
* **Structure (relationships)**
* **Computation (aggregation)**

---
