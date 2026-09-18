---
id: event-sourcing
kind: concept
title: Event Sourcing
panels: [journal-report, action-detail, lineage]
design: [2-unified-event-schema.md, 16-journal-reporting-plugin.md, 91-journal-payload-manifest.md]
sources: [src/simulation-framework/journal.js]
stamps:
  panel:journal-report: e88448
  panel:action-detail: 863051
  panel:lineage: 87213c
  src/simulation-framework/journal.js: c6d854
---

Nothing in this simulation holds a balance that someone set. Every number is the
result of replaying a stream of dated events, in order, from the opening state.

An **event** is a financial moment: a payday, a month boundary, a settle date. It
carries no money of its own — it is a time at which something is due to happen. An
**action** is the money movement or decision that a handler emits when an event
fires: sell these units, pay this tax, convert this much. A **reducer** applies one
action to the state and produces the next state; it is the only thing in the system
allowed to change a balance.

The **journal** is the ordered record of every one of those reducer executions, and
it is the ledger in the accounting sense: the balances are a consequence of it, not
a thing stored beside it. That is what makes the questions this tool exists to answer
askable at all. "Where did this $40,000 come from" is a query, not a reconstruction.

The **graph** is the other half. The journal answers *what changed*, in a durable,
state-centric order. The execution graph answers *why* — which action emitted which,
and under what decision. The two are genuinely different structures, and conflating
them is the usual mistake: an action's causal parent is the action that emitted it,
while its temporal predecessor is simply the previous entry. A tax payment emitted by
a sale sits next to that sale in the graph and possibly months away from it in time.

Three consequences worth holding onto:

- **A run is reproducible.** Same inputs, same seed, same byte-identical state. The
  golden fixtures depend on this, and so does any A/B you trust.
- **Adding an event re-orders others.** Events that fall on the same date are broken
  by a tie rule, so introducing one anywhere can change which of two same-day actions
  runs first, everywhere. A diff that looks unrelated to your change often is not.
- **Reporting reads the journal, never the balances.** A report that sums account
  fields instead of journal entries will disagree with the ledger the moment an action
  touches two accounts at once.

The Journal Report panel queries entries; Action Detail opens one; Lineage walks the
causal parentage back to the decision that started it.
