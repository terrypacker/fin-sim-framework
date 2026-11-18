---
id: mc-config
kind: panel
title: Monte Carlo
panels: [mc-config]
design: [100-mc-analysis-surface.md]
stamps:
  panel:mc-config: ad4956
---

The Monte Carlo run controls: how many iterations, which variables are random, and
the distribution each one is drawn from.

The variable table is built from the scenario's own sweepable surface, so any
parameter marked for Monte Carlo appears here — including a row per shock. Each row
has a centre and a spread; the centre is the plan's current value for that parameter
unless you typed your own.

The line above Run names the return processes and replayed years every path uses; see
[Stochastic Return Paths](../concepts/stochastic-return-paths.md). "Return processes &
history" under it edits them: the same settings as Parameters → Economic Shocks, on the
same plan, so either place shows what the other set.

A date is drawn as *uniformDate* (any day between two dates, the default) or *normalDate*
(around a centre date, spread in days). A date pinned to one day of the year, such as a
1 July move, keeps that day and varies only the year.

Rows you have not touched are re-synced
from the live scenario on every run. Centres you set by hand are never overwritten;
they are flagged instead, so a stale one is visible.

Needs a scenario loaded. Results land in [MC Results](mc-results.md) and
each iteration in [MC Runs](mc-runs.md).

Iteration count is the honest cost control: a thousand paths cost a thousand runs.
Start small, then raise it once the question is worth the wall clock.
