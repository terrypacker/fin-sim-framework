---
id: mc-config
kind: panel
title: Monte Carlo
panels: [mc-config]
design: [100-mc-analysis-surface.md]
stamps:
  panel:mc-config: 2c8dce
---

The Monte Carlo run controls: how many iterations, which variables are random, and
the distribution each one is drawn from.

The variable table is built from the scenario's own sweepable surface, so any
parameter marked for Monte Carlo appears here — including a row per shock. Each row
has a centre and a spread; the centre is the plan's current value for that parameter
unless you typed your own.

That distinction matters more than it looks. Rows you have not touched are re-synced
from the live scenario on every run, so a panel opened at load time does not keep
sampling a plan you have since edited away from. Centres you set by hand are never
overwritten — they are flagged instead, so a deliberate override stays deliberate and
a stale one is visible.

Needs a scenario loaded. Results land in [MC Results](mc-results.md) and the
individual iterations in [MC Runs](mc-runs.md).

Iteration count is the honest cost control: paths are independent runs of the whole
simulation, so a thousand of them costs a thousand runs. Start small enough to see
whether the arms differ at all, then raise it once the question is worth the wall
clock.
