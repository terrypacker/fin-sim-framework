---
id: config-graph
kind: panel
title: Graph
panels: [config-graph]
stamps:
  panel:config-graph: bbebb1
---

The scenario's records as a graph: every node the plan registered, and the edges
saying which depends on which. A filter bar above the canvas narrows it by kind or
by name.

[Nodes](config-list.md) arranges the same records by kind, which is what you want
when you know what you are looking for. This arranges them by relationship, which is
what you want when you do not — when the question is "what does this account feed"
or "what would break if I deleted this".

During a run the graph is live: nodes light as they fire, so you can watch which
parts of the plan are actually doing anything at a given date. A node that never
lights is a node the run never reached, which is usually more interesting than it
looks.

Clicking a node opens it in [Edit](inspector.md), and fills
[Node History](exec-history.md) and [Lineage](lineage.md) for that node.

Needs a scenario loaded. The graph's DOM is owned by the workbench runtime rather
than by this panel, so it exists and stays wired whether or not this tab has ever
been opened — a layout with this tab closed still gets a working graph when you
open it later.
