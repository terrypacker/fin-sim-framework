---
id: reducer
kind: node
title: Reducer
node: reducer
panels: [config-list, config-graph, journal-report]
design: [2-unified-event-schema.md, 16-journal-reporting-plugin.md]
sources: [src/simulation-framework/reducers.js]
stamps:
  panel:config-list: 786f94
  panel:config-graph: bbebb1
  panel:journal-report: e88448
  node:reducer: 445aa6
  src/simulation-framework/reducers.js: fcfeea
---

The only thing in the engine allowed to change a balance. A reducer registers against
an [action](action.md) type; when an action of that type is applied it produces the
next state, and the [journal](../concepts/event-sourcing.md) records the execution.
Balances are a consequence of that record, not a thing stored beside it.

Reducers are pure with respect to the run: given the same state, action and date they
produce the same next state, which is what makes a run byte-reproducible and the
golden fixtures possible at all.

Open one to see which action types reach it and what it wrote — the graph lights it as
it fires, and [Journal Report](../panels/journal-report.md) queries the entries it
produced.

Two facts worth holding before authoring one. **Priority is a within-date ordering,
not a schedule**: everything registered for an action runs, in priority order, lowest
first, so a cash movement is applied before the tax layer reads it and long before the
metrics layer records it. And **one action applied by two reducers writes two journal
entries** — that is the ledger being honest about two writes, but it double-counts any
report that sums by action type instead of filtering on the reducer.

## Fields

- `name` — The label on the node, in the graph and on every journal entry this reducer writes. Free text, and worth choosing well: it is the name you will filter journal entries by.
- `type` — Which reducer implementation this node is. It decides what the reducer writes and which sub-editor appears below. Not to be confused with the action type it consumes — that is a registration, made where the action is wired.
- `priority` — Where this reducer runs within a single date, lowest first: pre-process (10), cash flow (20), position update (30), cost basis (40), tax calculation (60), tax apply (70), metrics (90), logging (100). Reading a value another reducer has not written yet is a priority mistake, not a logic one, and it shows up as a stale number rather than an error.
- `accountKey` — The state key of the account this reducer credits or debits, e.g. usSavingsAccount. It must name an account the plan actually registered; a key that resolves to nothing leaves the transaction with nowhere to land.
- `fieldName` — The state field this reducer writes. On a scripted reducer it is optional: blank lets the script return a partial state object and patch several fields at once.
- `value` — A fixed value to write on every firing. Blank takes the value from the action being applied, or from the state — which is the difference between a reducer that models a rule and one that hard-codes an answer.
- `script` — Inline JavaScript of the shape (state, action, date), returning a value when a target field is set, or a partial state to merge when it is not. For prototyping. Test it with the button beside the box before running, because a throw here stops the run at that date.
