---
id: field-pnl
kind: panel
title: Field P&L
panels: [field-pnl]
design: [134-farm-job-costing.md]
sources: [src/finance/farm/farm-reports.js]
stamps:
  panel:field-pnl: 0930cc
  src/finance/farm/farm-reports.js: 1c43ec
---

A farm season's profit and loss per field, with the price and yield that would make each
field break even. It reads a farm scenario (US Farm).

Rows open operator (or crop), then field, then the field's lines, each naming its
Schedule F line. **Direct** costs were posted to the field; **overhead** is the operator's
cost spread by acres, owned acres, or the fields a cost names. **Machinery** is custom
rates (hiring the work done) or actual (the operator's real cost by acre); the switch moves
the net and the breakevens.

**The breakevens**: *BE unpriced* is the price the uncontracted bushels must fetch, red when
above the expected price. They use the planned yield.

**The chart** shows one crop's cash price through the season against that breakeven, the
zone below it shaded, contracts as diamonds, planned sales as triangles and a marker at the
run's date. Click a row to chart it (the footer is the whole farm); pick a crop where the
scope grows two. The line is the **planned** season's (the farm run to its end out of sight),
so it stays put as the run steps.

Grain still owed or in the bin counts at its contract or latest price: revenue, not yet
cash. Mid-run the table is the season to date, with breakevens too low.

Warnings name what the totals leave out: a cost with no crop plan to land on, or a plan that
looks incomplete, such as an annual crop with no seed cost.
