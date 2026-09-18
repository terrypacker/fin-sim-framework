---
id: lineage
kind: panel
title: Lineage
panels: [lineage]
design: [30-decision-graph-analysis.md]
stamps:
  panel:lineage: 87213c
---

The causal chain behind one node's most recent execution: every step that led to it,
with each step's kind, name, timestamp and how many state fields it changed.

This is the *why* panel. [Node History](exec-history.md) tells you that a node fired
and what it changed; this tells you what made it fire. Select a node in
[Graph](config-graph.md) and the chain fills, staying live as playback advances.

Open it when a number is right but you do not believe it — when a sale happened and
you want to know which decision caused it, or when a tax payment appeared and you
want the income that triggered it. Following the chain back is usually faster than
reasoning forward from the parameters.

The chain is causal parentage, not time order. A step in it may sit months away from
the one below it in the calendar; the [Timeline](timeline.md) is where you go for
what happened next, as opposed to what happened because.

Needs a run that has executed the selected node at least once. With no executions
there is no instance to trace, and the panel says so rather than showing an empty
chain that looks like an answer.
