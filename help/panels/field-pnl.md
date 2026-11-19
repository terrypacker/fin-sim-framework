---
id: field-pnl
kind: panel
title: Field P&L
panels: [field-pnl]
design: [134-farm-job-costing.md]
sources: [src/finance/farm/farm-reports.js]
stamps:
  panel:field-pnl: 0930cc
  src/finance/farm/farm-reports.js: ded5ec
---

A farm season's profit and loss for each field, with the prices and yields that would
make each field break even. It reads a farm scenario (US Farm); a household plan has no
farm records, and the panel says so.

Rows open operator (or crop), then field, then the field's lines, each naming its
Schedule F line. **Direct** costs were posted to the field itself. **Overhead** is the
operator's cost spread over its acres, its owned acres, or the fields a cost names (a loan).

**Machinery** has two figures: custom rates (hiring the work done) and actual (the
operator's real machinery cost by acre). The switch changes the net and the breakevens;
the other figure stays on the field as a memo.

**The breakevens** say what price the grain must fetch and what yield the field must make.
*BE unpriced* is the price the bushels not under contract must fetch, red when above the
price expected. They are measured against the **planned** yield. When a season harvests
more or less (a yield shock, which Monte Carlo draws), a field's share of its grain pool's
revenue follows the bushels it put in the bin, not the plan.

Grain still owed or in the bin at the end of the run counts at its contract or latest
price: revenue for the field, not yet cash income. Mid-run the panel shows the season to
date, and the breakevens are too low until the grain is sold.
