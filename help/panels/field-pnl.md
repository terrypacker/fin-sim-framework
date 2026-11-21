---
id: field-pnl
kind: panel
title: Field P&L
panels: [field-pnl]
params: [farmDemoCropYear]
design: [134-farm-job-costing.md]
sources: [src/finance/farm/farm-reports.js]
stamps:
  param:farmDemoCropYear: ff634f
  panel:field-pnl: 0930cc
  src/finance/farm/farm-reports.js: f76d31
---

A farm season's profit and loss per field, with the price and yield that break it even.

Rows open operator (or crop), then field, then its lines, each naming its Schedule F line.
**Direct** costs were posted to the field; **overhead** is the operator's, spread by acres,
owned acres or named fields. **Machinery** is custom rates or actual; the switch moves the
net and breakevens. *BE unpriced* is what the uncontracted bushels must fetch, red when above
the expected price.

**The price charts** set the cash price against the planned season's breakeven: contracts as
diamonds, sales as triangles, today as a dot, real Nebraska months as white dots (green at or
above breakeven). Click a row to chart it. **Demo crop year** under Parameters shows a past
season.

**Where the grain is** stacks each crop's bushels: stored for a later contract (blue), stored
unpriced (amber), delivered, sold. A field shows its operator's pool, since grain is pooled
by operator and crop.

**What the grain is worth** stacks the same grain in dollars: paid, owed, stored at its
contract price, and stored at that day's cash price, the only band the market moves. The
dashed red line is what this season's grain must earn; carried-in grain is not held against it.

Grain owed or in the bin is revenue, not yet cash. Mid-run the table is the season to date.
