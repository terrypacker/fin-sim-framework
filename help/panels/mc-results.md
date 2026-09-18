---
id: mc-results
kind: panel
title: MC Results
panels: [mc-results]
design: [100-mc-analysis-surface.md, 89-spending-over-time-reporting.md]
stamps:
  panel:mc-results: 315796
---

The batch as a distribution: success rate and percentile badges, a fan chart of the
confidence bands over time, a histogram of terminal values, and — when the run was
made to collect them — asset-mix and spending sections.

The fan chart is what most questions actually want. A median is a single path's worth
of comfort; the band is the range the plan lives in, and the width of it at the point
you retire is usually the number that changes a decision.

"Path shape" is the diagnostic section: failure by realised return, and what separates
a failing path from a surviving one. It answers *why* the failures failed rather than
how many there were, which is the difference between a scary percentage and something
you can act on.

"Against baseline" appears once you have kept a batch as a baseline, and shows paired
rescues and money delta against it. Paired is the important word: comparing two batches
run on different random draws measures the draws as much as the change.

The mix and spending sections only exist for a batch that was run with them enabled, and
say so when absent rather than showing empty charts.

Needs a completed [Monte Carlo](mc-config.md) run.
