---
id: dg-config
kind: panel
title: Decision Graph
panels: [dg-config]
design: [30-decision-graph-analysis.md]
stamps:
  panel:dg-config: 5c40a2
---

The setup for a decision-graph run: the branching choices to explore and the shape of
the tree they produce.

Where [Optimize](opt-config.md) searches a continuous space for one best answer, this
explores a *tree of decisions* — retire at 62 or 65, and then within each of those,
sell the house or keep it. The point is the structure: it keeps the branches distinct
instead of collapsing them into a single optimum, so you can see what each choice
costs conditional on the ones before it.

Open it when the question has the word "or" in it and the options are discrete. Open
[Optimize](opt-config.md) instead when the question is "how much" and the answer is a
number on a range.

Needs a scenario loaded. Results land in [DG Results](dg-results.md), and any leaf
can be sent to [Scenario Compare](scenario-compare.md) to be diffed against its base.

Every leaf is a full run, so the cost is the number of leaves, which multiplies with
each level you add rather than adding to it.
