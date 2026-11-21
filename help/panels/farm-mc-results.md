---
id: farm-mc-results
kind: panel
title: Farm MC Results
panels: [farm-mc-results]
params: []
actions: []
tools: []
design: [134-farm-job-costing.md]
sources: [src/visualization/workbench/plugins/finance/farm-mc-results-plugin.js]
stamps:
  panel:farm-mc-results: f52087
  src/visualization/workbench/plugins/finance/farm-mc-results-plugin.js: 79656f
---

The last [Farm MC](farm-mc.md) batch, opened when it finishes. It keeps the batch until the
next one, through rebuilds and replays.

**The charts**, for the whole farm or one operator: a fan of the cash in and out month by
month as 10th–90th and 25th–75th percentile bands around the median, and a histogram of the
season's net, losses in red. The fan is cash, before the custom-rate charges and the tax-year
rules. **The table** gives each scope's *P(loss)*, its net at the 10th, 50th and 90th
percentiles, the breakevens' range, and how often insurance and ARC pay.

**Paths** lists the seasons behind those numbers: worst, 10th percentile, median, 90th and
best first, then every path, sortable, or the losing ones only. Click a path to see what it
drew, ranked by how far each value sits from the batch median in the batch's own spread. A historical
yield year shows as the year and county it replayed. The value at the top is usually what made
that season.

**Replay** writes that path onto the scenario, rebuilds, runs the season and opens the
[Field P&L](field-pnl.md), so the breakevens, grain and value charts are that season's. A
badge says which path is in force. **Clear** puts your values back; one you edited while
replaying keeps your edit. A batch run on another scenario cannot be replayed onto this one.
