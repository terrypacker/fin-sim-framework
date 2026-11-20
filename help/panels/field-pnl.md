---
id: field-pnl
kind: panel
title: Field P&L
panels: [field-pnl]
design: [134-farm-job-costing.md]
sources: [src/finance/farm/farm-reports.js]
stamps:
  panel:field-pnl: 0930cc
  src/finance/farm/farm-reports.js: 1b9d12
---

A farm season's profit and loss per field, with the price and yield that would make each
field break even.

Rows open operator (or crop), then field, then the field's lines, each naming its
Schedule F line. **Direct** costs were posted to the field; **overhead** is the operator's
cost spread by acres, owned acres, or the fields a cost names. **Machinery** is custom
rates (hiring the work done) or actual (the machinery figure or per-acre ownership,
computed fuel and labor); the switch moves the net and breakevens.

**The breakevens**: *BE unpriced* is the price the uncontracted bushels must fetch, red when
above the expected price. They use the planned yield.

**The charts**, one per crop, show its cash price against its own breakeven: contracts as
diamonds, planned sales as triangles, today's price as a dot. Click a row to chart it (the
footer is the whole farm). The breakeven is the **planned** season's, so it stays put as the
run steps. White dots are the crop year's real Nebraska monthly prices published so far; a
month shaded green was at or above breakeven, a chance to sell there. To see a past season, set
**Demo crop year** under Parameters (the demo's costs stay put).

Grain still owed or in the bin counts at its contract or latest price: revenue, not yet
cash. Mid-run the table is the season to date, with breakevens too low.

Warnings name what the totals leave out, such as a crop plan with no seed cost.
