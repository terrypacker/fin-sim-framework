---
id: paycheque
kind: panel
title: Paycheque
panels: [paycheque]
design: [95-wage-logic-and-payroll-contributions.md, 107-retirement-paycheck-and-tax-instalments.md]
stamps:
  panel:paycheque: f8d503
---

One earner, one month, gross down to net — plus the two yearly tables that explain
why it came out that way.

**Payslip** walks the pipeline for a single person-month: pre-tax and sacrificed
amounts, statutory withholding, after-tax payroll, and the net split across accounts,
each stage a reduction from the one above, with what the employer added beside it.
The month follows the run's cursor, which is why this is a panel and not a report —
stepping the simulation advances it.

**Contributions** is every year's contributions per person and stream, **with the
clamps as a column**. A contribution stopped by a cap should be visible where the
contributions are shown, not inferred from a number being lower than expected.

**Super caps** is the Australian cap state as a table: the five-year unused-cap ring,
the total-super-balance snapshot that gates it, and the bring-forward. The ATO
publishes this as a table, and so does this.

Open it when a contribution did not happen, when net pay is not what you expected, or
when a cap is doing something you cannot see from the totals.

Needs a scenario built and stepped, with someone earning in the period you are
looking at.
