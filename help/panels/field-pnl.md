---
id: field-pnl
kind: panel
title: Field P&L
panels: [field-pnl]
design: [134-farm-job-costing.md]
sources: [src/finance/farm/farm-reports.js]
stamps:
  panel:field-pnl: 0930cc
  src/finance/farm/farm-reports.js: 1c2159
---

A farm season's profit and loss per field, with the price and yield that would make each
field break even.

Rows open operator (or crop), then field, then its lines, each naming its Schedule F line.
**Direct** costs were posted to the field; **overhead** is the operator's cost spread by
acres, owned acres or named fields. **Machinery** is custom rates or actual (machinery
figure or ownership rates, computed fuel and labor); the switch moves the net and breakevens.

*BE unpriced* is the price the uncontracted bushels must fetch, red when above the expected
price, at the planned yield.

**The price charts**, one per crop, set the cash price against the planned season's
breakeven: contracts as diamonds, planned sales as triangles, today's price as a dot. White
dots are the real Nebraska monthly prices; a green month was at or above breakeven. Click a
row to chart it (the footer is the whole farm). **Demo crop year** under Parameters shows a
past season.

**Where the grain is** charts each crop's bushels by date: in storage owed to a later
contract (blue), in storage unpriced (amber), delivered, and sold. Hover a date for its
moves. Grain is pooled by operator and crop, so a field shows its operator's pool.

Grain owed or in the bin counts at its contract or latest price: revenue, not yet cash.
Mid-run the table is the season to date, with breakevens too low. Warnings name what the
totals leave out.
