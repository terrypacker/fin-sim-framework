---
id: dg-results
kind: panel
title: DG Results
panels: [dg-results]
design: [30-decision-graph-analysis.md]
stamps:
  panel:dg-results: d0b251
---

The outcome of every leaf of a decision-graph run, arranged by the branch structure
that produced it.

Read it down the branches rather than across the leaves. The ranking of the leaves
tells you which combination won; the structure tells you something more useful —
whether a choice mattered *at all*, and whether it mattered differently depending on
what was decided above it. A branch whose two sides land within noise of each other
is a decision you can stop agonising over.

Each leaf has a Compare button that opens it in
[Scenario Compare](scenario-compare.md) against its base, which is how you get from
"this branch ends $300k higher" to where and when the difference actually accrued.

Needs a completed [Decision Graph](dg-config.md) run.

A leaf is one deterministic run, so the differences shown are the differences the
choices make on that path — not the range they make across possible futures. For
that, take the branch you care about and run it through
[Monte Carlo](mc-config.md).
