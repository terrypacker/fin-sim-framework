---
id: handler
kind: node
title: Handler
node: handler
panels: [config-list, config-graph]
design: [2-unified-event-schema.md]
stamps:
  panel:config-list: 786f94
  panel:config-graph: bbebb1
  node:handler: 9709a1
---

The decision layer. A handler subscribes to one or more [event](event.md) types, and
when one of them fires it decides what — if anything — should happen, and emits
[actions](action.md) saying so. It is the only place in the engine where a *choice*
lives: should this sale happen, how much of it, out of which sleeve.

A handler never changes a balance. It cannot: only a [reducer](reducer.md) may, and
it does so by consuming an action. That separation is what makes the run explicable
rather than merely correct — the graph can show which handler decided a thing and the
journal can show what the decision cost, and neither has to be reconstructed from the
other. See [Event Sourcing](../concepts/event-sourcing.md).

Almost every handler in a real plan comes from a toolset rather than from this form.
You would author one here when prototyping a mechanic the toolsets do not model, and
the usual reason to *open* one is the opposite of authoring: to see which events feed
it and which actions it emits, which the graph and
[Node History](../panels/exec-history.md) show for the selected node.

A handler whose events never fire is inert, not broken. So is one whose actions no
reducer consumes — the actions are emitted and recorded, and nothing applies them.

## Fields

- `handlerClass` — Which handler implementation this node is. The class decides what the handler does and what configuration it reads; the rest of this form only names and wires it. Changing it on an existing node re-points the same node at different behaviour.
- `name` — The label shown on the node, in the graph and in Node History. Free text: nothing keys on it, but it is what you will be reading when tracing why an action was emitted, so name it after the decision rather than the mechanism.
