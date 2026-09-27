# 114 — Pool shapes that inherit, and a pool editor that fits its panel

**Status:** PHASE 1 BUILT, 26 Sep 2026 (§11); phases 2–6 proposed. Picks up design 112 §7 (shapes that reference pools) and
reworks the pool authoring surface built across design 97 §17.1/§21/§22.5, design 109 §11 and
design 110 Leg A. Decisions D1–D5 (§3) and the scope of Part II (S1–S6) were taken with the
author before drafting. The MC and Opt panels are deliberately last (§9, phase 6). Open
questions are in §10.

---

## 1. The ask

A later shape is almost always the earlier one with a few changes. Today a shape is a complete
copy of a graph (`liquidityShapes`, design 109 §4 Q1), made with `+ Duplicate`, and nothing
links the copy to what it was copied from:

- an edit to a pool in the base has to be repeated in every shape that carries it, and a
  missed copy diverges silently;
- the author cannot see *what* a shape changes — the diff line (design 109 §11) reports pools
  added and retired, never a pool whose settings differ.

The author named two use cases, and review added four:

1. **A small change to an existing shape** — a spend order, a gate threshold, one pool added
   or retired.
2. **A completely new shape** — a different structure, started blank or from a copy.
3. **Edit once, apply everywhere** — a change to a carried pool reaches every shape that did
   not deliberately change it. This, rather than the first copy, is the real cost of copying.
4. **Stages that build on each other** — accumulate → bridge → pension-age, each the previous
   stage plus or minus a pool.
5. **Converting existing plans** — shapes authored as copies should shrink to their
   differences mechanically, not by hand.
6. **The search levers keep working** — gate axes, `targetScale`, the shape-year axis and
   MPC's `POOL_SHAPE` all read shapes.

Separately, the author asked for the whole pool authoring surface to be looked at: it has grown
by accretion and is hard to read.

## 2. What the surface looks like today (audited on the author's plan)

The audit was done in the running app, on a plan with a nine-pool, seven-flow base graph and
one scheduled shape.

- **Most values cannot be read.** The Parameters panel is about 600px wide. The pools table
  has 10 columns and the flows and gate tables have 9 each, so nearly every cell is
  truncated: ids, spend numbers, sizes and flow endpoints are unreadable without clicking in.
- **The `Remainder of` checkset stretches its row** to one line per pool name, about nine
  lines on that plan.
- **A shape repeats everything.** The base editor is about 2,400px tall and the shape repeats
  all of it. On that plan the shape differed from the base in **one field of one pool**
  (a spend order); the other eight pools and all seven flows were identical.
- **The pool params are scattered.** Each is its own row in the Parameters list under
  `Spending`, alphabetically mixed with unrelated params (the paycheck switches sit between
  the pool switches and the shapes).
- **The target schedule shows every MPC row.** A session that re-decides every year writes a
  row per pool per year; on that plan 30 rows took about 1,000px, although design 112 R13
  already renders them as one line per run above the table.

---

# Part I — shapes that inherit

## 3. Decisions (taken with the author)

- **D1 — inheritance, not a pool library.** A shape names a parent and stores only its
  differences. Design 112 §7's `{ ref: 'cash' }` library was rejected: names are identity
  (design 109 §9), so two variants of one pool would need either two library ids (a switch
  between them retires one pool and cold-starts the other) or a reference plus an override,
  which is this design with an extra table. An edit-list schedule ("2035: add `bridge`") was
  rejected too: what governs in 2040 would be a fold of every earlier row, which is design
  109 Q1's per-pool timeline by another route.
- **D2 — an override replaces a whole pool or a whole flow.** No field-level merge. A gate is
  a clause tree and a pool's claims are a list; merging either needs a rule (replace or append?)
  the author cannot see. The editor still shows which fields differ, derived for display (§7.3).
- **D3 — chains are allowed.** A shape may extend another shape, not only the base; use case 4
  needs it. Cycles are refused.
- **D4 — conversion is a button.** `Convert to inherit from X` computes the delta and proves it
  (§5.3).
- **D5 — `+ New shape` offers Blank, Inherit from X, or Copy of X.** Copy stays, for use case 2
  with a starting point and no ongoing link.

## 4. The authored form

A shape with no `extends` is exactly today's form — a whole graph — so every existing plan
means what it meant. A shape with `extends` is a delta:

```js
liquidityShapes: {
  bridge: {
    extends: 'base',                 // the base graph, or another shape's id
    pools:  [ { id: 'reserve', ... } ],    // an id the parent has ⇒ REPLACES it; a new id ⇒ ADDED
    flows:  [ { id: 'growth-to-bridge', ... } ],
    remove: { pools: ['offset'], flows: ['offset-to-cash'] },
  },
  pension: { extends: 'bridge', pools: [ ... ] },
}
```

- `extends: 'base'` names `liquidityGraph`. `base` becomes a reserved shape id; a shape
  authored under that id is refused at load, naming the rename needed (§10 Q1).
- A pool override carries its own `claims` — claims live inside a pool, so D2 makes them part
  of the override.
- `remove` of an id the parent does not have is refused: it is either a typo or a parent that
  changed underneath the shape, and both should be seen.
- A pool or flow in the delta that is deep-equal to the parent's is legal and inert, but the
  editor reports it (§7.3) so an override that no longer overrides anything is visible.

## 5. Expansion — one function, every reader

### 5.1 The rule

`expandLiquidityShapes(liquidityGraph, liquidityShapes) → { <shapeId>: fullGraph }` is pure and
lives in a leaf module (MPC's `lever-schedule.js` may import leaf modules only). Resolution:

1. Resolve the parent first (recursively), then apply the delta.
2. **Order is preserved:** the result is the parent's pools and flows in the parent's order,
   an override in its parent's position, removed ids dropped, and additions appended in delta
   order. This is what lets conversion be byte-identical (§5.3).
3. The result carries no `extends` and no `remove`, so expansion is idempotent and an expanded
   bag can be passed anywhere a raw one could.
4. A cycle (`a → b → a`), an unknown parent, or a `remove` of an absent id throws, naming the
   shape and the chain.

**Every reader of `liquidityShapes` calls it.** Twelve sites outside the loader read the raw
value today: the schedule and target-schedule editors, `scenario-param-generator`,
`pool-shape-year-axis`, `pool-target-scale` (three), `pool-gate-axis`, `pool-axis-hygiene`,
`cockpit-controller` (two) and `lever-schedule` (two). A reader that skips expansion sees a
delta shape — no inherited pools — and the failure is quiet: a gate axis finds no flow to move,
or `targetScale` reports a pool as absent from a shape that inherits it. That is exactly the
dead-lever shape the pool-axis work already paid for twice (`pool-axis-dropped-by-toolset-
forwarding`, `zero-target-axis-was-a-dead-lever`). So a **hygiene test** walks `src/` and fails
on any `.liquidityShapes` read outside `expandLiquidityShapes` and an explicit allow-list (the
authored-value writers: the editor's `sync` and the scenario serializer).

**Why not expand once in the loader and write the result back into the bag:** the authored
form has to survive for the editor and for save, and the bag is what MC and Opt forward
(`forwardToolsetOverrides`). Writing the expanded form back would save every plan as copies
again the first time it was opened and saved.

### 5.2 Validation

Everything design 109 §12 validates runs on the **expanded** graph, unchanged. Two messages
change so the author is sent to the right place:

- A dangling reference (a flow into a pool the shape removed) names the flow as *inherited from
  `<parent>`* and suggests removing it too — the editor offers that as one action (§7.3).
- `_warnResurrectedPools` (a pool id that disappears and reappears across the schedule) runs on
  expanded shapes; with chains it is easier to trigger by accident, so it matters more.

### 5.3 Conversion

`Convert to inherit from X` on a standalone shape:

1. delta = pools/flows not deep-equal to X's, plus `remove` for X's ids the shape lacks;
2. **prove it:** `expand(X ⊕ delta)` must deep-equal the original shape, order included;
3. if it does not — the shape reorders items relative to X — refuse and say so, rather than
   change the order the run sees.

A converted plan is therefore byte-identical in simulation by construction, and the golden
fixture harness checks it (§8).

## 6. What does not change

- **The whole-graph rule** (design 109 Q1). Every shape is still one complete graph when it is
  compiled, validated and cycle-checked. Inheritance is authoring sugar, resolved before any
  of that runs.
- **The schedule**, `shape: null` for the base, MPC's `POOL_SHAPE` lever and recorded runs
  (design 81): they select shape ids, and ids do not change.
- **Gate axes apply by flow id** across every shape (`pool-gate-axis.js`), now over expanded
  shapes, so an inherited flow is moved with its parent's — which is the behaviour use case 3
  asks for.

---

# Part II — the pool editor

## 7. The editor

### 7.1 S4 — one Liquidity Pools group

The pool params move into one group, rendered in a fixed order:

1. **Switches** on one line: Liquidity Pools Enabled, Pool Refill Flows Enabled.
2. **Structure** — one composite editor over `liquidityGraph` + `liquidityShapes` (§7.2).
3. **Schedule** (`liquidityGraphSchedule`).
4. **Target schedule** (`liquidityTargetSchedule`, §7.6).

Two neighbours are explained in the group, not moved:

- `poolCashYears` / `poolBondYears` size the **allocation mix** (design 97 §9), not the pool
  graph, despite the name. A one-line note says so and links to them.
- `drawdownSequence` is the older spend-order authority, and authoring it beside a graph
  throws. With a graph present and enabled, it renders as "superseded by the pool graph"
  rather than as an input.

The group is the toolset's `group` field. The MC config panel and the sweep variable table also
group by it, so this change moves rows there too (§10 Q2).

### 7.2 S5 — shapes as tabs

One structure is shown at a time:

```
[ Base ]  [ bridge · from 2035 ]  [ pension · from 2045 ]  [ + New shape ▾ ]
```

- A tab carries the schedule years that select it (a shape scheduled twice shows both); a shape
  no row selects is marked `unscheduled` — design 109 §12 rule 3's warning, now visible where
  the shape is.
- The tab header holds the shape id, **Extends** (a select over Base and the other shapes,
  cycles not offered), `Convert to inherit…` (standalone shapes only) and Remove.
- `+ New shape` offers Blank, Inherit from X, Copy of X (D5).

### 7.3 An inheriting shape's tab

The four tables hold only the shape's **own** rows — overrides and additions. Above them:

- **The diff line, against the parent** (replacing design 109 §11's "vs previous"):
  `vs base: 8 inherited · 1 overridden (reserve: spendOrder) · 0 added · 0 removed`. The
  overridden fields are derived by comparing with the parent, for display only (D2).
- An override row is marked `overrides <parent>.<id>`, with **Revert** (drop the row, inherit
  again). An override deep-equal to its parent is marked `no longer differs`.

Below them, collapsed by default: **Inherited from `<parent>`** — the parent's pools and flows
as one-line summaries, each with **Override** (copy that one item into the shape's tables) and
**Remove**. Removed items are listed with **Restore**.

Select options in a shape's tables (a flow's From/To, a claim's pool, a gate's flow) offer the
**expanded** id set, since a local flow may point at an inherited pool. The readouts (compiled
spend order, what each pool holds, gates as sentences — design 110 §4.2) render the
**expanded** shape; that is the graph the run uses.

### 7.4 S1 — core and advanced columns, with no hidden decisions

| Table | Core (always shown) | Advanced (behind **More columns**) |
|---|---|---|
| Pools | Id, Spend #, Target, Size, Remainder of | Label, While in, Early access, Capacity, Cap size |
| Flows | Id, From → To, Trigger, at, Amount | Priority, Cadence, f |
| Gate clauses | Flow, OR #, Sense, Clause, X, Measured against, For N yrs, Vetoes | Search id |

Every advanced column does something (While in is how a float empties abroad — design 107
§15.3; Capacity is what bounds an offset pool — design 97 §24), so hiding a column must never
hide a decision: **a non-default value in a hidden column renders as a badge on the row**
(`US only`, `cap: offset`, `ALLOW_PENALTY`, `annual`). Defaults are the ones `sync` already
omits from the saved value, so "non-default" has one definition.

This needs one addition to `row-list-editor`: `col.optional` plus a row badge function. The
toggle is a per-viewer UI preference, not scenario data.

### 7.5 S2 and S3 — one-line rows, and focusing a pool

- **S2.** `Remainder of` renders as a summary — `after float, reserve` — and opens
  the checkset on click. Rows stay one line tall. This is a `checkset` display option in
  `row-list-editor`, not a new column type.
- **S3.** A **Show rows for** select above the tables (All pools, or one pool id) filters the
  claims, flows (from *or* to) and gate tables to the rows that involve that pool. Storage stays
  three flat tables joined by id (design 97 §17.1); this is a view filter only. A row added while
  focused defaults to the focused pool.

### 7.6 S6 — the target schedule opens collapsed

It opens on the one-line-per-run summary it already renders (design 112 R13), with the rows
behind `Show N rows`. Adding a row expands it.

## 8. Test plan

Part I:

1. **Absent ⇒ byte-identical.** No shape uses `extends`: every golden fixture unchanged.
2. **Conversion is byte-identical.** A fixture plan with a copied shape, converted, simulates to
   the same whole-state JSON as before; the saved shape shrinks to its delta.
3. **Expansion unit tests:** override in place, addition order, remove, chains of three,
   cycle refused, unknown parent refused, `remove` of an absent id refused, idempotence.
4. **Readers see inherited pools:** a gate axis on a flow the shape inherits moves it in that
   shape; `targetScale` describes an inherited pool in every shape; the shape-year axis and
   `POOL_SHAPE` select a delta shape and run its expanded graph.
5. **Hygiene:** the `src/` walk fails on a raw `.liquidityShapes` read outside the allow-list.

Part II (`tests/viz/structured-param-editors.test.mjs`):

6. A delta shape round-trips through the editor unchanged (no expansion leaks into the saved
   value).
7. Override → edit → Revert restores inheritance; Remove → Restore likewise.
8. A hidden advanced column with a non-default value shows its badge; toggling columns does not
   change the saved value.
9. Focus filters rows and never drops unfocused rows from the saved value.

## 9. Phasing

1. **Expansion + validation** (§5): the leaf module, every reader moved onto it, hygiene test,
   conversion function. No UI. Gate: tests 1–5.
2. **Shape tabs and the inheriting tab** (§7.2, §7.3), including New shape and Convert.
3. **`row-list-editor` additions and the columns** (§7.4, §7.5 S2).
4. **Focus, the group, the target schedule** (§7.5 S3, §7.1, §7.6).
5. **Help:** param descriptions for `liquidityShapes` (the delta form) and the regrouped params;
   `pool-shapes-over-time` and `liquidity-pools` topics updated; `help:build` and restamp.
6. **MC and Opt panels** — grouping of the pool levers there, once the Parameters surface is
   settled (the author's ordering). Phase 4's group change is checked against these panels and
   anything it moves is tidied here.

## 10. Open questions

- **Q1 — the reserved `base` id.** Reserving it is simplest, and the schedule already names the
  base without a shape id (`shape: null`). A plan that already has a shape called `base` would
  be refused at load until renamed. Alternative: `extends: null` meaning the base, which reads
  as "extends nothing". Proposed: reserve `base`.
- **Q2 — the group change reaches MC/Opt early.** Changing `group` moves pool levers in the MC
  and Opt panels in phase 4, before phase 6 designs them. Alternatives: a Parameters-view-only
  grouping (a second grouping authority, which is what the one-field `group` exists to avoid),
  or holding the group change until phase 6. Proposed: change `group` in phase 4, accept the
  interim move, tidy in phase 6.

## 11. As built — phase 1 (26 Sep 2026)

`src/finance/pools/pool-shape-expansion.js` (leaf, no imports) holds `expandLiquidityShapes`,
`applyShapeDelta`, `shapeLineage`, `shapeDeltaAgainst` and the reader helpers
`poolGraphEntries`, `poolGraphFor`, `expandedShapesOf`, `liquidityShapeIds`. Q1 and Q2 were
taken as proposed. What the build decided that the text above did not:

1. **Lenient expansion.** Readers that run on an unloaded bag (the axis lists, the hygiene report,
   MPC) expand with `{ lenient: true }`: a shape that cannot be expanded comes back as authored
   instead of throwing, so a broken plan never takes a panel down. The loader runs strict and is
   the only authority on the refusal.
2. **The gate's allow rule** is a line marker, `// shapes: raw-ok (<reason>)`, plus a structural
   pass-through rule (a read that is the value of a `liquidityShapes:` property — a bag being
   built for a helper that expands it). The gate parses `src/` with Babel and was checked
   against a probe file with two raw reads.
3. **A delta's cells stay raw.** `_shapeCellProblems` reads the authored delta so a problem's
   `index` points at the row the editor will show (§7.3); an inherited pool's cells are reported
   once, in the graph that authors them.
4. **An ancestor's refusal skips its descendants.** A bad base cell, or a base graph whose
   whole-graph pass fails, adds `base` to the dirty set, and `_normalizeShapes` skips every shape
   whose lineage reaches a dirty ancestor — otherwise the parent's error was re-reported under
   each child.
5. **Conversion treats an absent list and an empty one as the same graph** (the normalizer reads
   both as `[]`); a copy with no `flows` whose parent's flows are all removed would otherwise be
   refused. Everything else is compared strictly, arrays by position.

Measured on the author's plan: its one shape converts cleanly to a single pool override, about a
tenth of the authored size. Tests: `pool-shape-expansion.test.mjs` (29, including two whole-run
byte-identity checks) and `pool-shape-expansion-hygiene.test.mjs` (2).
