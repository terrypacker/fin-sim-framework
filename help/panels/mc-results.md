---
id: mc-results
kind: panel
title: MC Results
panels: [mc-results]
design: [100-mc-analysis-surface.md, 89-spending-over-time-reporting.md]
stamps:
  panel:mc-results: cc2f55
---

The batch as a distribution: success rate and percentile badges, a fan chart of the
confidence bands over time, a histogram of terminal values, and — when the run was
made to collect them — asset-mix and spending sections.

The fan chart is what most questions actually want: the band is the range the plan
lives in, and its width at retirement is usually the number that changes a decision.

"Path shape" is the diagnostic section: failure by realised return, and what separates
a failing path from a surviving one. It answers *why* the failures failed rather than
how many there were.

"By start year" appears for a batch run with rolling historical starts: one tile per
starting year, marked where the plan failed. The darker a tile, the less the plan ended
with from that start in today's dollars, so a plan that never fails still shows which
starts hurt it. Faded tiles replay under 15 years of history before it runs out, so random
years carry the rest.

"Against baseline" appears once you have kept a batch as a baseline, and shows paired
rescues and money delta against it. Paired is the important word: comparing two batches
run on different random draws measures the draws as much as the change.

The mix and spending sections only exist for a batch that was run with them enabled, and
say so when absent rather than showing empty charts.

Needs a completed [Monte Carlo](mc-config.md) run.
