---
id: mc-runs
kind: panel
title: MC Runs
panels: [mc-runs]
design: [100-mc-analysis-surface.md]
stamps:
  panel:mc-runs: dc440d
---

The individual iterations behind a batch, in two sections: a handful of
representatives — best, worst, median, most volatile, earliest failure — and then
every run, sortable and filterable to failures only.

Both exist on purpose. The representatives answer *how bad does it get*; only the full
list answers *how many of them look like that*.

Any run expands to its parameters, ranked by how far each sits from the batch median.
That is the difference between knowing a run failed and knowing what failed it — the
outlier at the top of that list is usually the answer. The tables are built when you
expand a row, not up front, because a thousand runs times a hundred parameters is a
hundred thousand rows nobody has asked to see.

Replay on a row re-runs that exact iteration as the live simulation, so a failure you
found in the distribution becomes something you can step through in
[Timeline](timeline.md) and [Chart](chart.md). The replay writes that run's values into your
plan, the Monte Carlo's own settings included; Clear on the replay badge puts yours back,
keeping anything you edited meanwhile.

After a rolling-start batch each run shows the historical year it opened with, and can be
sorted by it. Values are then in today's dollars: start years differ mostly in the
inflation they carry, so in nominal money the 1970s starts would look best.

Needs a completed [Monte Carlo](mc-config.md) run.
