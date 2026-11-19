---
id: field-pnl
kind: panel
title: Field P&L
panels: [field-pnl]
design: [134-farm-job-costing.md]
sources: [src/finance/farm/farm-reports.js]
stamps:
  panel:field-pnl: 0930cc
  src/finance/farm/farm-reports.js: 2ece5e
---

A farm season's profit and loss for each field, with the prices and yields that would
make each field break even. It reads a farm scenario (US Farm); a household plan has no
farm records, and the panel says so.

Rows open operator (or crop), then field, then the field's lines, each naming its
Schedule F line. **Direct** costs were posted to the field itself. **Overhead** is the
operator's cost spread over its acres, its owned acres, or the fields a cost names (a loan).

**Machinery** has two figures: custom rates (hiring the work done) and actual (the
operator's real machinery cost by acre). The switch changes the net and the breakevens.

**The breakevens** say what price the grain must fetch and what yield the field must make.
*BE unpriced* is the price the uncontracted bushels must fetch, red when above the expected
price. They use the **planned** yield; when a season harvests more or less, a field's share
of the pool's revenue follows the bushels it put in the bin.

Grain still owed or in the bin at the end counts at its contract or latest price: revenue,
not yet cash. Mid-run the panel shows the season to date, with breakevens too low.

Warnings name what the totals leave out: a cost with no crop plan to land on, or a plan that
looks incomplete, such as an annual crop with no seed cost.
