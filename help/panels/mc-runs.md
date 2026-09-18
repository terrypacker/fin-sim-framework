---
id: mc-runs
kind: panel
title: MC Runs
panels: [mc-runs]
design: [100-mc-analysis-surface.md]
stamps:
  panel:mc-runs: aca7d2
---

The individual iterations behind a batch, in two sections: a handful of
representatives — best, worst, median, most volatile, earliest failure — and then
every run, sortable and filterable to failures only.

Both exist on purpose. The representatives answer *how bad does it get*; only the full
list answers *how many of them look like that*, and a panel that showed five of a
thousand with no way to reach the rest would send you back to re-running the batch to
find out.

Any run expands to its parameters, ranked by how far each sits from the batch median.
That is the difference between knowing a run failed and knowing what failed it — the
outlier at the top of that list is usually the answer. The tables are built when you
expand a row, not up front, because a thousand runs times a hundred parameters is a
hundred thousand rows nobody has asked to see.

Replay on a row re-runs that exact iteration as the live simulation, so a failure you
found in the distribution becomes something you can step through in
[Timeline](timeline.md) and [Chart](chart.md). Clear the replay badge to go back.

Needs a completed [Monte Carlo](mc-config.md) run.
