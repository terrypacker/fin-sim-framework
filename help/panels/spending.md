---
id: spending
kind: panel
title: Spending
panels: [spending]
design: [89-spending-over-time-reporting.md]
stamps:
  panel:spending: f9f5c7
---

What the plan actually costs, year by year, classified by what the money was for.

The flow sibling of [Allocation](allocation.md): that panel answers what shape the
portfolio is, this one answers the question both a net-worth line and a withdrawal
total hide — **of everything that left an account, how much was genuinely a cost?**

On the reference plan the answer is about half. Summing every debit counts transfers
between your own accounts, tax instalments later refunded, and rebalancing as though
they were money spent, which overstates the cost of the plan by roughly double. That
gap is the reason this panel exists.

The classification and the pivot are the same modules the headless spending report
uses, and the colours are shared with it — someone who learned that amber means tax
on one should not have to relearn it here.

Open it when you want the real number behind "what do we live on", or to see how the
composition changes across retirement as tax and healthcare take a different share.

Needs a scenario built and stepped, with the journal recorded.

Its flow-ties-to-stock check depends on the run carrying a balance sampler. Without
one the panel still works and reports that line as "not checked" rather than hiding
the fact.
