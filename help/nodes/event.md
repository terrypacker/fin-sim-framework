---
id: event
kind: node
title: Event
node: event
panels: [config-list, config-graph]
design: [2-unified-event-schema.md]
sources: [src/simulation-framework/events/event-series.js]
stamps:
  panel:config-list: 786f94
  panel:config-graph: bbebb1
  node:event: 7c3ccb
  src/simulation-framework/events/event-series.js: 456eeb
---

A dated moment at which something is due to happen: a payday, a month boundary, a
tax settle date. An event carries no money of its own — it is a time, plus a type
that handlers subscribe to. What actually moves is whatever the
[handlers](handler.md) attached to it emit when it fires.

Two shapes, chosen by the type you pick. A **series** recurs on an interval from an
offset into the run. A **one-off** fires on a single date and never again.

You would add one when the plan needs a rhythm the engine does not already have —
a quarterly instalment, an annual review, a one-time liquidity moment. Most plans
never need one: the toolsets install the events the modelled mechanics require, and
an event with no handler subscribed to its type does nothing at all.

The one thing to know before adding any event is that
[event ordering is not stable](../concepts/event-sourcing.md) under insertion. Events
falling on the same date are broken by a tie rule, so a new event anywhere can change
which of two same-day actions runs first, everywhere in the run. A diff that looks
unrelated to the event you added usually is not.

Series are deduplicated **by type**. Four quarterly series sharing one type collapse
to one; a set of irregular dates needs one type each.

## Fields

- `name` — The label shown on the node and in the graph. Free text, for reading — nothing in the engine keys on it.
- `type` — The event type handlers subscribe to. This, not the name, is the wiring: a handler fires when an event of its declared type does, so two events sharing a type are one trigger with two dates. Series sharing a type are also collapsed to one.
- `color` — Node colour in the graph. Presentation only — useful when a family of related events should read as a family.
- `enabled` — Off suppresses every firing of this event without deleting it, which is the safe way to A/B a mechanic: the node, its handlers and its history all stay where they are.
- `interval` — How often a series repeats: monthly, quarterly, semiannual, annually, month-end or year-end. Only on a recurring series.
- `startOffset` — Whole years after the simulation start before the series begins firing. 0 starts immediately; 5 waits five years, which is how a rhythm that begins at retirement is expressed without naming a calendar date.
- `date` — The single calendar date a one-off event fires on. Outside the run's span it simply never fires — that is not an error, and it is the usual cause of an event whose node never lights up during playback.
