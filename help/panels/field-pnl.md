---
id: field-pnl
kind: panel
title: Field P&L
panels: [field-pnl]
design: [134-farm-job-costing.md]
sources: [src/finance/farm/farm-reports.js]
stamps:
  panel:field-pnl: 0930cc
  src/finance/farm/farm-reports.js: 4dfebc
---

A farm season's profit and loss for each field, with the prices and yields that would
make each field break even. It reads a farm scenario (US Farm). A household plan has no
farm records, and the panel says so.

Rows open in three levels: operator (or crop), then field, then the field's lines. Each line
names its Schedule F line. **Direct** costs
were posted to the field itself. **Overhead** is the operator's cost spread over the
operator's acres, its owned acres, or the fields a cost names (a loan, for example).

**Machinery** has two figures. Custom rates are what hiring the work done would cost.
Actual is the operator's real machinery cost, spread over its acres. The switch changes
the net and the breakevens; the field's lines show the other figure as a memo, so the
gap between them is visible.

**The breakevens** answer two questions: what price must this field's grain fetch, and
what yield must it make? *BE unpriced* is the price the bushels not under contract must
fetch. It turns red when it is above the price that grain is expected to get.

Grain that is still owed or still in the bin at the end of the run is counted at its
contract or latest price. It is revenue for the field, but not yet cash income.

Mid-run it shows the season to date. Until the grain is sold, the breakevens are too
low, so read them at the run's end.
