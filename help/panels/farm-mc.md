---
id: farm-mc
kind: panel
title: Farm MC
panels: [farm-mc]
params: []
actions: []
tools: []
design: [134-farm-job-costing.md]
sources: [src/finance/farm/farm-mc.js]
stamps:
  panel:farm-mc: 7bf9f3
  src/finance/farm/farm-mc.js: 43c2eb
---

Sets up and runs the farm season many times with its uncertain inputs drawn at random. It
reads a farm scenario (US Farm). The results open in [Farm MC Results](farm-mc-results.md).

**Variables** lists what the batch can draw: yield shocks, price rows, cost multipliers and
the contracted share. Tick a row to sample it. The season yield shocks and price paths come
calibrated from USDA history for Nebraska counties (`npm run farm:calibrate`). Every other
row starts at a spread of 0, because no source sets it, so type one; the panel calls that a
sensitivity run.

**Historical yield year** draws a real season instead of a shock: one Nebraska county-year
from USDA, your ARC county's when NASS reports it. It sets both farm-wide yield shocks, so
tick it instead of them. The fitted shocks give a total crop failure far more often than
history does.

**Paths** sets how many seasons the batch draws. After a run, **Results →** reopens the last
batch.

The same seed always gives the same seasons, so rerunning after one change is a fair
comparison.
