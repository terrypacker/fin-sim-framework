---
id: exec-history
kind: panel
title: Node History
panels: [exec-history]
stamps:
  panel:exec-history: cc5517
---

What one config node has actually been doing during the run: whether it is firing or
idle right now, how many times it has executed, and the state diff its most recent
execution produced.

Select a node in [Graph](config-graph.md) to fill it. It stays live during playback,
so it updates as the simulation steps rather than showing a snapshot from whenever
you clicked.

Open it when a node is not doing what you expect. The three readouts answer three
different versions of that: *is it firing at all* (live status), *is it firing as
often as it should* (instance count), and *is it changing what it should change*
(the last diff). A node with a healthy count and an empty diff is the quiet failure
worth catching — it ran, and did nothing.

It also reports diffExecution coverage: config nodes missing from the execution
chain, or present in it and not in the config. That is a consistency check on the
graph itself rather than on your plan.

Needs a run that has stepped at least once. Before that there are no executions to
report and the panel has nothing to say.
