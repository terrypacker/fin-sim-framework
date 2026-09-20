---
id: action
kind: node
title: Action
node: action
panels: [config-list, config-graph, action-detail]
design: [2-unified-event-schema.md, 91-journal-payload-manifest.md]
stamps:
  panel:config-list: 786f94
  panel:config-graph: bbebb1
  panel:action-detail: 863051
  node:action: 74d46b
---

A money movement or decision, emitted by a [handler](handler.md) and applied by a
[reducer](reducer.md). An action is a *statement that something should happen*, not
the happening: it carries a type and a payload, it is recorded whether or not anything
consumes it, and it is the unit the whole causal half of the app is built on — the
graph's edges are actions, and [Lineage](../panels/lineage.md) walks them back to the
decision that started the chain.

Open one from the Nodes panel to see its class, its payload shape, and which handlers
emit it; [Action Detail](../panels/action-detail.md) shows a single firing, with the
values it actually carried on that date.

The **type** is the join. A reducer registers against a type, not against a node, so
an action reaches every reducer registered for its type and no others. Emitting an
action of a type nothing registers for is silent: it appears in the graph, and no
balance moves. That is the usual explanation for a mechanic that "does nothing".

Note that one action can be applied by more than one reducer, and the journal then
carries one entry per reducer. Summing a report by action type double-counts those;
filter on the reducer instead.

## Fields

- `name` — The label on the node and in the graph. Free text — name it after what the action asks for ("sell to fund spending"), because that is what you will read when tracing a chain.
- `actionClass` — Which action implementation this node is. It decides the payload shape and which of the sub-editors below appears; the fields under it belong to the class you pick.
- `type` — The discriminator reducers register against, e.g. RECORD_METRIC. This is the wiring, and it is a free-text string on purpose: a type nothing registers for is a legal, silent action rather than an error. Spelling it differently from the reducer's registration is the most common way to author a dead mechanic.
- `fieldName` — The state field this action targets. On a field-valued action it is required; on a scripted one it is optional, and leaving it blank lets the script return a partial state instead of a single value.
- `value` — The fixed amount this action carries. Left blank where the class allows it, the value is taken from the state or from the emitting handler's context instead — which is what makes one action node serve a whole run rather than one date.
- `script` — Inline JavaScript run when the action fires, with state, date, sourceEvent, handlerContext and me in scope. For prototyping a mechanic no action class models. Test it with the button beside the box; a script that throws fails the run at that date rather than being skipped.
